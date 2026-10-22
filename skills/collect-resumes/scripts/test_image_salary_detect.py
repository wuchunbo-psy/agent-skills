# -*- coding: utf-8 -*-
"""图片页薪酬检测回归测试（2026-10-22 候选人13案修复， AGENTS.md 薪酬脱敏铁律配套）。

背景：候选人13一页图片简历文本层 79 字符，「期望薪资 20-35K」画在整页图片里。
旧文档级判定（redact_salary <50 字符 / content_extractors <20 字符）双双漏判，
归档闸门绿、薪酬直传 ATS。修复=按页 image_dominant_pages（单一事实源，
redact_salary 脱敏路径与 verify_archive 闸门提取路径共用）。

跑法: python test_image_salary_detect.py   （easyocr 首次初始化约 15-20s）
覆盖: ①合成混合型 PDF（文本页+整页薪酬图）检测/闸门提取/脱敏全链+脱敏后复验
      ②真实件回归：候选人13(已脱敏)/候选人14(31页合订本) 防误报
      ③纯文本 PDF 零 OCR 快路径
"""
import io
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import fitz
from PIL import Image, ImageDraw, ImageFont

from content_extractors import image_dominant_pages, extract_pdf
from redact_salary import redact_pdf
from salary_pattern import SALARY

TMP = tempfile.mkdtemp(prefix="_test_imgsalary_")
FONT = r"C:/Windows/Fonts/simhei.ttf"
FAILURES = []


def check(name, cond, detail=""):
    tag = "✅" if cond else "❌"
    print(f"  {tag} {name}" + (f" — {detail}" if detail and not cond else ""))
    if not cond:
        FAILURES.append(name)


def build_hybrid_pdf(path):
    """合成候选人13案形态：p1 文本充实页（≥150字）+ p2 整页图片页（薪酬只在图里）。"""
    doc = fitz.open()
    p1 = doc.new_page(width=595, height=842)
    p1.insert_text((72, 100), "王小测 高级游戏美术设计师 联系电话 13800138000", fontsize=14)
    body = "工作经历：负责角色原画设计、场景气氛图、UI界面规范制定与引擎落地。" * 8
    p1.insert_textbox(fitz.Rect(72, 130, 520, 700), body, fontsize=12)
    img = Image.new("RGB", (800, 1100), "white")
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, 30)
    d.text((60, 60), "个人简历", font=f, fill="black")
    d.text((60, 200), "期望薪资：25-35K", font=f, fill="black")
    d.text((60, 280), "期望城市：广州", font=f, fill="black")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    p2 = doc.new_page(width=595, height=842)
    p2.insert_image(p2.rect, stream=buf.getvalue())
    doc.save(path)
    doc.close()


def build_text_pdf(path):
    doc = fitz.open()
    pg = doc.new_page(width=595, height=842)
    pg.insert_text((72, 100), "李测试 后端开发工程师 13800138001", fontsize=14)
    pg.insert_textbox(fitz.Rect(72, 130, 520, 700),
                      "五年Golang后端经验，高并发网关与帧同步服务器。" * 10, fontsize=12)
    doc.save(path)
    doc.close()


def main():
    print("【① 合成混合型 PDF 全链】")
    hybrid = os.path.join(TMP, "hybrid_王小测_主美.pdf")
    build_hybrid_pdf(hybrid)

    doc = fitz.open(hybrid)
    dom = image_dominant_pages(doc)
    doc.close()
    check("按页检测：p2 图像主导", dom == [1], f"实际 {dom}")

    r = extract_pdf(hybrid)
    check("闸门提取：薪酬可命中（旧代码在此漏判）", bool(SALARY.search(r.text)))
    check("闸门提取：fmt=pdf_scanned", r.fmt == "pdf_scanned", r.fmt)

    check("文本页 p1 未误判（文本充分免OCR）", 0 not in dom)

    hits, modified = redact_pdf(hybrid, dry_run=True)
    check("脱敏 dry-run：报 OCR 命中", any("OCR" in str(h[0]) for h in hits), str(hits))

    hits2, modified2 = redact_pdf(hybrid)
    check("脱敏实跑：已涂白", modified2 and len(hits2) > 0, str((hits2, modified2)))

    r2 = extract_pdf(hybrid)
    check("脱敏后复验：薪酬不再可见", not SALARY.search(r2.text))

    # 精确边界：期望城市保留（铁律1：只涂命中块，不扩几何范围）
    check("相邻字段「期望城市」未被误删", "广州" in r2.text or "期望城市" in r2.text)

    print("【② 真实件回归（防误报）】")
    xm = "<PROJECT_ROOT>/data/在招岗位候选人管理/山海弹珠项目/美术端/主美（AI美术方向）/已收集简历/10.16_5份/可推/候选人13_小米简历.pdf"
    if os.path.exists(xm):
        r3 = extract_pdf(xm)
        check("候选人13(已脱敏)：无薪酬误报", not SALARY.search(r3.text or ""))
        check("候选人13：判定为扫描件走OCR", r3.fmt == "pdf_scanned", r3.fmt)
    else:
        print("  ⚠️ 候选人13归档件不在，跳过")

    wzq = "<PROJECT_ROOT>/data/在招岗位候选人管理/山海弹珠项目/美术端/主美（AI美术方向）/已收集简历/10.16_5份/待定/候选人14_主美（AI美术方向）_18年.pdf"
    if os.path.exists(wzq):
        doc = fitz.open(wzq)
        dom2 = image_dominant_pages(doc)
        doc.close()
        check("候选人1431页：封面+作品页为图像主导", 0 in dom2 and 4 in dom2, f"实际 {dom2[:6]}")
        check("候选人1431页：文本页 p2-p4 不误判", not any(i in dom2 for i in (1, 2, 3)))
        h3, _ = redact_pdf(wzq, dry_run=True)
        check("候选人1431页：dry-run 无薪酬命中", len(h3) == 0, str(h3))
    else:
        print("  ⚠️ 候选人14归档件不在，跳过")

    print("【③ 纯文本 PDF 快路径】")
    txt = os.path.join(TMP, "text_李测试.pdf")
    build_text_pdf(txt)
    doc = fitz.open(txt)
    dom3 = image_dominant_pages(doc)
    doc.close()
    check("纯文本：零图像主导页", dom3 == [])
    r4 = extract_pdf(txt)
    check("纯文本：不走 OCR（fmt=pdf）", r4.fmt == "pdf", r4.fmt)

    shutil.rmtree(TMP, ignore_errors=True)
    print()
    if FAILURES:
        print(f"🔴 {len(FAILURES)} 项失败: {FAILURES}")
        sys.exit(1)
    print("🟢 全部通过")


if __name__ == "__main__":
    main()
