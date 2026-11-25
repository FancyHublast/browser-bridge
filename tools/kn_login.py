#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
千牛/淘宝卖家登录（账号密码 + 可选滑块）。

【为什么做成脚本】
    这条链路上每一步都有一个"踩过才知道"的坑，散在对话里迟早会忘：
      · **系统级鼠标在淘宝登录框上会跑偏** —— 对密码框那一下就偏到了账号框，
        紧接着的全选+输入把账号覆盖成了密码串（截图实锤）。
        所以：聚焦一律用**应用层点击**（合成事件只设焦点，风控不看它），
        输入才用**系统级真实键盘**（真 keydown/keyup，风控就看这个）。
      · **滑块不能精确对齐终点，要撑到尽头**（详见 slider_solve.py）。
      · 风控帧通过验证后**不会从 frames 列表消失**，别拿它当判据 ——
        要看滑块横条是否消失 / 是否跳转。
    把这些固化下来，比每次现场重新踩一遍强。

【用法】
    python tools/kn_login.py --user "你的账号:子账号" --password "xxxx"
    python tools/kn_login.py --tab 120181398 --reload
    python tools/kn_login.py --auto-slider          # 遇到滑块自动过一次
    环境变量也行：BB_TAOBAO_USER / BB_TAOBAO_PASSWORD

【安全】
    账号密码只从命令行/环境变量进来，不写进任何文件、不落日志。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "server"))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

from bb_client import Browser  # noqa: E402
from slider_solve import find_risk_frame, find_slider, solve_slider  # noqa: E402

LOGIN_ID = "#fm-login-id"
LOGIN_PW = "#fm-login-password"
LOGIN_BTN = "button[type=submit]"
LOGIN_HOST_HINTS = ("loginmyseller.taobao.com", "login.taobao.com", "havanalogin.taobao.com")
HOME_HINTS = ("myseller.taobao.com", "sycm.taobao.com")


def pick_tab(b: Browser, tab_id=None):
    tabs = b.tabs()
    if tab_id is not None:
        return next((t for t in tabs if int(t.get("tabId") or -1) == int(tab_id)), None)
    # 先找还停在登录页的，再找已登录域的
    for hints in (LOGIN_HOST_HINTS, HOME_HINTS):
        for t in tabs:
            if any(h in (t.get("url") or "") for h in hints):
                return t
    return None


