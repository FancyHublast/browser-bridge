# -*- coding: utf-8 -*-
"""
把「扩展桥接」和「Win32 系统级输入」缝起来。

分工：
    bridge.py    —— 跟浏览器扩展通信（拿页面信息、算元素坐标、读回结果）
    osinput.py   —— 只管往系统里送真实的鼠标/键盘事件
    本模块       —— 把「顶层视口 CSS 坐标」换算成「屏幕物理像素」，
                    并保证每一次系统级输入都发生在正确的窗口上

【坐标是怎么算出来的，为什么这么算】
    系统级鼠标要的是**屏幕物理像素**，而页面里拿到的是**顶层视口 CSS 像素**。
    中间的换算不是简单地乘 devicePixelRatio —— 还得加上"视口左上角在屏幕上的位置"。
    视口原点用这条路求，比用 window.screenX/outerHeight 稳：

        视口底边 === 客户区底边          （Chrome 的工具栏/标签栏都在视口上方）
        ⟹ 视口顶边(物理) = 客户区顶边 + 客户区高度 − 视口高度 × dpr

    好处是它不依赖"窗口边框有多宽""标题栏多高"这些会因为最大化/缩放而变的量，
    也不依赖 window.outerHeight 那种各家浏览器算法不一致的值。
    （2026-10-15 我是用 window.screenX + 手工累加 iframe 偏移算的，差 21px 把滑块起点
     落到了按钮外面 —— 那次的教训就是"别手工累加，让工具算"。）

【安全护栏】
    系统级输入打到的是**前台窗口**。为此每一次输入前都会校验
    「前台窗口 == 目标窗口」，中途每次检查也照此办理；
    一旦用户切走窗口就立刻中止，宁可这次任务失败，也不能把密码打进别的程序。
"""
from __future__ import annotations

import re

import osinput


class OsDriverError(RuntimeError):
    """系统级输入编排失败。消息会直接透给 agent，所以要写清"下一步怎么办"。"""


# ───────────────────────── 视口 → 屏幕 ─────────────────────────


class Viewport:
    """一个标签页的「坐标换算上下文」—— 拿到它，就等于拿到了屏幕坐标系里的视口。"""

    __slots__ = ("tab_id", "hwnd", "title", "ox", "oy", "dpr", "vw", "vh", "client")

    def __init__(self, tab_id, hwnd, title, ox, oy, dpr, vw, vh, client):
        self.tab_id = tab_id
        self.hwnd = hwnd
        self.title = title
        self.ox = ox
        self.oy = oy
        self.dpr = dpr
        self.vw = vw
        self.vh = vh
        self.client = client

    def to_screen(self, x: float, y: float) -> tuple:
        """顶层视口 CSS 坐标 → 屏幕物理像素。"""
        return (self.ox + float(x) * self.dpr, self.oy + float(y) * self.dpr)

    def in_viewport(self, x: float, y: float) -> bool:
        if x is None or y is None:
            return False
        return -2 <= float(x) <= self.vw + 2 and -2 <= float(y) <= self.vh + 2


def resolve_viewport(bridge, tab_id=None) -> Viewport:
    """
    求出目标标签页对应的窗口 + 视口原点。

    步骤刻意排成"先激活、后取信息"：Chrome 的窗口标题是**活动标签页**的标题，
    目标 tab 不是活动 tab 时按标题根本找不到窗口。
    """
    if not osinput.available():
        raise OsDriverError(
            "系统级输入需要 Windows（当前是 %s），或者把服务端跑在 Windows 上。"
            "也可以改用 method=\"auto\"。" % __import__("sys").platform
        )

    # ① 激活标签页：既让窗口到前台，也让窗口标题变成这个页面的标题
    try:
        bridge.call_data("activate_tab", {"tabId": tab_id}, timeout=12)
    except Exception as e:
        raise OsDriverError("激活标签页失败（tabId=%s）：%s" % (tab_id, e))

    # ② 取该页面的度量（标题、视口尺寸、dpr）
    try:
        info = bridge.call_data("page_info", {"tabId": tab_id}, timeout=20)
    except Exception as e:
        raise OsDriverError("取页面信息失败（tabId=%s）：%s" % (tab_id, e))
    metrics = (info or {}).get("metrics") or {}
    title = metrics.get("title") or ""
    vw = float(metrics.get("viewportWidth") or 0)
    vh = float(metrics.get("viewportHeight") or 0)
    dpr = float(metrics.get("devicePixelRatio") or 1) or 1.0
    if vw <= 1 or vh <= 1:
        raise OsDriverError(
            "页面报告的视口尺寸异常（%s×%s）—— 换算屏幕坐标不可信，已放弃。"
            "确认标签页已加载完成再试。" % (vw, vh)
        )

    # ③ 按标题找窗口
    hwnd = osinput.find_window(title)

    # ④ 提到前台并校验（系统级输入只认前台窗口，这一步不成就不能继续）
    if not osinput.focus_window(hwnd):
        raise OsDriverError(
            "无法把窗口提到前台（标题「%s」）。"
            "系统级输入只能作用于前台窗口，所以这里必须停下 —— "
            "请手动点一下那个浏览器窗口再重试。" % title[:40]
        )

    # ⑤ 客户区 → 视口原点
    left, top, cw, ch = osinput.client_screen_rect(hwnd)
    viewport_h_phys = vh * dpr
    if viewport_h_phys > ch + 2:
        raise OsDriverError(
            "页面报告的视口高度（%.0f 物理像素）比窗口客户区还高（%.0f）—— "
            "换算前提不成立（可能页面缩放/多显示器缩放不一致），已放弃系统级输入。"
            % (viewport_h_phys, ch)
        )
    ox = left + (cw - vw * dpr) / 2.0
    oy = top + ch - viewport_h_phys

    return Viewport(tab_id, hwnd, title, ox, oy, dpr, vw, vh, (left, top, cw, ch))


