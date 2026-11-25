#!/usr/bin/env python3
"""
Browser Bridge · 协议自测（模拟 Chrome 插件端）

【为什么需要这个】
    真正调试时，"是插件的问题"还是"是服务端的问题"经常分不清。
    这个脚本假装自己是一个插件：连上 WebSocket、回 pong、把收到的指令原样回执。
    如果它能跑通，说明服务端这半边是好的，问题一定在插件侧。

【用法】
    终端 1：python mcp_server.py --ws-only
    终端 2：python tools/selftest.py
            python tools/selftest.py ws://127.0.0.1:8765/?token=你的token
"""

import asyncio
import json
import sys


async def main() -> None:
    try:
        import websockets
    except ImportError:
        print("缺少 websockets，请先 pip install -r server/requirements.txt")
        sys.exit(1)

    uri = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:8765"
    print("连接 %s ..." % uri)

    try:
        async with websockets.connect(uri, max_size=64 * 1024 * 1024) as ws:
            print("握手成功（若服务端配了 token，这里没带 token 会直接被拒）")

            # 服务端的 welcome
            first = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            print("服务端首发消息：%s" % json.dumps(first, ensure_ascii=False))

            await ws.send(json.dumps({"type": "hello", "role": "extension", "version": "0.0.0-selftest"}))
            print("已发送 hello。等待指令（服务端每 20 秒会发一次心跳）...\n")

            count = 0
            while True:
                raw = await ws.recv()
                msg = json.loads(raw)

                if msg.get("type") == "ping":
                    await ws.send(json.dumps({"type": "pong"}))
                    print("  ← ping  → pong")
                    continue

                if msg.get("id"):
                    count += 1
                    print("  ← 收到指令 [%d] cmd=%s args=%s" % (count, msg.get("cmd"), json.dumps(msg.get("args"), ensure_ascii=False)))
                    await ws.send(
                        json.dumps(
                            {
                                "id": msg["id"],
                                "ok": True,
                                "data": {"echo": msg.get("cmd"), "args": msg.get("args"), "by": "selftest"},
                                "ms": 1,
                            },
                            ensure_ascii=False,
                        )
                    )
                    print("  → 已回执")

    except OSError as e:
        print("连接失败：%s" % e)
        print("请确认本地服务已在运行：python server/mcp_server.py --ws-only")
        sys.exit(2)
    except asyncio.TimeoutError:
        print("握手后 10 秒没收到服务端消息，服务端可能未正常工作")
        sys.exit(3)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n已退出")
