# -*- coding: utf-8 -*-
"""position-retro 事实层：六源 join 产出岗位事实 JSON。纯函数在上，I/O 与 CLI 在下。"""
import json
import re
import sys

def extract_file_name(content: str) -> str:
    m = re.search(r'name="([^"]+)"', content or "")
    return m.group(1) if m else ""

def classify_file(fname: str) -> str:
    if re.search(r"作品|portfolio|artwork", fname, re.I):
        return "作品"
    if re.search(r"\.(pdf|docx?|pptx?|rar|zip|7z)$", fname, re.I):
        return "简历"
    return "其他"

def strip_game_prefix(s: str) -> str:
    return s[2:] if s.startswith("游戏") else s

def position_matches(hint: str, target: str) -> bool:
    h, t = strip_game_prefix(hint or ""), strip_game_prefix(target or "")
    # ATS 标题与归档目录名空格不一致（如"AI Native 游戏"vs"AI Native游戏"），匹配前归一化空白
    h, t = re.sub(r"\s+", "", h), re.sub(r"\s+", "", t)
    return bool(h) and bool(t) and (h in t or t in h)

POSITION_RE = re.compile(
    r"(战斗客户端程序|系统客户端程序|服务器主程|Unity客户端|AI Native游戏服务端|UIUE设计师|游戏UI设计师|"
    r"主美术设计师|执行数值策划|数值策划|交互设计师|3D角色设计师|3D动作设计师)")

def parse_push_file(fname: str) -> dict:
    stem = re.sub(r"\.(pdf|docx?|pptx?|rar|zip|7z)$", "", fname, flags=re.I)
    m = POSITION_RE.search(stem)
    hint = m.group(1) if m else ""
    name = stem.split("_")[0].split("-")[0]
    if stem.startswith("【") and hint:
        parts = stem.split("】", 1)[1].split("_")
        name = parts[0] if parts else name
    return {"name": name.strip("【】 "), "position_hint": hint, "file_type": classify_file(fname)}

def build_pushes(messages, wu_open_id, target):
    by_name = {}
    for m in messages:
        if (m.get("sender") or {}).get("id") != wu_open_id or m.get("msg_type") not in ("file", "folder", "image"):
            continue
        fname = extract_file_name(m.get("content") or "")
        if not fname:
            continue
        p = parse_push_file(fname)
        rec = by_name.setdefault(p["name"], {
            "name": p["name"], "files": [], "hints": set(),
            "pushed_at_first": m.get("create_time"), "multi_position": False,
            "position_matched": False})
        rec["files"].append({"fname": fname, "file_type": p["file_type"], "pushed_at": m.get("create_time")})
        if p["position_hint"]:
            rec["hints"].add(p["position_hint"])
    out = []
    for r in by_name.values():
        r["multi_position"] = len(r["hints"]) > 1
        r["position_matched"] = any(position_matches(h, target) for h in r["hints"])
        del r["hints"]
        out.append(r)
    return out

def build_interview_facts(interviews, talent_names, job_titles, target, app_map):
    out = []
    for iv in interviews:
        app = app_map.get(iv.get("application_id"))
        if not app:
            continue
        talent_id, job_id = app
        title = job_titles.get(job_id, "")
        if not position_matches(title, target):
            continue
        recs = iv.get("interview_record_list") or []
        for r in recs or [{}]:
            out.append({
                "name": talent_names.get(talent_id, talent_id),
                "round": iv.get("round"),
                "begin_time": iv.get("begin_time"),
                "conclusion": r.get("conclusion"),
                "interviewer": (r.get("interviewer") or {}).get("name", (r.get("interviewer") or {}).get("id", "")),
                "job_title": title, "app_id": iv.get("application_id")})
    return out

def extract_feedback_text(record):
    parts = []
    for mod in (record or {}).get("module_assessments") or []:
        for d in mod.get("dimension_assessments") or []:
            c = d.get("dimension_content")
            if c:
                parts.append(c)
    return "；".join(parts)

def collect_group_quotes(messages, biz_ids, names):
    out = []
    for m in messages:
        s = (m.get("sender") or {}).get("id")
        if s not in biz_ids:
            continue
        try:
            body = json.loads(m.get("content") or "{}").get("text", m.get("content") or "")
        except Exception:
            body = m.get("content") or ""
        hits = [n for n in names if n and n in body]
        hit = max(hits, key=len) if hits else None
        if hit:
            out.append({"name": hit, "speaker": biz_ids[s], "text": body, "date": m.get("create_time")})
    return out

VERDICT_RE = re.compile(r"^\|\s*([^|]+?)\s*\|[^|]+\|[^|]+\|\s*(🟢|🟡|⚪|🔴)[^||]*\|", re.M)