def login(
    b: Browser,
    tab_id: int,
    user: str,
    password: str,
    *,
    reload_first: bool = False,
    auto_slider: bool = False,
    overrun: float = 90,
) -> dict:
    out: dict = {"tabId": tab_id, "steps": []}

    def step(name, payload):
        out["steps"].append({"step": name, **payload})
        return payload

    if reload_first:
        b.call("reload", {"tabId": tab_id})
        time.sleep(5)
        step("reload", {"ok": True})

    # ① 账号：桥接点击聚焦 + 系统级键盘
    r1 = b.type_os(tab_id, LOGIN_ID, user, clear=True, focus="bridge", delay_ms=70)
    step("fill-user", {"match": r1.get("match"), "actual": r1.get("actual"), "via": r1.get("focusVia")})
    if not r1.get("match"):
        out["ok"] = False
        out["stage"] = "fill-user"
        out["error"] = "账号框回读和输入不一致，已中止（继续点登录只会得到一次失败尝试）"
        return out

    # ② 密码：同样走桥接聚焦（这个站点 os 鼠标落点会偏到账号框）
    r2 = b.type_os(tab_id, LOGIN_PW, password, clear=True, focus="bridge", delay_ms=70)
    actual = str(r2.get("actual") or "")
    step(
        "fill-password",
        {"match": r2.get("match"), "length": len(actual), "via": r2.get("focusVia")},
    )
    if not r2.get("match"):
        out["ok"] = False
        out["stage"] = "fill-password"
        out["error"] = (
            "密码框回读不一致（期望 %d 位，实际 %d 位）。"
            "先看页面上密码框有几个点，再决定下一步 —— 不要盲目再点一次登录。"
            % (len(password), len(actual))
        )
        return out

    # ③ 点登录 → 有滑块就过 → 再点一次登录。
    #
    # 【为什么要循环】2026-10-15 实测：滑块验证通过后，登录表单**不会自动重新提交**，
    #   页面就静静停在登录页 —— 账号密码都还在、登录按钮也可点、一条报错都没有。
    #   必须再点一次登录才真正提交。这一步不补，前面全白干（会误判成"账号密码不对"）。
    LOGIN_ROUNDS = 3
    logged_in = False
    for rnd in range(1, LOGIN_ROUNDS + 1):
        b.call("click", {"target": LOGIN_BTN, "tabId": tab_id})
        step("click-login", {"round": rnd})
        time.sleep(2.5)

        # 判据用「滑块元素还在不在」，**不用**「风控帧还在不在」：
        # 风控帧过验后不会从 frames 列表消失，拿它当判据会把"已经过了"误判成"还在风控"。
        risk, frame_id, frame_url = find_risk_frame(b, tab_id)
        frame = str(frame_id) if frame_id is not None else None
        sel, rect = find_slider(b, tab_id, frame) if risk.get("risk") else (None, None)

        if sel:
            step("risk", {"round": rnd, "frameId": frame_id, "slider": sel})
            if not auto_slider:
                out["ok"] = False
                out["stage"] = "slider-pending"
                out["error"] = "检测到滑块验证，但本次没开 --auto-slider，交给调用方决定。"
                return out
            sr = solve_slider(b, tab_id, overrun=overrun)
            v = sr.get("verdict") or {}
            out.setdefault("sliders", []).append(
                {"round": rnd, "solved": v.get("solved"), "why": v.get("why")}
            )
            step("solve-slider", {"round": rnd, "solved": v.get("solved"), "why": v.get("why")})
            if not v.get("solved"):
                out["ok"] = False
                out["stage"] = "slider-failed"
                out["error"] = (
                    "滑块第 %d 轮没过。不要连撞 —— 可以加大 overrun（如 140）再试一次，"
                    "仍不成请转人工。" % rnd
                )
                return out
            time.sleep(3)
            continue  # 过完滑块回到循环顶部：**再点一次登录**，那才是真正提交的那一下

        # 没有滑块了 → 看有没有跳出登录域
        time.sleep(2)
        tab = next((t for t in b.tabs() if int(t.get("tabId") or -1) == int(tab_id)), {})
        url = tab.get("url") or ""
        if any(h in url for h in HOME_HINTS) and not any(h in url for h in LOGIN_HOST_HINTS):
            logged_in = True
            break
        # 还停在登录页、又没有风控 —— 多半是验证刚过、表单还没提交，下一轮再点一次
        step("retry-login", {"round": rnd, "url": url[:90]})

    # ④ 出结果
    tab = next((t for t in b.tabs() if int(t.get("tabId") or -1) == int(tab_id)), {})
    url = tab.get("url") or ""
    logged_in = logged_in or (
        any(h in url for h in HOME_HINTS) and not any(h in url for h in LOGIN_HOST_HINTS)
    )
    info = b.call("page_info", {"tabId": tab_id, "withText": True, "maxChars": 400})
    out["tabAfter"] = {"url": url, "title": tab.get("title")}
    out["pageText"] = (info.get("page") or {}).get("text", "")[:200]
    out["ok"] = bool(logged_in)
    out["stage"] = "logged-in" if logged_in else "still-on-login"
    if not logged_in:
        out["error"] = (
            "点了 %d 轮登录仍停在登录页。可能是：账号密码不对 / 需要短信或图片验证 / 页面还在跳转。"
            "先看 pageText 和 tabAfter.url 再决定下一步。" % LOGIN_ROUNDS
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tab", type=int, default=None)
    ap.add_argument("--user", default=os.environ.get("BB_TAOBAO_USER", ""))
    ap.add_argument("--password", default=os.environ.get("BB_TAOBAO_PASSWORD", ""))
    ap.add_argument("--reload", action="store_true", help="先刷新页面（页面挂久了建议开）")
    ap.add_argument("--auto-slider", action="store_true", help="遇到滑块自动过一次")
    ap.add_argument("--overrun", type=float, default=90)
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    if not args.user or not args.password:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "需要账号密码：--user / --password，或环境变量 BB_TAOBAO_USER / BB_TAOBAO_PASSWORD。",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        sys.exit(2)

    b = Browser(port=args.port)
    try:
        b.wait_extension(30)
        tab = pick_tab(b, args.tab)
        if not tab:
            print(json.dumps({"ok": False, "error": "没找到千牛/淘宝登录页标签页。"}, ensure_ascii=False, indent=2))
            sys.exit(3)
        r = login(
            b,
            int(tab["tabId"]),
            args.user,
            args.password,
            reload_first=args.reload,
            auto_slider=args.auto_slider,
            overrun=args.overrun,
        )
        print(json.dumps(r, ensure_ascii=False, indent=2))
        sys.exit(0 if r.get("ok") else 4)
    finally:
        b.close()


if __name__ == "__main__":
    main()
