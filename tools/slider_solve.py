#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
过滑块验证（阿里 nc / 千牛 / 淘宝登录滑块）。

【这条路和以前有什么不同】
    以前的做法是"精确算好要拖多远，然后停在那个坐标上"。对这类滑块恰恰是反的：
    它的判据是「滑块有没有到达终点区域」—— 你**撑到尽头**它就把滑块夹在末端，
    多出来的部分只是指针在走；而"精确停在终点值上"反而是最强的机器特征。
    2026-10-15 实测：精确落点被连续判 error:zAuBTf，改成一口气撑过头一次就过。
    人的直觉也是这样：拉过去不少，然后松手。

    所以本脚本拖的总距离 = 轨道剩余距离 + 余量(extra) + 超程(overrun)，
    一路冲到底、不回拉。

【用法】
    python tools/slider_solve.py --tab 120181398
    python tools/slider_solve.py --tab 120181398 --dry-run     # 只报几何，不真拖
    python tools/slider_solve.py                                # 用当前活动标签页
    可选：--dist 420        强制指定拖多远（默认按轨道几何算）
          --overrun 90      冲过终点后继续压多少像素
          --selector "#nc_1_n1z"

【它不做的事】
    不猜、不反复硬撞：只拖一次，然后如实报告"过没过"。
    一次不过就交给调用方（人或 agent）决定 —— 连试两次返回同一串错误码，
    说明是「机器判定」而不是「位置没对准」，继续撞只会让风控升级。

【给别的脚本复用】
    from slider_solve import solve_slider
    r = solve_slider(browser, tab_id, overrun=90)
    if r["verdict"]["solved"]: ...
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "server"))

try:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台默认 GBK，中文会炸
except Exception:
    pass

from bb_client import Browser  # noqa: E402

# nc 滑块的常见结构：轨道 + 里面的可拖按钮。
# 多给几个候选，不同版本/皮肤用的 id 不一样。
SLIDER_SELECTORS = ["#nc_1_n1z", ".btn_slide", "[aria-label='滑块']", "#nc_1_n1z_holder"]
TRACK_SELECTORS = ["#nc_1__scale_text", ".nc_scale", "#nc_1__bg", ".nc_scale_text"]


def find_slider(b, tab_id, frame, selector=""):
    """返回 (选择器, 帧内 rect)。按候选顺序找第一个命中的 —— 且要求可见。"""
    cands = [selector] if selector else SLIDER_SELECTORS
    for sel in cands:
        r = b.query(sel, tab_id, frame, limit=5)
        for el in r.get("elements") or []:
            if el.get("visible") and (el.get("rect") or {}).get("w"):
                return sel, el["rect"]
    return None, None


def find_track(b, tab_id, frame):
    for sel in TRACK_SELECTORS:
        rect = b.first_rect(sel, tab_id, frame)
        if rect and rect.get("w"):
            return sel, rect
    return None, None


def find_risk_frame(b, tab_id):
    """扫出风控帧。返回 (risk_dict, frameId, frameUrl)。"""
    risk = b.risk(tab_id)
    if not risk.get("risk"):
        return risk, None, None
    sig = (risk.get("signals") or [{}])[0]
    return risk, sig.get("frameId"), sig.get("url")


