#!/usr/bin/env node
/**
 * 招聘作战台 · 本地服务 v2
 * --------------------------------------------
 * 零依赖（仅 Node 内置模块）。
 * 职责：
 *   1. 静态服务 workbench/ 目录（index.html 单文件应用）
 *   2. GET  /api/data     → 合并返回 notes/_daily_review.json + _signals.json + _nurture_state.json
 *   3. GET  /api/status   → 数据新鲜度 + 刷新任务状态
 *   4. POST /api/decide   → 决策写回（语义复刻 signals.py --decide，本服务自包含实现）
 *   5. POST /api/touch    → 记录保温触达（语义复刻 nurture_state.py --touch）
 *   6. POST /api/response → 记录候选人回复状态（语义复刻 nurture_state.py --response）
 *   7. POST /api/nurture-reset → 终止保温跟踪（语义复刻 nurture_state.py --reset）
 *   8. POST /api/refresh  → 异步触发早晨对账（python notes/_daily_review.py），GET /api/status 轮询
 *
 * 安全：仅绑定 127.0.0.1；写回语义服务端自包含（不调 skill 内脚本），前端不直接写 JSON。
 * 启动：node server.mjs   （PORT 环境变量覆盖，默认 5173）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');          // 项目根（workbench 上一级，notes/ 数据所在处）
const PORT = Number(process.env.PORT || 5173);
const HOST = '127.0.0.1';

const REVIEW_PY = path.join(ROOT, 'notes', '_daily_review.py');
const REFRESH_LOG = path.join(ROOT, 'notes', '_wb_refresh.log');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function readJson(relOrAbs) {
  try {
    const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.join(ROOT, relOrAbs);
    if (!fs.existsSync(abs)) return null;
    return JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch {
    return null;
  }
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 对账刷新异步任务 ----------
const refreshJob = { running: false, started_at: null, finished_at: null, ok: null, tail: '' };

function startRefresh() {
  if (refreshJob.running) return { started: false, reason: 'already_running' };
  refreshJob.running = true;
  refreshJob.started_at = new Date().toISOString();
  refreshJob.finished_at = null;
  refreshJob.ok = null;
  refreshJob.tail = '';
  const child = spawn('python', [REVIEW_PY], { cwd: ROOT, windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  let out = '';
  child.stdout.on('data', (c) => { out += c.toString(); });
  child.stderr.on('data', (c) => { out += c.toString(); });
  child.on('close', (code) => {
    refreshJob.running = false;
    refreshJob.finished_at = new Date().toISOString();
    refreshJob.ok = code === 0;
    refreshJob.tail = out.slice(-2000);
    try { fs.writeFileSync(REFRESH_LOG, out, 'utf-8'); } catch { /* 日志写失败不影响主流程 */ }
  });
  child.on('error', (e) => {
    refreshJob.running = false;
    refreshJob.finished_at = new Date().toISOString();
    refreshJob.ok = false;
    refreshJob.tail = String(e.message);
  });
  return { started: true };
}

// ---------- 写回：工作台自包含实现 ----------
// 设计原则：工作台与 skill 相互独立——不依赖 ~/.agents/skills/ 下任何脚本；
// 唯一共享的是数据文件契约（_signals.json / _nurture_state.json 的字段与枚举，
// 见 daily-recruit-report/references/review-contract.md 与 candidate-nurture/references/signals-contract.md）。
// 升降级/合并语义逐行复刻自 signals.py 与 nurture_state.py，保证两个生产者写出的文件可互换。

const NOTES_DIR = path.join(ROOT, 'notes');
const VALID_DECISIONS = ['今天约', '催面评', '再等等', '终止'];

function loadJsonFile(f) {
  try {
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf-8'));
  } catch { return null; }
}

/** 原子写（同 signals.py/_save 与 nurture_state.py/_save：临时文件 + rename） */
function atomicWriteJson(f, obj) {
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, f);
}

