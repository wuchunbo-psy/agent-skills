#!/usr/bin/env python3
"""打开候选人的飞书招聘人才页（每人一个独立 Chrome 新窗口）。

用途：创建面试 API 未开放期间的过渡提效——Agent 帮用户把页面和「安排面试」弹窗
准备好，用户只补 日期/时段 并检查后提交。

用法：
    python open_interview_dialog.py 姓名 [姓名...] [--dry-run]

数据源（按序取第一个命中）：
    1. notes/_hire_result.json（录入历史，含 talent_id）
    2. notes/_daily_review.json 的 structured.ats

后续分工：Agent 用无障碍点击窗口里的「安排面试」按钮（禁用坐标通道），
弹出创建弹窗后交还用户。任何一方都不得代用户点「提交」——提交即向候选人发邀约。
"""
import json
import os
import subprocess
import sys

PROJECT_ROOT = os.environ.get("PROJECT_ROOT", os.getcwd())
CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe"
URL_TPL = "https://mini1.feishu.cn/hire/talent/{tid}"


def load_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def resolve_talent_id(name):
    # ATS 快照优先：_hire_result 里可能存在档案分裂的旧 tid，
    # 对账以 daily_review 的 structured.ats 为准（同人也优先当前活跃投递挂的档案）
    review = load_json(os.path.join(PROJECT_ROOT, "notes", "_daily_review.json")) or {}
    for item in (review.get("structured") or {}).get("ats") or []:
        if item.get("name") == name and item.get("talent_id"):
            return item["talent_id"], "_daily_review.json"

    recs = load_json(os.path.join(PROJECT_ROOT, "notes", "_hire_result.json")) or []
    if isinstance(recs, dict):
        recs = recs.get("records") or recs.get("results") or []
    hits = [r for r in recs if isinstance(r, dict) and r.get("name") == name and r.get("talent_id")]
    if hits:
        return hits[-1]["talent_id"], "_hire_result.json"
    return None, None


def main():
    names = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry_run = "--dry-run" in sys.argv
    if not names:
        print(__doc__)
        sys.exit(2)

    ready = []
    for name in names:
        talent_id, source = resolve_talent_id(name)
        if talent_id:
            ready.append((name, talent_id, source))
        else:
            print(f"[x] {name}: 本地无档案记录（录入历史/日报快照都没有），先用 candidate-entry 录入")
    if not ready:
        sys.exit(1)

    for name, talent_id, source in ready:
        url = URL_TPL.format(tid=talent_id)
        print(f"[ok] {name}  talent_id={talent_id}  ({source})")
        print(f"     {url}")
        if not dry_run:
            subprocess.Popen([CHROME, "--new-window", url])
    if not dry_run:
        print("done: 已按人开窗。下一步 Agent 点各窗口的「安排面试」，用户补日期/时段后自行提交。")


if __name__ == "__main__":
    main()
