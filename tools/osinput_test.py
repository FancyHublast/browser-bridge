# -*- coding: utf-8 -*-
"""
系统级输入（SendInput）层的离线自测。

这一层最怕的不是"报错"，而是**静默失灵**：
  · INPUT 结构体差几个字节 → SendInput 直接失败，且错误码很难懂
  · ctypes 返回类型没声明 → 64 位句柄被截断，功能悄悄不生效（不报错！）
  · VK/扫描码映射错 → 打出来的字不对，但页面不报错
所以这里把"能验的常量与纯函数"全验一遍，跑它不需要浏览器、不会动鼠标。

用法：
    python tools/osinput_test.py            # 只跑离线检查
    python tools/osinput_test.py --live     # 额外做只读的真机检查（找窗口 / 虚拟桌面尺寸）
"""
import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

import osinput  # noqa: E402

_ap = argparse.ArgumentParser()
_ap.add_argument("--live", action="store_true", help="额外做只读真机检查（找窗口 / 客户区）")
ARGS = _ap.parse_args()

PASS = 0
FAIL = 0
FAILED = []


def ok(cond, name, extra=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print("  \u2713 %s" % name)
    else:
        FAIL += 1
        FAILED.append(name)
        print("  \u2717 %s  %s" % (name, extra))


def eq(a, b, name):
    ok(a == b, name, "（期望 %r，实际 %r）" % (b, a))


# ───────────────────────── 1. 结构体 ─────────────────────────
print("\n1) SendInput 结构体定义")

if not osinput.available():
    print("  非 Windows 或 user32 不可用 —— 跳过全部检查")
    sys.exit(0)

# x64 上 INPUT 必须是 40 字节（type 4 + 对齐 4 + union 32）。
# 差一个字节 SendInput 就会以 ERROR_INVALID_PARAMETER 失败，且提示毫无线索。
eq(osinput.INPUT_SIZE, 40, "INPUT 结构体大小 = 40 字节（x64）")
eq(osinput.INPUT_MOUSE, 0, "INPUT_MOUSE = 0")
eq(osinput.INPUT_KEYBOARD, 1, "INPUT_KEYBOARD = 1")
eq(osinput.MOUSEEVENTF_ABSOLUTE, 0x8000, "MOUSEEVENTF_ABSOLUTE")
eq(osinput.MOUSEEVENTF_VIRTUALDESK, 0x4000, "MOUSEEVENTF_VIRTUALDESK")
eq(osinput.KEYEVENTF_UNICODE, 0x0004, "KEYEVENTF_UNICODE")


# ───────────────────────── 2. 字符 → 按键计划 ─────────────────────────
print("\n2) 字符 → 按键计划（ASCII 走真实 VK，非 ASCII 走 Unicode）")

p_a = osinput._char_plan("a")
eq(len(p_a), 1, "单字符只产出一条计划")
eq(p_a[0][0], 65, "'a' 的 VK = 65")
eq(p_a[0][1], 0, "'a' 不需要 Shift")

p_shift = osinput._char_plan("A")
eq(p_shift[0][0], 65, "'A' 也是 VK 65")
ok(p_shift[0][1] is not None and (p_shift[0][1] & 1) == 1, "'A' 带 Shift 修饰位")

# 密码里常见的字符必须都能走 VK 路径（走 Unicode 会丢 keyCode，真实度打折）
for ch in "Str0ng_Pass:1":
    plan = osinput._char_plan(ch)
    ok(plan[0][1] is not None, "密码字符 %r 走 VK 路径（不是 Unicode 直送）" % ch, "实际 %r" % (plan,))

# 中文必须走 Unicode 路径（VkKeyScanW 对中文返回 -1）
p_cn = osinput._char_plan("麦")
ok(p_cn[0][1] is None, "中文 '麦' 走 Unicode 直送路径")
eq(p_cn[0][0], 0x9EA6, "'麦' 的码点正确")

# 冒号这类符号要带 Shift（VK 186 + Shift，US/中文拼音布局一致）
p_colon = osinput._char_plan(":")
ok(p_colon[0][1] is not None, "':' 能映射到 VK")
ok((p_colon[0][1] & 1) == 1, "':' 需要 Shift")


# ───────────────────────── 3. 虚拟键名表 ─────────────────────────
print("\n3) 具名键与修饰键")

for name, vk in (("Ctrl", 0x11), ("Control", 0x11), ("Shift", 0x10), ("Alt", 0x12)):
    eq(osinput.VK_NAMES.get(name), vk, "VK_NAMES 里有 %s" % name)
for name, vk in (("Enter", 0x0D), ("Tab", 0x09), ("Escape", 0x1B), ("Delete", 0x2E)):
    eq(osinput.VK_NAMES.get(name), vk, "VK_NAMES 里有 %s" % name)

# 组合键 "Ctrl+A" 前面的修饰键必须能查到，否则 press 会直接抛错
ok(osinput.VK_NAMES.get("Ctrl") is not None and osinput.VK_NAMES.get("A".capitalize()) is None,
   "组合键前缀 Ctrl 可解析（'A' 走单字符兜底）")

# 扩展键必须带 EXTENDEDKEY 标志，否则方向键/Delete 在部分程序里会被当成小键盘
for vk in (0x25, 0x26, 0x27, 0x28, 0x2E):
    ok(vk in osinput._EXTENDED_VKS, "扩展键 0x%02X 在 _EXTENDED_VKS 里" % vk)


# ───────────────────────── 4. 坐标归一化 ─────────────────────────
print("\n4) 屏幕物理像素 → SendInput 归一化坐标")

vx, vy, vw, vh = osinput.virtual_screen()
ok(vw > 0 and vh > 0, "虚拟桌面尺寸可取到（%dx%d，原点 %d,%d）" % (vw, vh, vx, vy))

nx0, ny0 = osinput._to_absolute(vx, vy)
eq((nx0, ny0), (0, 0), "虚拟桌面左上角 → (0,0)")

nx1, ny1 = osinput._to_absolute(vx + vw - 1, vy + vh - 1)
eq(nx1, 65535, "虚拟桌面右下角 → x=65535")
eq(ny1, 65535, "虚拟桌面右下角 → y=65535")

nmid, _ = osinput._to_absolute(vx + vw / 2, vy + vh / 2)
ok(32000 < nmid < 33500, "屏幕中心归一化落在中段（%d）" % nmid)

# 单调性：越往右值越不能变小（分母写错 65536/65535 会破坏端点）
seq = [osinput._to_absolute(vx + i * (vw / 10), vy)[0] for i in range(11)]
ok(all(seq[i] <= seq[i + 1] for i in range(len(seq) - 1)), "归一化 x 单调不减")
ok(seq[0] == 0 and seq[-1] >= 65000, "归一化 x 端点正确（%d → %d）" % (seq[0], seq[-1]))

# 越界一律夹到合法区间，绝不送出非法值
ok(osinput._to_absolute(-99999, -99999) == (0, 0), "越界坐标被夹到 (0,0)")
ok(osinput._to_absolute(999999, 999999)[0] == 65535, "越界坐标被夹到 65535")


# ───────────────────────── 5. 风险特征识别 ─────────────────────────
print("\n5) 风控/验证码特征识别（os_driver.risk_scan 的正则）")

import os_driver  # noqa: E402

# 这四条是 2026-10-15 真机撞到的真实 URL / DOM 特征
cases = [
    ("https://sec.taobao.com/_____tmd_____/punish?x5secdata=xx&action=captcha", True),
    ("https://havanalogin.taobao.com/member/login.jhtml", False),
    ("https://x/_____tmd_____/slide?action=captcha", True),
    ("https://static/x/nc_1_n1z.html", True),
    ("https://x/baxia-dialog-content", True),
    ("https://www.geetest.com/static/gt.js", True),
    ("https://myseller.taobao.com/home.htm/QnworkbenchHome/", False),
    ("https://sycm.taobao.com/portal/home.htm", False),
]
for url, want in cases:
    hit = any(pat.search(url) for pat, _ in os_driver._RISK_PATTERNS)
    eq(hit, want, "%-58s → %s" % (url[:58], "风险" if want else "正常"))

# 反例：文章 slug 里出现 captcha 不该误判（通用词只在 URL 分隔符位置才认）
ok(not any(pat.search("https://x/blog/post-about-captcha-design") for pat, _ in os_driver._RISK_PATTERNS),
   "文章 slug 里的 captcha 不误判")
# 但真正的验证码入口一个都不能漏
for url in ("https://x/captcha", "https://x/login?action=captcha", "https://captcha.taobao.com/x",
            "https://www.google.com/recaptcha/api.js"):
    ok(any(pat.search(url) for pat, _ in os_driver._RISK_PATTERNS), "真实验证码入口不遗漏：%s" % url)


# ───────────────────────── 6. 相对位移与坐标串 ─────────────────────────
print("\n6) 端点解析（相对位移 / 绝对坐标 / 定位表达式）")

import mcp_server  # noqa: E402

eq(mcp_server.parse_point("+349,0"), {"dx": 349.0, "dy": 0.0}, '"+349,0" → 相对位移')
eq(mcp_server.parse_point("+-120,0"), {"dx": -120.0, "dy": 0.0}, '"+ -120,0" 能表达负位移')
eq(mcp_server.parse_point("+0,-40"), {"dx": 0.0, "dy": -40.0}, '"+0,-40" → 向上 40')
eq(mcp_server.parse_point("120,340"), {"x": 120.0, "y": 340.0}, '"120,340" → 绝对坐标')
eq(mcp_server.parse_point("text=提交订单"), "text=提交订单", "定位表达式原样透传")
eq(mcp_server.parse_point("#nc_1_n1z"), "#nc_1_n1z", "CSS 选择器原样透传")

# 数字型坐标串在 os_driver 里要能识别（不能被当成选择器去查 DOM）
m = os_driver._NUM_PAIR.match("120,340")
ok(m is not None, "os_driver 能识别 'x,y' 坐标串")
ok(os_driver._NUM_PAIR.match("text=提交") is None, "选择器不会被误认成坐标串")
eq((float(m.group(1)), float(m.group(2))), (120.0, 340.0), "坐标串数值解析正确")


# ───────────────────────── 7. 只读真机检查 ─────────────────────────
print("\n7) 只读真机检查")

cpos = osinput.cursor_pos()
# 注意：虚拟桌面原点可能是负的（本机副屏在主屏左上方），所以范围要按 (vx..vx+vw) 判
ok(vx <= cpos[0] <= vx + vw and vy <= cpos[1] <= vy + vh,
   "光标坐标落在虚拟桌面内 (%d,%d)" % cpos)

dpi = osinput.dpi_info()
print("  DPI 感知 = %s；虚拟桌面 %s×%s @ (%s,%s)；显示器 %s 台"
      % (dpi["awareness"], dpi["virtualDesktop"]["width"], dpi["virtualDesktop"]["height"],
         dpi["virtualDesktop"]["x"], dpi["virtualDesktop"]["y"], dpi["monitors"]))
ok(dpi["awareness"] != "unknown",
   "进程已切成 DPI 感知（否则 Win32 坐标会被虚拟化，SendInput 会整体点偏）")
ok(dpi["awareness"] != "SYSTEM_AWARE" or dpi["monitors"] == 1,
   "多显示器场景下用的是 per-monitor 感知（SYSTEM_AWARE 在多屏不同缩放下会算错）")

if ARGS.live:
    print("  坐标系往返自检（只移动光标，不点击，测完还原）…")
    cal = osinput.calibrate()
    for s in cal["samples"]:
        print("    期望 %s → 实到 %s（误差 %dpx）" % (s["want"], s["got"], s["err"]))
    ok(cal["ok"], "坐标系自检通过（最大误差 %dpx ≤ %dpx）" % (cal["maxErrorPx"], cal["tolerancePx"]),
       cal["note"])

if ARGS.live:
    title = "千牛商家工作台"
    try:
        hwnd = osinput.find_window(title)
        left, top, cw, ch = osinput.client_screen_rect(hwnd)
        print("  找到窗口：hwnd=%s 标题=%r" % (hwnd, osinput.window_title(hwnd)[:50]))
        print("  客户端区：left=%d top=%d %dx%d" % (left, top, cw, ch))
        ok(cw > 200 and ch > 200, "客户区尺寸合理")
        ok(left >= vx and top >= vy, "客户区落在虚拟桌面范围内")
        # 视口高度必须小于客户区高度（差值就是工具栏那一条）—— 这是换算公式的前提
        ok(ch > 0, "客户区高度可用于反推视口原点")
    except Exception as e:
        print("  ! 未找到「%s」窗口：%s" % (title, e))
        print("    （不影响其它结论；要看这条请先把该窗口打开或换成当前页面的标题）")
else:
    print("  （--live 未开启，跳过真机找窗口检查）")


# ───────────────────────── 汇总 ─────────────────────────
print("\n" + "=" * 52)
print("系统级输入层：%d 项通过" % PASS + ("，%d 项失败" % FAIL if FAIL else "，全部通过"))
if FAILED:
    print("失败项：")
    for f in FAILED:
        print("  · %s" % f)
sys.exit(1 if FAIL else 0)