def load_eval_verdicts(paths):
    def date_key(p):
        m = re.search(r"简历评估_(\d{1,2})\.(\d{1,2})", p)
        return (int(m.group(1)), int(m.group(2))) if m else (0, 0)
    verdicts = {}
    for p in sorted(paths, key=date_key):
        try:
            with open(p, encoding="utf-8") as f:
                text = f.read()
        except OSError:
            continue
        for m in VERDICT_RE.finditer(text):
            name, emoji = m.group(1).strip(), m.group(2)
            if name and not set(name) & {"-", "姓"}:
                verdicts[name] = emoji + {"🟢": "强推", "🟡": "可推", "⚪": "待定", "🔴": "不推"}[emoji]
    return verdicts

def detect_anomalies(pushes, ivs, evals, quotes, stuck_positions, target):
    out = []
    iv_names = {i["name"] for i in ivs}
    push_names = {p["name"] for p in pushes}
    pni = sorted(p["name"] for p in pushes if p["position_matched"] and p["name"] not in iv_names)
    out.append({"type": "pushed_not_interviewed", "names": pni,
                "detail": f"推送 {len(pni)} 人未进面（静默拒/在途）"})
    inp = sorted(iv_names - push_names)
    out.append({"type": "interviewed_not_pushed", "names": inp,
                "detail": f"进面 {len(inp)} 人非群推送来（他渠道）"})
    div = sorted(n for n, v in evals.items()
                 if (v.startswith("🟢") and n not in iv_names) or (v[:1] in "⚪🔴" and n in iv_names))
    out.append({"type": "eval_business_divergence", "names": div,
                "detail": "我方评估与业务行为分歧（🟢没进面 / ⚪🔴进了面）"})
    qn = {q["name"] for q in quotes}
    ubv = sorted(i["name"] for i in ivs if i["conclusion"] is None and i["name"] in qn)
    out.append({"type": "unreported_but_verbal", "names": ubv,
                "detail": "面评未交但群内已有口头结论，催前先核对"})
    detail = "本岗不在卡住清单"
    if target in stuck_positions:
        unrep = sum(1 for i in ivs if i["conclusion"] is None)
        latest = max((i["begin_time"] for i in ivs), default=None)
        detail = f"卡住标注（{target}）：未交面评 {unrep} 场，最晚面试时间戳 {latest}"
    out.append({"type": "stuck_cause_split", "names": [], "detail": detail})
    return out

def person_rollup(ivs):
    """人级漏斗口径：每人取其有 conclusion 的最晚一轮定状态（1过/2挂），全 null=未交。
    返回 (ok_names, bad_names, unrep_names) 三个列表。"""
    by = {}
    for i in sorted(ivs, key=lambda x: x.get("begin_time") or 0):
        c = i.get("conclusion")
        if c is not None:
            by[i["name"]] = c
    ok = [n for n, c in by.items() if c == 1]
    bad = [n for n, c in by.items() if c == 2]
    unrep = sorted({i["name"] for i in ivs} - set(by))
    return ok, bad, unrep

# ---- I/O 适配层 + CLI（以下全部追加）----
import argparse
import glob as _glob
import os
import subprocess
import time as _time

LARK_CLI = os.environ.get("LARK_CLI_PATH", "lark-cli")
WU_OPEN_ID = "YOUR_OPEN_ID"   # 吴春波（推送人）
NOTES_RETRO = os.path.join(os.environ.get("PROJECT_ROOT", os.getcwd()), "notes", "retro")
NOTES_DIR = os.path.join(os.environ.get("PROJECT_ROOT", os.getcwd()), "notes")

def build_facts_dict(position, pushes, ivs, feedback, evals, anomalies, window, gaps, group_excerpt=None):
    n = len({i["name"] for i in ivs})
    d = {"pushes": pushes, "interviews": ivs, "feedback_texts": feedback,
         "eval_conclusions": evals, "anomalies": anomalies,
         "meta": {"generated_at": _time.strftime("%Y-%m-%d %H:%M"), "window": window,
                  "position": position, "n_rule": n >= 5, "data_gaps": gaps}}
    if group_excerpt is not None:   # Ruling U：main() 实跑必传（可为[]），纯函数缺省不落键（兼容既有调用）
        d["group_excerpt"] = group_excerpt
    return d

def _lark(args, timeout=300):
    cmd = ["cmd", "/c", LARK_CLI] + args
    env = {**os.environ, "MSYS_NO_PATHCONV": "1"}
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env=env, timeout=timeout)
    return json.loads(r.stdout)

