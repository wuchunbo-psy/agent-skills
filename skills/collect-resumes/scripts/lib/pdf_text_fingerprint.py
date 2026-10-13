# -*- coding: utf-8 -*-
"""PDF 文本指纹：重审"重复排除"时的内容比对依据（reaudit_duplicates.mjs 调用）。

用法:
    python pdf_text_fingerprint.py <pdf1> <pdf2> [...]

输出 JSON 数组（每文件一项）:
    [{"path": ..., "pages": N, "text": "<全页文本、去空白拼接>"}, ...]
    解析失败的文件项为 {"path": ..., "error": "..."}

为什么用文本层而不是像素/SHA：BOSS/邮箱侧同一份 PDF 重导出后字节级 SHA 必不同、
像素因重压缩而漂移，但文本层稳定——文本指纹一致=同一份文档的重导出。
仅当文本量足够（调用方判断）时文本比对才有意义；纯图片型 PDF 文本为空，不可据此判同。
"""
import json
import re
import sys

import fitz


def main():
    out = []
    for p in sys.argv[1:]:
        try:
            d = fitz.open(p)
            text = ''.join(pg.get_text() for pg in d)
            text = re.sub(r'\s+', '', text)
            out.append({"path": p, "pages": len(d), "text": text})
        except Exception as e:  # noqa: BLE001 —— 单文件坏不拖垮整批
            out.append({"path": p, "error": str(e)})
    print(json.dumps(out, ensure_ascii=False))


if __name__ == '__main__':
    main()