def _guard(vp: Viewport):
    """输入过程中的前台窗口校验 —— 防止内容被打进别的程序。"""

    def _check():
        return osinput.is_foreground(vp.hwnd)

    return _check


_NUM_PAIR = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$")


def _resolve_point(bridge, tab_id, spec, frame=None, timeout=25) -> dict:
    """
    让扩展把定位表达式解析成顶层视口的 CSS 坐标。

    spec 有三种形态，这里统一收口：
       {"x":..,"y":..}  或  "120,340"   —— 已经是坐标，直接用
       "+349,-20"                       —— 相对位移（由 _resolve_second 处理，不该走到这里）
       其它字符串                        —— 当定位表达式，交给扩展解析
    """
    args = {"tabId": tab_id}
    if isinstance(spec, dict) and spec.get("x") is not None:
        args["x"], args["y"] = spec["x"], spec["y"]
    elif isinstance(spec, str) and _NUM_PAIR.match(spec):
        m = _NUM_PAIR.match(spec)
        args["x"], args["y"] = float(m.group(1)), float(m.group(2))
    else:
        args["target"] = spec
        if frame:
            args["frame"] = frame
    try:
        return bridge.call_data("point", args, timeout=timeout) or {}
    except Exception as e:
        raise OsDriverError("解析元素坐标失败（%s）：%s" % (spec, e))


def _read_value(bridge, tab_id, selector, frame=None) -> str:
    try:
        r = bridge.call_data("get_value", {"target": selector, "tabId": tab_id, "frame": frame}, timeout=20)
        return str((r or {}).get("value") or "")
    except Exception:
        return ""


# ───────────────────────── 三个动作 ─────────────────────────