def find_chat_id(project_name):
    """chat-search 按项目名搜群。返回 (chat_id, create_date) 或 (None, None)。"""
    d = _lark(["im", "+chat-search", "--query", project_name, "--as", "user", "--format", "json"])
    chats = ((d.get("data") or {}).get("chats")) or []
    if not chats:
        return None, None
    c = chats[0]
    return c.get("chat_id"), (c.get("create_time") or "")[:10]

def fetch_group_messages(chat_id, since):
    d = _lark(["im", "+chat-messages-list", "--chat-id", chat_id, "--as", "user",
               "--start", since, "--order", "asc", "--page-all", "--page-limit", "200",
               "--no-reactions", "--format", "json"])
    return ((d.get("data") or {}).get("messages")) or []

def find_project_by_archive(target):
    """归档目录反查项目名：data/在招岗位候选人管理/{项目}/**/{岗位目录}。"""
    root = os.environ.get("ARCHIVE_ROOT", "")
    for dirpath, dirnames, _ in os.walk(root):
        for dn in dirnames:
            if position_matches(dn, target):
                rel = os.path.relpath(os.path.join(dirpath, dn), root)
                return rel.split(os.sep)[0]
    return None

def load_talent_names():
    try:
        with open(os.path.join(NOTES_DIR, "_talents_cache.json"), encoding="utf-8") as f:
            return {t["id"]: t.get("name", "") for t in json.load(f).get("items", [])}
    except OSError:
        return {}

def load_job_titles():
    sys.path.insert(0, NOTES_DIR)
    from lib.hire_api import get_all_jobs_raw
    out = {}
    for j in get_all_jobs_raw():
        t = j.get("title")
        out[j.get("id")] = t.get("zh_name") if isinstance(t, dict) else t
    return out

def fetch_interviews(since_ms, end_ms):
    sys.path.insert(0, NOTES_DIR)
    from lib.hire_api import _page_all
    return _page_all("/open-apis/hire/v1/interviews",
                     {"start_time": str(since_ms), "end_time": str(end_ms)})

def build_app_map_for_jobs(target, job_titles):
    """裁决M：按岗拉投递建 app->(talent_id, job_id)，远省于全窗口逐投递。"""
    sys.path.insert(0, NOTES_DIR)
    from lib.hire_api import hire_list_applications, hire_get_application
    app_map, errs = {}, []
    for jid, title in job_titles.items():
        if not (title and position_matches(title, target)):
            continue
        try:
            aids = hire_list_applications(job_id=jid)
        except Exception as e:
            errs.append(f"job {jid}: {e}")
            continue
        for aid in aids:
            try:
                app = hire_get_application(aid) or {}
                app_map[aid] = (app.get("talent_id", ""), jid)
            except Exception as e:
                errs.append(f"application {aid}: {e}")
    return app_map, errs

def load_stuck_positions(path=None):
    """裁决N：stuck 名单按人存无 job 字段，经 structured.ats 姓名反查岗位。"""
    path = path or os.path.join(NOTES_DIR, "_daily_review.json")
    try:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
    except OSError:
        return []
    s = d.get("structured") or {}
    stuck_names = {x.get("name") for x in (s.get("stuck") or [])}
    return sorted({a.get("job") for a in (s.get("ats") or [])
                   if a.get("name") in stuck_names and a.get("job")})

