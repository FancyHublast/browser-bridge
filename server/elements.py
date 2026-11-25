# -*- coding: utf-8 -*-
"""
元素库：把「定位过、确认能用的元素」按站点落盘，下次直接按名字取用。

【为什么要有它】
    在此之前，元素只能「每次现识别」：agent 每开一步都得重新 browser_find 扫一遍页面，
    或者每次去扩展的 bb_picks 里捞一遍。人拾取的结果确实存在 chrome.storage.local，
    但那是浏览器里的暂存，不是项目资产 —— 换台机器、清一次扩展数据、换一个会话就没了，
    也没有按站点归档，攒到几十条之后连自己都认不出哪条是哪条。

    落盘之后这件事就变成一次性的：
        示教一次（人拾取 / 给个选择器）
            → browser_elements(action="save")
            → 以后 browser_elements(action="get", name="登录按钮")
            → 拿到描述符直接喂给 browser_find / browser_click。

【为什么按站点分文件】
    同一个名字（"登录按钮"）在不同站点指的不是同一个元素；按 host 分文件既避免串味，
    也方便直接打开某个站点的 json 看和改。

【描述符优先于选择器】
    存的优先是描述符（带权重的属性集合，改版还能认），因为那才是「可持续」的定位方式；
    只有一个选择器时也允许存，但会标 fidelity="selector" —— 站点一改版它就归零，
    到时候重新示教一次即可。

【文件长这样】
    elements/sycm.taobao.com.json
    {
      "host": "sycm.taobao.com",
      "updatedAt": "2026-10-15T15:40:00",
      "items": [
        {
          "name": "登录按钮",
          "fidelity": "descriptor",
          "descriptor": {"v": 1, "attrs": [...]},
          "selector": "",
          "summary": "tag=button + text=\"登录\" → 唯一命中（1）",
          "url": "https://sycm.taobao.com/portal/home.htm",
          "frameUrl": "",
          "quality": {...},
          "note": "",
          "savedAt": "2026-10-15T15:40:00"
        }
      ]
    }
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from urllib.parse import urlsplit

ELEMENTS_DIR = Path(__file__).resolve().parent / "elements"

# 上限只是防止脚本化示教把文件撑爆；一个站点几十条完全够用
MAX_PER_SITE = 200

# 拿不到 host 时（chrome://、about:blank、file://）落这里，至少不丢
UNKNOWN_HOST = "_unknown"


class ElementStoreError(RuntimeError):
    """元素库读写失败。消息会直接透给 agent，所以要写清"怎么办"。"""


def host_of(url: str) -> str:
    """从 URL 里取出站点标识（netloc，含端口）。取不到就落到 _unknown。"""
    try:
        parts = urlsplit(str(url or "").strip())
    except Exception:
        return UNKNOWN_HOST
    netloc = (parts.netloc or "").strip()
    if "@" in netloc:  # 去掉可能的 user:pass@
        netloc = netloc.rsplit("@", 1)[1]
    return netloc.lower() or UNKNOWN_HOST


def _file(host: str) -> Path:
    safe = "".join(c if (c.isalnum() or c in ".-_") else "_" for c in (host or UNKNOWN_HOST))
    return ELEMENTS_DIR / (safe + ".json")


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def load(host: str) -> dict:
    """读一个站点的元素文件；不存在就返回一个空壳（不报错 —— 空库是正常状态）。"""
    path = _file(host)
    if not path.exists():
        return {"host": host or UNKNOWN_HOST, "updatedAt": "", "items": []}
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        raise ElementStoreError(
            "元素库文件解析失败（%s）：%s。可以直接删掉这个文件，从空白重来。" % (path, e)
        )
    if not isinstance(doc, dict):
        return {"host": host or UNKNOWN_HOST, "updatedAt": "", "items": []}
    doc.setdefault("items", [])
    if not isinstance(doc["items"], list):
        doc["items"] = []
    return doc


def _write(host: str, doc: dict) -> None:
    ELEMENTS_DIR.mkdir(parents=True, exist_ok=True)
    doc["host"] = host or UNKNOWN_HOST
    doc["updatedAt"] = _now()
    _file(host).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")


def _brief(item: dict, with_descriptor: bool = False) -> dict:
    out = {
        "name": item.get("name") or "",
        "fidelity": item.get("fidelity") or ("descriptor" if item.get("descriptor") else "selector"),
        "summary": item.get("summary") or "",
        "selector": item.get("selector") or "",
        "url": item.get("url") or "",
        "frameUrl": item.get("frameUrl") or "",
        "note": item.get("note") or "",
        "savedAt": item.get("savedAt") or "",
    }
    if with_descriptor:
        # descriptor 原样给出去，agent 直接当 target 传给 browser_find / browser_click
        out["descriptor"] = item.get("descriptor")
        out["quality"] = item.get("quality")
    return out


def list_sites() -> dict:
    """所有站点汇总 —— "我到底在哪些站点存过东西"。"""
    sites = []
    if ELEMENTS_DIR.exists():
        for f in sorted(ELEMENTS_DIR.glob("*.json")):
            doc: dict = {}
            items: list = []
            try:
                parsed = json.loads(f.read_text(encoding="utf-8"))
                if isinstance(parsed, dict):
                    doc = parsed
                    items = doc.get("items") or []
                    if not isinstance(items, list):
                        items = []
            except Exception:
                # 文件坏了也不该让"列出站点"整个失败 —— 照样报出来，让人知道有这个文件
                doc = {}
            sites.append(
                {
                    "host": doc.get("host") or f.stem,
                    "count": len(items),
                    "updatedAt": doc.get("updatedAt") or "",
                    "file": str(f),
                }
            )
    sites.sort(key=lambda s: s["updatedAt"], reverse=True)
    return {"sites": sites, "total": sum(s["count"] for s in sites), "dir": str(ELEMENTS_DIR)}


def list_items(host: str) -> dict:
    doc = load(host)
    items = doc.get("items") or []
    return {
        "host": doc.get("host") or host,
        "count": len(items),
        "updatedAt": doc.get("updatedAt") or "",
        "items": [_brief(i) for i in items],
        "file": str(_file(host)),
    }


def find_item(items: list, name: str):
    """先精确、再「包含」—— 和 browser_picks 的手感保持一致。"""
    want = (name or "").strip()
    if not want:
        return None
    for i in items:
        if (i.get("name") or "") == want:
            return i
    low = want.lower()
    for i in items:
        n = (i.get("name") or "")
        if n and (low in n.lower()):
            return i
    return None


def get(host: str, name: str) -> dict:
    doc = load(host)
    items = doc.get("items") or []
    hit = find_item(items, name)
    if not hit:
        return {
            "found": False,
            "host": doc.get("host") or host,
            "name": name,
            "count": len(items),
            "available": [i.get("name") for i in items],
        }
    return {
        "found": True,
        "host": doc.get("host") or host,
        "count": len(items),
        "item": _brief(hit, with_descriptor=True),
        "how_to_use": (
            "把 item.descriptor 原样传给 browser_find / browser_click 的 target 参数"
            "（以 { 开头的字符串会被识别为描述符）。"
            "也可以直接 browser_elements(action=\"locate\", name=...) 让服务端帮你定位。"
        ),
    }


def put(
    host: str,
    name: str,
    *,
    descriptor=None,
    selector: str = "",
    summary: str = "",
    url: str = "",
    frame_url: str = "",
    quality=None,
    note: str = "",
) -> dict:
    """存一条。同名覆盖 —— 人对同一元素又示教一遍，就用最新的那份。"""
    name = (name or "").strip()
    if not name:
        raise ElementStoreError("保存元素必须给 name（以后就按这个名字取）。")
    if not descriptor and not selector:
        raise ElementStoreError(
            "保存元素需要 target：要么是描述符 JSON（browser_picks/browser_find 给的），"
            "要么是一个能定位到它的选择器。"
        )

    fidelity = "descriptor" if isinstance(descriptor, dict) and descriptor.get("attrs") else "selector"
    if isinstance(descriptor, str) and not selector:
        # 传进来的是字符串却当成了 descriptor —— 当选择器用，别存成一个坏描述符
        selector, descriptor, fidelity = descriptor, None, "selector"

    item = {
        "name": name,
        "fidelity": fidelity,
        "descriptor": descriptor if fidelity == "descriptor" else None,
        "selector": selector or "",
        "summary": summary or "",
        "url": url or "",
        "frameUrl": frame_url or "",
        "quality": quality or None,
        "note": note or "",
        "savedAt": _now(),
    }

    doc = load(host)
    items = [i for i in (doc.get("items") or []) if (i.get("name") or "") != name]
    items.insert(0, item)
    if len(items) > MAX_PER_SITE:
        items = items[:MAX_PER_SITE]
    doc["items"] = items
    _write(host, doc)
    return {
        "saved": True,
        "host": host or UNKNOWN_HOST,
        "name": name,
        "fidelity": fidelity,
        "total": len(items),
        "file": str(_file(host)),
    }


def drop(host: str, name: str) -> dict:
    name = (name or "").strip()
    if not name:
        raise ElementStoreError("drop 需要 name。")
    doc = load(host)
    items = doc.get("items") or []
    kept = [i for i in items if (i.get("name") or "") != name]
    doc["items"] = kept
    _write(host, doc)
    return {"dropped": len(items) - len(kept), "remaining": len(kept), "host": doc.get("host") or host}


def import_picks(picks: list) -> dict:
    """
    把扩展里「人攒的拾取结果」一次性收进元素库，按各自 URL 的站点归档。

    这是把"浏览器里的暂存"变成"项目资产"的那一步 —— 之后 agent 不必每次都去 bb_picks 捞。
    """
    groups: dict = {}
    skipped = []
    for p in picks or []:
        if not isinstance(p, dict):
            skipped.append("非对象条目（%r）" % (p,))
            continue
        desc = p.get("descriptor")
        name = (p.get("name") or "").strip()
        if not desc or not name:
            # 带上站点，否则一堆"无名"根本看不出丢的是哪一条
            skipped.append(
                "%s（%s）" % (name or "无名", host_of(p.get("url") or "") or "无 URL")
            )
            continue
        host = host_of(p.get("frameUrl") or p.get("url") or "")
        groups.setdefault(host, []).append(p)

    result = {}
    for host, rows in groups.items():
        saved = 0
        for p in rows:
            put(
                host,
                p.get("name"),
                descriptor=p.get("descriptor"),
                selector="",
                summary=p.get("summary") or "",
                url=p.get("url") or "",
                frame_url=p.get("frameUrl") or "",
                quality=p.get("quality"),
                note="来自手动拾取",
            )
            saved += 1
        result[host] = saved

    return {
        "imported": result,
        "totalSaved": sum(result.values()),
        "skipped": skipped,
        "note": "已按站点归档到 elements/ 目录；以后用 browser_elements(action=\"get\", name=...) 取。",
    }
