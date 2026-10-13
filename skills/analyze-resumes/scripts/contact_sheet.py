# -*- coding: utf-8 -*-
"""作品集缩略图墙 + 定点补渲染（portfolio-eye 专用，补"前8页封顶"的尾部盲区）。

两种模式：
  1) 图墙（默认）：全页低清渲染拼成网格图（每格左下角标页码 pN），1-2 张看全貌。
     用法：python contact_sheet.py <pdf> <outdir> [--cols 4] [--thumb-w 360] [--per-sheet 16]
  2) 定点补渲染：--pages 9-15（或 9,11-13），指定页全尺寸渲染成 pages_pNN.png，供图墙发现疑点后细看。
     用法：python contact_sheet.py <pdf> <outdir> --pages 9-15 [--zoom 1.6]

输出写到 <outdir>，stdout 打印生成文件路径清单（逐行）。
"""
import sys, os, json, argparse
import fitz
from PIL import Image, ImageDraw


def parse_pages(spec, total):
    """'9-15' / '9,11-13' -> 有序去重页号列表（1-based）。"""
    pages = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-", 1)
            lo, hi = int(a), int(b)
        else:
            lo = hi = int(part)
        for p in range(max(1, lo), min(total, hi) + 1):
            pages.add(p)
    return sorted(pages)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf", help="作品集 PDF 路径")
    ap.add_argument("outdir", help="输出目录")
    ap.add_argument("--cols", type=int, default=4, help="图墙列数（默认4）")
    ap.add_argument("--thumb-w", type=int, default=360, help="图墙单页缩略宽px（默认360）")
    ap.add_argument("--per-sheet", type=int, default=16, help="每张墙最多格数（默认16）")
    ap.add_argument("--pages", default=None, help="定点补渲染页号，如 9-15 或 9,11-13（传此参则不生成图墙）")
    ap.add_argument("--zoom", type=float, default=1.6, help="定点补渲染缩放（默认1.6）")
    args = ap.parse_args()

    if not os.path.isfile(args.pdf):
        print(json.dumps({"error": f"文件不存在：{args.pdf}"}), file=sys.stderr)
        sys.exit(2)
    os.makedirs(args.outdir, exist_ok=True)
    doc = fitz.open(args.pdf)
    total = len(doc)
    outs = []

    if args.pages:
        for p in parse_pages(args.pages, total):
            page = doc[p - 1]
            pix = page.get_pixmap(matrix=fitz.Matrix(args.zoom, args.zoom))
            out = os.path.join(args.outdir, f"pages_p{p:02d}.png")
            pix.save(out)
            outs.append(out)
    else:
        thumbs = []
        for i, page in enumerate(doc):
            z = args.thumb_w / max(page.rect.width, 1)
            pix = page.get_pixmap(matrix=fitz.Matrix(z, z))
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            thumbs.append((i + 1, img))
        label_h = 20
        pad = 8
        for s in range(0, total, args.per_sheet):
            batch = thumbs[s:s + args.per_sheet]
            rows = (len(batch) + args.cols - 1) // args.cols
            cell_w = max(im.width for _, im in batch)
            cell_h = max(im.height for _, im in batch) + label_h
            sheet = Image.new("RGB", (cell_w * args.cols + pad * (args.cols + 1),
                                      cell_h * rows + pad * (rows + 1)), (30, 30, 30))
            d = ImageDraw.Draw(sheet)
            for idx, (pno, im) in enumerate(batch):
                r, c = divmod(idx, args.cols)
                x = pad + c * (cell_w + pad)
                y = pad + r * (cell_h + pad)
                sheet.paste(im, (x + (cell_w - im.width) // 2, y))
                d.text((x + 4, y + cell_h - label_h - 2), f"p{pno}", fill=(255, 215, 0))
            out = os.path.join(args.outdir, f"contact_sheet_{s // args.per_sheet + 1}.png")
            sheet.save(out)
            outs.append(out)
        print(f"# pages={total} sheets={len(outs)}")
    doc.close()
    for o in outs:
        print(o)


if __name__ == "__main__":
    main()
