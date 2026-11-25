#!/usr/bin/env python3
"""
Browser Bridge · 静态一致性校验

【为什么需要它】
    这个工程有四条"名字契约"跨文件、跨语言，写错一个字符串就是运行时故障，
    而且报错信息往往很含糊（"未找到元素"、"未知动作"），排查成本极高：

      1. manifest.json 里列出的 content script 文件必须真实存在
         （写错路径 ⇒ 插件加载成功但完全不工作）
      2. mcp_server.py 里 call("xxx") 的指令名，必须在 commands.js 的 TABLE 里
         （写错 ⇒ agent 收到"未知指令"）
      3. commands.js / screenshot.js 里 contentCall(x, "yyy") 的动作名，
         必须在 content/router.js 的 MAP 里
         （写错 ⇒ 页面侧收不到，表现为神秘超时；
          v1.3.1 起 MAP 在 router.js，它 all_frames 注入，iframe 才收得到指令）
      4. `import * as X` 之后必须写 `X.foo()`；写成裸 `foo()` 语法合法、
         运行时 ReferenceError，且会被 MCP 客户端压成一句通用报错
         （2026-10-15 实测：browser_ax 三个 action 全废，就少了个 `ax.`）

    浏览器里跑不通时，先跑这个 —— 能在 3 秒内排除掉最低级的整类错误。

【用法】
    server\\.venv\\Scripts\\python.exe tools\\consistency_check.py
"""

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXT = ROOT / "extension"
SW = EXT / "src" / "sw"
CONTENT = EXT / "src" / "content"
SERVER = ROOT / "server"

problems = []
notes = []


def read(p: Path) -> str:
    return p.read_text(encoding="utf-8")


