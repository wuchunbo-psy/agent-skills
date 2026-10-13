# -*- coding: utf-8 -*-
"""
展示面试官本周（或指定区间）可约时段。

输出三种形式（skill 标准展示）：
  1. markdown 表格：日期 | 空闲时段 | 备注（自动生成"最宽裕/时段零碎/周末"等备注）
  2. 可排档位列表（默认 45 分钟/场切档，只列未来档位）
  3. --svg <path>：生成时间轴色段图（SVG），空闲绿/会议红（标候选人+时刻）/午休灰/已过半透明；全空周末整行不画，有安排/今天的周末日照画（行尾「周末」徽标）；调休补班日按工作日照画（--workdays 可追加名单）
  4. --html <path>：生成 HTML 色段条（div 布局文件）。**2026-09-02 起对话内联标准 = --svg 出图后 Playwright 渲 PNG 3 倍分辨率内嵌**；SVG/HTML 作为文件产物留存

用法：
  python show_availability.py --interviewer 面试官B
  python show_availability.py --interviewer 谢坤,潘腾飞 --duration 60     # 多人：每人 + 共同档位
  python show_availability.py --interviewer 面试官B --svg out.svg        # 同时生成色段图
  python show_availability.py --interviewer 面试官B --html out.html      # 生成 HTML 色段条文件（内联看 PNG 3x，见 --svg 用法）
  python show_availability.py --interviewer 面试官B --start 2026-08-05 --days 3
  python show_availability.py --interviewer 面试官B --work-start 10:00 --work-end 20:00  # 晚上面试
  python show_availability.py --interviewer 面试官B --past               # 连已过档位一起列

与 match_schedule.py 共用 freebusy 反推逻辑（同一数据源），只展示不排候选人。
"""
import argparse
import datetime
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from match_schedule import resolve_interviewers, get_freebusy_blocks, TZ, is_weekend, EXTRA_WORKDAYS


def _short_job(title):
    """岗位全名 → 图上短名：去括号注释、去常见尾缀、去空格，限 7 字。
    例：Unity 客户端开发工程师（AI-Native 方向）→ Unity客户端；系统客户端程序 → 系统客户端。"""
    import re as _re
    t = _re.sub(r"[（(].*?[)）]", "", title or "").strip()
    for suf in ("开发工程师", "工程师", "设计师", "程序", "开发"):
        if t.endswith(suf):
            t = t[: -len(suf)]
            break
    return t.replace(" ", "")[:7]


def fetch_interview_labels(oids, start_iso, end_iso):
    """⑥手法：时间窗拉全租户面试，过滤面试官=oids，返回 [(begin_dt, end_dt, 姓名, 岗位短名)]。
    姓名走 talents 缓存（miss 走服务端查），岗位短名走 application.job_id → jobs 全量表。
    任何失败返回 []——会议块退化为不标姓名，只影响 SVG 块标注，不影响忙闲正确性（忙闲仍以 freebusy 为准）。"""
    try:
        import json as _json
        import time as _time
        sys.path.insert(0, os.path.join(os.environ.get("PROJECT_ROOT", os.getcwd()), "notes"))
        from lib.hire_api import _page_all, get_all_jobs_raw, hire_get_application, hire_get_talent, to_ms
        tc = _json.load(open(os.path.join(os.environ.get("PROJECT_ROOT", os.getcwd()), "notes", "_talents_cache.json"), encoding="utf-8"))
        tname = {t.get("id"): t.get("name", "") for t in tc.get("items", [])}
        jtitle = {j.get("id"): j.get("title", "") for j in get_all_jobs_raw()}
    except Exception as e:
        print(f"  [⚠️ 面试姓名标注跳过] {e}")
        return []
    try:
        # end 用完整 ISO（含 T23:59:59）：截 [:10] 会把窗口终点砍成当天 00:00，
        # 单日查询时 start==end 区间为空 → 面试标注静默消失（2026-09-02 单日出图实测踩坑）
        end_ms = to_ms(end_iso) if not str(end_iso).isdigit() else str(end_iso)
        items = _page_all("/open-apis/hire/v1/interviews",
                          {"start_time": to_ms(start_iso[:10]), "end_time": end_ms})
    except Exception as e:
        print(f"  [⚠️ 面试姓名标注跳过] interviews 查询失败: {e}")
        return []
    oset = set(oids)
    seen_iv = set()
    out = []
    apps = {}
    for iv in items:
        if iv.get("id") in seen_iv:
            continue
        seen_iv.add(iv.get("id"))
        for r in iv.get("interview_record_list", []) or []:
            if (r.get("interviewer") or {}).get("id") not in oset:
                continue
            bt, et = iv.get("begin_time"), iv.get("end_time")
            if not bt or not et:
                continue
            aid = iv.get("application_id")
            if aid and aid not in apps:
                try:
                    _app = hire_get_application(aid) or {}
                    apps[aid] = (_app.get("talent_id", ""), _app.get("job_id", ""))
                except Exception:
                    apps[aid] = ("", "")
            tid, jid = apps.get(aid, ("", ""))
            name = tname.get(tid, "")
            if not name:
                # talents 缓存只隔夜重建，当天新录的人不在 → 服务端查一次（按 tid 去重）
                if tid and tid not in tname:
                    try:
                        name = ((hire_get_talent(tid) or {}).get("basic_info") or {}).get("name", "")
                        tname[tid] = name
                    except Exception:
                        name = ""
            name = name or "候选人"
            b = datetime.datetime.fromtimestamp(int(bt) / 1000, TZ)
            e2 = datetime.datetime.fromtimestamp(int(et) / 1000, TZ)
            out.append((b, e2, name, _short_job(jtitle.get(jid, ""))))
    return out