def os_type(
    bridge,
    tab_id,
    selector,
    text,
    *,
    frame=None,
    clear=True,
    press_enter=False,
    delay_ms=0,
    jitter_ms=45,
    focus="auto",
) -> dict:
    """
    系统级输入文字：真实鼠标点进去 → 真实键盘逐字敲。

    这是三个动作里最要紧的一个。CDP 输入之所以被风控逮到，就是因为
    `Input.dispatchKeyEvent{type:'char'}` **一次 keydown 都不产生**；
    走系统级输入，浏览器看到的是货真价实的按键流。

    focus（聚焦方式）：
      "auto"   默认。坐标可信就用系统级鼠标点进去（最真实），不可信退回应用层点击。
      "bridge" 强制用应用层点击聚焦 —— 2026-10-15 实测：淘宝/千牛登录框上，
               系统级鼠标的落点会系统性偏移，对密码框那一下偏到了**账号框**，
               随后的全选+输入把账号覆盖成了密码串（截图实锤）。
               在这种站点上，"合成点击只用来定位焦点" + "系统级键盘负责真实输入"
               才是既真实又不出错的组合（合成 click 只设焦点，风控并不看它）。
      "mouse"  强制系统级鼠标，即使坐标不可信也点（仅在明确知道坐标没问题时用）。
    """
    vp = resolve_viewport(bridge, tab_id)
    guard = _guard(vp)

    # ① 先点一下目标（真实鼠标），否则键盘没有落点
    #    拿不到坐标就退回应用层点击 —— 有它没它都能跑，只是真实度差一档
    notes = []
    pt = {}
    if focus != "bridge":
        try:
            pt = _resolve_point(bridge, tab_id, selector, frame)
        except OsDriverError as e:
            pt = {}
            notes.append("取坐标失败（%s），聚焦改用了应用层点击。" % e)

    use_mouse = focus == "mouse" or (
        focus == "auto" and pt.get("x") is not None and pt.get("reliable", True)
    )
    if use_mouse:
        sx, sy = vp.to_screen(pt["x"], pt["y"])
        if not vp.in_viewport(pt["x"], pt["y"]):
            notes.append(
                "目标坐标 %s,%s 落在视口之外，可能没滚进可视区 —— 已照常点击，若结果不对请先 browser_scroll。"
                % (round(pt["x"]), round(pt["y"]))
            )
        osinput.click(sx, sy, guard=guard)
        focus_via = "os-mouse"
    else:
        # 换算不可信（或调用方点名要桥接聚焦）时才退回应用层点击
        bridge.call_data("click", {"target": selector, "tabId": tab_id, "frame": frame}, timeout=25)
        focus_via = "bridge-click"
        if focus == "bridge":
            notes.append(
                "按调用方要求用应用层点击聚焦（该系统级鼠标落点会偏移，键盘仍是系统级真实按键）。"
            )
        else:
            notes.append(
                "跨帧坐标换算不可信（%s），聚焦改用了应用层点击；"
                "后面的按键仍然是系统级真实按键。" % (pt.get("note") or "未说明")
            )

    # ② 清空（人也是这么干的：全选再删）
    if clear:
        osinput.press("Ctrl+A", hwnd=vp.hwnd, guard=guard)
        osinput.press("Delete", hwnd=vp.hwnd, guard=guard)

    # ③ 逐字敲
    base = int(delay_ms) if delay_ms else 72
    typed = osinput.type_text(
        text, hwnd=vp.hwnd, base_ms=base, jitter_ms=jitter_ms, guard=guard
    )

    # ④ 回车
    if press_enter:
        osinput.press("Enter", hwnd=vp.hwnd, guard=guard)

    # ⑤ 回读校验 —— 系统级输入最大的不确定性是输入法，只有回读才能确认打进去的是原文
    actual = _read_value(bridge, tab_id, selector, frame)
    match = actual == str(text)

    out = {
        "method": "os",
        "tabId": tab_id,
        "window": {"hwnd": vp.hwnd, "title": vp.title[:60]},
        "viewportOrigin": [round(vp.ox, 1), round(vp.oy, 1)],
        "devicePixelRatio": vp.dpr,
        "focusVia": focus_via,
        "typed": (typed or {}).get("typed"),
        "actual": actual,
        "match": match,
        "trust": "SendInput（系统级真实按键，keydown/keyup 成对）",
    }
    if notes:
        out["notes"] = notes
    if not match:
        out["warning"] = (
            "回读值与期望不一致。系统级输入最可能被两件事干扰："
            "① 输入法处于中文态（会把字母变成候选词）；② 页面自身格式化/截断。"
            "先看页面上的实际内容再决定下一步，不要盲目重试。"
        )
    return out


def os_click(bridge, tab_id, target=None, *, x=None, y=None, frame=None, button="left", click_count=1) -> dict:
    """系统级鼠标点击：真的移动光标过去，真的按下抬起。"""
    vp = resolve_viewport(bridge, tab_id)
    guard = _guard(vp)
    pt = _resolve_point(bridge, tab_id, {"x": x, "y": y} if x is not None else target, frame)
    if pt.get("x") is None:
        raise OsDriverError("拿不到点击坐标：point 没有返回 x/y。")
    if not pt.get("reliable", True):
        raise OsDriverError(
            "目标在 iframe 内且跨帧坐标换算不可信（%s）—— 系统级鼠标必须要有可信的屏幕坐标，"
            "已拒绝执行（点错位置的代价比不点大）。可改用 method=\"auto\"。" % (pt.get("note") or "未说明")
        )
    if not vp.in_viewport(pt["x"], pt["y"]):
        raise OsDriverError(
            "目标坐标 %s,%s 不在视口内，系统级鼠标点不到。先用 browser_scroll 把它滚进可视区。"
            % (round(pt["x"]), round(pt["y"]))
        )
    sx, sy = vp.to_screen(pt["x"], pt["y"])
    r = osinput.click(sx, sy, button=button, click_count=click_count, guard=guard)
    return {
        "method": "os",
        "tabId": tab_id,
        "viewportPoint": [round(pt["x"], 1), round(pt["y"], 1)],
        "screenPoint": [round(sx), round(sy)],
        "frameId": pt.get("frameId") or 0,
        "trust": "SendInput（真实光标 + 真实按键状态）",
        "result": r,
    }