def solve_slider(
    b,
    tab_id,
    *,
    selector: str = "",
    dist: float = 0,
    extra: float = 60,
    overrun: float = 90,
    wait: float = 2.5,
    dry_run: bool = False,
) -> dict:
    """
    过滑块（一次）。返回 {"ok", "stage", "plan", "drag", "verdict"}。

    只做一次尝试，绝不内部重试 —— 重试的决策留给调用方（人对"要不要再来一次"更敏感）。
    """
    tab = next((t for t in b.tabs() if int(t.get("tabId") or -1) == int(tab_id)), None)
    if not tab:
        return {"ok": False, "stage": "find-tab", "error": "找不到 tabId=%s" % tab_id}

    risk, frame_id, frame_url = find_risk_frame(b, tab_id)
    frame = str(frame_id) if frame_id is not None else None

    # ⚠️ 判据是「滑块元素在不在」，**不是**「风控帧在不在」。
    #    风控帧通过验证后不会从 frames 列表里消失（2026-10-15 实测），
    #    拿它当判据会把"其实已经过了"误判成"还在风控"。
    sel, slider = find_slider(b, tab_id, frame, selector)
    if not sel:
        if not risk.get("risk"):
            return {
                "ok": False,
                "stage": "risk-scan",
                "error": "这个标签页既没有风控帧也没有滑块 —— 不需要过滑块。",
                "tab": {"tabId": tab_id, "url": tab.get("url")},
                "risk": risk,
            }
        return {
            "ok": False,
            "stage": "no-slider",
            "error": (
                "风控帧还在，但里面已经没有滑块元素了 —— 大概率是**已经通过**了"
                "（风控帧过验后不会自动消失，别被它误导）。"
                "换个判据确认：滑块横条是否消失、页面是否跳转到了目标地址。"
            ),
            "frameId": frame_id,
            "frameUrl": frame_url,
            "tried": SLIDER_SELECTORS if not selector else [selector],
        }

    track_sel, track = find_track(b, tab_id, frame)
    slider_center_x = slider["x"] + slider["w"] / 2.0
    need = ((track["x"] + track["w"]) - slider_center_x) if track else 300.0
    real_dist = float(dist) if dist else max(120.0, need) + float(extra)

    plan = {
        "tab": {"tabId": tab_id, "url": tab.get("url"), "title": tab.get("title")},
        "riskFrameId": frame_id,
        "riskFrameUrl": frame_url,
        "slider": {"selector": sel, "rect": slider},
        "track": {"selector": track_sel, "rect": track},
        "needToTrackEnd": round(need, 1),
        "dist": round(real_dist, 1),
        "overrun": overrun,
        "totalBeyondTarget": round(real_dist + overrun - need, 1),
    }
    if dry_run:
        plan["dryRun"] = True
        return {"ok": True, "stage": "plan", "plan": plan}

    drag = b.drag_os(tab_id, sel, "+%d,0" % round(real_dist), frame=frame, overrun=float(overrun))

    time.sleep(max(0.5, float(wait)))
    after = b.query(sel, tab_id, frame, limit=5)
    elems = after.get("elements") or []
    now_tab = next((t for t in b.tabs() if int(t.get("tabId") or -1) == int(tab_id)), tab)

    if not elems or not elems[0].get("visible"):
        verdict = {"solved": True, "why": "滑块条已消失"}
    else:
        x = (elems[0].get("rect") or {}).get("x", -1)
        if x > slider["x"] + 60:
            verdict = {"solved": True, "why": "滑块已停在末端（x=%.0f → %.0f）" % (slider["x"], x)}
        else:
            verdict = {
                "solved": False,
                "why": "滑块还在原位（x=%.0f → %.0f），这次没成" % (slider["x"], x),
                "advice": (
                    "不要再连续硬撞：两次返回同一串错误码就是「机器判定」而非对位不准。"
                    "可以加大 --overrun（如 140）再试**一次**；仍不成请转人工。"
                ),
            }

    return {
        "ok": True,
        "stage": "done",
        "plan": plan,
        "drag": drag,
        "verdict": verdict,
        "tabAfter": {"url": now_tab.get("url"), "title": now_tab.get("title")},
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tab", type=int, default=None, help="目标标签页 id；不给就用活动页")
    ap.add_argument("--selector", default="", help="滑块元素选择器（默认自动试几个常见的）")
    ap.add_argument("--dist", type=float, default=0, help="强制拖动距离(CSS px)；不给就按轨道几何算")
    ap.add_argument("--extra", type=float, default=60, help="在轨道剩余距离之上多拖多少（默认 60）")
    ap.add_argument("--overrun", type=float, default=90, help="冲过终点后继续压多少像素（默认 90）")
    ap.add_argument("--wait", type=float, default=2.5, help="拖完等几秒看结果")
    ap.add_argument("--dry-run", action="store_true", help="只报几何，不真的拖")
    ap.add_argument("--port", type=int, default=8765)
    args = ap.parse_args()

    b = Browser(port=args.port)
    try:
        b.wait_extension(30)
        tab_id = args.tab if args.tab is not None else b.active_tab_id()
        r = solve_slider(
            b,
            tab_id,
            selector=args.selector,
            dist=args.dist,
            extra=args.extra,
            overrun=args.overrun,
            wait=args.wait,
            dry_run=args.dry_run,
        )
        print(json.dumps(r, ensure_ascii=False, indent=2))
        sys.exit(0 if r.get("ok") else 2)
    finally:
        b.close()


if __name__ == "__main__":
    main()