def section_keys(text: str, start_marker: str) -> set:
    """从 `const X = {` 开始，取到与之匹配的 `};`，抽出形如 `name:` 的键"""
    i = text.find(start_marker)
    if i < 0:
        return set()
    depth = 0
    j = i
    while j < len(text):
        if text[j] == "{":
            depth += 1
        elif text[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    body = text[i : j + 1]
    return set(re.findall(r"^\s{0,4}([a-z_][a-z0-9_]*)\s*:", body, re.M))


# ── 1. manifest 引用的文件是否存在 ──
print("1) manifest.json 引用的文件是否存在")
mf = json.loads(read(EXT / "manifest.json"))
missing = []
for cs in mf.get("content_scripts", []):
    for f in cs.get("js", []):
        if not (EXT / f).exists():
            missing.append(f)
for key in ("service_worker",):
    p = mf.get("background", {}).get(key)
    if p and not (EXT / p).exists():
        missing.append(p)
popup = mf.get("action", {}).get("default_popup")
if popup and not (EXT / popup).exists():
    missing.append(popup)
for _, p in (mf.get("icons") or {}).items():
    if not (EXT / p).exists():
        missing.append(p)

if missing:
    problems.append("manifest 引用了不存在的文件：%s" % missing)
    print("   [FAIL] %s" % missing)
else:
    print("   [OK  ] 全部存在（%d 个 content 脚本 + SW + popup + 图标）" % sum(len(c.get("js", [])) for c in mf.get("content_scripts", [])))

# 交叉校验：tabs.js 里 executeScript 补注入用的文件列表，必须和 manifest 一致
#
# v1.3.0 拆组后，manifest 有 5 组；tabs.js 把它们按依赖顺序铺平成两个数组：
#   CONTENT_FILES_MAIN  = 主文档注入（含 panel/main）
#   CONTENT_FILES_FRAME = iframe 注入（去 panel/main）
# 这里只看 MAIN 数组——它代表"主文档动态补注入"的真相。
#
# 实现形式可能是 `export const X = [ ... ]` 也可能是 `export const X = OTHER;`（先定义 OTHER）
# 两种都要覆盖。
tabs_js = read(SW / "tabs.js")
m_direct = re.search(r"CONTENT_FILES_MAIN\s*=\s*\[([^\]]+)\]", tabs_js)
if m_direct:
    inject_files = re.findall(r"'([^']+)'", m_direct.group(1))
else:
    # 间接形式（= ALL_FILES）—— 找 ALL_FILES 数组
    m_all = re.search(r"\bALL_FILES\s*=\s*\[([^\]]+)\]", tabs_js)
    if not m_all:
        problems.append("tabs.js 找不到 CONTENT_FILES_MAIN / ALL_FILES 数组")
        print("   [FAIL] tabs.js 没有 CONTENT_FILES_MAIN 数组")
        inject_files = []
    else:
        inject_files = re.findall(r"'([^']+)'", m_all.group(1))

if inject_files:
    # manifest 里把所有非网络层（net-hook / net-relay）的 js 平铺
    manifest_main = []
    for c in mf.get("content_scripts", []):
        for js in c.get("js", []):
            base = Path(js).name
            if base in ("net-hook.js", "net-relay.js"):
                continue
            manifest_main.append(js)
    if sorted(inject_files) != sorted(manifest_main):
        problems.append(
            "tabs.js 的 CONTENT_FILES_MAIN 与 manifest 的非网络层合并列表不一致。\n"
            "      manifest: %s\n      tabs.js : %s\n"
            "      （不一致会导致扩展更新后，老页面补注入的文件缺斤少两）"
            % (manifest_main, inject_files)
        )
        print("   [FAIL] tabs.js 补注入列表与 manifest 不一致")
    else:
        print("   [OK  ] tabs.js 补注入列表与 manifest 一致（%d 个文件）" % len(inject_files))

# ── 2. MCP 工具 -> commands.js 的指令名 ──
print("\n2) mcp_server.py 调用的指令名是否都在 commands.js 的 TABLE 里")
table = section_keys(read(SW / "commands.js"), "const TABLE = {")
mcp_src = read(SERVER / "mcp_server.py")
called = set(re.findall(r'\bcall\(\s*"([a-z_]+)"', mcp_src))
called |= set(re.findall(r'\bcall_data\(\s*"([a-z_]+)"', mcp_src))
unknown = sorted(called - table)
if unknown:
    problems.append("mcp_server.py 调用了 commands.js 里不存在的指令：%s" % unknown)
    print("   [FAIL] %s" % unknown)
else:
    print("   [OK  ] %d 个指令全部命中（TABLE 共 %d 项）" % (len(called), len(table)))

unused = sorted(table - called)
if unused:
    notes.append("TABLE 里这些指令没有 MCP 工具暴露：%s（可能是给插件内部或面板用的）" % unused)

# ── 3. commands/screenshot -> content/router.js 的动作名 ──
print("\n3) service worker 调用的 content 动作名是否都在 content/router.js 的 MAP 里")
# v1.3.1：路由（MAP + onMessage）已从 main.js 迁到 router.js，改为每帧注入。
#           这一步必须跟着换文件，否则校验会永远报"MAP 为空"。
ROUTER = CONTENT / "router.js"
if not ROUTER.exists():
    problems.append("找不到 content/router.js（消息路由已迁移到该文件）")
    print("   [FAIL] content/router.js 不存在")
    map_keys = set()
else:
    map_keys = section_keys(read(ROUTER), "const MAP = {")
content_actions = set()
for f in (SW / "commands.js", SW / "screenshot.js", SW / "tabs.js"):
    src = read(f)
    content_actions |= set(re.findall(r"contentCall\(\s*\w+\s*,\s*'([a-z_]+)'", src))
    content_actions |= set(re.findall(r'contentCall\(\s*\w+\s*,\s*"([a-z_]+)"', src))
    content_actions |= set(re.findall(r"action:\s*'([a-z_]+)'", src))

unknown2 = sorted(content_actions - map_keys)
if unknown2:
    problems.append("SW 里调用了 content/router.js 未实现的动作：%s" % unknown2)
    print("   [FAIL] %s" % unknown2)
else:
    print("   [OK  ] %d 个动作全部命中（MAP 共 %d 项）" % (len(content_actions), len(map_keys)))

# ── 4. 面板动作闭环 ──
print("\n4) 面板/弹窗发出的动作是否都在 service worker 的 handlePanel 里有分支")
sw_src = read(SW / "service-worker.js")
panel_cases = set(re.findall(r"case '([a-z_]+)':", sw_src))
sent = set()
for f in (CONTENT / "panel.js", EXT / "src" / "popup" / "index.js"):
    sent |= set(re.findall(r"__bb_panel:\s*true,\s*action:\s*'([a-z_]+)'", read(f)))
unknown3 = sorted(sent - panel_cases)
if unknown3:
    problems.append("面板/弹窗发了 SW 未处理的动作：%s" % unknown3)
    print("   [FAIL] %s" % unknown3)
else:
    print("   [OK  ] %d 个面板动作全部有处理分支（handlePanel 共 %d 个 case）" % (len(sent), len(panel_cases)))

# ── 5. content_scripts 的装配顺序 ──
# 拆组后不能只取第一个组 —— 必须按 all_frames 分组，分别校验依赖顺序。
# 组内文件按数组顺序注入；不同组的文件彼此独立，所以组之间不要求顺序
# （只要每组内部的依赖靠前面已经注入的就行）。
print("\n5) content 脚本装配顺序（依赖靠 manifest 的数组顺序保证）")
# 每组内部的"已注入依赖"由前面已经校验的组提供，这里只校验**这一组**的内部顺序。
# 约定：第一组（net-hook）→ 第二组（net-relay）→ 第三组（共享基础层）
#  → 第四组（picker）→ 第五组（router）→ 第六组（panel+main）
GROUP_ORDERS = [
    (["net-hook.js"], "network 主世界"),
    (["net-relay.js"], "network 转发层"),
    (["config.js", "adapter.js", "locator.js", "actions.js"], "共享基础层（每帧跑）"),
    (["picker.js"], "拾取器（每帧跑，依赖共享基础层）"),
    (["router.js"], "消息路由（每帧跑，依赖共享基础层）"),
    (["panel.js", "main.js"], "面板 + 入口（仅主文档）"),
]

groups_ok = True
for gi, (order, desc) in enumerate(GROUP_ORDERS):
    group_cs = mf["content_scripts"][gi] if gi < len(mf["content_scripts"]) else None
    actual = [Path(x).name for x in (group_cs or {}).get("js", [])]
    if actual == order:
        print("   [OK  ] 组 %d（%s）：%s" % (gi + 1, desc, " → ".join(order)))
    else:
        print("   [FAIL] 组 %d（%s）：\n      期望：%s\n      实际：%s" % (gi + 1, desc, order, actual))
        problems.append("content 脚本组 %d 顺序不对" % (gi + 1))
        groups_ok = False
        break

# 多 / 少组也要报
if groups_ok and len(mf["content_scripts"]) != len(GROUP_ORDERS):
    print("   [FAIL] content_scripts 共 %d 组，期望 %d 组" % (len(mf["content_scripts"]), len(GROUP_ORDERS)))
    problems.append("content_scripts 组数不对")
elif groups_ok:
    print("   [OK  ] 全部 %d 组装配顺序正确" % len(GROUP_ORDERS))

# ── 6. SW 模块的命名空间裸调用 ──
#
# `import * as ax from './ax.js'` 拿到的是一个**命名空间对象**，
# 必须写 `ax.axTree(...)`。写成 `axTree(...)` 在语法上完全合法（Node --check 也过），
# 但运行时抛 ReferenceError —— 而 MCP 客户端会把工具异常压成一句
# "Error executing tool xxx"，真实原因一个字都看不到。
# 2026-10-15 实测：`browser_ax` 三个 action 全军覆没，排查了整整一轮才定位到少写 `ax.`。
# 所以这一步专门把它焊死在静态校验里。
print("\n6) service worker 模块的命名空间调用（import * as X 后必须写 X.foo()）")


def _blank_comments(text: str) -> str:
    """把注释清成等长空白 —— 保留换行位置，这样行号仍然准确"""

    def blank(m):
        return re.sub(r"[^\n]", " ", m.group(0))

    text = re.sub(r"/\*.*?\*/", blank, text, flags=re.S)
    return re.sub(r"//[^\n]*", blank, text)


def _exports_of(text: str) -> set:
    names = set(
        re.findall(
            r"^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)",
            text,
            re.M,
        )
    )
    for m in re.finditer(r"^export\s*\{([^}]*)\}", text, re.M):
        for part in m.group(1).split(","):
            part = part.strip().split(" as ")[-1].strip()
            if part:
                names.add(part)
    return names


sw_exports = {p.name: _exports_of(read(p)) for p in SW.glob("*.js")}
bare_calls = []
for p in sorted(SW.glob("*.js")):
    raw = read(p)
    body = _blank_comments(re.sub(r"(?m)^\s*import .*$", lambda m: " " * len(m.group(0)), raw))
    # 本文件自己定义的名字不算裸调用（比如 screenshot.js 里有个局部 `const send`）
    local = set(re.findall(r"(?:async\s+)?function\s+([A-Za-z_$][\w$]*)", body))
    local |= set(re.findall(r"\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)", body))
    for m in re.finditer(r"^import \* as ([A-Za-z_$][\w$]*) from '\./([\w.]+)'", raw, re.M):
        ns, mod = m.group(1), m.group(2)
        for name in sw_exports.get(mod, set()):
            if name in local:
                continue
            for call in re.finditer(r"(?<![\w.$])" + re.escape(name) + r"\s*\(", body):
                if body[: call.start()].rstrip().endswith(ns + "."):
                    continue
                line = body[: call.start()].count("\n") + 1
                bare_calls.append(
                    "%s:%d 裸调用 %s()（应写 %s.%s()）" % (p.name, line, name, ns, name)
                )

if bare_calls:
    problems.append(
        "SW 模块命名空间裸调用（运行时 ReferenceError，且会被 MCP 吞成通用报错）：%s"
        % "；".join(sorted(set(bare_calls)))
    )
    print("   [FAIL] %s" % "；".join(sorted(set(bare_calls))))
else:
    print("   [OK  ] 无裸调用（%d 个模块）" % len(sw_exports))

# ── 汇总 ──
print("\n" + "=" * 62)
if problems:
    print(" 发现 %d 个问题：" % len(problems))
    for i, p in enumerate(problems, 1):
        print("  %d. %s" % (i, p))
else:
    print(" 跨文件契约全部一致。")
for n in notes:
    print(" 提示：%s" % n)
print("=" * 62)
sys.exit(1 if problems else 0)