def os_drag(bridge, tab_id, from_spec, to_spec, *, frame=None, overrun=None) -> dict:
    """
    系统级鼠标拖拽。两端都要有可信的顶层坐标。

    overrun（CSS 像素）：>0 表示「冲过终点后继续压这么多像素再松手」，不回拉。
    给「拖到最右就算过」的滑块用（阿里 nc / 千牛 / 淘宝登录滑块）——
    这类组件要的是"撑到尽头"，不是"对齐终点值"。0/None 维持默认的过冲回正。
    """
    vp = resolve_viewport(bridge, tab_id)
    guard = _guard(vp)

    a = _resolve_point(bridge, tab_id, from_spec, frame)
    bx, by, rel, b_ok, b_note = _resolve_second(bridge, tab_id, to_spec, a, frame)
    if a.get("x") is None or bx is None:
        raise OsDriverError("拖拽端点解析失败（from=%s, to=%s）。" % (from_spec, to_spec))
    ends = (("起点", a.get("x"), a.get("y"), a.get("reliable", True), a.get("note")), ("终点", bx, by, b_ok, b_note))
    for name, px, py, ok, note in ends:
        if not ok:
            raise OsDriverError(
                "%s的跨帧坐标换算不可信（%s）—— 系统级拖拽必须要有可信的屏幕坐标，"
                "已拒绝执行（落点错了比不拖更糟）。" % (name, note or "未说明")
            )
        if not vp.in_viewport(px, py):
            raise OsDriverError("%s %s,%s 不在视口内。" % (name, round(px), round(py)))

    sx1, sy1 = vp.to_screen(a["x"], a["y"])
    sx2, sy2 = vp.to_screen(bx, by)
    # overrun 用 CSS 像素表达（agent 思考的单位），落到发送时才换算成屏幕物理像素
    try:
        ovr_css = max(0.0, float(overrun or 0.0))
    except (TypeError, ValueError):
        ovr_css = 0.0
    r = osinput.drag(sx1, sy1, sx2, sy2, guard=guard, overrun=ovr_css * vp.dpr)
    out = {
        "method": "os",
        "tabId": tab_id,
        "viewportFrom": [round(a["x"], 1), round(a["y"], 1)],
        "viewportTo": [round(bx, 1), round(by, 1)],
        "relative": rel,
        "trust": "SendInput（真实光标拖拽，含变速 + 弧线/直冲 + 收尾特征）",
        "result": r,
    }
    if ovr_css > 0:
        out["overrunCss"] = round(ovr_css, 1)
        out["note"] = (
            "撞尽头模式：已冲过目标 %.0f CSS px 才松手（不回拉）。"
            "这类滑块的判据是「到达终点区域」，撑到尽头比精确对齐更稳。" % ovr_css
        )
    return out


def _resolve_second(bridge, tab_id, spec, first, frame):
    """
    解析拖拽的第二端。支持**相对位移**写法 "+349,-20" —— 这是从起点再走多远。

    【为什么要支持它】（2026-10-15 的教训）
      滑块那一次，我是先读 `browser_query` 的元素矩形、再手工叠加 iframe 偏移得出起点，
      结果和工具实时算的偏移差了 21px，起点落到了滑块按钮外面 4px，拖动压根没开始，
      页面却报"验证失败"—— 症状和真因完全对不上。
      相对写法把"从实际起点出发"这件事交给工具算，手工累加就彻底没必要了。
    """
    if isinstance(spec, str):
        s = spec.strip()
        if s.startswith("+"):
            body = s[1:].strip()
            parts = [p.strip() for p in body.split(",")]
            if len(parts) != 2:
                raise OsDriverError("相对位移要写成 \"+dx,dy\"（例如 \"+349,0\"），收到的是「%s」。" % spec)
            try:
                dx, dy = float(parts[0]), float(parts[1])
            except ValueError:
                raise OsDriverError("相对位移里的数字解析不了：「%s」。" % spec)
            if first.get("x") is None:
                raise OsDriverError("用了相对终点 \"%s\"，但起点坐标没解析出来。" % spec)
            return float(first["x"]) + dx, float(first["y"]) + dy, {"dx": dx, "dy": dy}, True, None
    p = _resolve_point(bridge, tab_id, spec, frame)
    return p.get("x"), p.get("y"), None, p.get("reliable", True), p.get("note")


