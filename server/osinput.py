# -*- coding: utf-8 -*-
"""
Win32 系统级输入（SendInput）—— 真实度最高的「第三档」。

【为什么需要这一档】（2026-10-15 真机实测的教训）
    用 CDP 的 Input.dispatchKeyEvent 输入账号密码，淘宝当场弹了 nc 滑块；
    而老大自己在同一个输入框里用鼠标点一下、让浏览器自动填充保存的密码，
    **一次就过了、没有验证码**。差别的根子不在"点了哪里"，而在**输入是怎么产生的**：

        CDP  `Input.dispatchKeyEvent {type:'char'}`  —— 只产生一次 input，**完全没有 keydown/keyup**。
        14 个字符 = 14 次 input + 0 次 keydown。风控只要把这两个计数一比，机器特征就露了。

    SendInput 走的是 Windows 硬件输入栈：事件由系统注入到前台窗口，
    浏览器看到的是"真的有键盘在敲"，keydown/keyup 成对、带真实 VK 与扫描码、
    时序由我们自己按人的节奏铺开。这是 CDP 层面做不到的。

【三档真实度，各管一段】
    ① 合成 DOM 事件   isTrusted=false   —— 轻量档，够用且快
    ② CDP Input.*     isTrusted=true    —— 增强档，但缺 keydown、按字符粒度不真
    ③ Win32 SendInput 系统级            —— 本模块；需要窗口在前台，会真的动鼠标

【安全红线】
    SendInput 的按键投给的是**当前前台窗口**。如果发密码的当口用户切走了窗口，
    密码就会被打进别的程序里。所以本模块所有键盘操作都必须带 `guard` 回调，
    逐键校验前台窗口仍是目标窗口，一旦不对立刻中止 —— 宁可不输入，也不能输错地方。
"""
from __future__ import annotations

import ctypes
import math
import random
import sys
import time
from ctypes import wintypes

IS_WINDOWS = sys.platform == "win32"


class OsInputError(RuntimeError):
    """系统级输入失败。消息会一路透到 agent，所以写清楚"为什么"和"怎么办"。"""


# ───────────────────────── Win32 结构与常量 ─────────────────────────

if IS_WINDOWS:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    imm32 = ctypes.WinDLL("imm32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    # 【必须显式声明返回类型】ctypes 默认把返回值当 32 位 int，
    # 而句柄在 x64 上是 64 位 —— 不声明就会被**高位截断**，
    # 于是 ImmGetContext 拿回来的 HIMC 是个残废指针，ImmSetOpenStatus 静默不生效。
    # 这类"返回值位宽"的坑 ctypes 不会报错，只会让功能悄悄失灵。
    user32.VkKeyScanW.restype = ctypes.c_short
    user32.VkKeyScanW.argtypes = [ctypes.c_wchar]
    user32.MapVirtualKeyW.restype = wintypes.UINT
    user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
    user32.GetForegroundWindow.restype = wintypes.HWND
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.c_void_p]
    user32.AttachThreadInput.argtypes = [wintypes.DWORD, wintypes.DWORD, wintypes.BOOL]
    user32.keybd_event.restype = None
    user32.keybd_event.argtypes = [wintypes.BYTE, wintypes.BYTE, wintypes.DWORD, ctypes.c_void_p]
    user32.SetForegroundWindow.restype = wintypes.BOOL
    user32.SetForegroundWindow.argtypes = [wintypes.HWND]
    user32.IsIconic.restype = wintypes.BOOL
    user32.IsIconic.argtypes = [wintypes.HWND]
    user32.ShowWindow.restype = wintypes.BOOL
    user32.ShowWindow.argtypes = [wintypes.HWND, ctypes.c_int]
    kernel32.GetCurrentThreadId.restype = wintypes.DWORD
    kernel32.GetCurrentThreadId.argtypes = []
    imm32.ImmGetContext.restype = wintypes.HANDLE
    imm32.ImmGetContext.argtypes = [wintypes.HWND]
    imm32.ImmSetOpenStatus.restype = wintypes.BOOL
    imm32.ImmSetOpenStatus.argtypes = [wintypes.HANDLE, wintypes.BOOL]
    imm32.ImmGetOpenStatus.restype = wintypes.BOOL
    imm32.ImmGetOpenStatus.argtypes = [wintypes.HANDLE]
    imm32.ImmReleaseContext.restype = wintypes.BOOL
    imm32.ImmReleaseContext.argtypes = [wintypes.HWND, wintypes.HANDLE]
else:  # pragma: no cover - 非 Windows 上只用于导入期不炸
    user32 = None
    imm32 = None
    kernel32 = None

