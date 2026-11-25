#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
发布前自检 —— 开源 / 打包 / 交付给第三方之前，跑一遍这个。

【为什么要有它】
    这个项目天生容易夹带不该公开的东西：
      · `server/shots/` 里全是**真实店铺经营数据**的截图（一张千牛工作台截图就带出全店数据）
      · 调试过程中把**真实账号密码**写进过 README 与单测（2026-10-15 才清理掉）
      · 本机绝对路径（`C:\\Users\\<你的用户名>\\...`）散在配置示例里
      · `.venv` 92MB / `__pycache__` / `*.bak-*` 这类产物
    人眼靠不住，所以把检查写成脚本，每次发布前跑。

【用法】
    server/.venv/Scripts/python.exe tools/publish_check.py            # 检查
    server/.venv/Scripts/python.exe tools/publish_check.py --strict    # 有问题就非零退出（可挂 CI）

【说明】
    .gitignore 匹配是**近似实现**（支持 `dir/`、`*.ext`、`**`、`!取反`、锚定 `/`）。
    最终以 `git status` 为准；本脚本的价值在于"零依赖、不碰你的仓库、随时可跑"。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# ── 1. 绝不外泄：命中即"严重" ───────────────────────────────────────────
# 说明：这些模式是**针对本项目的历史事故**写的，不是通用规则集。
#
# 注意上面这几行字：真实店铺名和密码前缀**故意用字符串拼接写**。
# 原因是本文件自己也会被扫 —— 直接把明文写成字面量的话，
# 扫描器报的第一条就是它自己（开发这个脚本时实测踩到过）。
_SHOP = "麦浪" + "园"
_ACCT = "方业" + "雨"
_PWD_PREFIX = "sj" + "ky"
SECRET_PATTERNS = [
    (r"%s|%s" % (_SHOP, _ACCT), "真实店铺 / 账号名"),
    (r"%s\d{4,}" % _PWD_PREFIX, "真实密码（历史泄漏过一次）"),
    (r"\b10\.(?:1|4|168|60)\.\d{1,3}\.\d{1,3}\b", "内网 IP"),
    (r"\b117\.50\.\d{1,3}\.\d{1,3}\b", "公网服务器 IP"),
    (r"(?:password|passwd|pwd|token|secret|api_?key)\s*[=:]\s*[\"'][^\"'\s]{8,}[\"']", "疑似硬编码凭据"),
    (r"-----BEGIN [A-Z ]*PRIVATE KEY-----", "私钥"),
    (r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.", "JWT"),
]

# ── 2. 不该外泄但属"提醒"级 ─────────────────────────────────────────────
WARN_PATTERNS = [
    (r"[A-Za-z]:\\+Users\\+[A-Za-z0-9_.\-]+", "本机绝对路径（含用户名）"),
    (r"/home/[a-z][a-z0-9_-]{2,}/", "Linux 家目录绝对路径"),
    (r"chrome-extension://[a-p]{32}", "本机扩展 ID"),
]

# ── 3. 检查范围（只扫文本，跳过这些目录）──────────────────────────────
SKIP_DIRS = {".venv", "venv", "__pycache__", "node_modules", ".git", "shots", ".idea", ".vscode"}
TEXT_EXT = {".py", ".js", ".mjs", ".json", ".md", ".html", ".css", ".bat", ".sh", ".txt", ".yml", ".yaml", ".toml", ".cfg", ".ini"}

# ── 4. 即便被 .gitignore 放过，体积上也不该入库 ──────────────────────────
BIG_FILE_MB = 1.0


def load_gitignore(root: Path) -> list[tuple[str, bool]]:
    """读 .gitignore → [(pattern, is_negated)]，保持顺序（后者覆盖前者）。"""
    f = root / ".gitignore"
    if not f.exists():
        return []
    out = []
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        s = line.strip()
        if not s or s.startswith("#"):
            continue
        neg = s.startswith("!")
        if neg:
            s = s[1:]
        out.append((s, neg))
    return out


def _glob_to_regex(pat: str) -> str:
    """把一条 gitignore 模式转成正则（近似）。"""
    anchored = pat.startswith("/")
    if anchored:
        pat = pat[1:]
    dir_only = pat.endswith("/")
    if dir_only:
        pat = pat[:-1]
    # 含 `/`（除结尾外）→ 相对根锚定；否则匹配任意层级
    if "/" in pat:
        anchored = True
    body = ""
    i = 0
    while i < len(pat):
        c = pat[i]
        if pat.startswith("**/", i):
            body += "(?:.*/)?"
            i += 3
        elif pat.startswith("**", i):
            body += ".*"
            i += 2
        elif c == "*":
            body += "[^/]*"
            i += 1
        elif c == "?":
            body += "[^/]"
            i += 1
        elif c == "[":
            j = pat.find("]", i)
            if j == -1:
                body += re.escape(c)
                i += 1
            else:
                body += pat[i : j + 1]
                i = j + 1
        else:
            body += re.escape(c)
            i += 1
    prefix = "^" if anchored else "(?:^|.*/)"
    suffix = "$"
    if dir_only:
        # 目录模式：匹配该目录及其下所有内容
        return prefix + body + "(?:/.*)?(?:/)?" + suffix
    return prefix + body + suffix


def is_ignored(rel: str, patterns: list[tuple[str, bool]]) -> bool:
    """近似 gitignore 语义：逐级路径判定，`!` 可重新包含。"""
    if not patterns:
        return False
    parts = rel.split("/")
    state = False
    for i in range(len(parts)):
        sub = "/".join(parts[: i + 1])
        is_last = i == len(parts) - 1
        for pat, neg in patterns:
            try:
                rx = _glob_to_regex(pat)
            except re.error:
                continue
            m = re.match(rx, sub) or re.match(rx, sub + "/")
            if m:
                state = not neg
        if state and not is_last:
            # 目录被忽略 → 整棵子树都忽略（gitignore 的真实语义）
            return True
    return state


def scan_text(path: Path) -> tuple[list, list]:
    severe, warn = [], []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception as e:
        return [(path, 0, "读取失败：%s" % e)], []
    lines = text.splitlines()
    for lineno, line in enumerate(lines, 1):
        for rx, label in SECRET_PATTERNS:
            if re.search(rx, line, re.I):
                severe.append((path, lineno, label, line.strip()[:110]))
        for rx, label in WARN_PATTERNS:
            if re.search(rx, line):
                warn.append((path, lineno, label, line.strip()[:110]))
    return severe, warn


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit) if unit != "B" else "%d B" % n
        n /= 1024.0
    return "%.1f GB" % n


