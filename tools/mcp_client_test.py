#!/usr/bin/env python3
"""Browser Bridge · MCP 客户端自测

【它验证什么】
    以「agent 的身份」连上 mcp_server.py，把工具列表和一次真实调用跑通。
    这能证明 agent 那一侧看到的接口是正常的 —— 和 selftest.py（验证插件侧协议）
    合在一起，就把整条链路上除浏览器本体之外的每一段都覆盖到了。

【用法】
    server\\.venv\\Scripts\\python.exe tools\\mcp_client_test.py

    # 8765 已被占用时（比如 agent 已经拉起了一个服务端）换个端口跑：
    server\\.venv\\Scripts\\python.exe tools\\mcp_client_test.py --port 8798
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVER = ROOT / "server" / "mcp_server.py"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--port",
        type=int,
        default=None,
        help="本测试会自己拉起一个服务端；若默认的 8765 已被占用（agent 起的那个），在这里换一个",
    )
    opts = ap.parse_args()

    try:
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client
    except ImportError as e:
        print("缺少 mcp 客户端库：%s" % e)
        return 1

    server_args = [str(SERVER)]
    if opts.port:
        server_args += ["--port", str(opts.port)]

    params = StdioServerParameters(
        command=sys.executable,
        args=server_args,
        env=dict(os.environ),
    )

    print("启动并连接 mcp_server.py ...\n")

    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            init = await session.initialize()
            print("握手成功")

            # mcp 2.x 的属性是 snake_case，1.x 是 camelCase，两种都兜住
            info = getattr(init, "server_info", None) or getattr(init, "serverInfo", None)
            proto = getattr(init, "protocol_version", None) or getattr(init, "protocolVersion", None)
            if info is not None:
                print("  服务端名称：%s %s" % (getattr(info, "name", "?"), getattr(info, "version", "?")))
            print("  协议版本：%s" % proto)

            tools = await session.list_tools()
            names = sorted(t.name for t in tools.tools)
            print("\n工具总数：%d" % len(names))
            for t in tools.tools:
                first = (t.description or "").strip().splitlines()[0] if t.description else ""
                print("  %-24s %s" % (t.name, first[:64]))

            # ── 真实调用一次 ──
            print("\n调用 browser_status（此刻没有浏览器插件连接是正常的，重点是看它有没有给出可执行的排查步骤）：")
            res = await session.call_tool("browser_status", {})
            texts = [c.text for c in res.content if getattr(c, "type", "") == "text"]
            for t in texts:
                try:
                    data = json.loads(t)
                    print(json.dumps(data, ensure_ascii=False, indent=2))
                except Exception:
                    print(t)

            # ── 校验工具数量 ──
            # 不写死具体数字：工具是增量演进的，硬编一个值反而会让"加了新工具"变成红字。
            # 只确认它是 browser_* 且数量合理（>=20，避免有人误删了一大片）。
            min_expected = 20
            ok_count = len(names) >= min_expected
            print(
                "\n工具数量：%d（下限 %d）%s"
                % (len(names), min_expected, "✓" if ok_count else "✗ 工具数异常偏低，可能漏注册了")
            )
            if not ok_count:
                return 1

    print("\n链路自测完成：MCP 侧正常。")
    print("接下来请在 Chrome 里加载 extension 目录，然后在插件弹窗里确认「已连接」。")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(asyncio.run(main()))
    except KeyboardInterrupt:
        print("\n已中断")