# ───────────────────────── 风控/验证码识别 ─────────────────────────

# 淘宝系风控的特征。命中任意一条就该停下来问人，而不是硬撞。
#
# 边界写法（2026-10-15 收紧过一次）：只在类似「URL 分隔符」的位置认 captcha 这类通用词，
# 这样 https://x/blog/post-about-captcha-design 这种文章 slug 不会被误判；
# 而 /captcha、action=captcha、captcha.taobao.com、/recaptcha/ 仍然照常命中。
# 有意保留一定的宁多勿漏：误报了只是多问人一次，漏报了就会在风控页上无限重试。
_SEP = r"(?:^|[/=?.&_])"
_TAIL = r"(?:[/=?.&_]|$)"
_RISK_PATTERNS = [
    (re.compile(r"_____tmd_____", re.I), "淘宝风控帧（tmd）"),
    (re.compile(r"/punish", re.I), "风控惩罚页（punish）"),
    (re.compile(r"action=captcha", re.I), "验证码拦截（captcha）"),
    (re.compile(r"nocaptcha|nc_1_|nc-container", re.I), "阿里 nc 滑块"),
    (re.compile(r"baxia-dialog", re.I), "baxia 风控弹窗"),
    (re.compile(r"/slide(verify|_)|slide-verify", re.I), "滑动验证"),
    (re.compile(_SEP + r"(?:re|h)?captcha" + _TAIL, re.I), "通用人机验证（captcha）"),
    (re.compile(_SEP + r"geetest", re.I), "极验滑块（geetest）"),
    (re.compile(r"verify\.html", re.I), "通用验证页"),
]


def risk_scan(bridge, tab_id=None) -> dict:
    """
    扫当前标签页的所有 frame，判断是否踩到人机验证/风控页。

    存在的意义是**把"该转人工"这条判断固化成工具**，而不是靠 agent 每次自己想起来：
    人机验证本来就该由人完成，硬撞只会让风控升级（滑块 → 图片点选 → 封号）。
    """
    try:
        f = bridge.call_data("frames", {"tabId": tab_id, "probe": False}, timeout=20) or {}
    except Exception as e:
        raise OsDriverError("列帧失败：%s" % e)

    frames = f.get("frames") or []
    hits = []
    for fr in frames:
        url = str(fr.get("url") or "")
        for pat, label in _RISK_PATTERNS:
            if pat.search(url):
                hits.append(
                    {
                        "frameId": fr.get("frameId"),
                        "url": url[:200],
                        "kind": label,
                        "isTop": fr.get("isTop"),
                    }
                )
                break

    if not hits:
        return {
            "risk": False,
            "tabId": f.get("tabId", tab_id),
            "framesScanned": len(frames),
            "advice": "没看到人机验证特征，可以继续。",
        }

    return {
        "risk": True,
        "tabId": f.get("tabId", tab_id),
        "framesScanned": len(frames),
        "signals": hits,
        "advice": (
            "检测到人机验证/风控页。**默认处理方式是请人来做**，不要让 agent 反复尝试 —— "
            "滑块类验证连试两次返回的往往是同一串错误码，那说明是「机器判定」而不是「位置没对准」，"
            "继续重试有升级为图片点选、甚至给账号打上风险标记的可能。"
        ),
        "howToAskHuman": (
            "告诉用户：验证框出现的位置和要做的动作（拖动滑块到最右 / 点选文字），"
            "然后轮询 browser_risk 或 browser_frames，等风险帧消失即表示人已完成。"
        ),
        "ifUserInsists": (
            "确实要让 agent 试，请按这个顺序来（2026-10-15 实测有效）："
            "① 用 method=\"os\" 的系统级拖拽；"
            "② 起点用 #nc_1_n1z（或风控帧里的滑块元素）、终点用相对位移 \"+N,0\"；"
            "③ **关键是给 overrun（比如 60~120）** —— 这类滑块要的是「撑到尽头」而不是"
            "「精确对齐终点」，精确停在目标值反而是最强的机器特征，实测会被判 error:zAuBTf；"
            "④ 一次不成先等 2~3 秒看是否已通过（通过后风控帧不一定消失，要看滑块条是否消失）；"
            "⑤ 最多两次——两次返回同一串错误码就是「机器判定」，转人工。"
        ),
    }
