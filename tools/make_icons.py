#!/usr/bin/env python3
"""
Browser Bridge · 图标生成

用标准库手写 PNG，不依赖 Pillow —— 只为了三张小图去装一个图像库不划算。
生成的图案：深蓝圆角方块 + 白色闪电（表示"给浏览器通电"）。

用法：python tools/make_icons.py
"""

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "extension" / "icons"

BG = (24, 95, 165)      # #185FA5
FG = (230, 241, 251)    # #E6F1FB

# 闪电多边形（归一化坐标），顺序连成闭合路径
BOLT = [
    (0.60, 0.05),
    (0.27, 0.55),
    (0.46, 0.55),
    (0.38, 0.95),
    (0.74, 0.42),
    (0.53, 0.42),
]


def point_in_poly(x, y, poly):
    inside = False
    n = len(poly)
    j = n - 1
    for i in range(n):
        xi, yi = poly[i]
        xj, yj = poly[j]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-9) + xi):
            inside = not inside
        j = i
    return inside


def rounded_alpha(x, y, size, radius, softness=0.8):
    """返回该像素在圆角矩形内的覆盖度（0~1），用于抗锯齿"""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx = x - cx
    dy = y - cy
    d = (dx * dx + dy * dy) ** 0.5
    if d <= radius - softness:
        return 1.0
    if d >= radius + softness:
        return 0.0
    return (radius + softness - d) / (2 * softness)


def supersample(fn, size, ss=4):
    """超采样抗锯齿：在 ss×ss 子像素上求平均值"""
    out = []
    for py in range(size):
        row = []
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(ss):
                for sx in range(ss):
                    x = (px + (sx + 0.5) / ss) / size
                    y = (py + (sy + 0.5) / ss) / size
                    r, g, b, a = fn(x, y, size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = ss * ss
            a = acc[3] / n
            if a > 0:
                # acc[i] 累加的已经是 r*a（r 本身就是 0-255），所以除以 acc[3] 得到的就是 0-255 的加权均值
                row.append(
                    (
                        min(255, int(round(acc[0] / acc[3]))),
                        min(255, int(round(acc[1] / acc[3]))),
                        min(255, int(round(acc[2] / acc[3]))),
                        min(255, int(round(a * 255))),
                    )
                )
            else:
                row.append((0, 0, 0, 0))
        out.append(row)
    return out


def make_png(size):
    radius = size * 0.24

    def sample(x, y, s):
        px = x * s
        py = y * s
        cover = rounded_alpha(px, py, s, radius)
        if cover <= 0:
            return (0, 0, 0, 0.0)
        # 闪电区域：给一点点内缩，避免贴边
        if point_in_poly(x, y, BOLT):
            r, g, b = FG
        else:
            r, g, b = BG
        return (r, g, b, cover)

    rows = supersample(sample, size, ss=4)

    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    return png


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in (16, 48, 128):
        data = make_png(size)
        p = OUT_DIR / ("icon%d.png" % size)
        p.write_bytes(data)
        print("已生成 %s（%d 字节）" % (p, len(data)))


if __name__ == "__main__":
    main()