/** 本地时间 ISO（机器在 UTC+8，与脚本产出的 +08:00 时间戳一致） */
function isoLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}+08:00`;
}

/** 姓名 → talent_id 匹配源（复刻 signals.py 的 _load_name_to_tid：从当日 ATS 投递建索引） */
function nameToTidMap() {
  const d = loadJsonFile(path.join(NOTES_DIR, '_daily_review.json'));
  const m = new Map();
  ((d?.structured?.ats) || []).forEach(a => {
    if (!a.name) return;
    if (!m.has(a.name)) m.set(a.name, new Set());
    m.get(a.name).add(String(a.talent_id));
  });
  return m;
}

/**
 * 决策落盘。语义复刻 signals.py --decide：
 * 校验枚举 → 空 talent_id 时用姓名唯一匹配补齐 → 同 talent_id 替换、其余保留（整体替换语义）。
 */
function handleDecideNative(body) {
  const items = Array.isArray(body.items) ? body.items : [body];
  for (const it of items) {
    if (!it.name) return { code: 400, msg: '缺少 name' };
    if (!VALID_DECISIONS.includes(it.decision)) return { code: 400, msg: `decision 非法: ${it.decision}` };
  }
  const file = path.join(NOTES_DIR, '_signals.json');
  const cur = loadJsonFile(file) || { date: todayStr(), generated_at: isoLocal(), signals: [], decisions: [] };
  const nameMap = nameToTidMap();
  const out = [];
  const touched = new Set();
  for (const it of items) {
    let tid = String(it.talent_id ?? '');
    if (!tid) {
      const s = nameMap.get(it.name);
      if (s && s.size === 1) tid = [...s][0];
    }
    touched.add(tid);
    out.push({ talent_id: tid, name: it.name, decision: it.decision, decided_at: isoLocal(), notes: it.notes || '' });
  }
  const kept = (Array.isArray(cur.decisions) ? cur.decisions : []).filter(d => !touched.has(String(d.talent_id)));
  cur.decisions = kept.concat(out);
  cur.date = todayStr();
  cur.generated_at = isoLocal();
  atomicWriteJson(file, cur);
  return { code: 200, msg: `写入 ${out.length} 条 decisions` };
}

// ---- 保温状态（复刻 nurture_state.py）----
function nurLoad() {
  return loadJsonFile(path.join(NOTES_DIR, '_nurture_state.json')) ||
         { last_updated: todayStr(), candidates: {} };
}
function nurSave(state) {
  state.last_updated = todayStr();
  atomicWriteJson(path.join(NOTES_DIR, '_nurture_state.json'), state);
}
function nurGetOrCreate(state, tid, name) {
  let c = state.candidates[tid];
  if (!c) {
    c = { name: name || tid, last_touch_date: null, last_touch_action: null, last_touch_channel: null,
          touch_count: 0, escalation_level: 1, last_response: null, status: 'active' };
    state.candidates[tid] = c;
  } else if (name && c.name !== name) {
    c.name = name;
  }
  return c;
}

function handleTouchNative(b) {
  if (!b.talent_id || !b.name || !b.action) return { code: 400, msg: '需要 talent_id/name/action' };
  const state = nurLoad();
  const c = nurGetOrCreate(state, String(b.talent_id), b.name);
  const today = todayStr();
  const prevCount = c.touch_count || 0;
  // 升级：上次 no_reply 且已碰过≥1次 且 今天还没碰过 → +1（封顶 L3）；L3 仍 no_reply → escalated
  if (c.last_response === 'no_reply' && prevCount >= 1 && today !== c.last_touch_date) {
    const nl = Math.min((c.escalation_level || 1) + 1, 3);
    if (nl > (c.escalation_level || 1)) c.escalation_level = nl;
    if (nl >= 3 && c.last_response === 'no_reply') c.status = 'escalated';
  }
  c.last_touch_date = today;
  c.last_touch_action = b.action;
  c.last_touch_channel = b.channel || '飞书IM';
  c.touch_count = prevCount + 1;
  c.last_response = null;
  if (c.status === 'escalated') { c.status = 'active'; c.escalation_level = Math.min(c.escalation_level || 1, 2); }
  nurSave(state);
  return { code: 200, msg: `记录触达: ${c.name} 第${c.touch_count}次 · L${c.escalation_level}` };
}

function handleResponseNative(b) {
  if (!b.talent_id || !['replied', 'no_reply'].includes(b.status)) {
    return { code: 400, msg: '需要 talent_id 和 status(replied|no_reply)' };
  }
  const state = nurLoad();
  const c = nurGetOrCreate(state, String(b.talent_id), b.name || null);
  if (!c.name) c.name = b.name || String(b.talent_id);
  c.last_response = b.status;
  if (b.status === 'replied') {
    c.escalation_level = 1;
    if (c.status === 'escalated') c.status = 'active';
  }
  nurSave(state);
  return { code: 200, msg: b.status === 'replied' ? `${c.name} 已回复，重置 → L1` : `${c.name} 未回复（记录中）` };
}

function handleResetNative(b) {
  if (!b.talent_id) return { code: 400, msg: '需要 talent_id' };
  const state = nurLoad();
  const c = state.candidates[String(b.talent_id)];
  if (!c) return { code: 200, msg: '不在状态文件中，无需重置' };
  c.touch_count = 0; c.escalation_level = 1; c.last_response = null;
  c.last_touch_date = null; c.last_touch_action = null; c.last_touch_channel = null;
  c.status = 'terminated';
  nurSave(state);
  return { code: 200, msg: `已重置 ${c.name}（terminated）` };
}

// ---------- HTTP 服务 ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1e6) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'http://localhost:' + PORT);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // ---- API ----
  if (url.pathname === '/api/data') {
    const review = readJson('notes/_daily_review.json');
    const payload = {
      review: review
        ? { date: review.date, generated_at: review.generated_at, summary: review.summary, structured: review.structured }
        : null,
      signals: readJson('notes/_signals.json'),
      nurture: readJson('notes/_nurture_state.json'),
      served_at: new Date().toISOString(),
    };
    sendJson(res, 200, payload);
    return;
  }

  if (url.pathname === '/api/status') {
    const review = readJson('notes/_daily_review.json');
    sendJson(res, 200, {
      today: todayStr(),
      review_date: review?.date || null,
      generated_at: review?.generated_at || null,
      fresh: !!review && review.date === todayStr(),
      refresh: refreshJob,
    });
    return;
  }

  if (url.pathname === '/api/decide' && req.method === 'POST') {
    try { sendJson(res, 200, handleDecideNative(await readBody(req))); }
    catch (e) { sendJson(res, 500, { code: 500, msg: e.message }); }
    return;
  }

  if (url.pathname === '/api/touch' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    sendJson(res, 200, handleTouchNative(b));
    return;
  }

  if (url.pathname === '/api/response' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    sendJson(res, 200, handleResponseNative(b));
    return;
  }

  if (url.pathname === '/api/nurture-reset' && req.method === 'POST') {
    const b = await readBody(req).catch(() => ({}));
    sendJson(res, 200, handleResetNative(b));
    return;
  }

  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    sendJson(res, 200, startRefresh());
    return;
  }

  // ---- 静态文件 ----
  let filePath;
  if (url.pathname === '/') filePath = path.join(__dirname, 'index.html');
  else filePath = path.join(__dirname, decodeURIComponent(url.pathname));

  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found: ' + url.pathname); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  });
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log('==============================================');
  console.log('  招聘作战台 v2 已启动');
  console.log(`  打开: ${url}`);
  console.log(`  数据源: ${path.join(ROOT, 'notes')}`);
  console.log('  按 Ctrl+C 停止服务');
  console.log('==============================================');
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`, { windowsHide: true }, () => {});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 被占用。换端口启动：PORT=5180 node server.mjs`);
  } else {
    console.error('服务启动失败:', e.message);
  }
  process.exit(1);
});