def parse_hhmm(s):
    h, m = s.split(":")
    return int(h), int(m)


def fmt(dt):
    return dt.strftime("%H:%M")


def merge_segs(segs):
    segs = sorted(segs)
    merged = []
    for s, e in segs:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    return merged


def build_table(days_info, duration, ws_str, we_str):
    """生成 markdown 表格：日期 | 空闲时段 | 备注"""
    lines = ["| 日期 | 空闲时段 | 备注 |", "|---|---|---|"]
    for d in days_info:
        label, seg_txt, remark, _ = d
        lines.append(f"| {label} | {seg_txt or '—'} | {remark} |")
    return "\n".join(lines)


def remark_for(day, today, segs, weekend_note, coverage):
    """备注列自动生成"""
    if day < today:
        return "已过去"
    if is_weekend(day):
        return "周末·一般不上班"
    if not segs:
        return "❌ 无可约时段"
    if coverage >= 6.5:
        return "最宽裕，几乎整天"
    if coverage >= 4:
        return "较宽裕"
    return "时段零碎"


def _merge_busy(segs):
    # 重叠会议合并为并集块再画：嵌套红块会盖住前一块的标注、自己又窄到标不出字（2026-09-08 同事 11:00-12:00+11:00-11:45 案例）
    # seg 兼容 (s,e)/(s,e,who)/(s,e,who,job)，合并后统一 4 元组；候选人标注优先保留（有姓名的块信息量高）
    merged = []
    for seg in sorted(segs, key=lambda x: (x[0], x[1])):
        s, e = seg[0], seg[1]
        who = seg[2] if len(seg) > 2 else ""
        job = seg[3] if len(seg) > 3 else ""
        if merged and s < merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], e)
            if not merged[-1][2] and who:
                merged[-1][2], merged[-1][3] = who, job
        else:
            merged.append([s, e, who, job])
    return [tuple(m) for m in merged]


