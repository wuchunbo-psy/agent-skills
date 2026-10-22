# -*- coding: utf-8 -*-
"""
content_extractors.py — 统一内容提取层

支持格式：
  - PDF（PyMuPDF 提取文本）
  - 图片型 PDF（OCR，后端不可用时阻断）
  - DOCX（python-docx 提取正文/表格/页眉/页脚）
  - ZIP（安全展开后递归提取包内 PDF/DOCX）

统一返回 ExtractResult：
  text: 提取的文本
  nchar: 可提取字符数
  nimg: 图片数
  fmt: 检测到的格式
  warnings: 警告列表
  block_reason: 阻断原因（非 None = 不可放行）

"""

import os
import re

try:
    import fitz  # PyMuPDF
except ImportError:
    fitz = None

try:
    import docx as python_docx
except ImportError:
    python_docx = None


class ExtractResult:
    """统一提取结果。"""

    def __init__(self, text="", nchar=0, nimg=0, fmt="unknown",
                 warnings=None, block_reason=None):
        self.text = text
        self.nchar = nchar
        self.nimg = nimg
        self.fmt = fmt
        self.warnings = warnings or []
        self.block_reason = block_reason

    @property
    def blocked(self):
        return self.block_reason is not None

    def __repr__(self):
        return f"ExtractResult(fmt={self.fmt}, nchar={self.nchar}, nimg={self.nimg}, blocked={self.blocked})"


def _get_easyocr_reader():
    """easyocr Reader（惰性初始化，进程内缓存；失败也缓存避免每个文件重复重试 15-20s）。
    返回 Reader 或 None（未装/初始化失败 → 调用方兜底 pytesseract 或阻断）。"""
    if hasattr(_get_easyocr_reader, "_reader"):
        return _get_easyocr_reader._reader
    try:
        import easyocr
        reader = easyocr.Reader(["ch_sim", "en"], gpu=False)
        _get_easyocr_reader._reader = reader
        return reader
    except Exception:
        _get_easyocr_reader._reader = None
        return None


def _ocr_available():
    """OCR 后端是否可用：easyocr（纯 Python，本机已装）优先，tesseract 兜底。
    定位单一真相源见 tesseract_path.py。"""
    if _get_easyocr_reader() is not None:
        return True
    from tesseract_path import ocr_available
    return ocr_available()


# ---- 按页图像主导检测（单一事实源：redact_salary.py 脱敏与 verify_archive.py 闸门共用）----
# 2026-10-22 候选人13案根因：她的一页简历文本层 79 字符（<200 不被信任为纯文本、≥50 又不算
# 纯图片），「期望薪资 20-35K」画在整页图片里——文档级判定（旧 redact <50 / 旧本模块 <20）
# 双双漏判。文档级分类天生判不了混合型（前页文本 + 后页整页图，如候选人14 31 页 p2-4 文本
# p1/p5+ 全页图），必须按页判。
IMG_DOM_COVERAGE = 0.5   # 图片面积占页面比例 ≥ 此值 → 视觉主体是位图
IMG_DOM_SPARSE_TEXT = 150  # 且文本层字符数 < 此值 → 文本层不可信该页内容


def image_dominant_pages(doc):
    """识别 PDF 中「图像主导页」，返回 0-based 页序号列表。

    判定：页面上的位图面积覆盖 ≥ IMG_DOM_COVERAGE 页面面积，且文本层稀疏
    （< IMG_DOM_SPARSE_TEXT 字符）。薪酬/联系方式若只出现在图片里，只可能藏在
    这种页面上——文本充分的页面不需要 OCR（BOSS 半加密 token PDF 全是文本页，
    按页判后自然零 OCR，保留 2026-09-03 的提速成果且更精准）。
    """
    dominant = []
    for i, page in enumerate(doc):
        try:
            if len(page.get_text().strip()) >= IMG_DOM_SPARSE_TEXT:
                continue
            area = page.rect.width * page.rect.height
            if area <= 0:
                continue
            img_area = 0.0
            for info in page.get_image_info():
                r = fitz.Rect(info["bbox"]) & page.rect
                if not r.is_empty:
                    img_area += abs(r)
            if img_area / area >= IMG_DOM_COVERAGE:
                dominant.append(i)
        except Exception:
            continue
    return dominant


