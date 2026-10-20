# -*- coding: utf-8 -*-
"""
draft_interviews.py — 约面编排器：一条命令跑完「候选人定位 → 面试官空闲匹配 → 可转发草稿」

为什么存在：约面的编排层（定位/称谓/分配/并行/清理）是确定性工作，收进脚本；
AI 只做两件事——把用户的话转译成参数、把输出交付出去。

用法（--interviewer / --candidates 成对出现，可重复=多组；面试官池用 | 分隔=任一人可面即可）：
  # 单组（最常见）
  python draft_interviews.py --interviewer "面试官A" --candidates "候选人V=9-2,候选人W"

  # 两组 + OR 面试官池（脚本自动把候选人分给最早可约的成员）
  python draft_interviews.py --interviewer "面试官A" --candidates "候选人V=9-2,候选人W" \
                             --interviewer "面试官I|花名C" --candidates "候选人X=9-2 10:00,候选人Y"

  # 当天新录入的候选人（人才索引缓存隔夜刷新，快照也是早晨的）：必须加 --lookup-hint 供扫描层用
  python draft_interviews.py --interviewer "面试官D" --candidates "张三=9-3" --lookup-hint "张三=Unity"

本脚本只做编排（名字解析 / alias 维护 / 子进程调度 / OR 分配 / 汇总清理），
不算时间——匹配逻辑唯一事实源是 match_schedule.py，ATS 定位唯一事实源是 lookup_candidates.py。

OR 分配规则（确定性，可解释）：
  逐个候选人（按输入顺序）分给「该候选人最早可约」的池成员；最早可约打平 → 分给当前
  已分配场次少的；再打平 → 池内顺序。只有一名成员能接 → 直接归他。谁也接不了 → 进
  【未排上】说明，不出现在任何草稿里。
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor

sys.stdout.reconfigure(encoding="utf-8")

SCRIPTS_DIR = os.path.dirname(os.path.abspath(__file__))
# 常量与缓存读写从 match_schedule import，不在编排器里复制（单一真相源）
sys.path.insert(0, SCRIPTS_DIR)
from match_schedule import CACHE, PROJECT_ROOT, load_cache, save_cache  # noqa: E402

LOOKUP = os.path.join(SCRIPTS_DIR, "lookup_candidates.py")
MATCH = os.path.join(SCRIPTS_DIR, "match_schedule.py")
RESULT_FILE = f"{PROJECT_ROOT}/notes/_drafts_result.txt"


def spec_name(spec):
    """'姓名=时间#形式@岗位' → 姓名。"""
    return spec.split("=")[0].split("#")[0].split("@")[0].strip()


# ============================================================
# 层1：面试官名字解析 + alias 自动维护
# ============================================================
def resolve_member(cache, token):
    """token → (oid, info) 或 None。匹配顺序：姓名 → alias（忽略大小写）→ email 前缀。"""
    tok = token.strip()
    low = tok.lower()
    for oid, info in cache.items():
        if info.get("name") == tok:
            return oid, info
    for oid, info in cache.items():
        if any(a.lower() == low for a in info.get("alias", [])):
            return oid, info
    for oid, info in cache.items():
        email = (info.get("email") or "").split("@")[0].lower()
        if email and email == low:
            return oid, info
    return None


def derive_alias(token, info, taken=None):
    """称谓惯例（2026-09-02 改版，用户定稿）：英文名直接用（首字母大写）；
    两字中文名=末字+哥（王芳→芳哥）；三字及以上=末两字不带哥（王大明→大明）。
    taken=存量 alias 集合（小写），推导结果撞车时回退「姓+哥」（李杰→李哥，不与张杰杰哥撞）。"""
    taken = taken or set()
    if re.search(r"[A-Za-z]", token):
        return token[0].upper() + token[1:]
    name = info.get("name") or token
    if len(name) == 2:
        cand = name[1] + "哥"
    elif len(name) >= 3:
        cand = name[-2:]
    else:
        cand = name + "哥"
    if cand.lower() in taken:
        cand = name[0] + "哥"
    return cand


def resolve_pools(pools):
    """所有组的面试官池解析成 (oid, info)；alias 为空时按惯例自动补并原子写回缓存。
    返回 [[(oid, info), ...], ...]（与 pools 顺序对齐）。"""
    cache = load_cache()
    resolved, changed = [], False
    for pool in pools:
        members = []
        for token in pool.split("|"):
            token = token.strip()
            hit = resolve_member(cache, token)
            if not hit:
                print(f"[❌ 面试官未解析] '{token}'（姓名/alias/email 前缀都没命中 interviewers.json），本池剔除该成员")
                continue
            oid, info = hit
            if not info.get("alias"):
                taken = {a.lower() for v in cache.values() for a in v.get("alias", [])}
                alias = derive_alias(token, info, taken)
                info["alias"] = [alias]
                changed = True
                print(f"[alias] {info.get('name')} 无称谓，按惯例自动补「{alias}」（草稿抬头用）")
            members.append((oid, info))
        if not members:
            raise SystemExit(f"[❌ 该组没有任何可解析的面试官：{pool}]")
        resolved.append(members)
    if changed:
        save_cache(cache)
    return resolved


# ============================================================
# 层2：候选人 ATS 定位（一条 lookup 兜所有组）
# ============================================================
def run_lookup(all_specs, hint_map, tmpdir):
    """跑 lookup_candidates.py，返回 (ats_file路径, {name: talent_id}, [未定位names], {name: record})。"""
    names, seen = [], set()
    for spec in all_specs:
        name = spec_name(spec)
        if name and name not in seen:
            seen.add(name)
            names.append(name)
    argv = [sys.executable, LOOKUP]
    for name in names:
        argv.append(f"{name}={hint_map[name]}" if name in hint_map else name)
    ats_path = os.path.join(tmpdir, "ats.json")
    argv += ["--out", ats_path]
    proc = subprocess.run(argv, capture_output=True, timeout=300,
                          env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    print(proc.stdout.decode("utf-8", "replace").rstrip())
    if proc.returncode != 0:
        raise SystemExit(f"[❌ lookup_candidates 失败 rc={proc.returncode}] "
                         f"{proc.stderr.decode('utf-8', 'replace')[-500:]}")
    tids, recs, misses = {}, {}, []
    if os.path.exists(ats_path):
        data = json.load(open(ats_path, encoding="utf-8"))
        for rec in data.get("structured", {}).get("ats", []):
            if rec.get("name"):
                tids[rec["name"]] = rec.get("talent_id", "")
                recs[rec["name"]] = rec
    for name in names:
        if name not in tids:
            misses.append(name)
    return ats_path, tids, misses, recs


# ============================================================
# 层3：match_schedule 子进程调度 + OR 分配
# ============================================================
def run_match(member_name, cand_specs, cand_names, tids, ats_path, passthrough, tag):
    """跑一次 match_schedule，返回 stdout 文本。
    talent-ids 只在全员命中时传（match 会过滤空值，部分命中会导致错位对齐）；
    否则留空走姓名匹配（--ats-file 记录里姓名+tid 都有）。"""
    tid_arg = ""
    tid_values = [tids.get(n, "") for n in cand_names]
    if cand_names and all(tid_values):
        tid_arg = ",".join(tid_values)  # 只在全员命中时传：match 会过滤空值，部分命中会错位对齐
    argv = [sys.executable, MATCH,
            "--interviewer", member_name,
            "--candidates", ",".join(cand_specs),
            "--ats-file", ats_path,
            "--talent-ids", tid_arg,
            ] + passthrough
    proc = subprocess.run(argv, capture_output=True, timeout=600,
                          env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUNBUFFERED": "1"})
    out = proc.stdout.decode("utf-8", "replace")
    if proc.returncode != 0 or not out.strip():
        err = proc.stderr.decode("utf-8", "replace")[-800:]
        raise SystemExit(f"[❌ match_schedule 失败] {tag} rc={proc.returncode}\n{err}")
    return out


HIT_RE = re.compile(r"^\s{2}(.+?)\s+周[一二三四五六日]\((\d+)-(\d+)\) → (✅|❌|⚠️).*?(?:（建议 (\d{1,2}:\d{2})）)?\s*$")


def parse_earliest(text):
    """match 输出 → {cand_name: 最早可约 (月,日,时,分)}（只收 ✅ 行）。"""
    earliest = {}
    for line in text.splitlines():
        m = HIT_RE.match(line)
        if not m or m.group(4) != "✅":
            continue
        name = m.group(1).strip()
        t = m.group(5)
        hh, mm = (t.split(":") + ["0"])[:2] if t else ("23", "59")
        rank = (int(m.group(2)), int(m.group(3)), int(hh), int(mm))
        if name not in earliest or rank < earliest[name]:
            earliest[name] = rank
    return earliest


def assign_or(members, cand_names, wave1):
    """OR 池分配：逐候选人给「最早可约」成员；打平给场次少的；再打平按池顺序。
    返回 ({cand: member_name}, [未排上cands])。"""
    assigned, load, unassigned = {}, {info.get("name"): 0 for _oid, info in members}, []
    for name in cand_names:
        eligible = []
        for idx, (_oid, info) in enumerate(members):
            mname = info.get("name")
            if name in wave1.get(mname, {}):
                eligible.append((wave1[mname][name], load[mname], idx, mname))
        if not eligible:
            unassigned.append(name)
            continue
        eligible.sort()
        best = eligible[0][3]
        assigned[name] = best
        load[best] += 1
    return assigned, unassigned


# ============================================================
# 层4：编排主流程
# ============================================================
def main():
    ap = argparse.ArgumentParser(description="约面编排器：一条命令出全部组的可转发草稿")
    ap.add_argument("--interviewer", action="append", required=True,
                    help="面试官，可重复；池内 | 分隔=OR（任一人可面即可），逗号=AND（共同空闲）")
    ap.add_argument("--candidates", action="append", required=True,
                    help="候选人及时间（格式同 match_schedule），与 --interviewer 按顺序配对；没给时间直接写姓名")
    ap.add_argument("--lookup-hint", action="append", default=[],
                    help="'姓名=岗位关键词'，供 lookup 扫描层消歧（当天新录入必须传）")
    ap.add_argument("--form", default="视频", help="面试形式，默认 视频")
    ap.add_argument("--duration", type=int, default=45, help="每场分钟数，默认 45")
    ap.add_argument("--days", type=int, default=7, help="查询窗口天数，默认 7")
    ap.add_argument("--work-start", default="9")
    ap.add_argument("--work-end", default="20")
    ap.add_argument("--lunch", default="12-14")
    ap.add_argument("--team", default="")
    ap.add_argument("--max-per-day", type=int, default=0)
    ap.add_argument("--no-room", action="store_true")
    ap.add_argument("--min-capacity", type=int, default=0)
    ap.add_argument("--room-name", default="")
    ap.add_argument("--building", default="")
    ap.add_argument("--floor", default="")
    ap.add_argument("--dry-run", action="store_true", help="只解析不查飞书（OR 池只跑首个成员）")
    args = ap.parse_args()

    if len(args.interviewer) != len(args.candidates):
        raise SystemExit(f"[❌ 参数不配对] --interviewer {len(args.interviewer)} 个 vs "
                         f"--candidates {len(args.candidates)} 个，须一一配对")

    passthrough = (["--form", args.form, "--duration", str(args.duration), "--days", str(args.days),
                    "--work-start", args.work_start, "--work-end", args.work_end, "--lunch", args.lunch]
                   + (["--team", args.team] if args.team else [])
                   + (["--max-per-day", str(args.max_per_day)] if args.max_per_day else [])
                   + (["--no-room"] if args.no_room else [])
                   + (["--min-capacity", str(args.min_capacity)] if args.min_capacity else [])
                   + (["--room-name", args.room_name] if args.room_name else [])
                   + (["--building", args.building] if args.building else [])
                   + (["--floor", args.floor] if args.floor else [])
                   + (["--dry-run"] if args.dry_run else []))

    groups = []
    for iv, cd in zip(args.interviewer, args.candidates):
        specs = [s.strip() for s in cd.split(",") if s.strip()]
        if not specs or any(not spec_name(s) for s in specs):
            raise SystemExit(f"[❌ 候选人条目解析失败] {cd}")
        groups.append({"pool_raw": iv, "specs": specs, "names": [spec_name(s) for s in specs]})

    # 层1：面试官解析 + alias 维护（在子进程前完成，防缓存写竞争、保证草稿称谓）
    pools = resolve_pools([g["pool_raw"] for g in groups])

    # 层2：候选人定位（一次 lookup 兜所有组）
    hint_map = {}
    for h in args.lookup_hint:
        name, _, kw = h.partition("=")
        hint_map[name.strip()] = kw.strip()
    all_specs = [s for g in groups for s in g["specs"]]
    tmpdir = tempfile.mkdtemp(prefix="draft_iv_")
    try:
        ats_path, tids, lookup_misses, recs = run_lookup(all_specs, hint_map, tmpdir)

        # 已约未面的候选人整份剔除（飞书招聘已建场）：再排=把用户敲定的面试作废重约
        booked_names = {n for n, rec in recs.items() if rec.get("scheduled_next")}
        booked_notes = [
            f"[⚠️ 已约未面] {n} 名下已有排期 {recs[n]['scheduled_next']} 的面试（飞书招聘已建）"
            f"——已从本轮草稿剔除，勿重复约；要改期先取消原场"
            for n in sorted(booked_names)
        ]
        for g in groups:
            if any(spec_name(s) in booked_names for s in g["specs"]):
                g["specs"] = [s for s in g["specs"] if spec_name(s) not in booked_names]
                g["names"] = [spec_name(s) for s in g["specs"]]

        # 层3a：多成员池先并行跑 wave1（全员匹配）定分配依据
        need_wave1 = [(gi, members) for gi, members in enumerate(pools)
                      if len(members) > 1 and not args.dry_run and groups[gi]["specs"]]
        wave1 = {}  # {member_name: {cand_name: earliest_rank}}
        if need_wave1:
            jobs = []
            for gi, members in need_wave1:
                for _oid, info in members:
                    mname = info.get("name")
                    jobs.append((mname, groups[gi]["specs"], groups[gi]["names"],
                                 f"组{gi + 1}·wave1·{mname}"))
            with ThreadPoolExecutor(max_workers=min(6, len(jobs))) as ex:
                outs = list(ex.map(lambda j: run_match(j[0], j[1], j[2], tids, ats_path,
                                                       passthrough, j[3]), jobs))
            wave1 = {j[0]: parse_earliest(o) for j, o in zip(jobs, outs)}

        # 层3b：分配 + 生成 wave2 任务
        wave2_jobs, group_outputs = [], []  # group_outputs: [(组号, 说明行, [(成员名, specs)])]
        for gi, (members, group) in enumerate(zip(pools, groups)):
            gtag = f"组{gi + 1}"
            if not group["specs"]:
                group_outputs.append((gi, [f"{gtag}：[{group['pool_raw']}] 候选人均已约未面或被剔除，本组跳过"], []))
                continue
            if len(members) == 1 or args.dry_run:
                if len(members) > 1:
                    print(f"[ℹ️ dry-run] OR 池不分配，只解析首个成员 {members[0][1].get('name')}")
                mname = members[0][1].get("name")
                group_outputs.append((gi, [f"{gtag}：[{group['pool_raw']}] 单池直跑 → 候选 {'、'.join(group['names'])}"],
                                      [(mname, group["specs"])]))
                wave2_jobs.append((mname, group["specs"], group["names"], f"{gtag}·{mname}"))
                continue
            member_names = [info.get("name") for _oid, info in members]
            assigned, unassigned = assign_or(members, group["names"], wave1)
            notes = [f"{gtag}：OR 池 [{'|'.join(member_names)}] 分配 → "
                     + ("；".join(f"{n}→{a}" for n, a in assigned.items()) if assigned else "无人可排")]
            if unassigned:
                notes.append(f"  【未排上】{'、'.join(unassigned)}——池内所有成员在候选窗口内均无空档，需与候选人重新协调")
            by_member = {info.get("name"): [] for _oid, info in members}
            for n, a in assigned.items():
                by_member[a].append(n)
            member_runs = []
            for mname in member_names:
                names_m = by_member[mname]
                if not names_m:
                    notes.append(f"  {mname}：本组无分配场次")
                    continue
                specs_m = [s for s in group["specs"] if spec_name(s) in names_m]
                member_runs.append((mname, specs_m))
                wave2_jobs.append((mname, specs_m, names_m, f"{gtag}·{mname}"))
            group_outputs.append((gi, notes, member_runs))

        # 层3c：wave2 并行——每成员一场，拿最终权威草稿（fresh freebusy）
        if not wave2_jobs:
            raise SystemExit("[❌ 没有任何可执行的分场（候选人/面试官均未解析成功）]")
        with ThreadPoolExecutor(max_workers=min(6, len(wave2_jobs))) as ex:
            outs = list(ex.map(lambda j: run_match(j[0], j[1], j[2], tids, ats_path,
                                                   passthrough, j[3]), wave2_jobs))
        out_by_tag = {j[3]: o for j, o in zip(wave2_jobs, outs)}

        # 层4：汇总——说明在前，各组输出（内含色块图+草稿）在后；全文落盘防截断
        parts = [f"===== draft_interviews 编排结果 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} =====", ""]
        parts.extend(booked_notes)
        if booked_notes:
            parts.append("")
        if lookup_misses:
            parts.append(f"[⚠️ ATS 未定位（草稿会标【需问用户】）] {'、'.join(lookup_misses)}")
            parts.append("")
        for _gi, notes, _runs in group_outputs:
            parts.extend(notes)
        parts.append("")
        for gi, _notes, runs in group_outputs:
            for mname, _specs in runs:
                tag = f"组{gi + 1}·{mname}"
                parts.append(f"########## 组{gi + 1}｜{mname} ##########")
                parts.append(out_by_tag.get(tag, f"[⚠️ 丢输出：{tag}]"))
                parts.append("")

        text = "\n".join(parts)
        with open(RESULT_FILE, "w", encoding="utf-8") as f:
            f.write(text)
        print(text)
        print(f"\n[✅ 完成] {len(wave2_jobs)} 场匹配（并行）。全文已存 {RESULT_FILE}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    main()
