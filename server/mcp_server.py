#!/usr/bin/env python3
"""
Browser Bridge · MCP 服务

【这是什么】
    暴露出 23 个 browser_* 工具，让支持 MCP 的 agent（WorkBuddy / Claude 等）
    能直接用自然语言操控你「已登录的 Chrome」——点击、输入、拖拽、截图、
    监听接口、读取 Cookie。

【它和插件怎么配合】
    本进程 ──WebSocket(127.0.0.1:8765)──▶ Chrome 插件 ──▶ 你已登录的页面
    agent  ──MCP(stdio)──▶ 本进程

【为什么工具返回的是 JSON 字符串而不是结构化对象】
    MCP 的 tool 返回值最终要走文本通道，统一返回 JSON 字符串能让 agent
    稳定地按字段取值；同时我们可以在字符串里附带"下一步该干什么"的提示
    （比如截图工具返回文件路径而非 base64），这比结构化返回值实用得多。

【日志必须走 stderr】
    stdio 传输模式下，stdout 是给 MCP 协议用的。
    任何一句 print() 都会污染协议流、导致客户端解析失败。
    所以本文件全局禁止 print，日志一律 logging → stderr。

【启动方式】
    python mcp_server.py                 # 标准：stdio MCP + WS 服务（agent 拉起）
    python mcp_server.py --ws-only       # 只跑 WS，用于手工排障
    python mcp_server.py --http          # WS + Streamable HTTP MCP（准备部署到服务器时用）
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import functools
import json
import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

# ───────────────────────── 路径与日志 ─────────────────────────

BASE_DIR = Path(__file__).resolve().parent
SHOTS_DIR = BASE_DIR / "shots"

# ── pythonw.exe 兼容（别删，删了服务就起不来）──
# 用 pythonw.exe 启动（无控制台、可做开机自启）时，sys.stdout 与 sys.stderr
# 都是 None。而下面的 logging.basicConfig 是 stream=sys.stderr，
# StreamHandler 在 emit 时会调 None.write()，抛 AttributeError ——
# 进程在 bind 端口之前就退出了。
#
# 症状（真机上踩过）：双击启动器后毫无反应、8765/8766 一直是空的、
# 也没有任何报错提示（因为本来就没有窗口能显示它），极难排查。
#
# 所以这里先把 None 的那条流接到 <server>/service.log：
# 既救活进程，又给无窗口运行留下可查的日志。
if sys.stdout is None or sys.stderr is None:
    try:
        _fallback_stream = open(BASE_DIR / "service.log", "a", encoding="utf-8", buffering=1)
    except Exception:
        _fallback_stream = open(os.devnull, "w", encoding="utf-8")
    if sys.stdout is None:
        sys.stdout = _fallback_stream
    if sys.stderr is None:
        sys.stderr = _fallback_stream

logging.basicConfig(
    stream=sys.stderr,  # 关键：绝不能写 stdout，那是 MCP 协议通道
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("bb.mcp")

sys.path.insert(0, str(BASE_DIR))
from bridge import BridgeError, BrowserBridge  # noqa: E402
import elements  # noqa: E402  元素库：把定位过的元素按站点落盘，下次按名字直接用

# 系统级（SendInput）输入：第三档真实度。
# 为什么它必须待在服务端而不是扩展里：扩展拿不到 Win32 API，
# 而服务端跟 Chrome 跑在同一台 Windows 上，是最自然的位置。
try:
    import os_driver  # noqa: E402
    import osinput  # noqa: E402
except Exception as _e:  # pragma: no cover - 非 Windows 或缺依赖时降级，不影响其它工具
    os_driver = None  # type: ignore
    osinput = None  # type: ignore
    log.warning("系统级输入不可用（method=\"os\" 会报错）：%s", _e)

DEFAULT_CONFIG = {
    "host": "127.0.0.1",
    "port": 8765,
    "token": "",
    "heartbeat_seconds": 20,
    "call_timeout_seconds": 60,
    "max_message_mb": 64,
    "screenshot_dir": "shots",
    "log_level": "INFO",
}

CONFIG: dict = dict(DEFAULT_CONFIG)
BRIDGE: Optional[BrowserBridge] = None


def _load_config(path: Optional[str]) -> dict:
    cfg = dict(DEFAULT_CONFIG)
    target = Path(path) if path else (BASE_DIR / "config.json")
    if target.exists():
        try:
            cfg.update(json.loads(target.read_text(encoding="utf-8")))
            log.info("已加载配置：%s", target)
        except Exception as e:
            log.warning("配置文件解析失败（改用默认值）：%s", e)
    else:
        log.info("未找到 config.json，使用默认配置（仅监听 127.0.0.1）")
    return cfg


# ───────────────────────── 小工具 ─────────────────────────

def dump(obj: Any) -> str:
    return json.dumps(obj, ensure_ascii=False, default=str)


def parse_point(spec: Any) -> Any:
    """
    拖拽端点解析：既接受 "https://..." 这样的定位表达式，也接受 "120,340" 这样的坐标。
    之所以用字符串而不是两个 number 参数，是因为调用方常常只知道其中一个。

    v1.3.3 起支持**相对位移**：以 "+" 开头的写法表示"从起点再走多远"，例如：
        "+349,0"    向右 349
        "+0,-40"    向上 40
        "+-120,0"   向左 120（先剥掉开头的 +，后面照常解析负数）
    这条语法的价值不是省事，而是**让工具去算起点**：手工叠加跨帧偏移曾经算错 21px，
    症状伪装成"验证失败"（2026-10-15 的滑块事故），查了很久。
    """
    if spec is None:
        return None
    if isinstance(spec, dict):
        return spec
    s = str(spec).strip()
    if s.startswith("+"):
        body = [p.strip() for p in s[1:].split(",")]
        if len(body) == 2:
            try:
                return {"dx": float(body[0]), "dy": float(body[1])}
            except ValueError:
                pass
    if "," in s:
        parts = [p.strip() for p in s.split(",")]
        if len(parts) == 2:
            try:
                return {"x": float(parts[0]), "y": float(parts[1])}
            except ValueError:
                pass
    return s


def _as_descriptor(spec: str) -> Any:
    """
    定位参数解析：以 { 开头就当「元素描述符」JSON，否则当普通定位表达式。

    为什么要做成一个参数而不是两个：agent 手里有时候是拾取来的描述符，
    有时候是人写的一句 text=提交按钮。让它自己判断用哪个参数，不如让字符串内容说了算
    —— 少一个参数就少一类误用。
    """
    s = (spec or "").strip()
    if not s.startswith("{"):
        return s
    try:
        return json.loads(s)
    except Exception as e:
        raise ValueError(
            "描述符不是合法 JSON：%s\n"
            "（描述符形如 {\"attrs\":[{\"k\":\"text\",\"v\":\"登录\",\"m\":\"eq\"}]}；"
            "如果你本来就想传选择器，去掉开头的 { 即可）" % e
        )


def save_screenshot(b64: str, mime: str, save_dir: Optional[str]) -> Path:
    ext = ".jpg" if "jpeg" in (mime or "") else ".png"
    d = Path(save_dir) if save_dir else (BASE_DIR / CONFIG.get("screenshot_dir", "shots"))
    d.mkdir(parents=True, exist_ok=True)
    name = "shot_" + datetime.now().strftime("%Y%m%d_%H%M%S_%f")[:-3] + ext
    p = d / name
    p.write_bytes(base64.b64decode(b64))
    return p.resolve()


async def call(cmd: str, args: Optional[dict] = None, timeout: Optional[float] = None) -> Any:
    """把阻塞的跨线程调用挪到线程池，避免堵住 MCP 的事件循环。"""
    assert BRIDGE is not None
    return await asyncio.to_thread(BRIDGE.call_data, cmd, args, timeout)


async def _resolve_tab(tab_id: Optional[int]) -> int:
    """
    把 tab_id 定死成一个具体值。

    系统级输入的流程要跨好几个调用（激活标签页 → 取页面信息 → 解析坐标 → 输入 → 回读），
    中间任何一步如果都用「None = 当前活动标签页」，用户一换标签就会整体漂到别的页面上 ——
    输入账号密码这种事漂一次代价太大，所以开头就把它定死。
    """
    if tab_id is not None:
        return int(tab_id)
    tabs = await call("tabs", {})
    for t in (tabs or {}).get("tabs", []):
        if t.get("active"):
            return int(t["tabId"])
    raise BridgeError("没有找到活动标签页，请显式给 tab_id。")


# ───────────────────────── MCP 工具 ─────────────────────────

# ── MCP SDK 版本兼容 ──
# mcp 2.x 把 FastMCP 更名为 MCPServer（路径 mcp.server.mcpserver），
# 1.x 里叫 FastMCP（路径 mcp.server.fastmcp）。两者用法基本一致（tool 装饰器、run(transport=...)），
# 所以这里做一次带兜底的导入，用户装哪个大版本都能跑起来，不需要锁版本。
try:
    from mcp.server.mcpserver import MCPServer as _MCPServer  # mcp >= 2.0

    _SDK_VERSION = "2.x (MCPServer)"
except ImportError:
    try:
        from mcp.server.fastmcp import FastMCP as _MCPServer  # mcp 1.x

        _SDK_VERSION = "1.x (FastMCP)"
    except ImportError:  # pragma: no cover
        log.error(
            "缺少依赖 mcp。请先执行：\n"
            "  python -m venv .venv\n"
            "  .venv\\Scripts\\python.exe -m pip install -r requirements.txt\n"
            "（当前解释器：%s）"
            "若上面的命令装不上，试试换源：-i https://pypi.org/simple/",
            sys.executable,
        )
        raise

log.info("MCP SDK：%s", _SDK_VERSION)
mcp = _MCPServer("browser-bridge", instructions="操控用户本地已登录的 Chrome 浏览器。首次使用请先调 browser_status 确认插件已连接。")


def tool_guard(fn):
    """
    把工具内部的异常转成**可读文本**返回，而不是抛出去。

    【为什么必须这么做】（v1.3.1 实测）
      工具抛异常时，MCP 走 isError 通道，而客户端只显示一句
      "Error executing tool <名字>"，**异常正文被整个丢掉**。
      于是"元素未找到"、"CSP 拒绝动态执行"、"iframe 注入失败"、"标签页不存在"
      这些真正有用的线索一个都看不到 —— 出错时唯一能看到的是那句无信息量的模板话，
      排障等于失明：连是链路问题、页面问题还是参数问题都分不出来。

      改成把异常降级为普通返回值（统一加 ❌ 前缀便于一眼识别），
      agent 拿到的是完整原因而不是"工具坏了"。代价是 isError 标志没了，
      对"由 agent 驱动、要自己判断下一步"的场景，看到原因远比看到标志重要。
    """

    @functools.wraps(fn)
    async def _wrapped(*args, **kwargs):
        try:
            return await fn(*args, **kwargs)
        except Exception as e:  # noqa: BLE001 —— 这里就是要兜住一切，交给 agent 判断
            msg = str(e) or e.__class__.__name__
            log.warning("工具 %s 失败：%s", fn.__name__, msg)
            return "❌ " + fn.__name__ + "：" + msg

    return _wrapped


@mcp.tool()
@tool_guard
async def browser_status() -> str:
    """检查本地服务与浏览器插件的连接状态。任何操作失败时，先调它定位是链路问题还是页面问题。"""
    assert BRIDGE is not None
    st = BRIDGE.status()
    st["commands_hint"] = "如果 extension_connected 为 false，请看返回里的排查步骤。"
    if not st["extension_connected"]:
        st["how_to_fix"] = BRIDGE._not_connected_hint()
    return dump(st)


@mcp.tool()
@tool_guard
async def browser_mode(mode: Optional[str] = None) -> str:
    """查看或切换事件档位。

    - light（默认）：合成 DOM 事件。无提示条、可用 F12，适合绝大多数页面。
    - debugger：走 Chrome 调试协议，事件 isTrusted=true，能过风控校验、
      支持真实拖拽、整页长截图、全量网络抓包。
      代价：浏览器顶部出现「正在调试此浏览器」黄条，且该页 F12 无法同时打开。

    什么时候必须切 debugger：拖拽完全没反应、点击后页面无响应但手动能点、
    需要 isTrusted 的验证码/滑块、需要完整响应体的抓包。
    """
    if mode:
        return dump(await call("mode", {"set": mode}))
    return dump(await call("mode", {}))


@mcp.tool()
@tool_guard
async def browser_tabs() -> str:
    """列出所有打开的标签页（含 tabId / 标题 / URL / 是否活动页）。操作指定页面前先用它拿 tabId。"""
    return dump(await call("tabs"))


@mcp.tool()
@tool_guard
async def browser_goto(url: str, tab_id: Optional[int] = None, new_tab: bool = False, timeout: int = 25) -> str:
    """打开网页。

    不指定 tab_id 且 new_tab=False 时，会在新标签页打开（不打断你正在看的页面）。
    想让已存在的某个标签页跳转，传 tab_id 并保持 new_tab=False。
    """
    return dump(await call("goto", {"url": url, "tabId": tab_id, "newTab": new_tab, "timeout": timeout * 1000}, timeout + 15))


@mcp.tool()
@tool_guard
async def browser_close_tab(tab_id: Optional[int] = None) -> str:
    """关闭标签页。不传 tab_id 则关当前活动页。"""
    return dump(await call("close_tab", {"tabId": tab_id}))


@mcp.tool()
@tool_guard
async def browser_activate_tab(tab_id: int) -> str:
    """把某个标签页切到前台并聚焦窗口。做截图或需要用户看见效果的操作前，通常要先切过去。"""
    return dump(await call("activate_tab", {"tabId": tab_id}))


@mcp.tool()
@tool_guard
async def browser_frames(tab_id: Optional[int] = None, probe: bool = True) -> str:
    """列出页面里所有的 frame（含跨域 iframe），并标注哪些是 iframe、是否跨域。

    什么时候必须用它：元素在页面上**明明看得见，query 却 0 命中**。
    十有八九目标不在主文档，而在 iframe 里 —— 登录表单、报表内容区、
    弹窗壳子、以及国内一大批后台（生意参谋 / 拼多多商家后台）都是这种结构。

    默认 frame="auto"，query/click/type 等会自动去 iframe 里找并返回 frameId；
    已经知道目标在哪一帧时，直接传 frame=<frameId> 可以省掉扫描，也更快。
    """
    return dump(await call("frames", {"tabId": tab_id, "probe": probe}))


@mcp.tool()
@tool_guard
async def browser_page_info(
    tab_id: Optional[int] = None,
    with_text: bool = False,
    max_chars: int = 12000,
    frame: Optional[str] = None,
) -> str:
    """读当前页面概况：URL、标题、页面总尺寸、视口尺寸、滚动位置、是否用了 Shadow DOM。

    with_text=True 时附带页面可见文本，用于判断「我现在走到哪一步了」。
    页面很长时正文消耗上下文很大，只在需要理解内容时才开。

    frame：默认 auto（主文档），写 frame="all" 可以把所有 frame 的概况一次拿全。
    """
    return dump(
        await call(
            "page_info",
            {"tabId": tab_id, "withText": with_text, "maxChars": max_chars, "frame": frame},
        )
    )


@mcp.tool()
@tool_guard
async def browser_find(
    target: str,
    tab_id: Optional[int] = None,
    index: Optional[int] = None,
    frame: Optional[str] = None,
    with_candidates: bool = False,
) -> str:
    """按「元素描述符」查找元素，只报告结果，不做任何点击 —— 先确认，再动手。

    描述符是 browser_pick 产出的东西（多个属性 + 各自权重），比单个选择器抗改版得多：
    站点改版把类名换个哈希、DOM 多包一层，选择器就归零，而描述符只要大部分属性还对得上就还能认出来。

    target 两种形态：
      - 描述符 JSON：{"attrs":[{"k":"text","v":"登录","m":"eq","w":2}, ...]}
      - 普通选择器：#id / //xpath / text=提交订单（此时等价于 browser_query）

    返回值里这几个字段决定了"这次定位可不可信"：
      score        相似度 0~1，越高越像
      runner_up    次高分候选的分数
      coverage     命中属性的权重占比（低 = 可能是靠单条属性蒙对的）
      misses       没对上的属性清单 —— 定位不准时先看它

    三条接受条件任一不满足就直接报错，不会"凑合返回一个"：
    分数不够 / 与次高分差距 < 0.12（歧义）/ 权重覆盖不足。
    宁可失败也不猜 —— 猜错就是点到删除、提交、付款上。

    index：显式指定第几个候选（人工消歧，跳过歧义检查）。
    with_candidates=True：把前几名候选一并返回，排查"为什么是它"时用。
    """
    return dump(
        await call(
            "find",
            {
                "descriptor": _as_descriptor(target),
                "tabId": tab_id,
                "index": index,
                "frame": frame,
                "withCandidates": with_candidates,
            },
        )
    )


@mcp.tool()
@tool_guard
async def browser_ax(
    action: str = "tree",
    role: Optional[str] = None,
    name: Optional[str] = None,
    name_contains: Optional[str] = None,
    value: Optional[str] = None,
    tab_id: Optional[int] = None,
    index: Optional[int] = None,
    limit: int = 10,
    with_generic: bool = False,
) -> str:
    """按「无障碍语义树」定位控件 —— 比选择器抗改版一个数量级，找不到元素时的第二把刀。

    【和 browser_query / browser_find 的区别】
      browser_query   绑 DOM 结构：#app > div > form > input:nth-child(2)
      browser_find    绑属性集合：多属性加权打分，抗改版但仍是 DOM 视角
      **browser_ax**  绑语义：role=textbox + name=账号

    前端把 DOM 重写一遍、类名加个哈希、多包一层 div —— 前两者都可能归零，
    但"这是个输入框、它叫账号"不会变。浏览器自己就维护着这层语义（屏幕阅读器读的就是它）。

    【怎么用它】
      1. 先 action="tree" 看看页面上有什么（返回精简后的 role + name 清单）
      2. 找到目标后用 action="query" 确认（返回节点 + 屏幕坐标，多个命中会明确提示歧义）
      3. 再 action="click" 按同一组条件点下去（走 CDP 真实鼠标事件）

    【参数】
      role           语义角色：button / textbox / checkbox / link / combobox / menuitem ...
      name           精确匹配可访问名称（按钮上的字、输入框的 label）
      name_contains  名称包含（记不全时用这个）
      value          按当前值匹配（输入框里已有的内容）
      limit          最多返回几个（默认 10）
      with_generic   True = 连无信息量的容器节点也返回（排查"为什么没有"时用）

    【注意】
      - 调用会临时附着一个调试会话；轻量档下用完自动释放，不会在浏览器顶部留黄条。
      - action="click" 命中多个且没给 index 时会**拒绝执行**并列出候选 —— 点错比点不动严重。
      - 目标在 iframe 里时点击会明确报错（跨帧坐标要走 browser_click 的元素路径），
        但 tree / query 仍能看到 iframe 内的节点（节点带 frameId）。
    """
    payload: dict = {"action": action, "tabId": tab_id, "limit": limit}
    if role is not None:
        payload["role"] = role
    if name is not None:
        payload["name"] = name
    if name_contains is not None:
        payload["nameContains"] = name_contains
    if value is not None:
        payload["value"] = value
    if index is not None:
        payload["index"] = index
    if with_generic:
        payload["withGeneric"] = True

    if action == "click":
        # 点击要过 CDP 真实事件，比查询慢不少
        return dump(await call("ax", payload, 60))

    return dump(await call("ax", payload, 40))


@mcp.tool()
@tool_guard
async def browser_picks(action: str = "list", name: str = "") -> str:
    """取回「人自己拾取」的元素描述符 —— 不需要 agent 在场的那一半能力。

    【它和 browser_pick 的分工】
      browser_pick   = agent 现在就要一个元素，于是挂起一次调用等人在页面上点一下；
      browser_picks  = 人自己按 **Alt+Shift+A** 已经在页面上攒好了一批，agent 随时来取。

    第二条才是「人先示教、agent 后执行」该有的样子：人浏览页面时顺手把要操作的
    元素挨个点出来（**按住 Ctrl + 左键**，可连续点多个，Esc 结束），过一会儿再让 agent 干活 ——
    不必让一次调用一直占着等人点。

    参数：
      action = "list"   取回全部（默认）。每条含 name / summary / url / title / descriptor / quality / frameUrl
      action = "get"    只取名字等于 name 的那一条；名字模糊时按"包含"匹配，取第一条
      action = "drop"   删除名字等于 name 的那一条，返回剩下几条
      action = "clear"  清空，返回清掉了几条

    取到的 descriptor 直接传给 browser_find / browser_click 的 target 参数即可
    （以 { 开头的字符串会被自动识别为描述符）。

    【存下来，别每次都来捞】
      这批元素如果以后还要反复用 → browser_elements(action="import_picks") 一次性把它们
      收进「按站点归档的元素库」（server/elements/<域名>.json，是项目文件、不会因为清浏览器
      数据而丢）。之后直接 browser_elements(action="get", name=...) 按名字取，不必再拾取。
    """
    return dump(await call("picks", {"action": action, "name": name}))


async def _site_for(site: str, tab_id: Optional[int]) -> str:
    """
    定「这条元素属于哪个站点」。

    显式给了 site 就用它；否则去取当前标签页 URL 的域名 —— 不这么兜底的话，
    每次存元素都得让 agent 手抄一遍域名，抄错一个字符就归到别的站里去了。
    """
    s = (site or "").strip()
    if s:
        return elements.host_of(s) if "://" in s else s.lower()
    tid = await _resolve_tab(tab_id)
    tabs = await call("tabs", {})
    for t in (tabs or {}).get("tabs", []):
        if int(t.get("tabId") or -1) == int(tid):
            host = elements.host_of(t.get("url") or "")
            if host == elements.UNKNOWN_HOST:
                raise BridgeError(
                    "当前标签页（%s）没有可取域名的 URL，无法归档。"
                    "可以显式传 site=\"sycm.taobao.com\"。" % (t.get("url") or "未知")
                )
            return host
    raise BridgeError("找不到 tabId=%s 的标签页。" % tid)


async def _tab_url(tab_id: int) -> str:
    try:
        tabs = await call("tabs", {})
        for t in (tabs or {}).get("tabs", []):
            if int(t.get("tabId") or -1) == int(tab_id):
                return t.get("url") or ""
    except Exception:
        pass
    return ""


@mcp.tool()
@tool_guard
async def browser_elements(
    action: str = "list",
    name: str = "",
    target: str = "",
    site: str = "",
    tab_id: Optional[int] = None,
    frame: Optional[str] = None,
    note: str = "",
) -> str:
    """元素库 —— 把定位过的元素按站点存下来，以后**按名字取用，不必每次重新识别**。

    【它解决的问题】
      在此之前元素只能"每次现识别"：每开一步都重新 browser_find 扫一遍页面，或者每次去
      browser_picks 里捞一遍。人拾取的结果虽然存在浏览器里（bb_picks），但那是暂存不是资产 ——
      清一次扩展数据、换一个会话就没了，也没按站点归档。
      落盘之后：示教一次 → 永久可用。

    【action】
      list          列出本体（默认）。不传 site = 列出所有站点汇总；传了 site = 列该站点的元素
      get           按 name 取一条，返回可用的 descriptor（支持名字"包含"匹配）
      save          存一条。target 可以是
                      · 描述符 JSON（"{"开头 —— browser_picks / browser_find 给的）
                      · 一个选择器 —— 服务端会让页面把它**升级成描述符**再存（更抗改版）
      locate        按 name 取出来并**当场定位一次**，直接返回坐标/匹配质量（省一步）
      drop          按 name 删除
      import_picks  把扩展里"人自己攒的拾取结果"一次性收进元素库（按各自站点归档）

    【怎么用才顺】
      1. 第一次：browser_query 找到选择器 → browser_elements(action="save", name="登录按钮",
         target="#login-btn")（或人拾取后 import_picks）
      2. 以后每次：browser_elements(action="get", name="登录按钮") → 拿 descriptor →
         browser_click(selector=<descriptor>)
      3. 改版后定位飘了：重新 save 一次同名即可（同名覆盖）

    存的是描述符（多属性加权打分）而不是单条选择器 —— 后者站点一改版就归零。
    """
    act = (action or "list").strip().lower()

    if act == "list":
        if (site or "").strip():
            return dump(elements.list_items(elements.host_of(site) if "://" in site else site.strip().lower()))
        return dump(elements.list_sites())

    if act == "get":
        host = await _site_for(site, tab_id)
        return dump(elements.get(host, name))

    if act == "locate":
        host = await _site_for(site, tab_id)
        hit = elements.get(host, name)
        if not hit.get("found"):
            raise BridgeError(
                "元素库里没有「%s」（站点 %s）。已存的有：%s。"
                "先用 action=\"save\" 示教一次，或 action=\"import_picks\" 把人拾取的收进来。"
                % (name, host, hit.get("available") or "（空）")
            )
        item = hit["item"]
        tgt = item.get("descriptor") or item.get("selector")
        tid = await _resolve_tab(tab_id)
        r = await call("find", {"target": tgt, "tabId": tid, "frame": frame}, timeout=25)
        return dump(
            {
                "host": host,
                "name": item.get("name"),
                "fidelity": item.get("fidelity"),
                "located": True,
                "result": r,
                "hint": "定位到了就能直接用 browser_click(selector=<descriptor>) 操作它。",
            }
        )

    if act == "drop":
        host = await _site_for(site, tab_id)
        return dump(elements.drop(host, name))

    if act == "import_picks":
        data = await call("picks", {"action": "list"})
        return dump(elements.import_picks((data or {}).get("items") or []))

    if act == "save":
        if not (name or "").strip():
            raise BridgeError("save 需要 name（以后就按这个名字取）。")
        raw = (target or "").strip()
        if not raw:
            raise BridgeError("save 需要 target：描述符 JSON（\"{\" 开头），或一个选择器。")
        tid = await _resolve_tab(tab_id)
        host = await _site_for(site, tid)

        descriptor, selector, summary, quality = None, "", "", None
        if raw.startswith("{"):
            try:
                parsed = json.loads(raw)
            except Exception as e:
                raise BridgeError("target 看着像描述符 JSON，但解析失败：%s" % e)
            if not isinstance(parsed, dict) or not parsed.get("attrs"):
                raise BridgeError(
                    "描述符 JSON 里没有 attrs。确认它来自 browser_picks / browser_find 吗？"
                    "如果只是想把选择器存下来，直接把选择器当 target 传即可。"
                )
            descriptor = parsed
        else:
            try:
                built = await call("describe", {"target": raw, "tabId": tid, "frame": frame}, timeout=25)
            except Exception as e:
                raise BridgeError(
                    "把选择器升级成描述符失败（%s）。先用 browser_query 确认这个选择器能命中，"
                    "或者直接传 browser_picks 给的描述符 JSON。" % e
                )
            descriptor = (built or {}).get("descriptor") or None
            summary = (built or {}).get("summary") or ""
            quality = (built or {}).get("quality")
            if not descriptor:
                selector = raw  # 拿不到描述符就退回存选择器，好歹能用

        out = elements.put(
            host,
            name,
            descriptor=descriptor,
            selector=selector,
            summary=summary,
            url=await _tab_url(tid),
            quality=quality,
            note=note,
        )
        if quality and not quality.get("unique"):
            out["warning"] = (
                "这条描述符在页面上**不是唯一命中**（候选 %s 个）—— 以后取用可能点到别的元素。"
                "建议先把选择器写得更具体，再 save 一次覆盖。"
                % quality.get("candidateCount")
            )
        return dump(out)

    raise BridgeError(
        "不认识的 action：%s。可用：list / get / locate / save / drop / import_picks。" % action
    )


@mcp.tool()
@tool_guard
async def browser_pick(
    hint: str = "",
    tab_id: Optional[int] = None,
    anchor: str = "semantic",
    multi: bool = False,
    name: str = "",
    timeout: int = 60,
) -> str:
    """让人在页面上「点一下」来指定元素，返回一个可以反复复用的元素描述符。

    【什么时候用它 —— 这是最省事的一条路，别硬撑】
      - agent 自动定位不到：canvas 画出来的控件、随机类名的第三方组件、一天改三版的运营页
      - 说不清是哪个：页面上有五个"确定"，你能看到但描述不出来
      一次人工点击的成本，远低于 agent 试错十次。

    【使用流程（务必按顺序）】
      1. 先 browser_activate_tab 把目标页切到前台（页面不在前台，用户看不到高亮框）
      2. 告诉用户："请**按住 Ctrl 再点左键**点击你要操作的元素"
      3. 调用本工具，用户按住 Ctrl 点一下
      4. 返回描述符（含 summary 人话摘要）+ quality（是否唯一命中）
      5. 把描述符存下来，之后 browser_find / browser_click / browser_type 直接传它

    【参数】
      hint            显示在页面左上角的提示文字（比如"请按住 Ctrl 点击导出按钮"）
      anchor          semantic（默认）会从鼠标位置向上冒泡到按钮/链接这类语义元素 —— 
                      直接点 <span> 生成的描述符下次可能就飘了；
                      raw 则严格选中鼠标正下方的元素
      multi           True = 连续拾取：点多个目标，最后按 Esc 一次性返回全部
      name            给这次拾取一个名字（强烈建议传）。例如 "login-submit" / "export-button"。
                     不传时按"页面标题-序号"自动命名，仅供排查，可读性差。
                     同一标签页浏览器里，同名 + 视口接近会自动覆盖（视为"人又示教了一遍"）。
      timeout         等待用户点击的秒数，超时返回错误并自动收掉页面上的拾取遮罩

    用户在页面上按 Esc 或点右键 = 取消。拾取期间页面不会响应任何点击（事件在捕获阶段被拦下了），
    所以不用担心误触发页面上的按钮。
    """
    data = await call(
        "pick",
        {
            "hint": hint,
            "tabId": tab_id,
            "anchor": anchor,
            "multi": multi,
            "name": name,
            "timeout": timeout,
        },
        timeout + 20,
    )
    if isinstance(data, dict) and not data.get("multi"):
        data["how_to_use"] = (
            "把这串 descriptor 原样存下来，后续调用 browser_find / browser_click 时"
            '把 descriptor 转成 JSON 字符串传给 target 参数（以 { 开头即可被识别为描述符）。'
        )
        q = data.get("quality") or {}
        if not q.get("unique", True):
            data["warning"] = (
                "这个描述符在当前页面上不是唯一命中 —— 页面上还有相似元素。"
                "建议改选一个更独特的元素，或留意定位时可能报歧义。"
            )
    return dump(data)


@mcp.tool()
@tool_guard
async def browser_query(
    selector: str,
    tab_id: Optional[int] = None,
    limit: int = 50,
    frame: Optional[str] = None,
) -> str:
    """查找元素，返回其标签、稳定 CSS 路径、属性、文本、尺寸、是否在视口内。

    selector 支持四种写法：
      #id .btn            普通 CSS 选择器
      //button[1]         XPath
      text=提交订单       按可见文本包含匹配（人话定位，最常用）
      label=用户名        按 <label> 文本找它关联的输入框

    看不到元素时先调它，而不是盲目点击 —— 返回里会告诉你命中几个、长什么样。

    frame（重要）：默认 auto —— 主文档找不到会**自动去 iframe 里找**，
    命中时返回里会带 frameId / frameUrl，告诉你元素实际在哪一帧。
    如果返回 frameNote 提示命中了 iframe，后续操作同一个元素请带上 frame=<frameId>，
    省掉重复扫描。也可以直接给 frame="all" 看每一帧各自的命中数。
    """
    return dump(await call("query", {"target": selector, "tabId": tab_id, "limit": limit, "frame": frame}))


@mcp.tool()
@tool_guard
async def browser_read(
    selector: str,
    kind: str = "text",
    tab_id: Optional[int] = None,
    max_chars: int = 20000,
    frame: Optional[str] = None,
) -> str:
    """读取元素内容。kind 取 text（可见文本）/ html（外层 HTML）/ value（输入框当前值）。

    输入类操作之后一定要用 kind="value" 回读一次确认真的写进去了 ——
    页面可能因为校验规则把值清空了，不核对等于没做。

    frame：默认 auto（自动扫 iframe），也可传具体 frameId。
    """
    if kind == "html":
        return dump(await call("get_html", {"target": selector, "tabId": tab_id, "maxChars": max_chars, "frame": frame}))
    if kind == "value":
        return dump(await call("get_value", {"target": selector, "tabId": tab_id, "frame": frame}))
    return dump(await call("get_text", {"target": selector, "tabId": tab_id, "frame": frame}))


@mcp.tool()
@tool_guard
async def browser_click(
    selector: Optional[str] = None,
    x: Optional[float] = None,
    y: Optional[float] = None,
    tab_id: Optional[int] = None,
    index: int = 0,
    click_count: int = 1,
    frame: Optional[str] = None,
    method: str = "auto",
) -> str:
    """点击元素或坐标。

    优先用 selector（会先自动滚进视口、派发完整鼠标事件序列、并检查是否被遮罩挡住）。
    只有拿不到选择器时（Canvas、地图、图表）才用 x/y 坐标。

    若返回 warning 说「被遮挡」，说明目标中心上盖着别的元素（弹窗、遮罩层），
    这时应该先关掉遮挡物，而不是反复点。

    frame：默认 auto（自动扫 iframe）。若目标是 iframe 内元素、且当前是「增强档」，
    会自动降级为该帧内的合成事件并在返回里说明 —— 因为 CDP 的点按只作用于顶层视口，
    拿帧内坐标硬点会点到别的元素（比点不动更危险）。

    method：auto（默认，CDP/合成）｜ os（Windows 系统级：真的移动系统光标再按下抬起）。
    method="os" 要求浏览器窗口在前台、目标已滚进可视区；坐标换算不可信时**直接拒绝执行**
    （宁可不动，也不点到错误的位置上去）。
    """
    if str(method).lower() in ("os", "native", "win32", "sendinput"):
        if os_driver is None:
            raise BridgeError("系统级输入不可用（服务端不在 Windows 上？）。改用 method=\"auto\"。")
        return dump(
            os_driver.os_click(
                BRIDGE,
                await _resolve_tab(tab_id),
                target=selector,
                x=x,
                y=y,
                frame=frame,
                button="left",
                click_count=click_count,
            )
        )
    args: dict = {"tabId": tab_id, "index": index, "clickCount": click_count, "frame": frame}
    if x is not None and y is not None:
        args["x"] = x
        args["y"] = y
    elif selector:
        args["target"] = selector
    else:
        raise BridgeError("browser_click 需要 selector，或同时提供 x 和 y")
    return dump(await call("click", args))


@mcp.tool()
@tool_guard
async def browser_type(
    selector: str,
    text: str,
    tab_id: Optional[int] = None,
    clear: bool = True,
    press_enter: bool = False,
    delay_ms: int = 0,
    frame: Optional[str] = None,
    method: str = "auto",
    focus: str = "auto",
) -> str:
    """往输入框、文本域或可编辑区域输入文字。

    clear=True 会先清空原内容。press_enter=True 输入后补一个回车。
    delay_ms>0 时逐字符输入（慢但更像真人，对按键频率做校验的站点用得上）。

    返回里的 actual / match 是输入后回读的实际值 ——
    如果 match 为 false，说明页面把你的输入改掉了（常见于校验失败、格式化、受控组件），
    此时不要继续下一步，先看清楚页面上的提示。

    frame：默认 auto。登录表单常被放在跨域 iframe 里，这种情况下必须靠 auto 扫帧。

    method（重要，登录/风控敏感场景必看）：
      auto（默认）—— 增强档走 CDP 真实事件，轻量档走合成事件。绝大多数场景够用。
      os           —— **Windows 系统级输入**：真的移动系统光标点进去、真的发键盘按键。
        【什么时候必须用它】CDP 的 Input.dispatchKeyEvent{type:'char'} 只产生 input、
        **一次 keydown 都不产生** —— 14 个字符 = 14 次 input + 0 次 keydown，
        风控把这两个计数一比就知道是机器（2026-10-15 实测：用 CDP 填淘宝登录框，
        点登录立刻弹 nc 滑块；人手动点输入框 + 浏览器自动填充则一次就过，没有验证码）。
        系统级输入的 keydown/keyup 成对、带真实 VK 与扫描码、节奏按人的习惯铺开。
        【代价】要求浏览器窗口处于前台，而且输入时会**真的动用户的鼠标**；
        输入期间服务端会逐键校验前台窗口，一旦用户切走就立即中止（防止内容打进别的程序）。

    focus（只在 method="os" 时有意义 —— 用哪种方式把光标点进输入框）：
      auto（默认）—— 系统级鼠标点进去（最真实）；坐标不可信时自动退回应用层点击。
      bridge       —— **强制用应用层点击聚焦**。淘宝/千牛登录框上系统级鼠标落点会偏：
                      实测对密码框那一下就偏到了**账号框**，随后的 Ctrl+A + 输入
                      把账号覆盖成了密码串（截图实锤）。这种站点上，正解是
                      "合成点击只负责定焦点（风控并不看它）+ 系统级键盘负责真实输入"。
    """
    if str(method).lower() in ("os", "native", "win32", "sendinput"):
        if os_driver is None:
            raise BridgeError(
                "系统级输入不可用：os_driver/osinput 没能加载（服务端可能不在 Windows 上）。"
                "改用 method=\"auto\"。"
            )
        return dump(
            os_driver.os_type(
                BRIDGE,
                await _resolve_tab(tab_id),
                selector,
                text,
                frame=frame,
                clear=clear,
                press_enter=press_enter,
                delay_ms=delay_ms,
                focus=focus,
            )
        )
    return dump(
        await call(
            "type",
            {
                "target": selector,
                "text": text,
                "tabId": tab_id,
                "clear": clear,
                "pressEnter": press_enter,
                "delayMs": delay_ms,
                "frame": frame,
            },
        )
    )


@mcp.tool()
@tool_guard
async def browser_hover(selector: str, tab_id: Optional[int] = None, frame: Optional[str] = None) -> str:
    """把鼠标移到元素上。用于触发下拉菜单、悬浮提示等只有 mouseover 才渲染的内容。"""
    return dump(await call("hover", {"target": selector, "tabId": tab_id, "frame": frame}))


@mcp.tool()
@tool_guard
async def browser_press(
    key: str, selector: Optional[str] = None, tab_id: Optional[int] = None, frame: Optional[str] = None
) -> str:
    """按一个键。key 可取 Enter / Tab / Escape / Backspace / ArrowDown / ArrowUp / ArrowLeft / ArrowRight。

    常用于：输入后回车提交、Tab 跳到下一个字段、Escape 关掉浮层。
    """
    return dump(await call("press", {"key": key, "target": selector, "tabId": tab_id, "frame": frame}))


@mcp.tool()
@tool_guard
async def browser_scroll(
    dy: Optional[float] = None,
    y: Optional[float] = None,
    selector: Optional[str] = None,
    container: Optional[str] = None,
    tab_id: Optional[int] = None,
    frame: Optional[str] = None,
) -> str:
    """滚动页面。

    dy：相对滚动多少像素（正数向下）。
    y：直接定位到页面绝对纵向位置。
    selector：把某个元素滚到视口中央。
    container：滚动某个内部滚动容器（而不是整个页面）——很多后台的表格是这种结构。
    """
    args: dict = {"tabId": tab_id, "frame": frame}
    if y is not None:
        args["y"] = y
    elif dy is not None:
        args["dy"] = dy
    if selector:
        args["target"] = selector
    if container:
        args["selector"] = container
    return dump(await call("scroll", args))


@mcp.tool()
@tool_guard
async def browser_drag(
    from_target: str,
    to_target: str,
    tab_id: Optional[int] = None,
    mode: str = "pointer",
    steps: int = 24,
    frame: Optional[str] = None,
    method: str = "auto",
    overrun: float = 0,
) -> str:
    """拖拽。

    from_target / to_target 可以是选择器（如 "text=待处理订单"），
    也可以是 "x,y" 形式的视口坐标。

    **相对位移**：to_target 写成 "+349,-20" 表示"从起点再走 349 右、20 上"。
    强烈建议拖滑块这类场景用它 —— 起点交给工具实时解析，能避开"手工叠加 iframe 偏移
    算错几个像素、起点落在元素外面、拖动压根没开始，页面却报验证失败"这种误导性故障。

    mode：
      pointer（默认）—— 派发 pointerdown + 一串 pointermove + pointerup，
                        带缓动与随机抖动，适合自研拖拽、排序列表。
      html5          —— 派发 dragstart/dragover/drop，适合用了 HTML5 拖放 API 的场景。

    method：auto（默认，CDP/合成）｜ os（Windows 系统级：真实光标拖拽）。
    method="os" 的轨迹带变速、弧线、过冲回正和到位停顿，是**真实度最高的一档**；
    但它要求窗口在前台，且两端坐标都必须可信，否则拒绝执行。

    **overrun（CSS 像素，仅 method="os" 有效）** —— 滑块验证专用：
      >0 表示"冲过 to_target 这么多像素再松手，不回拉"，一路撑到组件尽头。
      为什么需要它：阿里 nc / 千牛 / 淘宝登录这类滑块，判据是「滑块是否到达终点区域」，
      拖过头它会把滑块夹在末端、多出来的只是指针在走；而**精确停在终点值上**
      恰恰是最强的机器特征（实测被连续判 error:zAuBTf，撑到尽头则通过）。
      经验值：滑块轨道剩下的全部长度 + 30~80。配合相对位移写成
      to_target="+260,0" + overrun=60 这种组合最稳。

    拖拽是最容易失败的动作。如果目标用了 setPointerCapture，或页面校验事件 isTrusted，
    合成事件一定不生效 —— 直接切 browser_mode("debugger") 再试；
    遇到滑块类人机验证，先看 browser_risk 的建议（默认应该转人工，而不是反复硬撞）。
    """
    if str(method).lower() in ("os", "native", "win32", "sendinput"):
        if os_driver is None:
            raise BridgeError("系统级输入不可用（服务端不在 Windows 上？）。改用 method=\"auto\"。")
        return dump(
            os_driver.os_drag(
                BRIDGE,
                await _resolve_tab(tab_id),
                from_target if isinstance(from_target, str) else parse_point(from_target),
                to_target if isinstance(to_target, str) else parse_point(to_target),
                frame=frame,
                overrun=overrun,
            )
        )

    frm = parse_point(from_target)
    to = parse_point(to_target)

    # 相对终点：先把起点解析成真实坐标，再加上位移 —— 别让调用方自己去加
    if isinstance(to, dict) and "dx" in to:
        if isinstance(frm, dict) and frm.get("x") is not None:
            ax, ay = float(frm["x"]), float(frm["y"])
        else:
            prep = await call("point", {"target": frm, "tabId": tab_id, "frame": frame})
            if prep.get("x") is None or not prep.get("reliable", True):
                raise BridgeError(
                    "to_target 用了相对位移，但起点坐标没能可信地解析出来"
                    "（%s）—— 相对位移的前提是起点可知，这里拒绝猜。"
                    % (prep.get("note") or "未说明")
                )
            ax, ay = float(prep["x"]), float(prep["y"])
        to = {"x": ax + float(to["dx"]), "y": ay + float(to["dy"])}

    return dump(
        await call(
            "drag",
            {
                "from": frm,
                "to": to,
                "tabId": tab_id,
                "mode": mode,
                "steps": steps,
                "frame": frame,
            },
        )
    )


@mcp.tool()
@tool_guard
async def browser_risk(tab_id: Optional[int] = None) -> str:
    """检查当前页面是否踩到了人机验证 / 风控拦截，并给出该怎么处理。

    什么时候该调它：
      · 点了登录/提交之后页面「卡住了」，什么都没发生
      · 出现了拖动条、点选图片、"请完成安全验证"这类东西
      · 某个操作莫名其妙失败、但元素明明看得见

    返回 risk=true 时，**默认做法是请人来做**，不要自己反复试：
    滑块类验证连试两次返回的往往是同一串错误码 —— 那说明是「机器判定」而不是「位置没对准」，
    继续重试有升级为图片点选、甚至给账号打风险标记的可能。
    正确姿势是：把验证框的位置和要做的动作告诉用户，然后轮询本工具等风险帧消失。

    自动化的边界就在这里：遇到必须由人完成的环节，agent 的价值是**准确求助**，不是硬闯。
    """
    if os_driver is None:
        raise BridgeError("browser_risk 需要加载 os_driver（服务端不在 Windows 上？）。")
    return dump(os_driver.risk_scan(BRIDGE, await _resolve_tab(tab_id)))


@mcp.tool()
@tool_guard
async def browser_reload() -> str:
    """热重载服务端的系统级输入模块（osinput / os_driver），让刚改过的代码立即生效。

    为什么需要它：服务端进程由 MCP 客户端拉起，一旦启动就一直跑着 ——
    改了 server/*.py 却不重启，跑的还是旧代码，于是出现"明明改了却没效果"这种
    最难查的错觉（上一轮为此不得不重启整个 WorkBuddy）。

    这里用 importlib.reload 原地重载。之所以能生效：所有调用点都写成
    `osinput.xxx()` / `os_driver.xxx()` 的模块属性访问，reload 是原地更新同一个模块对象，
    所以调用方无需重新绑定。

    ⚠️ 覆盖范围：只重载 osinput.py 与 os_driver.py。
       mcp_server.py 自身的改动（新增工具、改工具签名）仍然必须重启服务。
    """
    if osinput is None or os_driver is None:
        raise BridgeError("系统级输入模块未加载（服务端不在 Windows 上？），无法热重载。")
    import importlib
    import inspect

    reloaded = {}
    for name, mod in (("osinput", osinput), ("os_driver", os_driver)):
        try:
            importlib.reload(mod)
            reloaded[name] = "ok"
        except Exception as e:  # 语法错/依赖缺失都在这里现形，别让它悄悄过去
            reloaded[name] = "失败：%s" % e

    # 光说 "ok" 没用 —— 把函数签名回读出来，能一眼看出新参数（如 overrun）到底在不在
    sig = {}
    try:
        sig["osinput.drag"] = list(inspect.signature(osinput.drag).parameters)
    except Exception as e:
        sig["osinput.drag"] = "读不到：%s" % e
    try:
        sig["os_driver.os_drag"] = list(inspect.signature(os_driver.os_drag).parameters)
    except Exception as e:
        sig["os_driver.os_drag"] = "读不到：%s" % e

    return dump(
        {
            "reloaded": reloaded,
            "signatures": sig,
            "available": bool(osinput.available()) if hasattr(osinput, "available") else None,
            "hint": "签名里能看到 overrun 就说明新代码已生效；mcp_server.py 自身的改动仍需重启服务。",
        }
    )


@mcp.tool()
@tool_guard
async def browser_wait_for(
    selector: str,
    state: str = "visible",
    timeout: int = 15,
    tab_id: Optional[int] = None,
    frame: Optional[str] = None,
) -> str:
    """等元素出现或消失。state 取 visible（默认）/ hidden / attached。

    点击后页面异步渲染，直接查会查不到 —— 先 wait_for 再操作，比盲目 sleep 稳得多。
    """
    return dump(
        await call(
            "wait_for",
            {"target": selector, "state": state, "timeout": timeout * 1000, "tabId": tab_id, "frame": frame},
            timeout + 10,
        )
    )


@mcp.tool()
@tool_guard
async def browser_evaluate(
    expression: str,
    tab_id: Optional[int] = None,
    world: str = "isolated",
    await_promise: bool = True,
    frame: Optional[str] = None,
) -> str:
    """在页面里执行一段 JavaScript 并把结果带回来。逃生舱：DOM 操作覆盖不到的场景靠它。

    expression 是表达式（如 "document.title"、"document.querySelectorAll('.row').length"）
    或一个立即执行的函数调用（如 "(async()=>{ ... })()"）。

    world="isolated"（默认）跑在插件的隔离环境，拿不到页面自身的变量。
    world="main" 跑在页面主世界，能读到 window 上挂的业务对象，但会受页面 CSP 限制。

    frame：默认主文档。**只有明确知道 frameId 时才传数字**（用 browser_frames 拿）——
    在 iframe 里跑任意 JS 属高危操作，不该由"猜"决定跑在哪一帧。

    若报错提到 CSP / unsafe-eval，说明该页禁止动态执行 ——
    切 browser_mode("debugger") 后重试，增强档走调试协议不受页面 CSP 约束。
    """
    return dump(
        await call(
            "evaluate",
            {
                "expression": expression,
                "tabId": tab_id,
                "world": world,
                "awaitPromise": await_promise,
                "frame": frame,
            },
        )
    )


@mcp.tool()
@tool_guard
async def browser_screenshot(
    full_page: bool = True,
    selector: Optional[str] = None,
    tab_id: Optional[int] = None,
    fmt: str = "png",
    save_dir: Optional[str] = None,
) -> str:
    """截图并存成文件，返回文件绝对路径（不是 base64，避免把上下文撑爆）。

    full_page=True 整页长截图；selector 指定则只截那个元素（此时忽略 full_page）。
    fmt 取 png（清晰、体积大）或 jpg（体积小、适合长图）。

    实现路径：
      增强档 → CDP 一次渲染成型，无拼接痕迹、不会重复吸顶元素。
      轻量档 → 逐屏滚动 + 拼接，速度慢且固定定位元素会重复出现。
    要干净的整页图，先 browser_mode("debugger")。
    """
    args: dict = {"fullPage": full_page, "format": "jpeg" if fmt.lower() in ("jpg", "jpeg") else "png", "tabId": tab_id}
    if selector:
        args["target"] = selector
    data = await call("screenshot", args, 240)
    b64 = data.pop("data", None)
    if not b64:
        raise BridgeError("插件未返回图像数据")
    path = save_screenshot(b64, data.get("mime", "image/png"), save_dir)
    data["file"] = str(path)
    data["hint"] = "可直接查看该文件确认执行效果。"
    return dump(data)


@mcp.tool()
@tool_guard
async def browser_cookies(
    url: Optional[str] = None,
    domain: Optional[str] = None,
    name: Optional[str] = None,
    tab_id: Optional[int] = None,
    with_value: bool = True,
) -> str:
    """读取 Cookie（含 HttpOnly —— 这是 JS 拿不到、只有扩展能读的部分）。

    不传 url/domain 时，取当前活动标签页所属站点的 Cookie。
    返回值里的 header 字段是现成的请求头串，可直接用于其它系统的鉴权。

    注意：这是「读取你已登录身份的凭据」，属高敏感操作，只在你自己的机器和授权范围内使用。
    """
    return dump(
        await call(
            "cookies",
            {"url": url, "domain": domain, "name": name, "tabId": tab_id, "withValue": with_value},
        )
    )


@mcp.tool()
@tool_guard
async def browser_set_cookie(
    url: str,
    name: str,
    value: str,
    domain: Optional[str] = None,
    path: str = "/",
    secure: bool = True,
    http_only: bool = False,
) -> str:
    """写入一条 Cookie。"""
    return dump(
        await call(
            "set_cookie",
            {
                "url": url,
                "name": name,
                "value": value,
                "domain": domain,
                "path": path,
                "secure": secure,
                "httpOnly": http_only,
            },
        )
    )


@mcp.tool()
@tool_guard
async def browser_clear_cookies(
    url: Optional[str] = None,
    domain: Optional[str] = None,
    name: Optional[str] = None,
) -> str:
    """删除 Cookie。必须指明 url 或 domain —— 不允许无边界的批量删除。

    注意：清掉登录站点的 Cookie 会让你退出登录，操作前想清楚。
    """
    return dump(await call("clear_cookies", {"url": url, "domain": domain, "name": name}))


@mcp.tool()
@tool_guard
async def browser_network(
    action: str = "list",
    url_contains: Optional[str] = None,
    method: Optional[str] = None,
    status: Optional[int] = None,
    limit: int = 100,
    seq: Optional[int] = None,
    with_body: bool = False,
    tab_id: Optional[int] = None,
) -> str:
    """网络接口监听。action 取：

      start  — 开始记录。轻量档只覆盖页面自身 fetch/XHR；
               增强档同时开启 CDP 全量抓包（含资源加载与响应体）。
      stop   — 停止记录（已抓到的仍在缓冲里，可继续 list）。
      list   — 列出记录。默认已滤掉图片/字体/CSS 等噪音，只留接口类请求。
               可按 url_contains / method / status 过滤。
      body   — 按 seq 取某条记录的完整响应体（list 默认不带正文，避免撑爆上下文）。
      clear  — 清空缓冲。

    典型用法：start → 在页面上触发一次操作 → list 找到目标接口 → body 看返回结构。
    """
    if action == "start":
        return dump(await call("net_start", {"tabId": tab_id}))
    if action == "stop":
        return dump(await call("net_stop", {}))
    if action == "clear":
        return dump(await call("net_clear", {}))
    if action == "body":
        if seq is None:
            raise BridgeError("action=body 需要 seq（从 list 返回里取）")
        return dump(await call("net_body", {"seq": seq}))
    return dump(
        await call(
            "net_list",
            {
                "urlContains": url_contains,
                "method": method,
                "status": status,
                "limit": limit,
                "withBody": with_body,
                "tabId": tab_id,
            },
        )
    )


# ───────────────────────── 入口 ─────────────────────────

def main() -> None:
    global BRIDGE, CONFIG

    parser = argparse.ArgumentParser(description="Browser Bridge MCP 服务")
    parser.add_argument("--config", help="配置文件路径（默认 server/config.json）")
    parser.add_argument("--ws-only", action="store_true", help="只启动 WebSocket 服务，不跑 MCP（手工排障用）")
    parser.add_argument("--http", action="store_true", help="MCP 走 Streamable HTTP（部署到服务器时用）")
    parser.add_argument("--host", help="覆盖监听地址")
    parser.add_argument("--port", type=int, help="覆盖监听端口")
    parser.add_argument("--token", help="覆盖连接 token")
    args = parser.parse_args()

    CONFIG = _load_config(args.config)
    if args.host:
        CONFIG["host"] = args.host
    if args.port:
        CONFIG["port"] = args.port
    if args.token is not None:
        CONFIG["token"] = args.token

    logging.getLogger().setLevel(str(CONFIG.get("log_level", "INFO")).upper())

    try:
        BRIDGE = BrowserBridge(
            host=CONFIG["host"],
            port=int(CONFIG["port"]),
            token=str(CONFIG.get("token") or ""),
            heartbeat_seconds=int(CONFIG.get("heartbeat_seconds", 20)),
            call_timeout=int(CONFIG.get("call_timeout_seconds", 60)),
            max_message_mb=int(CONFIG.get("max_message_mb", 64)),
        )
        BRIDGE.start()
    except BridgeError as e:
        log.error("%s", e)
        sys.exit(2)

    log.info("Browser Bridge 已就绪。等待 Chrome 插件连接……")

    if args.ws_only:
        log.info("--ws-only：只跑 WebSocket 服务，按 Ctrl+C 退出。")
        try:
            while True:
                import time

                time.sleep(1)
        except KeyboardInterrupt:
            log.info("已退出")
        return

    try:
        if args.http:
            # 部署到服务器 / 多会话共享时走这条：MCP 也可被其他 agent 通过 HTTP 访问。
            # 再次强调：此时务必同时配好 token 与 TLS 反代，否则等于开放你的浏览器。
            host = str(CONFIG.get("http_host") or "127.0.0.1")
            port = int(CONFIG.get("http_port") or 8766)
            log.warning("以 Streamable HTTP 方式启动 MCP：http://%s:%d/mcp", host, port)

            # ⚠️ 这里有个踩过的坑，别再改回去：
            #   mcp 2.x 的 MCPServer **没有 settings 属性**，端口只能通过 run() 的
            #   kwargs 往下传给 run_streamable_http_async()。旧代码写的是
            #       try: mcp.settings.host = host; mcp.settings.port = port
            #       except Exception: pass
            #   异常被静默吞掉 —— 配置里写 8766，服务却起在 SDK 默认的 8000 上，
            #   表现为"端口明明配了却没监听"，极难排查。
            #   1.x 的 FastMCP 才用 settings，所以按 SDK 大版本分支。
            if _SDK_VERSION.startswith("2."):
                mcp.run(transport="streamable-http", host=host, port=port)
            else:
                mcp.settings.host = host
                mcp.settings.port = port
                mcp.run(transport="streamable-http")
        else:
            mcp.run()
    except KeyboardInterrupt:
        log.info("已退出")
    except TypeError:
        # 老版本 mcp SDK 不支持 transport 参数
        log.error("当前 mcp 版本不支持 streamable-http，请升级：pip install -U mcp")
        sys.exit(3)
    finally:
        if BRIDGE:
            BRIDGE.stop()


if __name__ == "__main__":
    main()