def extract_pdf(path):
    """
    提取 PDF 文本。
    - 文本型 PDF：直接提取
    - 含「图像主导页」的 PDF（按页判定，见 image_dominant_pages）：对这些页 OCR 后合并；
      OCR 不可用 → 阻断（fail-closed，人工看原件）
    - 加密/损坏 PDF → 阻断
    """
    if fitz is None:
        return ExtractResult(block_reason="PyMuPDF 不可用，无法提取 PDF")

    try:
        doc = fitz.open(path)
    except Exception as e:
        return ExtractResult(block_reason=f"PDF 打开失败（可能损坏/加密）: {e}")

    if doc.needs_pass:
        doc.close()
        return ExtractResult(block_reason="PDF 加密，无法提取")

    try:
        pages_text = []
        nimg = 0
        for pg in doc:
            pages_text.append(pg.get_text())
            nimg += len(pg.get_images())
        text = "\n".join(pages_text)
        nchar = len(text.strip())

        # 按页判定：图像主导页（含纯图片型整本 + 文本/图片混合型）→ 对这些页 OCR
        dominant = image_dominant_pages(doc)
        doc.close()

        if dominant:
            if not _ocr_available():
                return ExtractResult(
                    text=text, nchar=nchar, nimg=nimg, fmt="pdf_scanned",
                    block_reason="存在图像主导页（薪酬可能只在图片里），OCR 后端不可用，无法验证姓名和薪酬"
                )
            # OCR 可用：只 OCR 图像主导页（文本页不重扫，作品集文本噪声源天然排除）
            ocr_text = _ocr_pdf(path, pages=dominant)
            if ocr_text is None:
                return ExtractResult(
                    text=text, nchar=nchar, nimg=nimg, fmt="pdf_scanned",
                    block_reason="OCR 提取失败或结果不足"
                )
            merged = (text + "\n" + ocr_text) if text.strip() else ocr_text
            return ExtractResult(text=merged, nchar=len(merged.strip()), nimg=nimg, fmt="pdf_scanned")

        return ExtractResult(text=text, nchar=nchar, nimg=nimg, fmt="pdf")
    except Exception as e:
        return ExtractResult(block_reason=f"PDF 提取异常: {e}")


# 只 OCR 前 N 个图像主导页（2026-08-26 候选人02案 + 2026-08-20 候选人03案共识：
# 薪酬只出现在简历信息页即第一页，作品集页的游戏截图数值会让闸门误报；上限防超长作品集慢扫）
OCR_MAX_PAGES = 3


def _ocr_pdf(path, pages=None):
    """对指定页（0-based；默认前 3 页）做 OCR。返回提取文本或 None（失败/不足）。
    引擎 easyocr 优先（纯 Python，与 redact_salary 脱敏路径同一引擎），pytesseract 兜底。"""
    try:
        doc = fitz.open(path)
        if pages is None:
            pages = list(range(min(OCR_MAX_PAGES, len(doc))))
        page_results = []

        import io
        from PIL import Image
        reader = _get_easyocr_reader()
        if reader is not None:
            import numpy as np
            for pi in pages:
                page = doc[pi]
                # 超长图拼页防 PIL 解压炸弹：按面积自动降渲染精度（与 redact_salary 同款保护）
                area = page.rect.width * page.rect.height
                zoom = 200 / 72
                if area > 0:
                    zoom = min(zoom, (170_000_000 / area) ** 0.5)
                pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
                img = np.array(Image.frombytes("RGB", (pix.width, pix.height), pix.samples))
                detections = reader.readtext(img)
                page_results.append("\n".join(t for _, t, _ in detections))
        else:
            import pytesseract
            from tesseract_path import configure_pytesseract
            configure_pytesseract(pytesseract)
            for pi in pages:
                pix = doc[pi].get_pixmap(dpi=200)
                img = Image.open(io.BytesIO(pix.tobytes("png")))
                page_results.append(pytesseract.image_to_string(img, lang="chi_sim+eng"))
        doc.close()
        result = "\n".join(page_results)
        # OCR 噪声行过滤（2026-08-26 候选人02案第二击）：作品集文字被 OCR 揉碎后
        # （"支持1-3人组队"→"szte1-3 KBPS"）会撞薪酬正则。真薪酬行必有语境关键词，
        # 无语境的数字+K 行按噪声丢弃（真实脱敏由 redact_salary 负责，闸门只是复核层）。
        from salary_pattern import SALARY
        kept = []
        for ln in result.splitlines():
            if SALARY.search(ln) and not re.search(r"薪|资|待遇|月薪|年薪|salary", ln, re.I):
                continue
            kept.append(ln)
        result = "\n".join(kept)
        return result if len(result.strip()) >= 20 else None
    except Exception:
        return None


