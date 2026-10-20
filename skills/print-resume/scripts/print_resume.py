# -*- coding: utf-8 -*-
"""打印候选人简历：定位归档文件 → 自动截取简历部分（作品集合订本） → SumatraPDF 静默直打。

用法:
  python print_resume.py --name 杨甜                     # auto：自动定位+自动截取+直接打
  python print_resume.py --name 杨甜 --dry-run           # 只看决策，不出纸
  python print_resume.py --pdf "F:/.../某简历.pdf" --pages 1-5   # 手动指定文件和页范围
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

import fitz

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT", "")
DEFAULT_PRINTER = os.environ.get("PRINTER_NAME", "")
SUMATRA = os.path.expandvars(r"%LOCALAPPDATA%/SumatraPDF/SumatraPDF.exe")
# 打印任务名=文件全路径（本机 SumatraPDF 3.6.1 写死，docname= 选项新版才有），
# 副本必须放盘符根目录，任务名才只剩「F:\岗位_姓名.pdf」
PRINT_STAGE = r"F:/"
NOTES_DIR = os.path.join(os.environ.get("PROJECT_ROOT", os.getcwd()), "notes")
REDACT_SCRIPT = os.path.expanduser(
    r"~/.agents/skills/collect-resumes/scripts/redact_salary.py")

# 作品集分界标记：从第2页起首次命中处的前一页 = 简历部分末页
# （第1页是基本信息/封面，跳过以防"附作品集链接"类字样误伤）
PORTFOLIO_MARKERS = [
    "个人作品", "作品集", "项目展示", "部分展示", "作品赏析",
    "PORTFOLIO", "Portfolio", "portfolio", "WORKS", "Works",
]

SHORT_DOC_MAX = 8  # 页数 ≤ 此值视为纯简历文件，全打
MAX_COPIES = 5

# 薪酬提示词（宽匹配，只当触发器）：命中即调 collect-resumes 的权威脱敏脚本白覆盖
SALARY_HINT = re.compile(
    r"面议|期望薪资|当前薪资|薪资|月薪|年薪|待遇|\d+\s*[-~]\s*\d+\s*[KkWw万]")

# SumatraPDF 官方退出码语义
EXIT_CODES = {
    0: "成功",
    1: "打印失败（未细分原因，检查打印机状态/纸张）",
    2: "文件打不开（路径/损坏）",
    3: "文档禁止打印",
    4: "打印机不存在（检查打印机名/连接）",
    5: "打印机驱动调用失败",
}


def fail(msg):
    print(f"❌ {msg}")
    sys.exit(2)


def find_pdfs(name):
    """在归档库搜候选人 PDF。返回命中列表（排除 _vision_ 定位目录）。"""
    hits = glob.glob(f"{ARCHIVE_ROOT}/**/*{name}*.pdf", recursive=True)
    hits = [h for h in sorted(set(hits)) if "_vision_" not in h]
    return hits


def find_zips(name):
    """在归档库搜候选人作品包 zip（兜底①：简历本体可能只在包里）。"""
    hits = glob.glob(f"{ARCHIVE_ROOT}/**/*{name}*.zip", recursive=True)
    return [h for h in sorted(set(hits)) if "_vision_" not in h]


def resume_from_zip(zip_path):
    """解出 zip 内简历本体到 %TEMP%。返回 (path, None)；拿不准时返回 (None, 候选列表)。"""
    with zipfile.ZipFile(zip_path) as z:
        docs = [i.filename for i in z.infolist()
                if not i.is_dir()
                and i.filename.lower().endswith((".pdf", ".doc", ".docx"))]
        non_pf = [p for p in docs
                  if not any(m in os.path.basename(p) for m in PORTFOLIO_MARKERS[:6])]
        cand = [p for p in non_pf if "简历" in os.path.basename(p)] or non_pf or docs
        if len(cand) != 1:
            return None, cand
        out = os.path.join(tempfile.gettempdir(), "_print_" + os.path.basename(cand[0]))
        with z.open(cand[0]) as s, open(out, "wb") as d:
            shutil.copyfileobj(s, d)
        return out, None


def wps_to_pdf(src, name):
    """老版 .doc/.docx → PDF。本机 Word COM 不可用，WPS（KWPS.Application）可用。

    PS1 及其引用的路径必须纯 ASCII：PowerShell 5.1 无 BOM 脚本按 ANSI 读，中文会乱码；
    临时名固定 ASCII 即可，打副本阶段会按「岗位_姓名」重命名。
    """
    dst = os.path.join(tempfile.gettempdir(), "_print_ats_converted.pdf")
    ascii_src = os.path.join(tempfile.gettempdir(), "_print_doc_src.doc")
    shutil.copyfile(src, ascii_src)
    ps = os.path.join(tempfile.gettempdir(), "_print_doc2pdf.ps1")
    src_n = ascii_src.replace("\\", "/")
    dst_n = dst.replace("\\", "/")
    with open(ps, "w", encoding="ascii") as f:
        f.write(
            "$ErrorActionPreference='Stop'\n"
            "try{\n"
            "$w=New-Object -ComObject KWPS.Application\n"
            "$w.Visible=$false\n"
            f"$d=$w.Documents.Open('{src_n}',$false,$true)\n"
            f"$d.ExportAsFixedFormat('{dst_n}',17)\n"
            "$d.Close($false)\n"
            "$w.Quit()\n"
            "Write-Output 'OK'\n"
            "}catch{Write-Output ('FAIL: '+$_.Exception.Message);exit 1}\n")
    r = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps],
        capture_output=True, timeout=180)
    out = (r.stdout or b"").decode("utf-8", "replace")
    if "OK" not in out or not os.path.exists(dst):
        fail(f"WPS 转 PDF 失败：{out.strip()[:200]}")
    print(f"🔁 WPS 转 PDF 完成：{os.path.basename(src)} → {os.path.basename(dst)}")
    return dst


def redact_check(pdf_path):
    """兜底来源（zip 解出/ATS 原件）不保证脱敏态：文本层扫薪酬，命中即调权威脚本白覆盖。"""
    doc = fitz.open(pdf_path)
    text = "".join(p.get_text() for p in doc)
    doc.close()
    if len(text.strip()) < 50:
        print("⚠️ 该 PDF 无文本层（图片型），无法自动核薪酬——共享打印机，介意请先目检。")
        return
    if SALARY_HINT.search(text):
        r = subprocess.run([sys.executable, REDACT_SCRIPT, pdf_path],
                           capture_output=True, timeout=300)
        out = (r.stdout or b"").decode("utf-8", "replace")
        if r.returncode != 0 or "已脱敏" not in out:
            print(f"⚠️ 薪酬脱敏脚本异常（out 尾部: {out.strip()[-150:]}），请目检后决定。")
        else:
            print("🛡️ 命中薪酬字段，已自动脱敏（白色覆盖）。")


def ats_locate(name, talent_id=None):
    """兜底②：归档全 miss → 飞书招聘 ATS 拉最新简历附件，doc 自动转 PDF。

    talent_id 来源优先级：--talent-id > 今日面试名单（面试语境自带，最权威）
    > 人才缓存（同名多条 fail-closed 让人挑）。
    """
    try:
        sys.path.insert(0, NOTES_DIR)
        from lib.hire_api import hire_api, hire_get_talent
    except ImportError as e:
        fail(f"ATS 兜底需要 lib/hire_api 模块：{e}")

    tid, source = talent_id, "--talent-id"
    if not tid:
        rev = os.path.join(NOTES_DIR, "_daily_review.json")
        if os.path.exists(rev):
            with open(rev, encoding="utf-8") as f:
                st = (json.load(f).get("structured") or {})
            for iv in st.get("today_interviews") or []:
                if iv.get("name") == name and iv.get("talent_id"):
                    tid, source = iv["talent_id"], "今日面试名单"
                    break
    if not tid:
        cache_p = os.path.join(NOTES_DIR, "_talents_cache.json")
        if os.path.exists(cache_p):
            with open(cache_p, encoding="utf-8") as f:
                items = json.load(f).get("items") or []
            same = [i for i in items if i.get("name") == name]
            if len(same) == 1:
                tid, source = same[0]["id"], "人才缓存"
            elif len(same) > 1:
                same.sort(key=lambda t: int(t.get("modify_time") or 0), reverse=True)
                print(f"❓ 人才缓存里有 {len(same)} 个同名「{name}」，不敢猜（--talent-id 指定其一）：")
                for i, t in enumerate(same[:8], 1):
                    tail = (t.get("mobile") or "")[-4:]
                    print(f"   [{i}] talent={t['id']} 手机尾号{tail or '?'}")
                sys.exit(2)
    if not tid:
        fail(f"归档库无「{name}」且人才缓存查不到。给 --talent-id，或此人还没录 ATS。")

    print(f"🔎 归档未命中，ATS 兜底：talent={tid}（talent_id 来源：{source}）")
    talent = hire_get_talent(tid) or {}
    atts = [a for a in (talent.get("resume_attachment_list") or []) if a.get("ID")]
    if not atts:
        fail(f"ATS 人才 {tid}（{name}）名下没有简历附件。")
    atts.sort(key=lambda a: int(a.get("CreateTime") or 0), reverse=True)
    att = atts[0]
    print(f"📎 简历附件: {att.get('Name')}（取最新1份，名下共{len(atts)}份）")

    d = hire_api("GET", f"/open-apis/hire/v1/attachments/{att['ID']}",
                 params={"type": 1})
    url = ((d.get("data") or {}).get("attachment") or {}).get("url")
    if not url:
        fail("ATS 未返回下载链接（链接有效期30分钟），重跑一次即可。")
    import requests
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    ext = os.path.splitext(att.get("Name") or "")[1] or ".bin"
    raw = os.path.join(tempfile.gettempdir(), f"_print_ats_{name}{ext}")
    with open(raw, "wb") as f:
        f.write(r.content)

    head = open(raw, "rb").read(4)
    if head == b"%PDF":
        pdf_path = raw
    else:
        pdf_path = wps_to_pdf(raw, name)
    redact_check(pdf_path)
    return pdf_path


def open_doc(path):
    if not path.lower().endswith(".pdf"):
        fail(f"不是 PDF 文件：{path}（本 skill 只处理 PDF）")
    if not os.path.exists(path):
        fail(f"文件不存在：{path}")
    return fitz.open(path)


def find_resume_end(doc):
    """返回简历部分末页页码（0-based）。返回 None = 无法自动判断，须人工给 --pages。"""
    n = doc.page_count
    if n <= SHORT_DOC_MAX:
        return n - 1
    for i in range(1, n):
        text = doc[i].get_text()
        if any(m in text for m in PORTFOLIO_MARKERS):
            return i - 1
    return None


def extract_pages(src_doc, pages, dst):
    """重建式截页（show_pdf_page），只携带目标页实际引用的资源。

    不能用 doc.select()：合订本 PDF 常共享整套资源字典（PPT 导出特征），
    select 会把未引用图片全部带上，98页19MB 截5页仍是19MB。
    """
    new = fitz.open()
    for i in pages:
        rect = src_doc[i].rect
        page = new.new_page(width=rect.width, height=rect.height)
        page.show_pdf_page(rect, src_doc, i)
    new.save(dst, garbage=4, deflate=True)
    return dst


def parse_pages(spec, doc):
    """解析页范围 → 0-based 页码列表。all=全部；auto=智能截取；N-M=指定。"""
    n = doc.page_count
    if spec == "all":
        return list(range(n)), "全部"
    if spec == "auto":
        end = find_resume_end(doc)
        if end is None:
            print(f"❓ {n} 页且未找到作品集分界标记（{', '.join(PORTFOLIO_MARKERS[:5])}…），不敢自动截。")
            print("   各页开头摘要（前12页）：")
            for i in range(min(12, n)):
                head = doc[i].get_text().strip().replace("\n", " ")[:40]
                print(f"   第{i+1}页: {head or '(无文本层)'}")
            fail(f"请用 --pages N-M 指定简历部分页范围（共{n}页）")
        pages = list(range(0, end + 1))
        why = f"auto：第{end+2}页起为作品集，截取第1-{end+1}页" if end + 1 < n else f"auto：{n}页≤{SHORT_DOC_MAX}全打"
        return pages, why
    try:
        a, b = spec.split("-")
        a, b = int(a), int(b)
        assert 1 <= a <= b <= n
        return list(range(a - 1, b)), f"指定第{a}-{b}页"
    except Exception:
        fail(f"--pages 格式错误：{spec}（应为 auto / all / N-M，且 N≤M≤总页数{n}）")


def locate_by_name(name, talent_id):
    """--name 定位兜底链：归档 PDF → 归档 zip 作品包 → ATS。返回 (pdf_path, label_hint)。"""
    hits = find_pdfs(name)
    if hits:
        if len(hits) > 1:
            # 文件名带作品集标记的自动降级（打简历不打作品集）；仍剩多个才停下来让人选
            non_pf = [h for h in hits if not any(m in os.path.basename(h) for m in PORTFOLIO_MARKERS[:6])]
            if len(non_pf) == 1:
                hits = non_pf
            else:
                print(f"❓ 搜到 {len(hits)} 个文件，请指定其一（--pdf 路径）：")
                for i, h in enumerate(hits, 1):
                    print(f"   [{i}] {h}")
                sys.exit(2)
        return hits[0], None

    # 兜底①：zip 作品包（简历本体只在包里，如李菲「简历+作品」整包归档）
    zhits = find_zips(name)
    if len(zhits) > 1:
        print(f"❓ 搜到 {len(zhits)} 个作品包，请指定其一（--pdf 直接解出会太重，先人工确认）：")
        for i, h in enumerate(zhits, 1):
            print(f"   [{i}] {h}")
        sys.exit(2)
    if len(zhits) == 1:
        print(f"📦 归档无独立 PDF，命中作品包：{zhits[0]}")
        member, cand = resume_from_zip(zhits[0])
        if member is None and cand:
            # 包里有文档但认不出简历本体：简历多半就在包里，自动落 ATS 可能打错附件，fail-closed
            print(f"❓ 包内 {len(cand)} 个文档拿不准哪个是简历本体：")
            for i, m in enumerate(cand, 1):
                print(f"   [{i}] {m}")
            fail("用 --pdf 先解压再指定路径。")
        if member is not None:
            if not member.lower().endswith(".pdf"):
                member = wps_to_pdf(member, name)
            redact_check(member)
            segs = os.path.normpath(zhits[0]).replace("\\", "/").split("/")
            label = None
            if "已收集简历" in segs and segs.index("已收集简历") > 0:
                label = f"{segs[segs.index('已收集简历') - 1]}_{name}"
            return member, label
        # 包内零文档（纯视频/图片作品包，如胡锦程_作品视频.zip 只有 mp4）：简历铁定不在包里，落 ATS 兜底②
        print("📭 包内无 pdf/doc/docx 简历文档（纯作品包），继续 ATS 兜底")

    # 兜底②：ATS（从未走过本地归档管线的人，如业务直接在飞书招聘建的档）
    return ats_locate(name, talent_id), f"{name}(ATS简历)"


def main():
    ap = argparse.ArgumentParser(description="简历静默直打（SumatraPDF）")
    ap.add_argument("--name", help="候选人姓名，在归档库模糊搜索")
    ap.add_argument("--pdf", help="直接指定 PDF 路径（优先于 --name）")
    ap.add_argument("--talent-id", help="ATS 兜底直指人才 ID（同名歧义时用）")
    ap.add_argument("--pages", default="auto", help="auto(默认)/all/N-M")
    ap.add_argument("--copies", type=int, default=1, help=f"份数，默认1，最多{MAX_COPIES}")
    ap.add_argument("--duplex", choices=["auto", "short", "long", "off"], default="auto",
                    help="auto(默认，按首页横竖定)/short(短边翻转)/long(长边翻转)/off(单面)")
    ap.add_argument("--printer", default=DEFAULT_PRINTER)
    ap.add_argument("--dry-run", action="store_true", help="只输出决策和命令，不出纸")
    args = ap.parse_args()

    if not os.path.exists(SUMATRA):
        fail(f"SumatraPDF 未安装：{SUMATRA}\n   安装：winget install --id SumatraPDF.SumatraPDF --silent")
    if not (1 <= args.copies <= MAX_COPIES):
        fail(f"份数须在 1-{MAX_COPIES} 之间")

    # 1. 定位文件
    label_override = None
    if args.pdf:
        pdf_path = os.path.abspath(args.pdf)
    elif args.name:
        pdf_path, label_override = locate_by_name(args.name, args.talent_id)
    else:
        fail("必须给 --name 或 --pdf 之一")
    print(f"📄 文件: {pdf_path}")

    # 2. 页范围决策
    doc = open_doc(pdf_path)
    pages, why = parse_pages(args.pages, doc)
    print(f"📐 页范围: {why} → 共{len(pages)}页 / 全文{doc.page_count}页")

    # 3. 打印副本：本机 SumatraPDF 3.6.1 任务名=文件全路径且无参数可改（9-04 审查源码坐实），
    #    副本放 F 盘根目录，任务名只剩「F:\岗位_姓名」。发送成功后即删（可随时再生成）。
    #    岗位 = 归档路径中「已收集简历」的上一层文件夹；归档外散文件退回原文件名。
    segs = os.path.normpath(pdf_path).replace("\\", "/").split("/")
    stem = os.path.splitext(os.path.basename(pdf_path))[0]
    if label_override:
        label = label_override
    elif "已收集简历" in segs and segs.index("已收集简历") > 0:
        job_dir = segs[segs.index("已收集简历") - 1]
        who = args.name or stem.split("_")[0]
        label = f"{job_dir}_{who}"
    else:
        label = stem
    suffix = "" if len(pages) == doc.page_count else "_简历部分"
    print_path = os.path.abspath(os.path.join(PRINT_STAGE, f"{label}{suffix}.pdf"))
    if os.path.normpath(print_path) == os.path.normpath(os.path.abspath(pdf_path)):
        print_path = os.path.abspath(pdf_path)  # 文件本身就在根目录且名对，就地打
    elif not args.dry_run:
        if len(pages) == doc.page_count:
            shutil.copyfile(pdf_path, print_path)
        else:
            extract_pages(doc, pages, print_path)
        size_mb = os.path.getsize(print_path) / 1048576
        print(f"📋 打印副本: {print_path}（{size_mb:.1f} MB，任务名用，打完即删）")

    # 4. 双面方向：横向内容=短边翻转（翻书式），纵向=长边
    if args.duplex == "auto":
        r = doc[0].rect
        duplex = "short" if r.width > r.height else "long"
    else:
        duplex = args.duplex

    # 5. 拼 SumatraPDF 参数并打印
    parts = []
    if len(pages) != doc.page_count:
        parts.append(f"{pages[0]+1}-{pages[-1]+1}")
    parts.append("fit")
    parts.append({"short": "duplexshort", "long": "duplexlong", "off": "simplex"}[duplex])
    if args.copies > 1:
        parts.append(f"{args.copies}x")
    settings = ",".join(parts)
    cmd = [SUMATRA, "-print-to", args.printer, "-print-settings", settings,
           "-silent", "-exit-when-done", print_path]

    duplex_desc = {"short": "双面·短边翻转", "long": "双面·长边翻转", "off": "单面"}[duplex]
    print(f"🖨️ 设置: {duplex_desc} | {args.copies}份 | 适配缩放 | 打印机 {args.printer}")
    print(f"   任务名「{os.path.basename(print_path)}」")
    if args.dry_run:
        print("⏸️ --dry-run：未出纸。命令：")
        print("   " + subprocess.list2cmdline(cmd))
        return

    r = subprocess.run(cmd, capture_output=True, timeout=180)
    if r.returncode == 0:
        if print_path != os.path.abspath(pdf_path):
            try:
                os.remove(print_path)
            except OSError:
                pass
        print(f"✅ 已发送打印（{EXIT_CODES[0]}）：{len(pages)}页 × {args.copies}份，出纸后到打印机取。")
    else:
        tip = EXIT_CODES.get(r.returncode, f"未知失败 code={r.returncode}")
        print(f"❌ 打印失败：{tip}")
        if print_path != os.path.abspath(pdf_path):
            print(f"   打印副本保留在 {print_path}，排除打印机问题后可直接重试")
        err = (r.stderr or b"").decode("utf-8", "replace").strip()
        if err:
            print(f"   stderr 尾部: {err[-300:]}")
        sys.exit(1)


if __name__ == "__main__":
    main()
