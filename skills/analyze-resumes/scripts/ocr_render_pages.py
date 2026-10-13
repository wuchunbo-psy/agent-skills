"""BOSS 加密简历渲染图的 tesseract OCR 底稿生成。

用法:
  python ocr_render_pages.py <extract_dir 或 单个json> [--tessdata <TESSDATA_DIR>]

对目录下每个含 render_pages 且 text 为空的 JSON：tesseract(chi_sim) 逐页识别 →
拼接写回 text 字段，标 ocr_draft=true。定位：兜底区升级为"有底稿的待定"——
够支撑方向/硬卡/经历主线判断，姓名与精确数字可能识别错误，强推仍需人工核对原图。
"""

import os
import argparse, glob, json, os, subprocess, sys

TESSERACT = r"C:/Program Files/Tesseract-OCR/tesseract.exe"


def ocr_image(png_path, tessdata):
    env = dict(os.environ, TESSDATA_PREFIX=tessdata)
    r = subprocess.run([TESSERACT, png_path, "stdout", "-l", "chi_sim", "--psm", "3"],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", env=env)
    if r.returncode != 0:
        return None, (r.stderr or "").strip()[:200]
    return r.stdout, None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("target", nargs="+", help="extract 输出目录或单个 .json")
    ap.add_argument("--tessdata", default="tessdata",
                    help="chi_sim.traineddata 所在目录（默认 <TESSDATA_DIR>）")
    args = ap.parse_args()

    if not os.path.isfile(TESSERACT):
        print(f"❌ 找不到 tesseract: {TESSERACT}")
        sys.exit(1)

    jsons = []
    for t in args.target:
        if os.path.isdir(t):
            jsons += sorted(glob.glob(os.path.join(t, "*.json")))
        else:
            jsons.append(t)

    done = skipped = failed = 0
    for jp in jsons:
        d = json.load(open(jp, encoding="utf-8"))
        pages = d.get("render_pages") or []
        if not pages:
            skipped += 1
            continue
        if d.get("text", "").strip():
            skipped += 1
            print(f"⏭️ {os.path.basename(jp)} 已有文本，跳过（--force 可覆盖时再加）")
            continue
        texts = []
        err = None
        for p in pages:
            out, e = ocr_image(p, args.tessdata)
            if e:
                err = e
                break
            texts.append(out or "")
        if err:
            print(f"🔴 {os.path.basename(jp)} OCR失败: {err}")
            failed += 1
            continue
        draft = "\n".join(texts).strip()
        d["text"] = draft
        d["is_valid"] = bool(draft)
        d["issue"] = "BOSS加密PDF经tesseract OCR转写底稿（错字率约15-20%，姓名/数字需对原图核验；强推档需人工看原图）"
        d["ocr_draft"] = True
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(d, f, ensure_ascii=False, indent=1)
        print(f"✅ {os.path.basename(jp)} 底稿 {len(draft)} 字符（{len(pages)}页）")
        done += 1

    print(f"\n📊 底稿生成 {done} · 跳过 {skipped} · 失败 {failed}")


if __name__ == "__main__":
    main()
