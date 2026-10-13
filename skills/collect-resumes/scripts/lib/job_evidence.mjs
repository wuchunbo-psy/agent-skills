// scripts/lib/job_evidence.mjs
// 定岗证据模块（2026-09-30 防错岗三层防线，spec: docs/superpowers/specs/2026-09-30-archive-job-misplacement-guard-design.md）
//
// 职责：把「定岗三查」从 SKILL.md 流程约束升级为脚本可调用的证据判定。
//   1. 撞名岗位群推导（层③ --collisions / --impact 的数据基础）
//   2. signals 反证（层②）：当日群推荐信号里写明的归属 vs 正在归档的岗位
//   3. ATS 反证（层②，仅撞名群岗位）：同人已有投递指向同岗名他工作室 → 拦
//
// 设计原则：
//   - 纯逻辑（evaluateConflicts 等）与 IO 分离：IO 结果以参数注入，单测无需真调 API
//   - fail-open：证据查询失败=无证据放行，只在「有反证」时拦（用户 2026-09-30 拍板）
//   - 不维护手工映射清单：团队核心名/岗位核心词均从 jobDirs 动态推导（防过期，_my_jobs.json 教训）

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIGNALS, MAX_BUFFER } from './paths.mjs';

const _thisDir = path.dirname(fileURLToPath(import.meta.url));

/** 项目 venv python（与 collect.mjs resolvePython 同策略：PYTHON env > venv > PATH）。 */
function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const c = 'python';
  try { if (fs.statSync(c).isFile()) return c; } catch { /* fallthrough */ }
  return 'python';
}

// ---------------------------------------------------------------------------
// 岗位名归一化（自 resolve_records.mjs 迁入，单一实现；resolve_records 改为 import）
// ---------------------------------------------------------------------------

export function normalizeJobName(s) {
  let r = (s || '').replace(/[\s\-—·・]/g, '').toLowerCase();
  // 去括号及内容（全角（）/半角()）
  r = r.replace(/[（(][^）)]*[）)]/g, '');
  // 去开头的业务前缀词，循环到无变化（长词放前避免子串吞，如"中高级"在"高级"前）
  let prev;
  do {
    prev = r;
    r = r.replace(/^(中高级|资深|高级|中级|初级|执行|游戏)/, '');
  } while (r !== prev);
  return r;
}

/**
 * 岗位核心词：归一化后再去结尾的设计类工种后缀（循环去），用于证据文字扫描。
 * "游戏UI设计师" → "ui"（归一化去"游戏"前缀后="ui设计师"→去后缀="ui"）。
 * 循环去后缀禁止清零：再去就空时停在前一步（"特效设计师"→"特效"，不能再去"特效"变空）。
 * 核心词 < 2 字符时返回 null（太短必误伤）。
 */
export function coreJobWord(jobDirName) {
  let r = normalizeJobName(jobDirName);
  let prev;
  do {
    prev = r;
    const next = r.replace(/(设计师|工程师|实习生|设计|策划|程序|原画|开发|动作|特效|美术)$/i, '');
    r = next.length >= 2 ? next : r; // 清零保护
  } while (r !== prev);
  return r.length >= 2 ? r : null;
}

/**
 * 工种族键：归一化名去开头 ASCII 技术修饰（unity3d/3d/ai/ios…）再去工种后缀后的方向词。
 * "特效设计师"/"Unity特效设计师"/"资深Unity3D特效" → 都是 "特效"（特效族）；
 * "3D动作设计师"/"资深3D动作" → "动作"；数值策划三岗 → "数值"。
 * 族键相等 = 同族岗位（裸名/近名解析的高危互混面）。空值回退归一化全名。
 */
export function jobFamilyKey(jobDirName) {
  const full = normalizeJobName(jobDirName);
  let r = full.replace(/^[a-z0-9]+/, '');
  let prev;
  do {
    prev = r;
    const next = r.replace(/(设计师|工程师|实习生|策划|程序|开发|原画)$/, '');
    r = next.length >= 1 ? next : r;
  } while (r !== prev);
  return r.length >= 2 ? r : full;
}