def extract_docx(path):
    """
    提取 DOCX 文本（正文、表格、页眉、页脚）。
    python-docx 不可用 → 阻断（不绕过）。
    """
    if python_docx is None:
        return ExtractResult(block_reason="python-docx 不可用，无法提取 DOCX")

    try:
        d = python_docx.Document(path)
    except Exception as e:
        return ExtractResult(block_reason=f"DOCX 打开失败（可能损坏/加密）: {e}")

    parts = []
    # 正文段落
    for para in d.paragraphs:
        if para.text.strip():
            parts.append(para.text)
    # 表格
    for table in d.tables:
        for row in table.rows:
            cells = [cell.text.strip() for cell in row.cells if cell.text.strip()]
            if cells:
                parts.append(" | ".join(cells))
    # 页眉页脚
    for section in d.sections:
        for para in section.header.paragraphs:
            if para.text.strip():
                parts.append(para.text)
        for para in section.footer.paragraphs:
            if para.text.strip():
                parts.append(para.text)

    text = "\n".join(parts)
    return ExtractResult(text=text, nchar=len(text.strip()), nimg=0, fmt="docx")


def _antiword_available():
    """检查 antiword 可执行文件是否在 PATH（用于老式 .doc 文本提取）。"""
    import shutil
    return shutil.which("antiword")


def extract_doc(path):
    """
    提取老式 .doc（OLE2/CFB 二进制 Word）文本。

    python-docx 只支持 .docx，不支持 .doc。antiword 可读取 .doc 纯文本。
    antiword 不可用或提取失败 → 阻断（fail-closed，不绕过）。

    注意：antiword 只能提取文本，无法用于脱敏（不能在 .doc 上涂白矩形）。
    含薪酬的 .doc 由闸门阻断，提示"转 PDF 后脱敏"。
    """
    if not _antiword_available():
        return ExtractResult(
            block_reason="老式 .doc 需要 antiword（PATH 中未找到），"
                         "无法提取验证。请安装 antiword 或转为 PDF/DOCX 后再归档"
        )
    import subprocess
    try:
        # antiword -m UTF-8.txt 强制 UTF-8 输出；-w 0 关闭自动换行（保留原始结构）
        r = subprocess.run(
            ["antiword", "-m", "UTF-8.txt", path],
            capture_output=True, timeout=60,
        )
    except subprocess.TimeoutExpired:
        return ExtractResult(block_reason=".doc 提取超时（文件过大或损坏）")
    except Exception as e:
        return ExtractResult(block_reason=f"antiword 调用失败: {e}")

    if r.returncode != 0:
        err = r.stderr.decode("utf-8", errors="replace").strip()[:120]
        return ExtractResult(block_reason=f"antiword 提取失败（可能损坏/非标准.doc）: {err}")

    text = r.stdout.decode("utf-8", errors="replace")
    nchar = len(text.strip())
    if nchar < 5:
        return ExtractResult(block_reason=".doc 提取文本过少（疑似空文档或提取异常）")

    return ExtractResult(text=text, nchar=nchar, nimg=0, fmt="doc")


def extract(path):
    """
    根据文件扩展名调度到对应提取器。
    不支持的格式 → 阻断（不假放行）。
    """
    ext = os.path.splitext(path)[1].lower()
    if ext == ".pdf":
        return extract_pdf(path)
    if ext == ".docx":
        return extract_docx(path)
    if ext == ".doc":
        return extract_doc(path)
    if ext in (".png", ".jpg", ".jpeg", ".gif", ".bmp"):
        return ExtractResult(block_reason="独立图片文件不直接验证，需先转为 PDF 或人工确认")
    return ExtractResult(block_reason=f"不支持的格式 .{ext}，无法提取验证")
