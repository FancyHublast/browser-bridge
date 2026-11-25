"""
Browser Bridge · 本地浏览器连接桥

【这个类在架构里的位置】

    agent  ──MCP(stdio)──▶  本进程  ──WebSocket──▶  Chrome 插件  ──▶  你已登录的页面

    它是「指令翻译官」：
      MCP 工具调用  →  {id, cmd, args}  →  WS  →  插件
      插件的 {id, ok, data}  →  工具返回值  →  agent

【为什么 WebSocket 要单开一个线程跑？】
    MCP 的 stdio 传输会长期占用主线程的事件循环（阻塞在 stdin 读取上），
    而 WebSocket 服务需要自己持续的 asyncio 循环。
    把两者塞进同一个循环，在 Windows 上会因为 stdin 的管道可等待行为而互相干扰。
    所以：WS 跑在独立线程的独立事件循环里，跨线程用 run_coroutine_threadsafe 提交调用。
    隔离换来的确定性，远比省一个线程值。

【安全边界 —— 这条规则写死在代码里，不只是写在 README 里】
    默认只监听 127.0.0.1，不出网。
    一旦监听非回环地址，就等于把你「登录着的浏览器」挂到了网络上：
    谁拿到地址，谁就能点你的生意参谋、翻你的拼多多后台、读你的 Cookie。
    所以：监听非回环地址 + token 为空 ⇒ 直接拒绝启动，不给"先跑起来再说"的机会。

【心跳为什么必须由服务端发】
    插件那侧是 MV3 的 service worker，空闲约 30 秒就会被浏览器回收，连接随之断开。
    而 WebSocket 断线后，插件无法"自己发现"（它只能重连，但重连需要 SW 被唤醒）。
    服务端每 20 秒发一次心跳，插件收到消息会重置 SW 的空闲计时器 ——
    这是让连接在无人操作时也活着的关键一环。
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import hmac
import itertools
import json
import logging
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import parse_qs, urlparse

log = logging.getLogger("bb.bridge")

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

# 新版 websockets（14+）把实现搬到了 websockets.asyncio，旧版在顶层。
# 这里做一次带兜底的导入，避免用户环境里装的是哪个版本都得改代码。
try:  # pragma: no cover - 取决于安装的 websockets 版本
    from websockets.asyncio.server import serve as _ws_serve
except ImportError:  # pragma: no cover
    from websockets import serve as _ws_serve  # type: ignore


class BridgeError(RuntimeError):
    """面向 agent / 用户的「可读错误」。消息会被原样呈现，所以必须写"该怎么办"。"""


class BrowserBridge:
    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8765,
        token: str = "",
        heartbeat_seconds: int = 20,
        call_timeout: int = 60,
        max_message_mb: int = 64,
    ) -> None:
        if host not in LOOPBACK_HOSTS and not token:
            raise BridgeError(
                "拒绝启动：监听地址 {} 不是回环地址，但没有配置 token。\n"
                "这等于把你已登录的浏览器直接挂到网络上，任何能访问该地址的人都能操控它。\n"
                "请在 server/config.json 里设置一个足够长的 token（建议 32 位以上随机串）。".format(host)
            )

        self.host = host
        self.port = port
        self.token = token or ""
        self.heartbeat = max(5, int(heartbeat_seconds))
        self.call_timeout = max(5, int(call_timeout))
        self.max_size = max(1, int(max_message_mb)) * 1024 * 1024

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._ws: Any = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._ready = threading.Event()
        self._start_error: Optional[BaseException] = None
        self._client_info: Optional[dict] = None
        self._connected_at: Optional[float] = None
        self._running = False

    # ───────────────────────── 生命周期 ─────────────────────────

    def start(self, wait_seconds: float = 15.0) -> None:
        """启动后台 WS 线程；端口被占用等问题会在启动阶段就抛出来，不拖到第一次调用。"""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run, name="bb-ws", daemon=True)
        self._thread.start()

        if not self._ready.wait(wait_seconds):
            raise BridgeError("WebSocket 服务启动超时（{}s）".format(wait_seconds))
        if self._start_error is not None:
            err = self._start_error
            self._start_error = None
            if isinstance(err, OSError) and getattr(err, "errno", None) in (48, 98, 10048):
                raise BridgeError(
                    "端口 {}:{} 已被占用。\n"
                    "最常见的情况：你之前手工双击过 start-server.bat，那个进程还开着。\n"
                    "  处理 → 双击 server\\stop-server.bat 把它停掉，再重来。\n"
                    "  （一个端口只能由一个服务占用，而 agent 需要的是「由 MCP 拉起的这个进程」——\n"
                    "    因为插件只能连到一个服务，手工那个占着的话，agent 就指挥不动浏览器。）\n"
                    "也可能是别的程序占了这个端口，确认命令：netstat -ano | findstr {}".format(
                        self.host, self.port, self.port
                    )
                )
            raise BridgeError("WebSocket 服务启动失败：{}".format(err))

    def stop(self) -> None:
        self._running = False
        if self._loop is not None:
            try:
                self._loop.call_soon_threadsafe(self._loop.stop)
            except RuntimeError:
                pass

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._serve())
        except BaseException as e:  # noqa: BLE001 - 启动期任何异常都要带回主线程
            self._start_error = e
            log.error("WebSocket 服务异常退出：%s", e)
            self._ready.set()
        finally:
            try:
                loop.close()
            except Exception:
                pass

    async def _serve(self) -> None:
        async with _ws_serve(
            self._handler,
            self.host,
            self.port,
            max_size=self.max_size,
            # 关掉库自带的心跳：我们走应用层心跳，语义更清楚、也方便排查
            ping_interval=None,
        ):
            log.info("WebSocket 服务已监听 ws://%s:%d（鉴权：%s）", self.host, self.port, "token" if self.token else "无（仅回环）")
            self._ready.set()
            stop_event = asyncio.Event()
            # 挂住这个协程，直到 loop.stop() 被调用
            try:
                await stop_event.wait()
            except asyncio.CancelledError:
                pass

    # ───────────────────────── 连接处理 ─────────────────────────

    def _authorize(self, path: str) -> bool:
        """未配置 token 时放行（只可能是回环地址）；配置了就必须带对。"""
        if not self.token:
            return True
        try:
            query = parse_qs(urlparse(path or "").query)
        except Exception:
            return False
        got = (query.get("token") or [""])[0]
        return hmac.compare_digest(got, self.token)

    async def _handler(self, websocket: Any, *args: Any) -> None:
        # 兼容旧版 websockets 的 (ws, path) 签名
        path = ""
        try:
            req = getattr(websocket, "request", None)
            if req is not None and getattr(req, "path", None):
                path = req.path
            elif len(args) > 0 and isinstance(args[0], str):
                path = args[0]
        except Exception:
            path = ""

        if not self._authorize(path):
            log.warning("已拒绝一个未通过鉴权的连接")
            try:
                await websocket.close(code=4001, reason="unauthorized")
            except Exception:
                pass
            return

        old = self._ws
        self._ws = websocket
        self._connected_at = time.time()

        heartbeat = asyncio.create_task(self._heartbeat(websocket))

        try:
            # 只保留一条连接：新连接顶掉旧的，避免指令发给了错误的浏览器
            if old is not None and old is not websocket:
                log.info("新连接顶替旧连接")
                try:
                    await old.close(code=4002, reason="superseded by new connection")
                except Exception:
                    pass

            await websocket.send(
                json.dumps({"type": "welcome", "note": "Browser Bridge 服务已就绪"}, ensure_ascii=False)
            )
            log.info("浏览器插件已连接")

            async for raw in websocket:
                self._on_message(raw)

        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - 单条连接的异常不能拖垮服务
            log.debug("连接处理结束：%s", e)
        finally:
            heartbeat.cancel()
            if self._ws is websocket:
                self._ws = None
                self._client_info = None
                self._connected_at = None
                log.info("浏览器插件已断开")

            # 断线时把所有待回执的调用一次性失败掉，
            # 让 agent 立刻知道"这条指令没执行"，而不是干等到超时。
            for fut in list(self._pending.values()):
                if not fut.done():
                    fut.set_exception(BridgeError("浏览器插件在处理这条指令时断开了连接，指令结果未知。"))
            self._pending.clear()

    async def _heartbeat(self, websocket: Any) -> None:
        try:
            while True:
                await asyncio.sleep(self.heartbeat)
                await websocket.send(json.dumps({"type": "ping", "t": int(time.time() * 1000)}))
        except asyncio.CancelledError:
            raise
        except Exception:
            # 连接已断，主循环会处理收尾
            return

    def _on_message(self, raw: Any) -> None:
        try:
            msg = json.loads(raw if isinstance(raw, str) else raw.decode("utf-8"))
        except Exception:
            return

        kind = msg.get("type")
        if kind == "pong":
            return
        if kind == "hello":
            self._client_info = {
                "version": msg.get("version"),
                "agent": msg.get("agent"),
            }
            log.info("插件自报：version=%s", msg.get("version"))
            return

        rid = msg.get("id")
        if rid is None:
            return
        fut = self._pending.pop(str(rid), None)
        if fut is not None and not fut.done():
            fut.set_result(msg)

    # ───────────────────────── 调用 ─────────────────────────

    @property
    def connected(self) -> bool:
        return self._ws is not None

    def status(self) -> dict:
        return {
            "listening": "{}:{}".format(self.host, self.port),
            "extension_connected": self.connected,
            "extension": self._client_info,
            "connected_seconds": round(time.time() - self._connected_at, 1) if self._connected_at else None,
            "auth": "token" if self.token else "none（仅回环地址，未设 token）",
        }

    def _not_connected_hint(self) -> str:
        return (
            "浏览器插件未连接，指令无法下发。请依次确认：\n"
            "  1) Chrome 里已加载扩展：chrome://extensions → 打开开发者模式 → 加载已解压的扩展程序 → 选择 browser-bridge/extension 目录；\n"
            "  2) 点击扩展图标，服务地址填 ws://{host}:{port}（有 token 的话要一起填）；\n"
            "  3) 弹窗顶部状态显示「已连接」；\n"
            "  4) 若一直连不上，确认本服务仍在运行、端口没被占用。"
        ).format(host=self.host if self.host not in ("::1",) else "127.0.0.1", port=self.port)

    async def _call_async(self, cmd: str, args: Optional[dict], timeout: float) -> dict:
        ws = self._ws
        if ws is None:
            raise BridgeError(self._not_connected_hint())

        rid = "srv-{}".format(next(self._ids))
        fut: asyncio.Future = self._loop.create_future()  # type: ignore[union-attr]
        self._pending[rid] = fut

        try:
            await ws.send(json.dumps({"id": rid, "cmd": cmd, "args": args or {}}, ensure_ascii=False))
            return await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError:
            raise BridgeError(
                "等待浏览器插件响应超时（{}s）：{}。\n"
                "可能是：页面正在跳转、页面弹了模态框挡住、或目标元素一直没出现。".format(timeout, cmd)
            )
        finally:
            self._pending.pop(rid, None)

    def call(self, cmd: str, args: Optional[dict] = None, timeout: Optional[float] = None) -> dict:
        """
        同步调用一条插件指令。任何 MCP 工具都经由这里下发。
        返回插件原始回执 {id, ok, data|error, ms}；错误由上层决定怎么呈现。
        """
        if not self._running or self._loop is None:
            raise BridgeError("本地服务未启动（内部错误：请通过 mcp_server.py 启动）")
        if self._ws is None:
            raise BridgeError(self._not_connected_hint())

        t = float(timeout or self.call_timeout)
        future = asyncio.run_coroutine_threadsafe(self._call_async(cmd, args, t), self._loop)
        try:
            return future.result(timeout=t + 10)
        except concurrent.futures.TimeoutError:
            raise BridgeError("跨线程等待超时（{}s）：{}".format(t + 10, cmd))

    def call_data(self, cmd: str, args: Optional[dict] = None, timeout: Optional[float] = None) -> Any:
        """
        和 call 一样，但把 {ok:false} 直接转成 BridgeError。
        MCP 工具用它，省掉每个工具里重复的 ok 判断。
        """
        res = self.call(cmd, args, timeout)
        if not isinstance(res, dict):
            raise BridgeError("插件回执格式异常：{}".format(res))
        if not res.get("ok"):
            raise BridgeError(str(res.get("error") or "插件执行失败（未给出原因）"))
        return res.get("data")