def build_svg(title, subtitle, days_info, ws_h, we_h, today, now, duration, out_path,
              lunch=(datetime.time(12, 0), datetime.time(14, 0))):
    """生成时间轴色段图 SVG。
    days_info: [(label, seg_txt, remark, day_data)] 其中 day_data =
      {"date", "free": [(s,e),...], "busy": [(s,e,who?),...], "weekend": bool, "past": bool}
    """
    # 周末行：全空周末不画；有会议/面试或是今天的周末日照画（行尾标「周末」徽标），
    # 调休补班日（is_weekend=False）按工作日照画
    days_info = [d for d in days_info
                 if not d[3].get("weekend") or d[3].get("busy") or d[3]["date"] == today]
    # 画布宽 2026-09-03：680→1070，45 分钟面试块≈61px，块内两行标（姓名+时刻）放得下
    X0, X1 = 130, 1030
    W = X1 - X0
    ROW_H, GAP = 48, 16
    y0 = 100  # 首行 y
    n = len(days_info)
    rows_bottom = y0 + n * (ROW_H + GAP) - GAP
    AXIS_Y = rows_bottom + 14
    LABEL_Y = AXIS_Y + 26
    H = LABEL_Y + 28

    px_per_h = W / (we_h - ws_h)

    def tx(hhmm):
        h, m = int(hhmm[:2]), int(hhmm[3:5])
        return X0 + (h + m / 60 - ws_h) * px_per_h

    parts = []
    # 配色规范（2026-09-02 审美版）：空闲绿为视觉主角（要一眼扫到"能约"），
    # 会议块加描边更"实"、午休弱灰；列斑马纹辅助按小时对列。
    parts.append(f'<svg viewBox="0 0 {X1 + 40} {H}" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" font-family="PingFang SC, Microsoft YaHei, sans-serif">')
    parts.append(f'<rect x="0" y="0" width="{X1 + 40}" height="{H}" fill="#FBFAF6"/>')
    parts.append(f"<title>{title}</title>")
    parts.append("<desc>面试官可约时段色段图：绿=空闲可约（块内标起止与时长），红=已有会议（标候选人+时刻），灰=午休，半透明=已过时段，全空周末不画（有安排的周末日照画）</desc>")
    parts.append(f'<text x="36" y="34" font-size="22" font-weight="700" fill="#2C2C2A">{title}</text>')
    parts.append(f'<text x="36" y="58" font-size="13" fill="#6B6A64">{subtitle}</text>')
    # 图例
    ly = 76
    parts.append(f'<rect x="130" y="{ly}" width="16" height="16" rx="4" fill="#7FCEB2"/>')
    parts.append(f'<text x="152" y="{ly+13}" font-size="13" fill="#444441">空闲可约</text>')
    parts.append(f'<rect x="252" y="{ly}" width="16" height="16" rx="4" fill="#F6ACA3"/>')
    parts.append(f'<text x="274" y="{ly+13}" font-size="13" fill="#444441">已有会议</text>')
    parts.append(f'<rect x="360" y="{ly}" width="16" height="16" rx="4" fill="#DCD9CF"/>')
    parts.append(f'<text x="382" y="{ly+13}" font-size="13" fill="#444441">午休</text>')
    parts.append(f'<rect x="446" y="{ly}" width="16" height="16" rx="4" fill="#9FE1CB" opacity="0.45"/>')
    parts.append(f'<text x="468" y="{ly+13}" font-size="13" fill="#444441">已过</text>')
    # 当前时刻胶囊（右上）：今天出现在图里就画（含调休日/有安排的周末）
    if not is_weekend(today) or any(d[3]["date"] == today for d in days_info):
        parts.append(f'<rect x="{X1 - 104}" y="14" width="104" height="26" rx="13" fill="#EFEDE4"/>')
        parts.append(f'<text x="{X1 - 52}" y="31" font-size="13" fill="#55544F" text-anchor="middle">当前 {now.strftime("%H:%M")}</text>')

    # 30 分钟细网格 + 整小时主网格（画在色块层之下，跨全部行区域）
    for k in range(int((we_h - ws_h) * 2) + 1):
        gx = X0 + k * 30 / 60 * px_per_h
        major = (k % 2 == 0)
        parts.append(f'<line x1="{gx:.1f}" y1="{y0 - 8}" x2="{gx:.1f}" y2="{rows_bottom + 6}" '
                     f'stroke="#{"D6D3C8" if major else "#ECE9E1"}" stroke-width="{0.9 if major else 0.5}"/>')

    for i, d in enumerate(days_info):
        label, _, _, data = d
        y = y0 + i * (ROW_H + GAP)
        day = data["date"]
        wd = "一二三四五六日"[day.weekday()]
        past = day < today

        def blk_op(s, e):
            # 已过整日整行半透明；今天则按块是否已过（块结束 <= now → 半透明）
            if past:
                return "0.45"
            if day == today and e <= now:
                return "0.45"
            return "1"
        # 行底 + 奇数小时列条纹（斑马纹，辅助按列对时）
        parts.append(f'<rect x="{X0}" y="{y}" width="{W}" height="{ROW_H}" rx="6" fill="#F1EFE7"/>')
        for k in range(ws_h, we_h):
            if k % 2 == 1:
                bx = X0 + (k - ws_h) * px_per_h
                parts.append(f'<rect x="{bx:.1f}" y="{y}" width="{px_per_h:.1f}" height="{ROW_H}" fill="#FFFFFF" opacity="0.35"/>')
        parts.append(f'<text x="122" y="{y + ROW_H / 2 + 6:.1f}" font-size="16" font-weight="600" fill="#2C2C2A" text-anchor="end">{label}</text>')
        # 工作时段截断显示
        day_s = datetime.datetime(day.year, day.month, day.day, ws_h, 0, tzinfo=TZ)
        day_e = datetime.datetime(day.year, day.month, day.day, we_h, 0, tzinfo=TZ)
        # 午休灰块（--lunch 时段且在窗口内，默认 12:00-14:00）
        lunch_s = datetime.datetime(day.year, day.month, day.day, lunch[0].hour, lunch[0].minute, tzinfo=TZ)
        lunch_e = datetime.datetime(day.year, day.month, day.day, lunch[1].hour, lunch[1].minute, tzinfo=TZ)
        ls, le = max(lunch_s, day_s), min(lunch_e, day_e)
        if le > ls:
            parts.append(f'<rect x="{tx(ls.strftime("%H:%M"))}" y="{y}" width="{max(2, tx(le.strftime("%H:%M"))-tx(ls.strftime("%H:%M")))}" height="{ROW_H}" rx="6" fill="#DCD9CF" opacity="{blk_op(lunch_s, lunch_e)}"/>')
        # 空闲绿块（视觉主角：宽段标起止+时长；窄段不标防挤，精确时刻看图下忙闲列表）
        for s, e in data.get("free", []):
            ss, ee = max(s, day_s), min(e, day_e)
            if ee > ss:
                x_s, x_e = tx(ss.strftime("%H:%M")), tx(ee.strftime("%H:%M"))
                w = max(2, x_e - x_s)
                parts.append(f'<rect x="{x_s}" y="{y}" width="{w}" height="{ROW_H}" rx="6" fill="#7FCEB2" opacity="{blk_op(ss, ee)}"/>')
                if w >= 108:
                    hrs = (ee - ss).total_seconds() / 3600
                    dur = f"{int(hrs)}h" if hrs == int(hrs) else f"{hrs:.1f}h"
                    parts.append(f'<text x="{(x_s + x_e) / 2:.1f}" y="{y + ROW_H / 2 + 5:.1f}" font-size="12" font-weight="600" fill="#0D5138" text-anchor="middle">{ss.strftime("%H:%M")}-{ee.strftime("%H:%M")} · {dur}</text>')
                elif w >= 78:
                    parts.append(f'<text x="{(x_s + x_e) / 2:.1f}" y="{y + ROW_H / 2 + 5:.1f}" font-size="12" font-weight="600" fill="#0D5138" text-anchor="middle">{ss.strftime("%H:%M")}-{ee.strftime("%H:%M")}</text>')
        # 忙碌红块（描边加"实"感；候选人块两行标=姓名+岗位短名，无主会议单行标时刻）
        for seg in _merge_busy(data.get("busy", [])):
            s, e = seg[0], seg[1]
            who = seg[2] if len(seg) > 2 else ""
            ss, ee = max(s, day_s), min(e, day_e)
            if ee > ss:
                x_s, x_e = tx(ss.strftime("%H:%M")), tx(ee.strftime("%H:%M"))
                w = max(2, x_e - x_s)
                parts.append(f'<rect x="{x_s}" y="{y}" width="{w}" height="{ROW_H}" rx="6" fill="#F6ACA3" stroke="#E08A80" stroke-width="0.8" opacity="{blk_op(ss, ee)}"/>')
                if who:
                    # 候选人块两行标（2026-09-03 定稿）：上行姓名，下行岗位短名（放得下才标；CJK≈12px/字@12px、≈10px/字@10px）
                    maxc = max(3, int(w / 12))
                    name_only = who.split("·", 1)[0] if "·" in who else who
                    shown = who if len(who) <= maxc else (name_only if len(name_only) <= maxc else name_only[:maxc - 1] + "…")
                    cx = (x_s + x_e) / 2
                    job = seg[3] if len(seg) > 3 else ""
                    if job and w >= len(job) * 10 + 2:
                        parts.append(f'<text x="{cx:.1f}" y="{y + 20}" font-size="12" font-weight="600" fill="#7E2424" text-anchor="middle">{shown}</text>')
                        parts.append(f'<text x="{cx:.1f}" y="{y + 35}" font-size="10" fill="#A35D5D" text-anchor="middle">{job}</text>')
                    else:
                        parts.append(f'<text x="{cx:.1f}" y="{y + ROW_H / 2 + 5:.1f}" font-size="12" font-weight="600" fill="#7E2424" text-anchor="middle">{shown}</text>')
                elif w >= 76:
                    parts.append(f'<text x="{(x_s + x_e) / 2:.1f}" y="{y + ROW_H / 2 + 5:.1f}" font-size="12" fill="#7E2424" text-anchor="middle">{ss.strftime("%H:%M")}-{ee.strftime("%H:%M")}</text>')
                elif w >= 30:
                    parts.append(f'<text x="{(x_s + x_e) / 2:.1f}" y="{y + ROW_H / 2 + 5:.1f}" font-size="11" fill="#7E2424" text-anchor="middle">{ss.strftime("%H:%M")}</text>')
        # 今天已过时段整段弱化（subtitle 承诺"半透明=已过"；块级判断只盖整块已过的，跨当前时刻的块由这里兜底）
        if day == today:
            ov_e = min(X1, tx(now.strftime("%H:%M")))
            if ov_e > X0:
                parts.append(f'<rect x="{X0}" y="{y}" width="{ov_e - X0:.1f}" height="{ROW_H}" fill="#FBFAF6" opacity="0.5"/>')
        # 今天当前时刻竖线
        if day == today:
            now_x = tx(now.strftime("%H:%M"))
            if X0 < now_x < X1:
                parts.append(f'<line x1="{now_x}" y1="{y}" x2="{now_x}" y2="{y+ROW_H}" stroke="#C0564C" stroke-width="1.6" stroke-dasharray="4,3"/>')
        # 右侧标记：已过优先，真周末（有安排才画出来的）标徽标提醒
        if past:
            parts.append(f'<text x="{X1 + 16}" y="{y + ROW_H / 2 + 5:.1f}" font-size="13" fill="#A32D2D" text-anchor="end">已过</text>')
        elif data.get("weekend"):
            parts.append(f'<text x="{X1 + 16}" y="{y + ROW_H / 2 + 5:.1f}" font-size="13" fill="#8B897F" text-anchor="end">周末</text>')

    # 时间轴
    parts.append(f'<line x1="{X0}" y1="{AXIS_Y}" x2="{X1}" y2="{AXIS_Y}" stroke="#D6D3C8" stroke-width="1"/>')
    for h in range(ws_h, we_h + 1):
        x = X0 + (h - ws_h) * px_per_h
        parts.append(f'<line x1="{x}" y1="{AXIS_Y}" x2="{x}" y2="{AXIS_Y + 5}" stroke="#C9C6BC" stroke-width="1"/>')
        parts.append(f'<text x="{x}" y="{LABEL_Y}" font-size="13" fill="#6B6A64" text-anchor="middle">{h}:00</text>')
    parts.append("</svg>")
    svg = "\n".join(parts)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(svg)
    return out_path


