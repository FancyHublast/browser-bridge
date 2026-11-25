#!/usr/bin/env python3
"""
Browser Bridge · 桥接协议闭环测试

【它验证什么】
    在同一个进程里，一边当"服务端"、一边当"Chrome 插件"，把中间的协议行为全部锁死：

      1. 握手        —— 插件连上后服务端能识别
      2. 指令闭环    —— 服务端下发 → 插件回执 → 服务端拿到结果
      3. 大消息      —— 模拟整页截图的 base64（5MB）能否原样过桥
                        （这一条最关键：截图的 PNG 常有几 MB，任何一端的消息上限没调够，
                          表现都是"截图功能神秘地没返回"，极难排查）
      4. 心跳        —— 服务端定时发 ping，这是让插件那侧 MV3 service worker 不休眠的关键
      5. 断线快速失败 —— 插件断开时，在途调用必须立刻报错，而不是干等到超时

【为什么值得单独做】
    真机排障时，"到底是服务端的问题还是插件的问题"经常分不清。
    这个测试跑通了，服务端这一半的协议行为就被钉死了 —— 问题只可能在插件侧。

【用法】
    server\\.venv\\Scripts\\python.exe tools\\protocol_test.py
"""

import asyncio
import json
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from bridge import BridgeError, BrowserBridge  # noqa: E402

TEST_PORT = 8799
BIG_BYTES = 5 * 1024 * 1024

_pass = []
_fail = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (_pass if ok else _fail).append(name)
    mark = "OK  " if ok else "FAIL"
    print("  [%s] %-28s %s" % (mark, name, detail))


async def fake_extension(port: int, ready: threading.Event, stats: dict) -> None:
    """扮演 Chrome 插件：握手、回 pong、执行指令、回执。"""
    import websockets

    uri = "ws://127.0.0.1:%d/" % port
    try:
        async with websockets.connect(uri, max_size=64 * 1024 * 1024) as ws:
            ready.set()
            await ws.send(json.dumps({"type": "hello", "role": "extension", "version": "test-0.0.1"}))

            async for raw in ws:
                msg = json.loads(raw)
                kind = msg.get("type")

                if kind == "ping":
                    stats["ping"] += 1
                    await ws.send(json.dumps({"type": "pong", "t": int(time.time() * 1000)}))
                    continue

                rid = msg.get("id")
                if rid is None:
                    continue

                cmd = msg.get("cmd")
                stats["cmds"].append(cmd)

                if cmd == "close":
                    await ws.send(json.dumps({"id": rid, "ok": True, "data": {"bye": True}}))
                    break

                if cmd == "big":
                    # 模拟一整页长截图的 base64 体积
                    await ws.send(
                        json.dumps({"id": rid, "ok": True, "data": {"blob": "A" * BIG_BYTES}})
                    )
                    continue

                if cmd == "boom":
                    await ws.send(json.dumps({"id": rid, "ok": False, "error": "插件侧故意报错"}))
                    continue

                await ws.send(json.dumps({"id": rid, "ok": True, "data": {"echo": cmd, "args": msg.get("args")}}))
    except Exception as e:  # noqa: BLE001
        stats["ext_error"] = str(e)


def main() -> int:
    print("=" * 62)
    print(" Browser Bridge · 桥接协议闭环测试")
    print("=" * 62)

    bridge = BrowserBridge(host="127.0.0.1", port=TEST_PORT, heartbeat_seconds=5, call_timeout=20)
    try:
        bridge.start()
    except BridgeError as e:
        print("启动失败：%s" % e)
        return 2

    ready = threading.Event()
    stats = {"ping": 0, "cmds": []}
    threading.Thread(
        target=lambda: asyncio.run(fake_extension(TEST_PORT, ready, stats)),
        daemon=True,
        name="fake-extension",
    ).start()

    if not ready.wait(6):
        print("模拟插件未能连上服务端")
        bridge.stop()
        return 2

    time.sleep(0.4)

    # ── 1. 握手 ──
    print("\n1) 握手与识别")
    check("插件已连接", bridge.connected, str(bridge.status()["extension_connected"]))
    info = bridge.status().get("extension") or {}
    check("读到插件自报信息", bool(info.get("version")), "version=%s" % info.get("version"))

    # ── 2. 指令闭环 ──
    print("\n2) 指令下发与回执")
    res = bridge.call("ping", {"hello": "world"})
    check("回执 ok", res.get("ok") is True, json.dumps(res.get("data"), ensure_ascii=False)[:60])
    check("服务端收到 args", res["data"].get("args", {}).get("hello") == "world")

    # ── 3. 插件报错要原样透传 ──
    print("\n3) 插件侧错误透传")
    try:
        bridge.call_data("boom", {})
        check("错误被抛出", False, "本应抛出 BridgeError")
    except BridgeError as e:
        check("错误被抛出", True, str(e)[:40])

    # ── 4. 大消息 ──
    print("\n4) 大消息过桥（%d MB）" % (BIG_BYTES // 1024 // 1024))
    t0 = time.time()
    try:
        big = bridge.call("big", {}, timeout=40)
        size = len(big["data"]["blob"])
        check("5MB 原样到达", size == BIG_BYTES, "收到 %d 字节，耗时 %.2fs" % (size, time.time() - t0))
    except BridgeError as e:
        check("5MB 原样到达", False, str(e)[:60])

    # ── 5. 心跳 ──
    print("\n5) 心跳（等待 12 秒，心跳周期 5 秒，预期 ≥2 次）")
    time.sleep(12)
    check("心跳在跑", stats["ping"] >= 2, "收到 %d 次 ping" % stats["ping"])

    # ── 6. 断线快速失败 ──
    print("\n6) 断线时在途调用立即失败（不应等到超时）")
    bridge.call("close", {})
    time.sleep(1.0)
    t0 = time.time()
    try:
        bridge.call("ping", {}, timeout=30)
        check("断线后立刻报错", False, "本应抛出 BridgeError")
    except BridgeError as e:
        elapsed = time.time() - t0
        check("断线后立刻报错", elapsed < 3, "%.2fs 内报错：%s" % (elapsed, str(e).splitlines()[0][:40]))

    bridge.stop()

    print("\n" + "=" * 62)
    print(" 通过 %d 项，失败 %d 项" % (len(_pass), len(_fail)))
    if _fail:
        print(" 失败项：" + "、".join(_fail))
    else:
        print(" 服务端侧协议行为全部正常。若真机仍不通，问题一定在插件侧 ——")
        print(" 请到 chrome://extensions 打开本扩展的 service worker 控制台看报错。")
    print("=" * 62)
    return 1 if _fail else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中断")