def main():
    ap = argparse.ArgumentParser(description="position-retro 事实层：六源 join 产出岗位事实 JSON")
    ap.add_argument("--position", required=True, help="岗位名，如 战斗客户端程序")
    ap.add_argument("--group", help="群 chat_id（缺省按归档项目名搜群）")
    ap.add_argument("--since", help="起始日 YYYY-MM-DD（缺省=建群日）")
    a = ap.parse_args()
    gaps, notes = [], []

    # 1) 群与推送
    project = find_project_by_archive(a.position)
    chat_id, chat_created = (a.group, None)
    if not chat_id:
        if not project:
            print(f"[gap] 归档目录反查项目失败：{a.position}"); return 1
        chat_id, chat_created = find_chat_id(project)
        if not chat_id:
            print(f"[gap] 搜群失败：{project}"); return 1
    since = a.since or (chat_created or "2026-06-01")
    try:
        msgs = fetch_group_messages(chat_id, since)
    except Exception as e:
        msgs, gaps = [], [f"群消息拉取失败: {e}"]
    pushes = build_pushes(msgs, WU_OPEN_ID, a.position)

    # 2) ATS 面试（窗口=since 至 now+7d）
    sys.path.insert(0, NOTES_DIR)
    from lib.hire_api import to_ms
    end_ms = int(_time.time() * 1000) + 7 * 86400 * 1000
    try:
        interviews = fetch_interviews(to_ms(since), end_ms)
    except Exception as e:
        interviews, g = [], [f"interviews 拉取失败: {e}"]; gaps += g
    try:
        job_titles = load_job_titles()
    except Exception as e:
        job_titles, g = {}, [f"jobs 拉取失败: {e}"]; gaps += g
    app_map, errs = build_app_map_for_jobs(a.position, job_titles) if job_titles else ({}, ["jobs 缺失，app_map 未建"])
    gaps += errs
    talent_names = load_talent_names()
    ivs = build_interview_facts(interviews, talent_names, job_titles, a.position, app_map)

    # 3) 面评全文（只拉本岗有结论的场次，控制调用量）
    # 实现者注意修正：遍历 interviews 原始列表中 application_id ∈ app_map 的条目，
    # 直接用其 interview_record_list 取 record_id（原始 item 自带），不依赖 _interview_id。
    sys.path.insert(0, NOTES_DIR)
    from lib.hire_api import hire_get_interview_record
    feedback = []
    fb_fail = 0
    for iv in interviews:
        aid = iv.get("application_id")
        if aid not in app_map:
            continue
        for r in iv.get("interview_record_list") or []:
            if r.get("conclusion") is None:
                continue
            try:
                txt = extract_feedback_text(hire_get_interview_record(r.get("id")))
                if txt:
                    feedback.append({"name": talent_names.get(app_map[aid][0], app_map[aid][0]),
                                     "source": "面评", "text": txt, "date": None})
            except Exception:
                fb_fail += 1  # 单条面评失败不阻断，循环后计数落 gaps
    if fb_fail:
        gaps.append(f"面评拉取失败 {fb_fail} 条")
    # 4) 群原话 + 评估结论 + 卡住
    biz = {}
    try:
        with open(os.path.join(NOTES_DIR, "interviewers.json"), encoding="utf-8") as f:
            biz = {k: v.get("name", k) for k, v in json.load(f).items()}
    except OSError:
        gaps.append("interviewers.json 缺失，群原话归因降级")
    # Ruling U：泛化 bar 原话可见性——业务发送人的 text 消息摘录（不要求含候选人名），截前 40 条防爆
    group_excerpt = []
    for m in msgs:
        if m.get("msg_type") != "text":
            continue
        s = (m.get("sender") or {}).get("id")
        if s not in biz:
            continue
        try:
            body = json.loads(m.get("content") or "{}").get("text", m.get("content") or "")
        except Exception:
            body = m.get("content") or ""
        group_excerpt.append({"speaker": biz[s], "text": body, "date": m.get("create_time")})
    group_excerpt = group_excerpt[-40:]  # Ruling V: 取最近40条（复盘更关心近期业务口径，早期可由卡片引用历史facts）
    quotes = collect_group_quotes(msgs, biz, [p["name"] for p in pushes] + [i["name"] for i in ivs])
    for q in quotes:
        feedback.append({"name": q["name"], "source": "群原话", "text": q["text"],
                         "date": q["date"], "speaker": q["speaker"]})
    evals = load_eval_verdicts(sorted(_glob.glob(os.path.join(NOTES_DIR, "_发布版_简历评估_*.md"))))
    if not evals:
        gaps.append("评估报告解析为空")
    stuck = load_stuck_positions()
    anomalies = detect_anomalies(pushes, ivs, evals, quotes, stuck, a.position)

    # 5) 组装落盘
    facts = build_facts_dict(a.position, pushes, ivs, feedback, evals, anomalies,
                             (since, _time.strftime("%Y-%m-%d")), gaps, group_excerpt=group_excerpt)
    os.makedirs(NOTES_RETRO, exist_ok=True)
    md = _time.strftime("%-m.%-d") if os.name != "nt" else _time.strftime("%m.%d").lstrip("0").replace(".0", ".")
    out = os.path.join(NOTES_RETRO, f"_facts_{a.position}_{md}.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(facts, f, ensure_ascii=False, indent=1)
    ok, bad, unrep = person_rollup(ivs)   # Ruling T：人级口径（每人取最晚有结论轮）
    print(f"推 {sum(1 for p in pushes if p['position_matched'])} | 进面 {len({i['name'] for i in ivs})} | "
          f"过 {len(ok)} | 挂 {len(bad)} | 未交 {len(unrep)} | n_rule={facts['meta']['n_rule']}")
    for an in anomalies:
        print(f"  [{an['type']}] {an['names']}")
    if gaps:
        print("[data_gaps]", *gaps, sep="\n  ")
    print("facts ->", out)
    return 0

if __name__ == "__main__":
    sys.exit(main())