def build_html(title, subtitle, days_info, ws_h, we_h, today, now, duration, out_path,
               lunch=(datetime.time(12, 0), datetime.time(14, 0))):
    """生成 HTML 色段条（div 布局，浅色主题，对话内联展示用）。
    与 build_svg 同一数据源同一配色：绿=空闲 #9FE1CB / 红=会议 #F7C1C1 / 灰=午休 #D3D1C7。
    days_info 同 build_svg。
    """
    hours = we_h - ws_h

    def pct(dt):
        return (dt.hour + dt.minute / 60 - ws_h) / hours * 100

    parts = []
    parts.append('<div style="font-family:var(--font-sans);color:#2C2C2A;max-width:680px">')
    parts.append(f'<div style="font-size:15px;font-weight:500">{title}</div>')
    parts.append(f'<div style="font-size:12px;color:#5F5E5A;margin:2px 0 8px">{subtitle}</div>')
    parts.append(
        '<div style="display:flex;gap:14px;font-size:12px;color:#444441;margin-bottom:8px">'
        '<span style="display:flex;align-items:center;gap:4px"><span style="width:14px;height:14px;border-radius:2px;background:#9FE1CB;display:inline-block"></span>空闲可约</span>'
        '<span style="display:flex;align-items:center;gap:4px"><span style="width:14px;height:14px;border-radius:2px;background:#F7C1C1;display:inline-block"></span>已有会议</span>'
        '<span style="display:flex;align-items:center;gap:4px"><span style="width:14px;height:14px;border-radius:2px;background:#D3D1C7;display:inline-block"></span>午休</span>'
        '<span style="color:#888780">半透明 = 已过 / 周末</span></div>')
    now_pct = pct(now) if not is_weekend(today) else None
    for label, _, _, data in days_info:
        day = data["date"]
        past = day < today
        weekend = is_weekend(day)
        day_s = datetime.datetime(day.year, day.month, day.day, ws_h, 0, tzinfo=TZ)
        day_e = datetime.datetime(day.year, day.month, day.day, we_h, 0, tzinfo=TZ)

        def blk(s, e, color):
            ss, ee = max(s, day_s), min(e, day_e)
            if ee <= ss:
                return ""
            o = "0.45" if (past or weekend or (day == today and ee <= now)) else "1"
            return (f'<div style="position:absolute;left:{pct(ss):.2f}%;width:{max(0.4, pct(ee)-pct(ss)):.2f}%;'
                    f'top:0;bottom:0;background:{color};opacity:{o};border-radius:2px"></div>')

        row = ('<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">'
               f'<div style="width:86px;text-align:right;font-size:13px;font-weight:500;flex-shrink:0">{label}</div>'
               '<div style="flex:1;height:28px;border-radius:4px;background:#F1EFE8;position:relative;overflow:hidden">')
        lunch_s = datetime.datetime(day.year, day.month, day.day, lunch[0].hour, lunch[0].minute, tzinfo=TZ)
        lunch_e = datetime.datetime(day.year, day.month, day.day, lunch[1].hour, lunch[1].minute, tzinfo=TZ)
        row += blk(lunch_s, lunch_e, "#D3D1C7")
        for s, e in data.get("free", []):
            row += blk(s, e, "#9FE1CB")
        for s, e, *_ in _merge_busy(data.get("busy", [])):
            row += blk(s, e, "#F7C1C1")
        if day == today and now_pct is not None and 0 < now_pct < 100:
            row += (f'<div style="position:absolute;left:{now_pct:.2f}%;top:0;bottom:0;width:1px;'
                    f'background:#5F5E5A;opacity:0.75"></div>')
        row += '</div>'
        right = ("已过" if past else ("周末" if weekend else ""))
        row += (f'<div style="width:34px;font-size:11px;color:{"#A32D2D" if past else "#888780"};'
                f'flex-shrink:0;text-align:right">{right}</div>')
        row += '</div>'
        parts.append(row)
    # 时间轴
    axis = ('<div style="margin-left:96px;position:relative;height:18px;margin-top:2px">'
            '<div style="position:absolute;left:0;right:0;top:6px;border-top:0.5px solid #D3D1C7"></div>')
    for h in range(ws_h, we_h + 1):
        p = (h - ws_h) / hours * 100
        tr = "translateX(0)" if h == ws_h else ("translateX(-100%)" if h == we_h else "translateX(-50%)")
        axis += (f'<span style="position:absolute;left:{p:.2f}%;transform:{tr};'
                 f'top:9px;font-size:11px;color:#888780">{h}:00</span>')
    axis += '</div>'
    parts.append(axis)
    parts.append('</div>')
    html = "\n".join(parts)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)
    return out_path