ULONG_PTR = ctypes.c_ulonglong if ctypes.sizeof(ctypes.c_void_p) == 8 else ctypes.c_ulong


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ULONG_PTR),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT), ("ki", KEYBDINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


# INPUT 在 x64 上必须是 40 字节；对不上说明结构体定义错了（SendInput 会直接失败）
INPUT_SIZE = ctypes.sizeof(INPUT)
INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_SCANCODE = 0x0008

MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_ABSOLUTE = 0x8000
MOUSEEVENTF_VIRTUALDESK = 0x4000

SM_XVIRTUALSCREEN = 76
SM_YVIRTUALSCREEN = 77
SM_CXVIRTUALSCREEN = 78
SM_CYVIRTUALSCREEN = 79

SW_RESTORE = 9

VK_SHIFT = 0x10
VK_CONTROL = 0x11
VK_MENU = 0x12  # Alt
VK_LWIN = 0x5B

MAPVK_VK_TO_VSC = 0

# Chrome / Edge 的顶层窗口类名。Chromium 系一律是它。
CHROMIUM_WINDOW_CLASSES = ("Chrome_WidgetWin_1",)

# 具名键 → VK。够用就好，缺的走字符路径。
VK_NAMES = {
    "Enter": 0x0D,
    "Return": 0x0D,
    "Tab": 0x09,
    "Escape": 0x1B,
    "Esc": 0x1B,
    "Backspace": 0x08,
    "Delete": 0x2E,
    "Insert": 0x2D,
    "Home": 0x24,
    "End": 0x23,
    "PageUp": 0x21,
    "PageDown": 0x22,
    "ArrowUp": 0x26,
    "ArrowDown": 0x28,
    "ArrowLeft": 0x25,
    "ArrowRight": 0x27,
    "Space": 0x20,
    " ": 0x20,
    # 修饰键（组合键写法如 "Ctrl+A" 要用到）
    "Ctrl": VK_CONTROL,
    "Control": VK_CONTROL,
    "Shift": VK_SHIFT,
    "Alt": VK_MENU,
    "Win": VK_LWIN,
    "Meta": VK_LWIN,
}

# 需要 KEYEVENTF_EXTENDEDKEY 的键
_EXTENDED_VKS = {0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D}


def available() -> bool:
    return bool(IS_WINDOWS and user32 is not None)


# ───────────────────────── DPI 感知（必须在用坐标之前定下来） ─────────────────────────


def _enable_dpi_awareness() -> str:
    """
    把本进程切成 per-monitor DPI 感知。

    【为什么这一步不能省】（2026-10-15 实测踩到）
      本机是「1920×1080 主屏 + 3840×2160 副屏」，副屏开了 150% 缩放。
      Python 默认是 **DPI 不感知**进程，于是 Windows 会把所有 Win32 几何 API 的返回值
      按 1/1.5 虚拟化一遍：

          SetProcessDPIAware 之前：主屏 1280×720，虚拟桌面 3840×1440 @ (-2560,-87)
          之后                  ：主屏 1920×1080，虚拟桌面 5760×2160 @ (-3840,-130)

      而 SendInput 的绝对坐标**永远按真实物理桌面归一化**（输入是系统层的，不参与虚拟化）。
      两边不在同一个坐标系里 —— 拿虚拟化后的值去算归一化，光标会**整体按 1.5 倍偏移**，
      点哪儿都不对，而且不会报任何错。这种错最难查，所以放在模块导入期一次性切好。
    """
    for name, fn in (
        ("PER_MONITOR_AWARE_V2", lambda: user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4 & 0xFFFFFFFFFFFFFFFF))),
        ("PER_MONITOR_AWARE", lambda: user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-3 & 0xFFFFFFFFFFFFFFFF))),
        ("SYSTEM_AWARE", lambda: user32.SetProcessDPIAware()),
    ):
        try:
            if fn():
                return name
        except Exception:
            continue
    return "unknown"


DPI_AWARENESS = _enable_dpi_awareness() if IS_WINDOWS else "n/a"


def dpi_info() -> dict:
    """当前坐标系自述 —— 出问题时一眼就能看出「是不是虚拟化过了」。"""
    if not available():
        return {"available": False, "platform": sys.platform}
    vx, vy, vw, vh = virtual_screen()
    return {
        "available": True,
        "awareness": DPI_AWARENESS,
        "virtualDesktop": {"x": vx, "y": vy, "width": vw, "height": vh},
        "primaryScreen": {
            "width": int(user32.GetSystemMetrics(0)),
            "height": int(user32.GetSystemMetrics(1)),
        },
        "monitors": int(user32.GetSystemMetrics(80)),
    }


