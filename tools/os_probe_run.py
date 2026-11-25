# -*- coding: utf-8 -*-
"""
系统级输入的真机验证脚本（配合 tools/os_probe.html 使用）。

它证明的是唯一关键的一件事：
    **走 SendInput 输入时，页面收到的 keydown 次数 == 字符数**；
    而走 CDP 的 Input.dispatchKeyEvent{type:'char'} 时，keydown 恒为 0。

后者正是 2026-10-15 淘宝登录框弹验证码的原因 —— 14 个字符、0 次按键，
风控把这两个计数一比就知道是机器。

用法：
    python tools/os_probe_run.py [--text "Ab3:中文"] [--title BB-OS-PROBE]
"""
import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "server"))

import osinput  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--text", default="Ab3:中文", help="要输入的文本（默认覆盖大写/数字/符号/中文四种路径）")
ap.add_argument("--title", default="BB-OS-PROBE", help="目标标签页标题（用来找窗口）")
ap.add_argument("--keep", action="store_true", help="不清空输入框再输（默认先 Ctrl+A / Delete）")
ARGS = ap.parse_args()

if not osinput.available():
    print("系统级输入不可用（非 Windows）")
    sys.exit(2)

info = osinput.dpi_info()
print("DPI 感知：%s  虚拟桌面 %sx%s @ (%s,%s)  显示器 %s 台"
      % (info["awareness"], info["virtualDesktop"]["width"], info["virtualDesktop"]["height"],
         info["virtualDesktop"]["x"], info["virtualDesktop"]["y"], info["monitors"]))

hwnd = osinput.find_window(ARGS.title)
print("目标窗口：hwnd=%s  标题=%r" % (hwnd, osinput.window_title(hwnd)[:60]))

if not osinput.focus_window(hwnd):
    print("！无法把窗口提到前台，系统级输入不会生效")
    sys.exit(3)
print("窗口已在前台 ✓")
time.sleep(0.35)

if not ARGS.keep:
    osinput.press("Ctrl+A", hwnd=hwnd)
    osinput.press("Delete", hwnd=hwnd)
    time.sleep(0.1)

guard_checks = []


def guard():
    alive = osinput.is_foreground(hwnd)
    guard_checks.append(alive)
    return alive


t0 = time.time()
res = osinput.type_text(ARGS.text, hwnd=hwnd, base_ms=60, jitter_ms=35, guard=guard)
dt = time.time() - t0

print("输入完成：%s 个字符，耗时 %.2fs（前台校验 %d 次全部通过：%s）"
      % (res.get("typed"), dt, len(guard_checks), all(guard_checks)))
print("送出内容：%r" % ARGS.text)
