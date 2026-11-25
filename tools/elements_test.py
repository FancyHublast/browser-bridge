#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
元素库单测（server/elements.py）—— 纯离线，不碰浏览器、不碰真实元素库。

它守的是这几条契约：
  · 按站点分文件，不同站点同名元素互不干扰
  · 同名覆盖（人对同一元素又示教一遍，不该堆出第二条）
  · 描述符优先，只有选择器时降级但不丢
  · 缺 name / 缺 target 要报**可读**的错，而不是写进一条坏数据
  · import_picks 按各自 URL 归档，坏条目跳过但要说得清跳过了什么
  · 文件损坏时 list_sites 不炸、load 报可读错

用法：python tools/elements_test.py
"""
from __future__ import annotations

import json
import pathlib
import shutil
import sys

_ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_ROOT / "server"))

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

import elements  # noqa: E402

TMP = _ROOT / "server" / "_tmp_elements_test"

_ok = 0
_bad = 0


def check(name, cond, extra=""):
    global _ok, _bad
    if cond:
        _ok += 1
        print("  ok   %s%s" % (name, ("  " + extra) if extra else ""))
    else:
        _bad += 1
        print("  FAIL %s%s" % (name, ("  " + extra) if extra else ""))


def main() -> int:
    if TMP.exists():
        shutil.rmtree(TMP)
    elements.ELEMENTS_DIR = TMP  # 隔离：别动真实元素库

    d = {"v": 1, "attrs": [{"k": "text", "v": "登录", "m": "eq", "w": 2}]}

    print("1) host 提取")
    check("普通 URL", elements.host_of("https://sycm.taobao.com/portal/home.htm") == "sycm.taobao.com")
    check("带端口", elements.host_of("http://127.0.0.1:8080/x") == "127.0.0.1:8080")
    check("去掉 user:pass", elements.host_of("https://u:p@a.com/x") == "a.com")
    check("空 URL 落到 _unknown", elements.host_of("") == "_unknown")
    check("scheme 大小写无关", elements.host_of("HTTPS://A.com/x") == "a.com")

    print("2) 存 / 取")
    r = elements.put("sycm.taobao.com", "登录按钮", descriptor=d, summary="text=登录")
    check("save 标记为 descriptor", r["saved"] and r["fidelity"] == "descriptor")
    g = elements.get("sycm.taobao.com", "登录按钮")
    check("get 能拿回描述符", g["found"] and g["item"]["descriptor"]["attrs"][0]["v"] == "登录")
    check("get 支持名字包含匹配", elements.get("sycm.taobao.com", "登录")["found"])
    miss = elements.get("sycm.taobao.com", "不存在")
    check("取不到时 found=False 且列出可选项", miss["found"] is False and miss["available"] == ["登录按钮"])

    print("3) 同名覆盖")
    elements.put("sycm.taobao.com", "登录按钮", descriptor=d, summary="第二版")
    items = elements.list_items("sycm.taobao.com")["items"]
    same = [i for i in items if i["name"] == "登录按钮"]
    check("同名只有一条", len(same) == 1)
    check("内容是新的", same[0]["summary"] == "第二版")

    print("4) 只有选择器时降级但不丢")
    r = elements.put("sycm.taobao.com", "导出", selector="#export-btn")
    check("fidelity=selector", r["fidelity"] == "selector")
    check("选择器能取回", elements.get("sycm.taobao.com", "导出")["item"]["selector"] == "#export-btn")

    print("5) 缺参数要报可读错（不能写坏数据）")
    for kw, label in (({"name": ""}, "缺 name"), ({"name": "x"}, "缺 target")):
        try:
            elements.put("sycm.taobao.com", kw["name"], descriptor=None, selector="")
            check(label, False)
        except elements.ElementStoreError:
            check(label, True)

    print("6) 站点隔离")
    elements.put("myseller.taobao.com", "登录按钮", descriptor=d, summary="另一个站的")
    check(
        "同一个名字在不同站点互不影响",
        elements.get("sycm.taobao.com", "登录按钮")["item"]["summary"] == "第二版",
    )
    check(
        "myseller 上的是自己的那份",
        elements.get("myseller.taobao.com", "登录按钮")["item"]["summary"] == "另一个站的",
    )
    s = elements.list_sites()
    check("list_sites 汇总 2 个站点", len(s["sites"]) == 2, str(sorted(x["host"] for x in s["sites"])))

    print("7) import_picks 按各自 URL 归档")
    picks = [
        {"name": "搜索框", "descriptor": d, "url": "https://sycm.taobao.com/a", "frameUrl": "https://sycm.taobao.com/a"},
        {"name": "结算", "descriptor": d, "url": "https://myseller.taobao.com/b", "frameUrl": ""},
        {"name": "", "descriptor": d, "url": "https://x.com/"},        # 无名 → 跳过
        {"name": "y", "descriptor": None, "url": "https://x.com/"},    # 无描述符 → 跳过
        "not-a-dict",                                                  # 非对象 → 跳过
    ]
    ir = elements.import_picks(picks)
    check("归档到 2 个站点", ir["totalSaved"] == 2, json.dumps(ir["imported"], ensure_ascii=False))
    check("跳过 3 条且说明得清", len(ir["skipped"]) == 3, str(ir["skipped"]))
    check("跳过的条目带站点信息", all("x.com" in s or "非对象" in s for s in ir["skipped"]))
    check("sycm 收到 搜索框", elements.get("sycm.taobao.com", "搜索框")["found"])
    check("myseller 收到 结算", elements.get("myseller.taobao.com", "结算")["found"])

    print("8) drop")
    d1 = elements.drop("sycm.taobao.com", "导出")
    check("drop 计数正确", d1["dropped"] == 1 and d1["remaining"] == 2)
    check("drop 后取不到", elements.get("sycm.taobao.com", "导出")["found"] is False)

    print("9) 坏文件不炸")
    (TMP / "broken.taobao.com.json").write_text("{ 这不是 json", encoding="utf-8")
    try:
        s = elements.list_sites()
        check("list_sites 容忍坏文件", True, "%d 个文件" % len(s["sites"]))
    except Exception as e:  # noqa: BLE001
        check("list_sites 容忍坏文件", False, repr(e))
    try:
        elements.load("broken.taobao.com")
        check("load 坏文件要报可读错", False)
    except elements.ElementStoreError as e:
        check("load 坏文件要报可读错", "元素库文件解析失败" in str(e))

    print("10) 上限保护")
    for i in range(elements.MAX_PER_SITE + 5):
        elements.put("limit.test", "item-%d" % i, selector="#x")
    n = len(elements.list_items("limit.test")["items"])
    check("超过 MAX_PER_SITE 会截断", n == elements.MAX_PER_SITE, "%d 条" % n)

    shutil.rmtree(TMP, ignore_errors=True)
    print("\n" + "=" * 60)
    print("元素库：%d 项通过，%d 项失败" % (_ok, _bad))
    return 1 if _bad else 0


if __name__ == "__main__":
    sys.exit(main())