def calibrate(samples: int = 3, tolerance: int = 3) -> dict:
    """
    坐标系自检：用 SendInput 把光标移到算出来的位置，再用 GetCursorPos 读回来比对。

    【为什么值得做】上面那个 DPI 虚拟化的坑，症状是"点偏了"而不是"报错了"。
    这个往返测试能**直接量出偏差**：如果归一化的分母用错了坐标系，
    误差会是个大数（几十上百像素），而不是 0~2 像素的取整误差。

    只发"移动"事件，不点任何东西；测完把光标放回原处，所以是安全的。
    """
    _require()
    start = cursor_pos()
    vx, vy, vw, vh = virtual_screen()
    targets = []
    if samples >= 1:
        targets.append((vx + vw * 0.5, vy + vh * 0.5))
    if samples >= 2:
        targets.append((vx + vw * 0.25, vy + vh * 0.75))
    if samples >= 3:
        targets.append((vx + vw * 0.75, vy + vh * 0.25))

    worst = 0.0
    detail = []
    try:
        for tx, ty in targets:
            ax, ay = _to_absolute(tx, ty)
            _push([_mi(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
            time.sleep(0.06)
            gx, gy = cursor_pos()
            err = max(abs(gx - tx), abs(gy - ty))
            worst = max(worst, err)
            detail.append({"want": [int(tx), int(ty)], "got": [gx, gy], "err": int(err)})
    finally:
        ax, ay = _to_absolute(start[0], start[1])
        _push([_mi(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])

    return {
        "ok": worst <= tolerance,
        "maxErrorPx": int(worst),
        "tolerancePx": tolerance,
        "awareness": DPI_AWARENESS,
        "samples": detail,
        "note": (
            "坐标系一致。"
            if worst <= tolerance
            else "偏差超出取整误差 —— 归一化用的坐标系与 SendInput 的不一致（多半是 DPI 虚拟化），"
            "此时系统级鼠标会点偏，不要继续用。"
        ),
    }


def _require():
    if not available():
        raise OsInputError(
            "系统级输入只在 Windows 上可用（本机是 %s）。"
            "请改用 method=\"auto\"（CDP/合成事件），或把服务端跑在 Windows 上。" % sys.platform
        )


# ───────────────────────── 窗口 ─────────────────────────


def _enum_chromium_windows() -> list:
    """枚举所有可见的 Chromium 系顶层窗口 → [(hwnd, title), ...]"""
    _require()
    out = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _cb(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        buf = ctypes.create_unicode_buffer(512)
        user32.GetClassNameW(hwnd, buf, 512)
        if buf.value not in CHROMIUM_WINDOW_CLASSES:
            return True
        tbuf = ctypes.create_unicode_buffer(1024)
        user32.GetWindowTextW(hwnd, tbuf, 1024)
        if tbuf.value:
            out.append((hwnd, tbuf.value))
        return True

    user32.EnumWindows(_cb, 0)
    return out


def window_title(hwnd: int) -> str:
    _require()
    buf = ctypes.create_unicode_buffer(1024)
    user32.GetWindowTextW(wintypes.HWND(hwnd), buf, 1024)
    return buf.value


def foreground_window() -> int:
    _require()
    return int(user32.GetForegroundWindow())


def is_foreground(hwnd: int) -> bool:
    _require()
    return foreground_window() == int(hwnd)


def find_window(title_hint: str) -> int:
    """
    按标签页标题找它所在的 Chrome 窗口。

    窗口标题的形态是「<标签页标题> - Google Chrome」，而标签页标题本身还可能带
    「- 千牛」这类后缀，所以用**包含**匹配而不是相等。

    匹配到多个时**拒绝猜测**（这是本工程一贯的取舍：宁可报错，也不赌一个）——
    只有在前台那个是候选之一时才取前台那个。
    """
    _require()
    hint = (title_hint or "").strip()
    if not hint:
        raise OsInputError("找窗口需要标签页标题，但拿到的是空的 —— 先调 browser_page_info 取标题。")

    wins = _enum_chromium_windows()
    if not wins:
        raise OsInputError(
            "没有找到任何 Chromium 系窗口（Chrome/Edge）。"
            "如果浏览器是最小化状态，先让它显示出来再试。"
        )

    exact = [w for w in wins if hint in w[1]]
    if not exact:
        # 退一步：拿标题里最长的一截做匹配（有些站点会把标题截断）
        head = hint[:24]
        exact = [w for w in wins if head and head in w[1]]
    if not exact:
        listing = "；".join("%s" % t for _h, t in wins[:6])
        raise OsInputError(
            "找不到标题包含「%s」的浏览器窗口。当前可见窗口有：%s。"
            "（系统级输入要求目标窗口在前台，请先把那个窗口点出来。）" % (hint, listing)
        )

    if len(exact) == 1:
        return exact[0][0]

    fg = foreground_window()
    for hwnd, _t in exact:
        if int(hwnd) == fg:
            return int(hwnd)
    raise OsInputError(
        "有 %d 个窗口的标题都包含「%s」，无法确定是哪一个 —— 拒绝猜。"
        "请把目标窗口点到前台，或先用 browser_activate_tab 激活。" % (len(exact), hint)
    )


def _tap_alt() -> None:
    """
    合成一次 ALT 的按下 + 抬起。

    用途见 focus_window：SetForegroundWindow 有一条硬规则 —— 只有当调用进程
    「当前拥有前台窗口」或「刚刚收到过用户输入」时才生效。本服务是 WorkBuddy
    拉起的后台子进程，两条都不满足；但 ALT 一旦进过输入队列，系统即认为
    「用户刚刚有输入」，前台锁随之解除。必须在 SetForegroundWindow **之前**发。
    """
    try:
        user32.keybd_event(VK_MENU, 0, 0, 0)
        time.sleep(0.03)
        user32.keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.06)
    except Exception:
        pass


def focus_window(hwnd: int) -> bool:
    """把窗口提到前台。SetForegroundWindow 受系统策略限制，所以返回是否真的成功。"""
    _require()
    h = wintypes.HWND(hwnd)
    if user32.IsIconic(h):
        user32.ShowWindow(h, SW_RESTORE)
        time.sleep(0.18)
    if is_foreground(hwnd):
        return True

    # 第一步必须是 ALT trick（见 _tap_alt 的注释）。
    # 2026-10-15 真机实测：裸调 SetForegroundWindow、以及只用 AttachThreadInput，
    # 都失败了（前台稳稳停在 WorkBuddy 上不动）；加上 ALT trick 后一次成功。
    _tap_alt()

    user32.SetForegroundWindow(h)
    time.sleep(0.12)
    if is_foreground(hwnd):
        return True

    # 兜底：AttachThreadInput 把自己的输入队列临时挂到前台线程上
    try:
        fg = user32.GetForegroundWindow()
        fg_tid = user32.GetWindowThreadProcessId(wintypes.HWND(fg), None)
        my_tid = kernel32.GetCurrentThreadId()
        if fg_tid and fg_tid != my_tid:
            user32.AttachThreadInput(my_tid, fg_tid, True)
            user32.SetForegroundWindow(h)
            user32.AttachThreadInput(my_tid, fg_tid, False)
            time.sleep(0.12)
    except Exception:
        pass
    return is_foreground(hwnd)


def client_screen_rect(hwnd: int) -> tuple:
    """
    客户区在屏幕上的物理像素矩形 → (left, top, width, height)。

    为什么是"客户区"而不是"窗口"：客户区已经排除了标题栏和边框，
    离"网页视口"只差顶部那条工具栏 —— 那条可以用视口高度从下往上反推，
    见 os_driver.viewport_screen_origin()。
    """
    _require()
    h = wintypes.HWND(hwnd)
    rc = wintypes.RECT()
    if not user32.GetClientRect(h, ctypes.byref(rc)):
        raise OsInputError("GetClientRect 失败（hwnd=%s）" % hwnd)
    pt = wintypes.POINT(0, 0)
    if not user32.ClientToScreen(h, ctypes.byref(pt)):
        raise OsInputError("ClientToScreen 失败（hwnd=%s）" % hwnd)
    return int(pt.x), int(pt.y), int(rc.right - rc.left), int(rc.bottom - rc.top)


def virtual_screen() -> tuple:
    """虚拟桌面的物理像素矩形（多显示器时是各屏的外接矩形）→ (x, y, w, h)"""
    _require()
    return (
        int(user32.GetSystemMetrics(SM_XVIRTUALSCREEN)),
        int(user32.GetSystemMetrics(SM_YVIRTUALSCREEN)),
        int(user32.GetSystemMetrics(SM_CXVIRTUALSCREEN)),
        int(user32.GetSystemMetrics(SM_CYVIRTUALSCREEN)),
    )


def cursor_pos() -> tuple:
    _require()
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return int(pt.x), int(pt.y)


# ───────────────────────── 底层：SendInput ─────────────────────────


def _push(events: list) -> int:
    _require()
    if not events:
        return 0
    arr = (INPUT * len(events))(*events)
    sent = user32.SendInput(len(events), ctypes.byref(arr), INPUT_SIZE)
    if sent != len(events):
        err = ctypes.get_last_error()
        hint = ""
        if err == 5:
            hint = (
                "（拒绝访问：目标窗口可能以管理员权限运行，而当前服务端没有。"
                "两边权限不一致时 Windows 会拦掉系统级输入。）"
            )
        raise OsInputError("SendInput 只送出了 %d/%d 个事件，错误码 %s%s" % (sent, len(events), err, hint))
    return int(sent)


def _kb(vk: int = 0, scan: int = 0, flags: int = 0) -> INPUT:
    return INPUT(type=INPUT_KEYBOARD, u=_INPUTUNION(ki=KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0, dwExtraInfo=0)))


def _mi(dx: int, dy: int, flags: int, data: int = 0) -> INPUT:
    return INPUT(type=INPUT_MOUSE, u=_INPUTUNION(mi=MOUSEINPUT(dx=dx, dy=dy, mouseData=data, dwFlags=flags, time=0, dwExtraInfo=0)))


def _to_absolute(x: float, y: float) -> tuple:
    """
    屏幕物理像素 → SendInput 的 0..65535 归一化坐标（虚拟桌面空间）。

    注意是 65535 而不是 65536：微软自己的文档和 SendInput 实现都用 65535 做分母，
    多算一格会让落点整体偏移几个像素。
    """
    vx, vy, vw, vh = virtual_screen()
    nx = int(round((float(x) - vx) * 65535.0 / max(1, vw - 1)))
    ny = int(round((float(y) - vy) * 65535.0 / max(1, vh - 1)))
    return max(0, min(65535, nx)), max(0, min(65535, ny))


# ───────────────────────── 键盘 ─────────────────────────


def _char_plan(ch: str) -> list:
    """
    一个字符 → 键盘事件计划。

    分两条路：
      · ASCII 可见字符：走 **真实 VK + 扫描码**（需要 Shift 的如 ':' 会带上 Shift 按下/抬起）。
        这条路产生的事件跟人敲键盘完全一样 —— keydown 带对的 keyCode/code。
      · 其它（中文、全角符号…）：走 **KEYEVENTF_UNICODE**，绕开输入法直接上屏。
    """
    o = ord(ch)
    if o > 0xFFFF:  # 补充平面字符（emoji 等）：拆成 UTF-16 代理对逐个送
        s = ch.encode("utf-16-le")
        cps = [int.from_bytes(s[i : i + 2], "little") for i in range(0, len(s), 2)]
        return [(cp, None) for cp in cps]

    if 0x20 <= o < 0x7F:
        packed = user32.VkKeyScanW(ctypes.c_wchar(ch))
        if packed != -1 and packed != 0xFFFF:
            vk = packed & 0xFF
            shift_state = (packed >> 8) & 0xFF
            return [(vk, shift_state)]
    return [(o, None)]


def _vsc(vk: int) -> int:
    return int(user32.MapVirtualKeyW(vk, MAPVK_VK_TO_VSC)) & 0xFF


def _mod_events(vk: int, down: bool) -> INPUT:
    """按下/抬起一个修饰键（Shift / Ctrl / Alt）。"""
    flags = 0 if down else KEYEVENTF_KEYUP
    if vk in (VK_CONTROL, VK_MENU):
        flags |= KEYEVENTF_EXTENDEDKEY
    return _kb(vk=vk, scan=_vsc(vk), flags=flags)


class _ImeGuard:
    """
    输入法守卫。

    中文 Windows 上输入法常常是开着的，那时我们送出的字母键会先进输入法变成拼音，
    打出来就全是"候选字"而不是原文。所以敲键前把输入法关掉，敲完再恢复原状
    （不改变用户的习惯）。Chrome 走 TSF，`ImmGetContext` 可能拿不到上下文，
    这种情况就退化成"什么都不做"，靠调用方回读校验兜住。
    """

    def __init__(self, hwnd: int):
        self.hwnd = hwnd
        self.himc = 0
        self.restore = None

    def __enter__(self):
        if not self.hwnd:
            return self
        try:
            h = wintypes.HWND(self.hwnd)
            self.himc = int(imm32.ImmGetContext(h) or 0)
            if self.himc:
                self.restore = bool(imm32.ImmGetOpenStatus(wintypes.HANDLE(self.himc)))
                if self.restore:
                    imm32.ImmSetOpenStatus(wintypes.HANDLE(self.himc), False)
        except Exception:
            self.himc = 0
        return self

    def __exit__(self, *exc):
        try:
            if self.himc:
                if self.restore:
                    imm32.ImmSetOpenStatus(wintypes.HANDLE(self.himc), True)
                imm32.ImmReleaseContext(wintypes.HWND(self.hwnd), wintypes.HANDLE(self.himc))
        except Exception:
            pass
        return False


def type_text(
    text: str,
    *,
    hwnd: int = 0,
    base_ms: int = 72,
    jitter_ms: int = 48,
    think_chance: float = 0.06,
    ime_off: bool = True,
    guard=None,
) -> dict:
    """
    逐字符系统级输入。

    `guard` 是个无参回调，每个字符送出前都会调用一次；返回假值就立刻中止。
    os_driver 用它来保证"前台窗口还是那个窗口" —— 这是防密码打错地方的关键。

    节奏不是固定间隔：基础间隔带抖动，另有小概率插入一次"想了一下"的长停顿。
    等距的间隔本身就是脚本特征，所以这里刻意做得不规整。
    """
    _require()
    text = "" if text is None else str(text)
    if not text:
        return {"typed": 0}

    cm = _ImeGuard(hwnd) if (ime_off and hwnd) else None
    if cm is not None:
        cm.__enter__()
    try:
        n = 0
        for i, ch in enumerate(text):
            if guard is not None and not guard():
                raise OsInputError(
                    "输入在送出第 %d/%d 个字符前被中止：目标窗口已经不是前台窗口了。"
                    "为避免把内容打进别的程序，这里直接停下。" % (n, len(text))
                )
            plan = _char_plan(ch)
            evs = []
            for vk_or_cp, shift_state in plan:
                if shift_state is None:
                    # Unicode 直送
                    evs.append(_kb(scan=vk_or_cp, flags=KEYEVENTF_UNICODE))
                    evs.append(_kb(scan=vk_or_cp, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
                else:
                    mods = []
                    if shift_state & 1:
                        mods.append(VK_SHIFT)
                    if shift_state & 2:
                        mods.append(VK_CONTROL)
                    if shift_state & 4:
                        mods.append(VK_MENU)
                    for m in mods:
                        evs.append(_mod_events(m, True))
                    flags = KEYEVENTF_EXTENDEDKEY if vk_or_cp in _EXTENDED_VKS else 0
                    evs.append(_kb(vk=vk_or_cp, scan=_vsc(vk_or_cp), flags=flags))
                    evs.append(_kb(vk=vk_or_cp, scan=_vsc(vk_or_cp), flags=flags | KEYEVENTF_KEYUP))
                    for m in reversed(mods):
                        evs.append(_mod_events(m, False))
            _push(evs)
            n += 1

            if i == len(text) - 1:
                continue
            d = base_ms + random.uniform(-jitter_ms, jitter_ms)
            if random.random() < think_chance:
                d += random.uniform(180, 520)
            time.sleep(max(0.012, d / 1000.0))
        return {"typed": n, "method": "os"}
    finally:
        if cm is not None:
            cm.__exit__(None, None, None)


def press(name: str, *, hwnd: int = 0, guard=None) -> dict:
    """按一个具名键（或一个字符）。"""
    _require()
    if guard is not None and not guard():
        raise OsInputError("按键前目标窗口已不是前台窗口，已中止。")

    key = str(name)
    combo = [p.strip() for p in key.split("+") if p.strip()]
    if len(combo) > 1:  # "Ctrl+A" 这类组合键
        vks = []
        for part in combo:
            vk = VK_NAMES.get(part) or VK_NAMES.get(part.capitalize())
            if vk is None and len(part) == 1:
                vk = (user32.VkKeyScanW(ctypes.c_wchar(part)) & 0xFF)
            if vk is None:
                raise OsInputError("不认识组合键里的「%s」" % part)
            vks.append(int(vk))
        evs = [_mod_events(v, True) for v in vks]
        evs += [_mod_events(v, False) for v in reversed(vks)]
        _push(evs)
        return {"key": key, "method": "os"}

    vk = VK_NAMES.get(key) or VK_NAMES.get(key.capitalize())
    if vk is None and len(key) == 1:
        plan = _char_plan(key)
        v = plan[0][0]
        if plan[0][1] is None:
            _push([_kb(scan=v, flags=KEYEVENTF_UNICODE), _kb(scan=v, flags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)])
            return {"key": key, "method": "os", "via": "unicode"}
        vk = v
    if vk is None:
        raise OsInputError(
            "不认识键名「%s」。支持的具名键：%s；组合键用 + 连接（如 Ctrl+A）。"
            % (key, "、".join(sorted(k for k in VK_NAMES if len(k) > 1)))
        )
    vk = int(vk)
    flags = KEYEVENTF_EXTENDEDKEY if vk in _EXTENDED_VKS else 0
    _push([_kb(vk=vk, scan=_vsc(vk), flags=flags), _kb(vk=vk, scan=_vsc(vk), flags=flags | KEYEVENTF_KEYUP)])
    return {"key": key, "method": "os"}


# ───────────────────────── 鼠标 ─────────────────────────


def move(x: float, y: float, *, steps: int = 0, duration_ms: int = 0, guard=None) -> dict:
    """把**真实光标**移到屏幕物理坐标 (x, y)。中间带抖动与变速，不是直线瞬移。"""
    _require()
    sx, sy = cursor_pos()
    dx, dy = float(x) - sx, float(y) - sy
    dist = math.hypot(dx, dy)
    if steps <= 0:
        steps = max(6, min(60, int(dist / 12) + 6))
    if duration_ms <= 0:
        duration_ms = int(max(160, min(700, dist * 0.9)))

    # 人手不是直线：横向大移动时纵向会画出一条浅弧
    bend = random.uniform(-1, 1) * min(26.0, dist * 0.06)
    for i in range(1, steps + 1):
        if guard is not None and i % 8 == 0 and not guard():
            raise OsInputError("移动鼠标途中目标窗口失去前台，已中止。")
        p = i / steps
        e = p * p * (3 - 2 * p)  # smoothstep：起步慢、中间快、收尾慢
        px = sx + dx * e
        py = sy + dy * e + math.sin(p * math.pi) * bend
        if i != steps:
            px += random.uniform(-0.9, 0.9)
            py += random.uniform(-0.9, 0.9)
        else:
            px, py = float(x), float(y)
        ax, ay = _to_absolute(px, py)
        _push([_mi(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
        time.sleep(max(0.004, (duration_ms / 1000.0) / steps * random.uniform(0.6, 1.5)))
    return {"cursor": [int(x), int(y)], "method": "os", "steps": steps}


def click(
    x: float,
    y: float,
    *,
    button: str = "left",
    click_count: int = 1,
    hold_ms: int = 0,
    guard=None,
) -> dict:
    """真实鼠标点击：移过去 → 迟疑 → 按下 → 停顿 → 抬起。"""
    _require()
    if guard is not None and not guard():
        raise OsInputError("点击前目标窗口已不是前台窗口，已中止（避免点到别的程序上）。")
    move(x, y, guard=guard)
    time.sleep(random.uniform(0.05, 0.16))

    down, up = (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP)
    if button == "right":
        down, up = MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP
    ax, ay = _to_absolute(x, y)
    for _ in range(max(1, int(click_count))):
        _push([_mi(ax, ay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
        _push([_mi(ax, ay, down | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
        time.sleep(max(0.03, (hold_ms or random.uniform(46, 118)) / 1000.0))
        _push([_mi(ax, ay, up | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
        time.sleep(random.uniform(0.04, 0.09))
    return {"at": [int(round(x)), int(round(y))], "method": "os", "button": button}


def drag(
    x1: float,
    y1: float,
    x2: float,
    y2: float,
    *,
    steps: int = 0,
    duration_ms: int = 0,
    guard=None,
    overrun: float = 0.0,
) -> dict:
    """
    真实鼠标拖拽（按 → 变速移动 → 停 → 松）。

    两种收尾风格，由 overrun 切换：

    · overrun == 0（默认）—— **过冲后回正**。人手长距离拖动收尾时容易一冲过头再拉回来。
      适合「要对齐某个位置」的拖拽（自研拖拽、排序列表、拼图缺口）。

    · overrun > 0 —— **一路冲过尽头，不回拉**。到目标之后继续沿同方向压 overrun 像素，
      撞进组件尽头（滑块被夹在末端）再松手。
      适合「拖到最右就算过」的滑块（阿里 nc / 千牛 / 淘宝登录滑块）：这类组件的判据是
      「滑块是否到达终点区域」，拖过头它自己把滑块夹在末端、多出来的部分只是指针在走；
      反倒**精确停在终点值上**成了最强的机器特征 —— 2026-10-15 实测，精确落点被
      连续判 error:zAuBTf，改成一口气撑到尽头就过。
      （这也是用户的直觉：正常人不会小心翼翼对齐终点，是"拉过去不少"然后松手。）
    """
    _require()
    if guard is not None and not guard():
        raise OsInputError("拖拽前目标窗口已不是前台窗口，已中止。")

    move(x1, y1, guard=guard)
    time.sleep(random.uniform(0.09, 0.26))  # 人不会"移到就按"

    ax, ay = _to_absolute(x1, y1)
    _push([_mi(ax, ay, MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
    time.sleep(random.uniform(0.05, 0.14))  # 按下后还要愣一下才发力

    dx, dy = x2 - x1, y2 - y1
    dist = math.hypot(dx, dy)
    try:
        overrun = max(0.0, float(overrun or 0.0))
    except (TypeError, ValueError):
        overrun = 0.0

    # 拖拽方向的单位向量：overrun 要沿"拖的方向"延伸，而不是只往右加
    if dist > 1e-6:
        ux, uy = dx / dist, dy / dist
    else:
        ux, uy = 1.0, 0.0

    if steps <= 0:
        steps = max(20, min(78, int(dist / 6)))
    if duration_ms <= 0:
        duration_ms = int(max(520, min(1250, 520 + dist * 0.55)))

    jitter_amp = max(1.2, min(4.5, dist * 0.013))
    y_off = 0.0

    if overrun > 0:
        # ── 撞尽头式：一路上冲到「目标 + overrun」，到点就停，绝不回拉 ──
        #    轨迹用 q**k（k<1，前快后慢）而不是 smoothstep —— 人手是"发力推到底"，
        #    不是"算好距离再优雅减速"。接近尽头时反而更有劲，撞上去才停。
        wall_x = x2 + ux * overrun
        wall_y = y2 + uy * overrun
        end_x = wall_x
        end_y = wall_y
        peak_x, peak_y = wall_x, wall_y
        back_at = 1.0          # 没有回拉段
        shape = random.uniform(0.62, 0.80)
        bend = 0.0             # 撞尽头就别画弧线了，直着怼
    else:
        # ── 过冲回正式（人手）：冲过头 → 回拉到「略超目标」的位置停下 ──
        overshoot = max(6.0, min(28.0, dist * 0.055)) * random.uniform(0.6, 1.5)
        peak_x = x2 + ux * overshoot
        peak_y = y2 + uy * overshoot
        back = overshoot * random.uniform(0.15, 0.55)
        end_x = x2 + ux * back
        end_y = y2 + uy * back
        back_at = random.uniform(0.78, 0.88)  # 开始回拉的进度点
        shape = 0.0
        bend = random.uniform(-1, 1) * min(9.0, dist * 0.02)

    for i in range(1, steps + 1):
        if guard is not None and i % 8 == 0 and not guard():
            raise OsInputError("拖拽途中目标窗口失去前台，已中止。")
        p = i / steps

        # 主位移：先冲到峰值（目标+过冲 / 目标+超程），再（可选）回拉到最终落点
        if p < back_at:
            q = p / back_at
            e = (q ** shape) if shape else (q * q * (3 - 2 * q))
            px = x1 + (peak_x - x1) * e
        else:
            q = (p - back_at) / max(1e-6, 1.0 - back_at)
            e = q * q * (3 - 2 * q)
            px = peak_x + (end_x - peak_x) * e

        # 纵向：弧线 + 随机游走抖动（限幅，别飘出元素外面）
        y_off += random.uniform(-1.0, 1.0) * jitter_amp * 0.45
        y_off = max(-jitter_amp * 1.8, min(jitter_amp * 1.8, y_off))
        py = (
            y1
            + (dy * ((px - x1) / dx) if dx else 0.0)
            + math.sin(min(1.0, p) * math.pi) * bend
            + y_off
        )

        if i == steps:
            px, py = float(end_x), float(end_y)
        else:
            px += random.uniform(-0.8, 0.8)
            py += random.uniform(-0.8, 0.8)
        aax, aay = _to_absolute(px, py)
        _push([_mi(aax, aay, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
        time.sleep(max(0.005, (duration_ms / 1000.0) / steps * random.uniform(0.55, 1.55)))

    # 到位停顿：滑块类组件要靠这段停顿把结果算完
    time.sleep(random.uniform(0.16, 0.40))

    if overrun > 0:
        # 撞到尽头之后手上还留着一点余劲，会「再顶一下」（这正是"拉过去不少"的体感）
        push_x = end_x + ux * random.uniform(1.0, 3.5)
        push_y = end_y + uy * random.uniform(1.0, 3.5)
        apx, apy = _to_absolute(push_x, push_y)
        _push([_mi(apx, apy, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
        time.sleep(random.uniform(0.03, 0.10))

    # 松手前最后蹭一下（人手在收尾时总要微调）
    fx = end_x + random.uniform(-1.6, 1.6)
    fy = end_y + random.uniform(-1.6, 1.6)
    afx, afy = _to_absolute(fx, fy)
    _push([_mi(afx, afy, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])
    time.sleep(random.uniform(0.02, 0.06))
    _push([_mi(afx, afy, MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)])

    out = {
        "from": [int(round(x1)), int(round(y1))],
        "to": [int(round(x2)), int(round(y2))],
        "releasedAt": [int(round(fx)), int(round(fy))],
        "steps": steps,
        "method": "os",
        "style": "overrun（冲过尽头，不回拉）" if overrun > 0 else "human（过冲后回正）",
    }
    if overrun > 0:
        out["overrun"] = int(round(overrun))
        out["wallAt"] = [int(round(wall_x)), int(round(wall_y))]
    else:
        out["overshoot"] = int(round(overshoot))
        out["overshotTo"] = [int(round(peak_x)), int(round(peak_y))]
    return out