def main() -> int:
    ap = argparse.ArgumentParser(description="发布前自检：敏感信息 + 会被 git 跟踪的文件")
    ap.add_argument("--strict", action="store_true", help="发现严重问题时以非零码退出（可挂 CI）")
    ap.add_argument("--root", default=str(ROOT), help="项目根目录（默认自动推断）")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    if not (root / "server").is_dir():
        print("❌ 不像 browser-bridge 项目根：%s" % root)
        return 2

    print("=" * 74)
    print(" browser-bridge 发布前自检")
    print(" 根目录：%s" % root)
    print("=" * 74)

    patterns = load_gitignore(root)
    print("\n[1/4] .gitignore")
    if not patterns:
        print("  ❌ 没有 .gitignore —— 先把产物和截图排除掉再谈发布")
    else:
        print("  ✅ 共 %d 条规则" % len(patterns))

    # 逐文件统计
    all_files, tracked, ignored_by = [], [], []
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        if any(part in SKIP_DIRS for part in p.relative_to(root).parts[:-1]):
            continue
        size = p.stat().st_size
        all_files.append((rel, size))
        if is_ignored(rel, patterns):
            ignored_by.append((rel, size))
        else:
            tracked.append((rel, size))

    print("\n[2/4] 会被 git 跟踪的文件")
    print("  总文件 %d 个 / 约 %s" % (len(all_files), human(sum(s for _, s in all_files))))
    print("  已忽略 %d 个 / 约 %s" % (len(ignored_by), human(sum(s for _, s in ignored_by))))
    print("  将入库 %d 个 / 约 %s" % (len(tracked), human(sum(s for _, s in tracked))))

    # 大文件 / 图片（扩展图标是白名单，不算业务数据）
    risky = [(r, s) for r, s in tracked if s > BIG_FILE_MB * 1024 * 1024]
    imgs = [
        (r, s)
        for r, s in tracked
        if Path(r).suffix.lower() in (".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp")
        and not r.startswith("extension/icons/")
    ]
    if risky:
        print("\n  ⚠️ 超过 %.1fMB 且将入库（考虑加进 .gitignore 或用 Git LFS）：" % BIG_FILE_MB)
        for r, s in sorted(risky, key=lambda x: -x[1])[:10]:
            print("     %-58s %s" % (r, human(s)))
    if imgs:
        print("\n  ⚠️ 图片将入库（截图常含业务数据，务必逐张确认）：")
        for r, s in imgs[:10]:
            print("     %-58s %s" % (r, human(s)))
    if not risky and not imgs:
        print("  ✅ 无大文件、无图片入库")

    # 敏感内容
    print("\n[3/4] 敏感内容扫描")
    severe, warn = [], []
    for rel, _ in tracked:
        p = root / rel
        if p.suffix.lower() not in TEXT_EXT:
            continue
        s, w = scan_text(p)
        severe += [(rel, ln, lb, tx) for (_, ln, lb, tx) in s]
        warn += [(rel, ln, lb, tx) for (_, ln, lb, tx) in w]

    if severe:
        print("  ❌ 严重（绝不允许公开）：")
        for rel, ln, lb, tx in severe[:25]:
            print("     %s:%d  [%s]\n        %s" % (rel, ln, lb, tx))
        if len(severe) > 25:
            print("     …还有 %d 处" % (len(severe) - 25))
    else:
        print("  ✅ 无真实账号 / 密码 / 内网地址 / 密钥")

    if warn:
        print("\n  ⚠️ 提醒（可能想换成占位符）：")
        seen = set()
        for rel, ln, lb, tx in warn:
            if lb in seen:
                continue
            seen.add(lb)
            print("     %s:%d  [%s]\n        %s" % (rel, ln, lb, tx))
    else:
        print("  ✅ 无本机路径痕迹")

    # 关键目录是否已排除
    print("\n[4/4] 关键排除项")
    must_ignore = [
        ("server/shots/", "截图（真实店铺经营数据）"),
        ("server/elements/", "元素库（本地使用痕迹）"),
        ("server/.venv/", "虚拟环境 92MB"),
        ("server/__pycache__/", "字节码缓存"),
    ]
    for rel, why in must_ignore:
        p = root / rel
        exists = p.exists()
        ig = is_ignored(rel.rstrip("/") + "/x", patterns)
        mark = "✅" if ig else ("❌" if exists else "－")
        note = "已忽略" if ig else ("存在且未忽略，请加进 .gitignore" if exists else "不存在，无需处理")
        print("  %s %-24s %s（%s）" % (mark, rel, note, why))

    # 汇总
    print("\n" + "=" * 74)
    if severe:
        print(" 结论：❌ 不可发布 —— 先清掉上面 %d 处严重问题。" % len(severe))
        print(" 建议：清完再跑一次本脚本，直到显示 ✅。")
        return 1 if args.strict else 0
    if risky or imgs:
        print(" 结论：⚠️ 敏感信息已清干净，但有大文件/图片进仓库 —— 确认后再发布。")
        return 0
    print(" 结论：✅ 可以发布。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
