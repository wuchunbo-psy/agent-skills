# -*- coding: utf-8 -*-
"""lib/hire_api.py — 飞书招聘（hire 域）最小封装（开源版自包含）。

⚠️ 本文件由仓库维护者手工维护：scripts/sync_to_opensource.py 不生成它，
   只把上层脚本里的 `from _lark_shared import ...` 重写为 `from lib.hire_api import ...`。

语义对齐内部版 notes/_lark_shared.py，两点差异：

- 鉴权：内部版 hire_api 用 requests 直连（tenant_access_token，~0.3s/次）；
  开源版统一走 lark-cli 子进程（零 token 管理、凭证零硬编码），代价是每次调用
  有 2-3.7s 的 CLI 冷启动。参考/低频使用足够，高频场景请自行换直连。
- 路径：缓存写进系统临时目录，不写仓库目录。

已知坑（内部实战沉淀，改动前先读）：
- /hire/v1/jobs 的 page_size 必须 ≤20，>20 返回空 items；
  /hire/v1/applications 实测支持 200，翻页省 10 倍请求。
- /hire/v1/applications 的 items 是 application_id 字符串数组（非对象数组），
  拿详情必须逐条调 hire_get_application(id)。
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import tempfile
import time

# 凭证走环境变量，不硬编码；Windows 下 subprocess 不走 PATHEXT，裸 "lark-cli" 会
# WinError 2，探测 .cmd 扩展（npm 全局装的话在 ~/AppData/Roaming/npm/）
_cli_env = os.environ.get("LARK_CLI_PATH")
if _cli_env:
    CLI = _cli_env
elif shutil.which("lark-cli"):
    CLI = shutil.which("lark-cli")
else:
    _win_guess = os.path.expanduser("~/AppData/Roaming/npm/lark-cli.cmd")
    CLI = _win_guess if os.path.exists(_win_guess) else "lark-cli"

# 固定 +08:00（业务时区），与内部版一致
TZ = datetime.timezone(datetime.timedelta(hours=8))

_TOKEN_ERR_CODES = {99991661, 99991663, 99991664, 99991668, 99991679}


def cli(args, timeout=120):
    """跑 lark-cli 子命令，返回 stdout+stderr 合并文本。"""
    env = dict(os.environ, MSYS_NO_PATHCONV="1")  # 防 git-bash 吃掉 /open-apis 前导斜杠
    r = subprocess.run([CLI] + args, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout, env=env)
    return (r.stdout or "") + (r.stderr or "")


def extract_json(raw):
    """从混了 tip/日志/notice 的 lark-cli 输出里抠出第一个 JSON 对象。"""
    m = re.search(r'\{[\s\S]*\}', raw)
    return json.loads(m.group(0)) if m else None


def api(method, path, params=None, data=None, timeout=120):
    """调 lark-cli api。成功返回 {ok:true, data:{...}}；失败/无 JSON 抛 RuntimeError。"""
    args = ["api", method, path, "--as", "bot"]
    if params:
        args += ["--params", json.dumps(params, ensure_ascii=False)]
    if data is not None:
        args += ["--data", json.dumps(data, ensure_ascii=False)]
    raw = cli(args, timeout=timeout)
    d = extract_json(raw)
    if d is None:
        raise RuntimeError(f"lark-cli 无 JSON 返回，原始输出前 200 字: {raw[:200]}")
    if d.get("ok") is False:
        err = d.get("error", {}) or {}
        code = err.get("code", 0)
        if code in _TOKEN_ERR_CODES:
            raise RuntimeError(f"token 过期/无效 (code={code})，请重跑 lark-cli auth login")
        raise RuntimeError(f"lark-cli 调用失败 code={code}: {err.get('message', '')[:200]}")
    return d


def hire_api(method, path, params=None, data=None, timeout=60):
    """hire 域调用，返回飞书原生 data 层（业务数据）；失败抛异常。

    path 形如 /open-apis/hire/v1/...。只用于 hire 域（bot token）；
    base/im/calendar 域要 user token，别走这里。
    """
    return api(method, path, params=params, data=data, timeout=timeout)


def check(d, where=""):
    """校验 hire_api/api 返回，返回 data 层；失败抛异常。"""
    if not isinstance(d, dict):
        raise RuntimeError(f"{where}: 无响应")
    if d.get("ok") is False:
        err = d.get("error", {}) or {}
        raise RuntimeError(f"{where}: code={err.get('code')} msg={err.get('message','')}")
    return d.get("data", {}) or {}


def to_ms(dt_str):
    """ISO 时间字符串 '2026-07-02 10:00' / '2026-07-02T10:00:00' → 毫秒时间戳（+08:00）。
    空串/None → 返回 ''（飞书 API 对空日期字段接受空串，不报错）。"""
    if not dt_str or not dt_str.strip():
        return ""
    s = dt_str.replace(" ", "T") if " " in dt_str and "T" not in dt_str else dt_str
    dt = datetime.datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return int(dt.timestamp() * 1000)


def from_ms(ms):
    """毫秒时间戳（int 或 str）→ 本地 datetime（+08:00）。"""
    if ms is None or ms == "":
        return None
    return datetime.datetime.fromtimestamp(int(ms) / 1000, tz=TZ)


def _page_all(path, params=None, data_key="items", page_size=20):
    """翻页拉 hire 列表接口。返回 items 数组。调用方按接口上限显式传大 page_size。"""
    params = dict(params or {})
    params["page_size"] = page_size
    out, pt = [], None
    while True:
        if pt:
            params["page_token"] = pt
        data = check(api("GET", path, params=params), f"_page_all {path}")
        out.extend(data.get(data_key, []) or [])
        pt = data.get("page_token") or ""
        if not data.get("has_more"):
            break
    return out


def hire_get_talent(talent_id, user_id_type="open_id"):
    """查人才详情。返回 talent dict（含 resume_attachment_list 等）。"""
    d = hire_api("GET", f"/open-apis/hire/v1/talents/{talent_id}",
                 params={"user_id_type": user_id_type})
    data = check(d, "hire_get_talent")
    return data.get("talent") or data


def hire_get_application(app_id):
    """查投递详情。返回 application dict（已是解包后对象，别再 .get('data')）。"""
    d = hire_api("GET", f"/open-apis/hire/v1/applications/{app_id}")
    data = check(d, "hire_get_application")
    return data.get("application") or data


def hire_list_applications(job_id=None, talent_id=None):
    """列投递。返回 application_id **字符串数组**(不是对象数组)。

    ⚠️ talent_id 过滤有效且默认含已终止投递(active_status=2)。
    例:
        for aid in hire_list_applications(talent_id="xxx"):
            app = hire_get_application(aid)  # 拿详情
    """
    params = {}
    if job_id:
        params["job_id"] = job_id
    if talent_id:
        params["talent_id"] = talent_id
    # applications 的 page_size=200 实测可用（jobs 才有 >20 返回空的坑）
    return _page_all("/open-apis/hire/v1/applications", params, page_size=200)


_JOBS_CACHE_FILE = os.path.join(tempfile.gettempdir(), "agent_skills_jobs_cache.json")
_JOBS_CACHE_TTL = 6 * 3600  # 岗位增减低频，没必要每次实时翻页（page_size≤20 → 每页一次 CLI 冷启动）


def get_all_jobs_raw(force_refresh=False):
    """全量拉岗位（带落盘缓存，TTL 6h），返回 items 数组。force_refresh=True 强制实时拉并回写。"""
    if not force_refresh and os.path.exists(_JOBS_CACHE_FILE):
        try:
            with open(_JOBS_CACHE_FILE, encoding="utf-8") as f:
                d = json.load(f)
            if time.time() - d.get("ts", 0) < _JOBS_CACHE_TTL:
                return d.get("items", [])
        except Exception:
            pass
    items = _page_all("/open-apis/hire/v1/jobs")  # page_size 保持默认 20（jobs >20 返回空）
    try:
        with open(_JOBS_CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump({"ts": time.time(), "items": items}, f, ensure_ascii=False)
    except Exception:
        pass
    return items


def hire_get_interview_record(record_id):
    """查面评全文记录（v2 接口，路径含 v2）。返回 record dict。"""
    d = hire_api("GET", f"/open-apis/hire/v2/interview_records/{record_id}")
    data = check(d, "hire_get_interview_record")
    return data.get("interview_record") or data