/** 岗位目录路径（"长青工作室/美术端/游戏UI设计师"）→ 工作室（首段"长青工作室"）。 */
export function studioOfJobDir(jobDir) {
  return String(jobDir || '').split('/')[0] || '';
}

/** 从归档绝对路径提取岗位目录（相对 ARCHIVE_ROOT 的正斜杠路径）；非归档路径 → null。 */
export function jobDirFromPath(p) {
  const m = String(p || '').match(/在招岗位候选人管理[/\\](.+?)[/\\]已收集简历/);
  return m ? m[1].replace(/\\/g, '/') : null;
}

const lastSeg = (jobDir) => String(jobDir || '').split('/').pop();

/**
 * 工作室核心名：去掉"项目团队/工作室/项目/业务"类组织后缀 + 生成 ≥2 字前缀变体。
 * "迷你世界项目团队"→["迷你世界项目团队","迷你世界","迷你"]；"长青工作室"→["长青工作室","长青"]。
 * 用于在 signals 的 source/evidence 文字里识别工作室指向。
 */
export function studioCoreNames(studios) {
  const out = new Map(); // core -> studio（全名）
  for (const st of studios) {
    if (!st) continue;
    out.set(st, st);
    let core = st;
    let prev;
    do {
      prev = core;
      core = core.replace(/(项目团队|工作室|项目|业务|团队)$/, '');
    } while (core !== prev);
    if (core && core !== st && core.length >= 2) {
      out.set(core, st);
      // ≥2 字前缀变体（"山海弹珠"→"山海"；两字核心不再切）
      if (core.length > 2) out.set(core.slice(0, 2), st);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 撞名岗位群推导（层③）
// ---------------------------------------------------------------------------

/**
 * 推导撞名岗位群：岗位目录列表 → 群数组。
 * 成组规则（均基于末级目录名归一化，动态推导不维护手工清单）：
 *   1. 同名组：归一化末级名相同（"游戏UI设计师"×2 工作室）
 *   2. 近名组：归一化末级名互为包含（"特效设计师" ⊂ "Unity特效设计师"）
 * @param {Array<{job_dir: string}>} jobDirs - discoverJobDirs 结果
 * @returns {Array<{kind: 'same'|'kin', members: string[]}>} 每群 ≥2 个 job_dir
 */
export function buildCollisionGroups(jobDirs) {
  const dirs = jobDirs.map(j => j.job_dir).filter(Boolean);
  const groups = [];
  const grouped = new Set();

  // 规则1：同名组
  const byNorm = new Map();
  for (const d of dirs) {
    const k = normalizeJobName(lastSeg(d));
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(d);
  }
  for (const [, members] of byNorm) {
    if (members.length > 1) {
      groups.push({ kind: 'same', members: [...members].sort() });
      members.forEach(m => grouped.add(m));
    }
  }

  // 规则2：近名组（互含且未被同名组吸收；短名 ≥2 字防误含）
  const rest = dirs.filter(d => !grouped.has(d));
  const restNorm = rest.map(d => ({ d, n: normalizeJobName(lastSeg(d)) }));
  const kinSeen = new Set();
  for (let i = 0; i < restNorm.length; i++) {
    for (let j = i + 1; j < restNorm.length; j++) {
      const a = restNorm[i], b = restNorm[j];
      if (!a.n || !b.n || a.n.length < 2 || b.n.length < 2) continue;
      if (a.n.includes(b.n) || b.n.includes(a.n)) {
        const key = [a.d, b.d].sort().join('|');
        if (kinSeen.has(key)) continue;
        kinSeen.add(key);
        groups.push({ kind: 'kin', members: [a.d, b.d] });
      }
    }
  }

  // 规则3：工种族组（jobFamilyKey 相等：特效族/动作族/数值族…）。
  // 抓互含抓不住的跨形态对（"特效设计师" vs "资深Unity3D特效" vs "Unity特效设计师"），
  // 也覆盖长青/坤灵 3D动作口径相反陷阱对、数值策划三岗。
  const byFamily = new Map();
  for (const d of dirs) {
    const k = jobFamilyKey(lastSeg(d));
    if (!byFamily.has(k)) byFamily.set(k, []);
    byFamily.get(k).push(d);
  }
  for (const [k, members] of byFamily) {
    if (members.length > 1) {
      // 已被同名组完整覆盖的跳过（避免重复输入，mergeTransitive 反正会融合）
      groups.push({ kind: 'family', members: [...members].sort() });
    }
  }
  // 近名/族组做传递合并（A⊂B、B⊂C → A/B/C 一组），避免碎片群
  return mergeTransitive(groups);
}

function mergeTransitive(groups) {
  const merged = [];
  for (const g of groups) {
    const hit = merged.find(m => m.members.some(x => g.members.includes(x)));
    if (hit) {
      hit.members = [...new Set([...hit.members, ...g.members])].sort();
      hit.kind = hit.kind === g.kind ? hit.kind : 'mixed';
    } else {
      merged.push({ ...g, members: [...g.members] });
    }
  }
  return merged;
}

/** 目标岗位所属的撞名群（无则 null）。 */
export function collisionGroupOf(jobDir, groups) {
  return groups.find(g => g.members.includes(jobDir)) || null;
}

// ---------------------------------------------------------------------------
// signals 证据提取与冲突判定（层② 纯逻辑）
// ---------------------------------------------------------------------------

/**
 * 从单条 signal 提取岗位/工作室指向。
 * @returns {{studios: string[], jobDirs: string[], source: string, evidence: string, time: string}}
 *   studios=证据文字命中的工作室全名；jobDirs=工作室∩岗位核心词联合定位出的具体岗位目录
 */
export function extractSignalHints(signal, jobDirs) {
  const studiosAll = [...new Set(jobDirs.map(j => studioOfJobDir(j.job_dir)).filter(Boolean))];
  const coreMap = studioCoreNames(studiosAll);
  const text = `${signal.source || ''} ${signal.evidence || ''}`.toLowerCase();
  const studios = [...new Set(
    [...coreMap.keys()].filter(core => text.includes(core.toLowerCase())).map(core => coreMap.get(core))
  )];

  const normText = (signal.evidence || '').toLowerCase().replace(/[\s\-—·・]/g, '');
  // 岗位核心词在证据文字中出现 → 候选岗；再用工作室指向收窄
  const candidates = jobDirs.filter(j => {
    const core = coreJobWord(lastSeg(j.job_dir));
    return core && normText.includes(core);
  });
  let pointed = candidates;
  if (studios.length > 0) {
    const narrowed = candidates.filter(j => studios.includes(studioOfJobDir(j.job_dir)));
    if (narrowed.length > 0) pointed = narrowed;
  }
  return {
    studios,
    jobDirs: pointed.map(j => j.job_dir),
    source: signal.source || '',
    evidence: signal.evidence || '',
    time: signal.time || '',
  };
}

/**
 * 综合证据判定：正在归档 targetJobDir 的候选人，signals / ATS 投递里有无反证。
 * 纯函数：signals 数组与 atsJobs（[{title, dept}]）由调用方注入。
 *
 * 拦截判据（只在「有反证」时拦，fail-open）：
 *   - 信号指向具体岗位且全部 ≠ 目标岗 → 拦（李淑婷模式）
 *   - 信号无岗位指向但工作室明确且不含目标工作室 → 拦
 *   - ATS 有与目标岗同名的投递且在别的工作室 → 拦（黄菲菲模式）
 * 证据一致/无证据/证据指向目标 → null 放行
 *
 * @returns {null | {kind: 'signal'|'ats', detail: string}}
 */
/**
 * ATS dept 与目标岗位目录是否"同处"（同根不判冲突）。
 * ATS 的 dept 粒度不稳定：可能是顶级工作室别名（"山海工作室" vs 本地"山海弹珠项目"）、
 * 也可能是内层团队（"用户和生态运营团队" 是目标路径的中段）。规则：
 *   1. dept 是目标路径的某一段（部门层级嵌套）→ 同处
 *   2. dept 核心名与路径首段核心名互为前缀（"山海"⊂"山海弹珠"）→ 同处
 *      ⚠️ 必须整段前缀不能只比 2 字——"迷你鲲"不是"迷你世界"的前缀（广州另一家勿混）
 * @returns {boolean} true=同处（不算冲突证据）
 */
export function sameOrgSide(dept, jobDir) {
  if (!dept) return true; // dept 缺失不作证据
  const segs = String(jobDir || '').split('/');
  if (segs.some(s => s === dept)) return true;
  const coreOf = (s) => {
    let r = s;
    let prev;
    do { prev = r; r = r.replace(/(项目团队|工作室|项目|业务|团队)$/, ''); } while (r !== prev);
    return r;
  };
  const a = coreOf(dept), b = coreOf(segs[0] || '');
  if (a.length >= 2 && b.length >= 2 && (b.startsWith(a) || a.startsWith(b))) return true;
  return false;
}

export function evaluateConflicts({ name, targetJobDir, jobDirs, signals = [], atsJobs = [] }) {
  const targetStudio = studioOfJobDir(targetJobDir);
  const targetNorm = normalizeJobName(lastSeg(targetJobDir));

  // 只有 type=invite（业务方主动邀约）的 signal 才是归属证据——
  // reject/hold 的 evidence 多为流程叙述（"面试反馈：不通过（产品经理…）"），
  // 文字里的岗位词不是归属指向，扫了必误报（2026-09-30 黄诗仪首跑误报教训）
  for (const sig of signals) {
    if (!sig || (sig.type || 'invite') !== 'invite') continue;
    if ((sig.name || '').trim() !== (name || '').trim()) continue;
    const hints = extractSignalHints(sig, jobDirs);
    const sigText = `「${hints.evidence}」（${hints.source} ${hints.time}）`;
    if (hints.jobDirs.length > 0) {
      if (!hints.jobDirs.includes(targetJobDir)) {
        return {
          kind: 'signal',
          detail: `群信号指向 ${hints.jobDirs.join('、')}，与目标 ${targetJobDir} 不符。证据：${sigText}`,
        };
      }
      // 指向含目标岗 → 一致，继续看其他信号
    } else if (hints.studios.length > 0 && !hints.studios.includes(targetStudio)) {
      return {
        kind: 'signal',
        detail: `群信号工作室指向 ${hints.studios.join('、')}，目标在 ${targetStudio}。证据：${sigText}`,
      };
    }
  }

  for (const app of atsJobs) {
    const appNorm = normalizeJobName(app.title || '');
    if (!appNorm || !targetNorm) continue;
    // 同名岗（互含口径，覆盖"游戏UI设计师" vs "游戏ui设计师·UI团队"这类 ATS title 变体）
    const sameJob = appNorm === targetNorm || appNorm.includes(targetNorm) || targetNorm.includes(appNorm);
    // 同名且不同处才拦（dept 同根=别名/嵌套团队，见 sameOrgSide）
    if (sameJob && !sameOrgSide(app.dept, targetJobDir)) {
      return {
        kind: 'ats',
        detail: `ATS 已有同名岗投递：${app.title}（${app.dept}），目标在 ${studioOfJobDir(targetJobDir)}。同人跨工作室同名岗需人工确认`,
      };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// IO 层（signals 读取 / ATS 投递查询），全部容错：失败=无证据放行
// ---------------------------------------------------------------------------

/** 读当日 signals（文件缺失/损坏 → []，不校验 date——对账场景宁可多用当天文件里所有条目）。 */
export function loadSignals(pathOverride) {
  try {
    const j = JSON.parse(fs.readFileSync(pathOverride || SIGNALS, 'utf8'));
    return Array.isArray(j?.signals) ? j.signals : [];
  } catch { return []; }
}

/**
 * 批量查一组名字在 ATS 的全部投递岗位（job 维：title+dept）。
 * IO 后端 = scripts/ats_evidence.py（复用 _lark_shared.hire_find_application，requests 直连
 * hire 域 tenant token）——lark-cli api 的 user token 调 GET /applications 报 1002002
 * process_id is required，勿改回 lark-cli（2026-09-30 实测）。
 * 一次 spawn 查全部名字（token 复用，批场景快）；任何失败 → 空 Map + error，视为无证据。
 * @param {string[]} names
 * @returns {{byName: Map<string, Array<{job_id,title,dept,active_status}>>, error: string|null}}
 */
export function fetchAtsJobsForNames(names) {
  const byName = new Map(names.map(n => [n, []]));
  if (!names || names.length === 0) return { byName, error: null };
  try {
    const r = spawnSync(resolvePython(),
      [path.join(_thisDir, '..', 'ats_evidence.py'), '--names', names.join(',')],
      { encoding: 'utf8', maxBuffer: MAX_BUFFER, timeout: 10 * 60 * 1000 });
    if (r.status !== 0) {
      return { byName, error: `ats_evidence.py exit ${r.status}: ${String(r.stderr || '').slice(0, 300)}` };
    }
    const parsed = JSON.parse(r.stdout);
    for (const [name, jobs] of Object.entries(parsed)) {
      byName.set(name, Array.isArray(jobs) ? jobs : []);
    }
    return { byName, error: null };
  } catch (e) {
    return { byName, error: String(e?.message || e) };
  }
}

/** 单名便捷封装（resolve 单条路径用）。 */
export function fetchAtsJobsForName(name) {
  const { byName, error } = fetchAtsJobsForNames([name]);
  return { jobs: byName.get(name) || [], error };
}

/**
 * resolve 层总入口：目标岗位的证据检查。
 * 1) signals 反证：所有 resolve 都查（本地文件，零成本）
 * 2) ATS 反证：仅目标岗在撞名群时才查（API 有成本；用户拍板「普通唯一岗零摩擦」）
 * 3) 同人跨岗历史提示：返回附在 hint 字段（不拦，万志颖三投转岗是正常场景）
 * @param {{name: string, targetJobDir: string, jobDirs: Array, manifestRecords?: object,
 *          runner?: Function, signals?: Array, atsJobs?: Array|null}} args
 * @returns {{conflict: null|{kind, detail}, crossJobHint: string|null}}
 */
export function checkEvidenceForResolve({ name, targetJobDir, jobDirs, manifestRecords = null, runner, signals, atsJobs = null }) {
  const sigList = signals !== undefined ? signals : loadSignals();
  const groups = buildCollisionGroups(jobDirs);
  const group = collisionGroupOf(targetJobDir, groups);

  // ATS 反证：撞名群岗位才查；atsJobs 显式传 [] 表示调用方已判定无需/已查
  let atsList = atsJobs;
  if (atsList === null && group) {
    const { jobs, error } = fetchAtsJobsForName(name, { runner });
    if (error) process.stderr.write(`  ⚠️ ATS 证据查询失败（视为无证据放行）：${error}\n`);
    atsList = jobs.map(j => ({ title: j.title, dept: j.dept }));
  }

  const conflict = evaluateConflicts({ name, targetJobDir, jobDirs, signals: sigList, atsJobs: atsList || [] });

  // 同人跨岗历史提示（不拦）
  let crossJobHint = null;
  if (manifestRecords && name) {
    const seen = new Set();
    for (const r of Object.values(manifestRecords)) {
      if ((r.candidate_name || '').trim() === name.trim() && ['archived', 'validated'].includes(r.status)) {
        const p = String(r.archived_path || r.target_dir || '');
        const m = p.match(/在招岗位候选人管理[/\\](.+?)[/\\]已收集简历/);
        if (m) seen.add(m[1].replace(/\\/g, '/'));
      }
    }
    seen.delete(targetJobDir);
    if (seen.size > 0) crossJobHint = `该候选人历史归档过 ${[...seen].join('、')}，确认本次岗位无误`;
  }

  return { conflict, crossJobHint };
}
