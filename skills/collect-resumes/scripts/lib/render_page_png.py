# -*- coding: utf-8 -*-
"""渲染 PDF 首页 PNG（视觉定名队列用，reaudit_duplicates.mjs 调用）。

用法:
    python render_page_png.py <pdf> <out.png> [max_width]

长图单页自动按 max_width 缩放（候选人08 8640pt 巨图教训：不缩会出几十 MB 大图）。
"""
import json
import sys

import fitz


def main():
    pdf, out = sys.argv[1], sys.argv[2]
    max_w = float(sys.argv[3]) if len(sys.argv) > 3 else 900.0
    d = fitz.open(pdf)
    pg = d[0]
    pix = pg.get_pixmap(matrix=fitz.Matrix(0.5, 0.5))
    if pix.width > max_w:
        s = max_w / pix.width
        pix = pg.get_pixmap(matrix=fitz.Matrix(0.5 * s, 0.5 * s))
    pix.save(out)
    print(json.dumps({"pages": len(d), "png": out, "w": pix.width, "h": pix.height}))


if __name__ == '__main__':
    main()
