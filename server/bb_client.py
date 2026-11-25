# -*- coding: utf-8 -*-
"""
不开 MCP，直接驱动浏览器。

    from bb_client import Browser
    b = Browser()
    b.wait_extension(20)
    b.call("activate_tab", {"tabId": 123})
    b.drag_os(123, "#nc_1_n1z", "+420,0", overrun=90)

【为什么需要这条路】
    MCP 那条线是给 agent 用的，但它有个绕不开的短板：
      · 改了服务端代码必须重启服务进程，而服务进程由宿主拉起 —— 重启就意味着
        "自定义连接器"要重新信任一次，当前会话直接失去浏览器能力；
      · 一段固定流程（登录、过滑块、定时取数）每次让 agent 现场编排，既慢又不稳定。
    这条路直接起 WS 服务（用的就是 MCP 那边同一个 bridge.BrowserBridge），
    插件照常连上来，于是「服务端能力」到「脚本」之间不再需要 MCP 这一跳。
    好处很实在：改完代码即时生效、流程可固化、可回归、可无人值守。

【安全边界不变】
    仍然只监听 127.0.0.1；本文件不提供任何"监听外网"的入口。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from bridge import BridgeError, BrowserBridge  # noqa: E402


class Browser:
    """一次「直连浏览器」会话。用完记得 close()（或 with 语句），把端口还回去。"""

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8765,
        token: str = "",
        *,
        start_wait: float = 15.0,
    ) -> None:
        self.bridge = BrowserBridge(host=host, port=port, token=token)
        try:
            self.bridge.start(start_wait)
        except BridgeError as e:
            # 端口冲突是这条路最常见的第一道坎：browser-bridge 只能有一个服务端，
            # 插件也只连一个。MCP 服务在跑的时候，脚本就起不来 —— 把选择讲清楚，
            # 比丢一句 "address already in use" 有用得多。
            if "已被占用" in str(e):
                raise BridgeError(
                    "端口 %d 已被占用 —— 多半是 WorkBuddy 拉起的 MCP 服务正在跑。\n"
                    "（browser-bridge 只能有一个服务端，插件也只连得上一个，所以两者不能并存。）\n"
                    "\n"
                    "两种选择：\n"
                    "  A) 有 MCP 通道就直接用 browser_* 工具（推荐）：\n"
                    "     browser_drag(from_target=\"#nc_1_n1z\", to_target=\"+420,0\",\n"
                    "                  method=\"os\", overrun=90, frame=<风控帧id>)\n"
                    "  B) 一定要跑脚本：先停掉 MCP 拉起的那个服务\n"
                    "     （在 WorkBuddy 里断开 browser-bridge 连接器，或让它重启），再跑脚本。\n"
                    "     脚本跑完记得把连接器重新连上。\n"
                    % port
                ) from e
            raise

    # ───────────────────────── 连接 ─────────────────────────

    def wait_extension(self, timeout: float = 30.0, poll: float = 0.4) -> dict:
        """等插件连上来。扩展侧自带重连（退避上限 5 秒），通常几秒内就到了。"""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.bridge.connected:
                return self.bridge.status()
            time.sleep(poll)
        raise BridgeError(
            "等了 %.0f 秒插件也没连上来。确认：① Chrome 里 browser-bridge 扩展是启用状态；"
            "② 扩展弹窗里的服务地址是 ws://%s:%d；③ 没有别的服务占着这个端口。"
            % (timeout, self.bridge.host, self.bridge.port)
        )

    def status(self) -> dict:
        return self.bridge.status()

    def call(self, cmd: str, args: dict = None, timeout: float = None):
        """发一条插件指令；插件回 ok:false 会直接抛 BridgeError（带原因）。"""
        return self.bridge.call_data(cmd, args, timeout=timeout)

    def close(self) -> None:
        """
        停服务并把 WS 线程等回来。

        join 这一步不是可有可无的：不等它结束，进程退出时解释器会强杀这个 daemon 线程，
        stderr 上就会刷一屏 "Task was destroyed but it is pending" —— 看着吓人、
        也确实会盖住真正有用的报错（脚本的 stdout 是 JSON，stderr 是日志，别混）。
        """
        self.bridge.stop()
        th = getattr(self.bridge, "_thread", None)
        if th is not None and th.is_alive():
            th.join(timeout=3)

    def __enter__(self) -> "Browser":
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ───────────────────────── 常用封装 ─────────────────────────

    def tabs(self) -> list:
        return (self.call("tabs") or {}).get("tabs", [])

    def tab_by_url(self, needle: str):
        """按 URL 片段找标签页 —— 比按标题稳（标题会随状态变）。"""
        for t in self.tabs():
            if needle in (t.get("url") or ""):
                return t
        return None

    def tab_by_title(self, needle: str):
        for t in self.tabs():
            if needle in (t.get("title") or ""):
                return t
        return None

    def active_tab_id(self) -> int:
        for t in self.tabs():
            if t.get("active"):
                return int(t["tabId"])
        raise BridgeError("没有活动标签页。")

    def query(self, selector: str, tab_id: int, frame=None, limit: int = 20) -> dict:
        # 注意参数名是 target 而不是 selector —— 插件侧的命令契约如此（跟 MCP 工具的参数名不一样，
        # 这里是最容易被绊一下的地方）
        args = {"target": selector, "tabId": int(tab_id), "limit": limit}
        if frame is not None:
            args["frame"] = str(frame)
        return self.call("query", args) or {}

    def first_rect(self, selector: str, tab_id: int, frame=None):
        """取第一个命中元素的帧内 rect（不叠加任何偏移 —— 换算交给 os_driver）。"""
        r = self.query(selector, tab_id, frame)
        els = r.get("elements") or []
        if not els:
            return None
        return (els[0] or {}).get("rect")

    def risk(self, tab_id: int) -> dict:
        import os_driver

        return os_driver.risk_scan(self.bridge, tab_id)

    # ───────────────────────── 系统级输入快捷方式 ─────────────────────────

    def drag_os(self, tab_id: int, from_spec, to_spec, *, frame=None, overrun: float = 0.0) -> dict:
        """系统级真实光标拖拽。overrun>0 = 冲过终点不回拉（滑块验证专用）。"""
        import os_driver

        return os_driver.os_drag(
            self.bridge, int(tab_id), from_spec, to_spec, frame=frame, overrun=overrun
        )

    def type_os(self, tab_id: int, selector: str, text: str, *, frame=None, clear: bool = True,
                press_enter: bool = False, delay_ms: int = 0, focus: str = "auto") -> dict:
        """
        系统级真实键盘输入（真 keydown/keyup，风控看不出是机器）。

        focus="bridge" 时改用应用层点击聚焦 —— 淘宝/千牛登录框上系统级鼠标会跑偏，
        在那里必须用这个（详见 os_driver.os_type 的说明）。
        """
        import os_driver

        return os_driver.os_type(
            self.bridge,
            int(tab_id),
            selector,
            text,
            frame=frame,
            clear=clear,
            press_enter=press_enter,
            delay_ms=delay_ms,
            focus=focus,
        )

    def click_os(self, tab_id: int, target: str, *, frame=None) -> dict:
        import os_driver

        return os_driver.os_click(self.bridge, int(tab_id), target, frame=frame)
