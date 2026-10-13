#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
report_lint.py — 评估报告组装自检（2026-09-30 加，9-29 两起组装事故后固化）。

背景：9-29 报告两处返工——①许正阳（TA）卡片贴进角色原画章节（并行子卡组装错位）；
②各岗位章节头漏加归档位置行（模板「归档可见性三规则」本就要求批次/档次进标题）。
本脚本把三道人工自检固化为机械校验，报告发出前必跑：

  python report_lint.py notes/简历评估/2026-09/简历评估_9.29.md

检查项（任何一项 fail 即 exit 1）：
  1. 数量一致：报告标题「N人」== 实际 #### 卡片数
  2. 章节归属：每张卡片的岗位名必须与其所在 ### 岗位章节的岗位名一致
     （防止子卡贴错章节；卡片标题格式 `#### {姓名} · {岗位}（{团队}）`）
  3. 章节人数：`### {岗位} — N人` 的 N == 该章节实际卡片数
  4. 位置行：每个 ### 岗位章节下有「> 归档位置：」行（归档可见性三规则）
  5. 归档行：每张非「已评估收录」卡片有含「归档」的表格行且带反引号路径
     （finalize 分发依赖，缺=静默漏件）

用法：主会话组装报告后、finalize 之前跑。exit 0=全过；exit 1=有问题（逐条列出）。
"""
import re
import sys

# 岗位章节标题：### {岗位名} — {N}人 · {emoji串}（破折号前空格可有可无，如「）— 2人」）
RE_SECTION = re.compile(r"^### (.+?)\s*—\s*(\d+)人", re.M)
RE_CARD = re.compile(r"^#### (.+)$", re.M)
RE_TOTAL = re.compile(r"^# 简历评估[^\n]*?(\d+)人", re.M)
# 卡片岗位名：#### {姓名} · {岗位}（{团队}） 或 #### {姓名} —（已评说明）
RE_CARD_POS = re.compile(r"^(.+?)\s*(?:·|—)", re.M)


def lint(report_path):
    text = open(report_path, encoding="utf-8").read()
    problems = []

    # ---- 按 ### 岗位章节切块（### 到下一个 ###/##/# 之间）----
    section_anchors = [(m.start(), m.group(1).strip(), int(m.group(2)))
                       for m in RE_SECTION.finditer(text)]
    if not section_anchors:
        problems.append("全文找不到任何 ### 岗位章节标题（— N人 格式）")
        return problems

    # 卡片归属：用#### 位置夹逼出所在章节
    cards = [(m.start(), m.group(1).strip()) for m in RE_CARD.finditer(text)]
    # 总标题人数
    m_total = RE_TOTAL.search(text)
    total_claim = int(m_total.group(1)) if m_total else None

    # ---- 检查1：数量一致 ----
    if total_claim is not None and total_claim != len(cards):
        problems.append(f"数量不一致：标题声称 {total_claim} 人，实际 {len(cards)} 张卡片")

    # ---- 检查2/3/4：逐章节 ----
    for i, (pos, sec_name, sec_n) in enumerate(section_anchors):
        sec_end = section_anchors[i + 1][0] if i + 1 < len(section_anchors) else len(text)
        # 章节边界还要排除被更高级标题截断（# 工作室标题已由 ### 锚点天然分隔，够用）
        block = text[pos:sec_end]
        sec_cards = [c_pos for c_pos, _ in cards if pos < c_pos < sec_end]

        # 检查3：章节人数标注 == 实际卡片数
        if sec_n != len(sec_cards):
            problems.append(f"章节「{sec_name}」标题标注 {sec_n} 人，实际 {len(sec_cards)} 张卡片")

        # 检查2：卡片岗位名与章节岗位名一致（容忍团队后缀/括号备注，取岗位名包含判断）
        sec_key = re.sub(r"[（(].*?[)）]", "", sec_name).strip()
        for c_pos in sec_cards:
            card_title = next(t for p, t in cards if p == c_pos)
            # 卡片标题 `姓名 · 岗位（团队）`：取 · 后、（ 前为岗位名
            if "·" in card_title:
                job_part = card_title.split("·", 1)[1]
                card_job = re.sub(r"[（(].*?[)）]|——.*$", "", job_part).strip()
            else:
                # `姓名 —（已评估收录）` 型：无岗位信息，跳过归属检查（已是收录说明卡）
                continue
            # 归属校验：卡片岗位名与章节岗位名互相包含其一即可（处理「策划端 · 资深数值策划」类前缀）
            if card_job and card_job not in sec_key and sec_key not in card_job:
                # 找卡片真正应该在的章节，给出精确提示
                correct = [n for _, n, _ in section_anchors
                           if card_job in re.sub(r"[（(].*?[)）]", "", n) or re.sub(r"[（(].*?[)）]", "", n) in card_job]
                hint = f"（应属章节：{correct[0]}）" if correct else ""
                problems.append(f"章节「{sec_name}」出现岗位不符的卡片：「{card_title}」，卡片岗位=「{card_job}」{hint}")

        # 检查4：归档位置行
        if "> 归档位置：" not in block:
            problems.append(f"章节「{sec_name}」缺「> 归档位置：」行（归档可见性三规则）")

        # 检查5：每张卡有归档行
        for c_pos in sec_cards:
            c_end = next((p for p, _ in cards if p > c_pos), len(text))
            card_block = text[c_pos:c_end]
            if not any("归档" in ln and "`" in ln and ln.strip().startswith("|") for ln in card_block.split("\n")):
                card_title = next(t for p, t in cards if p == c_pos)
                problems.append(f"卡片「{card_title[:40]}」无「归档」表格行（finalize 分发依赖，缺=漏件）")

    return problems


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    problems = lint(sys.argv[1])
    if problems:
        print(f"🔴 报告自检未过（{len(problems)} 项）：")
        for p in problems:
            print(f"  - {p}")
        sys.exit(1)
    print("🟢 报告自检全过：数量/章节归属/位置行/归档行 四项 OK")


if __name__ == "__main__":
    main()
