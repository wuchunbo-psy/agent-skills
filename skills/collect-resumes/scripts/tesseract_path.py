"""tesseract 定位单一真相源（2026-08-26）。

安装器没把 tesseract 加进 PATH（此前 shutil.which 永远找不到，图片型 PDF 闸门恒报
"OCR 后端不可用"），且 chi_sim 中文包不在安装目录——本模块显式指向：
- 二进制：C:\\Program Files\\Tesseract-OCR\\tesseract.exe（v5.4.0）
- 语言包：<TESSDATA_DIR>\\（chi_sim tessdata_fast 2.4MB + eng）
可用环境变量 TESSERACT_CMD / TESSDATA_PREFIX 覆盖。
"""
import os

TESSERACT_EXE = os.environ.get("TESSERACT_CMD", r"C:\Program Files\Tesseract-OCR\tesseract.exe")
TESSDATA_DIR = os.environ.get("TESSDATA_PREFIX", "tessdata")


def ocr_available() -> bool:
    return os.path.isfile(TESSERACT_EXE)


def configure_pytesseract(pytesseract):
    """设置 pytesseract 的二进制路径与语言包目录（eng 与 chi_sim 同目录，chi_sim+eng 可用）。"""
    os.environ["TESSDATA_PREFIX"] = TESSDATA_DIR
    pytesseract.pytesseract.tesseract_cmd = TESSERACT_EXE