def main():
    ap = argparse.ArgumentParser(description="展示面试官可约时段（表格 + 档位 + 色段图）")
    ap.add_argument("--interviewer", required=True, help="面试官姓名，逗号分隔")
    ap.add_argument("--duration", type=int, default=45, help="每场时长（分钟），默认 45")
    ap.add_argument("--start", default="", help="起始日期 YYYY-MM-DD，默认本周一")
    ap.add_argument("--days", type=int, default=7, help="展示天数，默认 7")
    ap.add_argument("--work-start", default="09:00", help="工作开始，默认 09:00")
    ap.add_argument("--work-end", default="20:00", help="工作结束，默认 20:00（2026-09-02 用户定稿：面试最晚约到 20:00）")
    ap.add_argument("--lunch", default="12:00-14:00", help="午休时段 HH:MM-HH:MM，默认 12:00-14:00（2026-09-01 用户定稿：公司午休）")
    ap.add_argument("--past", action="store_true", help="连已过档位一起列出")
    ap.add_argument("--svg", default="", help="生成色段图 SVG 文件路径（如 availability.svg）")
    ap.add_argument("--png", default="", help="生成 PNG 3x 文件路径（对话内嵌标准产物；未传 --svg 时自动同目录产 SVG 原稿）")
    ap.add_argument("--html", default="", help="生成 HTML 色段条文件路径（文件产物；内联标准=PNG 3x）")
    ap.add_argument("--workdays", default="", help="调休补班日 YYYY-MM-DD，逗号分隔：名单里的周六日按工作日展示/画行")
    args = ap.parse_args()
    EXTRA_WORKDAYS.update(x.strip() for x in args.workdays.split(",") if x.strip())

    ws_h, ws_m = parse_hhmm(args.work_start)
    we_h, we_m = parse_hhmm(args.work_end)
    _ls, _le = args.lunch.split("-")
    ls_h, ls_m = parse_hhmm(_ls.strip())
    le_h, le_m = parse_hhmm(_le.strip())
    lunch = (datetime.time(ls_h, ls_m), datetime.time(le_h, le_m))
    today = datetime.date.today()
    if args.start:
        start = datetime.date.fromisoformat(args.start)
    else:
        start = today - datetime.timedelta(days=today.weekday())
    end = start + datetime.timedelta(days=args.days - 1)

    interviewer_names = [n.strip() for n in args.interviewer.split(",")]
    oids, labels, _infos = resolve_interviewers(interviewer_names)
    if not oids:
        print("[❌] 面试官解析失败，终止")
        return

    start_iso = f"{start}T00:00:00+08:00"
    end_iso = f"{end}T23:59:59+08:00"
    blocks, busy_by_date, _blocks_raw = get_freebusy_blocks(oids, start_iso, end_iso, labels)
    # 会议块标面试姓名（⑥手法：ATS interviews 时间窗按面试官过滤，时间重叠匹配忙块）
    iv_labels = fetch_interview_labels(oids, start_iso, end_iso)

    def _iv_label_at(s, e):
        for b, e2, nm, jb in iv_labels:
            if b < e and s < e2:
                return nm, jb
        return "", ""

    now = datetime.datetime.now(TZ)
    wd_cn = "一二三四五六日"

    print(f"\n=== {'、'.join(labels)} 可约时段（{args.duration}分钟/场）===")
    print(f"查询区间：{start.month}/{start.day}（周{wd_cn[start.weekday()]}）~ "
          f"{end.month}/{end.day}（周{wd_cn[end.weekday()]}）｜"
          f"工作时段 {args.work_start}-{args.work_end}｜午休 {args.lunch} 已排除"
          + ("" if args.past else "｜仅列未来档位"))

    # 按天聚合：空闲段（工作时段截断）+ 忙碌段
    free_by_day = {}
    busy_by_day = {}
    for bs, be in blocks:
        day = bs.date()
        win_s = datetime.datetime(day.year, day.month, day.day, ws_h, ws_m, tzinfo=TZ)
        win_e = datetime.datetime(day.year, day.month, day.day, we_h, we_m, tzinfo=TZ)
        s, e = max(bs, win_s), min(be, win_e)
        if e > s:
            free_by_day.setdefault(day, []).append((s, e))
    for d, lst in busy_by_date.items():
        busy_by_day[d] = lst

    def gen_slots(day, segs):
        out = []
        for s, e in segs:
            cur = s
            while cur + datetime.timedelta(minutes=args.duration) <= e:
                if args.past or cur >= now:
                    out.append(cur.strftime("%H:%M"))
                cur += datetime.timedelta(minutes=args.duration)
        return out

    days_info = []
    print()
    for d in (start + datetime.timedelta(days=i) for i in range(args.days)):
        label = f"{d.month}/{d.day}（周{wd_cn[d.weekday()]}）"
        segs = merge_segs(free_by_day.get(d, []))
        busy_segs = [(s, e) + _iv_label_at(s, e) for s, e, *_ in busy_by_day.get(d, [])]
        coverage = sum((e - s).total_seconds() / 3600 for s, e in segs)
        seg_txt = "、".join(f"{fmt(s)}-{fmt(e)}" for s, e in segs)
        remark = remark_for(d, today, segs, True, coverage)
        days_info.append((label, seg_txt, remark, {
            "date": d, "free": segs, "busy": busy_segs,
            "weekend": is_weekend(d), "past": d < today,
        }))
        if d < today:
            print(f"{label}: 已过去，跳过")
            continue
        if not segs:
            print(f"{label}: ❌ 无可约时段")
            continue
        slots = gen_slots(d, segs)
        if not slots:
            print(f"{label}: 空闲 {seg_txt}，但今日已过时段，无可排未来档位")
            continue
        am = [x for x in slots if int(x[:2]) < 12]
        pm = [x for x in slots if int(x[:2]) >= 13]
        parts = []
        if am:
            parts.append("上午: " + " ".join(am))
        if pm:
            parts.append("下午: " + " ".join(pm))
        print(f"{label}: 空闲 {seg_txt}")
        print(f"  可排档位（{'/'.join(parts)}）")

    # markdown 表格（skill 标准展示形式）
    print("\n=== 表格（复制用）===")
    print(build_table(days_info, args.duration, args.work_start, args.work_end))

    # 多人共同档位
    if len(oids) > 1:
        print("\n=== 共同可排档位 ===")
        for d in (start + datetime.timedelta(days=i) for i in range(args.days)):
            if d < today:
                continue
            segs = merge_segs(free_by_day.get(d, []))
            slots = gen_slots(d, segs)
            if slots:
                print(f"{d.month}/{d.day}（周{wd_cn[d.weekday()]}）: " + " ".join(slots))
        print("\n（说明：上方为空闲段反推交集，真实会议见飞书日历；档位为建议起点，需按会议时长复查）")

    # SVG 色段图
    if args.svg:
        title = f"{'、'.join(labels)} 可约时段"
        subtitle = (f"工作时段 {args.work_start}-{args.work_end} · 已排除午休 {args.lunch} · "
                    f"半透明色块 = 已过时段")
        out = build_svg(title, subtitle, days_info, ws_h, we_h, today, now, args.duration, args.svg, lunch=lunch)
        print(f"\n[✅] 色段图已生成: {out}")

    # PNG 3x（对话内嵌标准产物；渲染走同目录 svg2png.js，playwright 在项目 node_modules）
    if args.png:
        import subprocess
        svg_for_png = args.svg
        if not svg_for_png:
            svg_for_png = args.png[:-4] + ".svg" if args.png.lower().endswith(".png") else args.png + ".svg"
        if not args.svg:
            title = f"{'、'.join(labels)} 可约时段"
            subtitle = (f"工作时段 {args.work_start}-{args.work_end} · 已排除午休 {args.lunch} · "
                        f"半透明色块 = 已过时段")
            build_svg(title, subtitle, days_info, ws_h, we_h, today, now, args.duration, svg_for_png, lunch=lunch)
        renderer = os.path.join(os.path.dirname(os.path.abspath(__file__)), "svg2png.js")
        env = dict(os.environ, NODE_PATH=os.path.join(os.environ.get("PROJECT_ROOT", os.getcwd()), "node_modules"))
        try:
            r = subprocess.run(["node", renderer, svg_for_png, args.png], env=env,
                               capture_output=True, text=True, timeout=120)
            if r.returncode == 0:
                print(f"[✅] PNG(3x) 已生成: {args.png}")
            else:
                print(f"[⚠️] PNG 渲染失败: {(r.stderr or r.stdout).strip()[-200:]}")
                print(f"     SVG 原稿在 {svg_for_png}，可手动重试: node {renderer} {svg_for_png} {args.png}")
        except Exception as e:
            print(f"[⚠️] PNG 渲染失败: {e}")
            print(f"     SVG 原稿在 {svg_for_png}，可手动重试: node {renderer} {svg_for_png} {args.png}")

    # HTML 色段条（文件产物；2026-09-02 起内联标准=PNG 3x）
    if args.html:
        title = f"{'、'.join(labels)} 可约时段"
        subtitle = (f"工作时段 {args.work_start}-{args.work_end} · 已排除午休 {args.lunch} · "
                    f"半透明色块 = 已过时段")
        out = build_html(title, subtitle, days_info, ws_h, we_h, today, now, args.duration, args.html, lunch=lunch)
        print(f"\n[✅] 色段图(HTML)已生成: {out}")


if __name__ == "__main__":
    main()
