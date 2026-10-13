// scripts/archive_audit.mjs
// 存量归档对账 + 撞名检测 + 新岗冲击清单（2026-09-30 防错岗层①③防线）。
// spec: docs/superpowers/specs/2026-09-30-archive-job-misplacement-guard-design.md
//
// 用法：
//   node archive_audit.mjs --collisions                 # 打印当前撞名岗位群（纯本地，零成本）
//   node archive_audit.mjs --audit [--no-ats] [--ats-limit 60]
//                                                      # 存量对账：圈定高危记录 → 三路证据 → 差异清单
//                                                      #   圈定 = 撞名群岗位记录 ∪ 8月收件 ∪ 同人跨岗
//                                                      #   证据 = 当日群信号(弱时效) + ATS 投递(强) + 同人多岗
//                                                      #   只列不挪：清单交用户逐条拍板
//   node archive_audit.mjs --impact "迷你世界项目团队/美术端/游戏UI设计师"
//                                                      # 新岗建立后跑：撞名邻岗下的历史记录 + 证据标注
//
// 输出（--audit）：notes/_archive_audit_<date>.json + .md（差异清单，给人拍板用）

import fs from 'node:fs';
import path from 'node:path';
import { readManifest } from './lib/manifest.mjs';
import { getArg, isDirectRun } from './lib/cli_helpers.mjs';
import { ARCHIVE_ROOT, AUDIT_OUT_DIR, MANIFEST as MANIFEST_DEFAULT } from './lib/paths.mjs';
import { discoverJobDirs } from './resolve_records.mjs';
import {
  buildCollisionGroups, collisionGroupOf, loadSignals, evaluateConflicts,
  fetchAtsJobsForNames, jobDirFromPath,
} from './lib/job_evidence.mjs';

const TODAY = (() => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
})();

/** 撞名群打印（--collisions / --impact 共用底层数据）。 */
function printCollisions(jobDirs, groups) {
  if (groups.length === 0) {
    console.log('当前无撞名岗位群（同名/近名检测均无命中）。');
    return;
  }
  console.log(`撞名岗位群 ${groups.length} 个（共 ${jobDirs.length} 个在招岗位目录）：\n`);
  for (const g of groups) {
    const label = g.kind === 'same' ? '⛔ 完全同名' : g.kind === 'mixed' ? '⛔ 混合' : '⚠️ 近名互含';
    console.log(`  ${label}：`);
    for (const m of g.members) console.log(`    - ${m}`);
  }
  console.log('\n裸岗位名（不带工作室路径前缀）resolve 到上述群任一岗位时，脚本会判歧义强制人工；');
  console.log('带路径前缀 resolve 时由证据交叉（signals/ATS 反证）兜底。');
}

/** 从 manifest 圈定高危记录。返回去重后的 [{name, jobDir, records}]。 */
function selectHighRisk(manifest, groups, opts = {}) {
  const records = Object.values(manifest.records || {});
  const settled = records.filter(r => ['archived', 'validated'].includes(r.status));

  // 同人跨岗分布（name → set(jobDir)）
  const byName = new Map();
  for (const r of settled) {
    const name = (r.candidate_name || '').trim();
    const jd = jobDirFromPath(r.archived_path || r.target_dir);
    if (!name || !jd) continue;
    if (!byName.has(name)) byName.set(name, new Map());
    const jobs = byName.get(name);
    jobs.set(jd, (jobs.get(jd) || []).concat(r));
  }

  const picked = new Map(); // key: name|jobDir
  const pick = (name, jobDir, reason) => {
    const key = `${name}|${jobDir}`;
    if (!picked.has(key)) picked.set(key, { name, jobDir, records: byName.get(name).get(jobDir), reasons: [] });
    picked.get(key).reasons.push(reason);
  };

  for (const g of groups) {
    for (const m of g.members) {
      for (const [name, jobs] of byName) {
        if (jobs.has(m)) pick(name, m, '撞名群岗位');
      }
    }
  }
  if (opts.augustToo) {
    for (const r of settled) {
      const name = (r.candidate_name || '').trim();
      const jd = jobDirFromPath(r.archived_path || r.target_dir);
      if (name && jd && /^2026-08/.test(r.received_at || '')) pick(name, jd, '8月错归高发期');
    }
  }
  for (const [name, jobs] of byName) {
    if (jobs.size > 1) {
      for (const jd of jobs.keys()) pick(name, jd, `同人跨岗(${jobs.size}岗)`);
    }
  }
  return [...picked.values()];
}

function confidenceOf(entry, conflict, atsQueried) {
  if (conflict) return conflict.kind === 'ats' ? '高' : '高';
  if (entry.reasons.some(r => r.startsWith('同人跨岗'))) return '中';
  if (!atsQueried && entry.reasons.includes('撞名群岗位')) return '低';
  return '低';
}

function runAudit(manifestPath, args) {
  const noAts = args.includes('--no-ats');
  const atsLimit = parseInt(getArg(args, '--ats-limit') || '60', 10);
  const manifest = readManifest(manifestPath || MANIFEST_DEFAULT);
  const jobDirs = discoverJobDirs();
  const groups = buildCollisionGroups(jobDirs);
  const signals = loadSignals();

  const entries = selectHighRisk(manifest, groups, { augustToo: true });
  console.log(`圈定高危归档 ${entries.length} 条（撞名群 ∪ 8月收件 ∪ 同人跨岗）；signals 当日条目 ${signals.length} 条`);

  // ATS 逐人查（强证据），限额保护；风险高者优先（触发原因多 = 撞名群+8月+跨岗三重命中最危险）
  const riskOrder = (e) => e.reasons.length * 10 + (e.reasons.includes('8月错归高发期') ? 5 : 0);
  const names = [...new Set([...entries].sort((a, b) => riskOrder(b) - riskOrder(a)).map(e => e.name))];
  const atsBudget = noAts ? [] : names.slice(0, atsLimit);
  let atsByName = new Map();
  if (atsBudget.length > 0) {
    process.stderr.write(`  ATS 证据批查询 ${atsBudget.length} 人（ats_evidence.py 一次跑）…\n`);
    const { byName, error } = fetchAtsJobsForNames(atsBudget);
    if (error) process.stderr.write(`  ⚠️ ATS 批查询失败（这部分视为无证据）：${error}\n`);
    atsByName = byName;
  }
  const atsSkipped = names.length - atsBudget.length;

  const results = [];
  for (const e of entries) {
    const atsJobs = (atsByName.get(e.name) || []).filter(j => j.title);
    const atsQueried = atsByName.has(e.name);
    const conflict = evaluateConflicts({
      name: e.name, targetJobDir: e.jobDir, jobDirs, signals,
      atsJobs: atsJobs.map(j => ({ title: j.title, dept: j.dept })),
    });
    // BOSS 脱敏姓（"陈先生/黄女士"）跨人共用，"同人跨岗"可能是重名假象
    const anonName = /(先生|女士|小姐)$/.test(e.name);
    results.push({
      name: e.name,
      anonymous_name: anonName,
      job_dir: e.jobDir,
      reasons: e.reasons,
      record_count: e.records.length,
      received_range: [e.records[0]?.received_at, e.records[e.records.length - 1]?.received_at],
      conflict,
      ats_jobs: atsJobs,
      confidence: confidenceOf(e, conflict, atsQueried),
    });
  }

  // 落盘 JSON + MD
  const outJson = path.join(AUDIT_OUT_DIR, `_archive_audit_${TODAY}.json`);
  const outMd = path.join(AUDIT_OUT_DIR, `_archive_audit_${TODAY}.md`);
  fs.writeFileSync(outJson, JSON.stringify({
    date: TODAY, generated_at: new Date().toISOString(),
    scope: { entries: entries.length, ats_queried: atsBudget.length, ats_skipped: atsSkipped },
    collision_groups: groups,
    results,
  }, null, 1), 'utf8');

  const order = { '高': 0, '中': 1, '低': 2 };
  results.sort((a, b) => (order[a.confidence] - order[b.confidence]) || a.name.localeCompare(b.name));
  const lines = [];
  lines.push(`# 存量归档对账差异清单（${TODAY}）`);
  lines.push('');
  lines.push(`> 圈定范围：撞名岗位群 ∪ 8月收件 ∪ 同人跨岗，共 ${entries.length} 条（去重后按人×岗位）。`);
  lines.push(`> 证据源：当日群信号（弱时效）+ ATS 投递（强，已查 ${atsBudget.length} 人${atsSkipped > 0 ? `，${atsSkipped} 人超限额未查` : ''}）。`);
  lines.push(`> **只列不挪**——每条待人工拍板后走既有挪岗流程。结构化数据：${outJson.replace(/\\/g, '/')}`);
  lines.push('');
  for (const lv of ['高', '中', '低']) {
    const bucket = results.filter(r => r.confidence === lv);
    if (bucket.length === 0) continue;
    const icon = lv === '高' ? '🔴' : lv === '中' ? '🟡' : '⚪';
    lines.push(`## ${icon} ${lv}置信度（${bucket.length} 条）`);
    lines.push('');
    for (const r of bucket) {
      lines.push(`### ${r.name}（现归：${r.job_dir}）`);
      const meta = [`触发：${[...new Set(r.reasons)].join('、')}`, `${r.record_count} 份记录`];
      if (r.anonymous_name) meta.push('⚠️脱敏姓（先生/女士），"同人跨岗"可能是不同人重名假象');
      lines.push(`- ${meta.join('｜')}`);
      if (r.conflict) {
        lines.push(`- **证据指向他岗**：${r.conflict.detail}`);
        lines.push(`- 建议：核实后挪岗（待拍板）`);
      } else if (r.confidence === '低') {
        lines.push(`- 无外部反证。若为 8 月裸名时代归档，结合群消息/ATS 手工核一次归属`);
      } else if (r.ats_jobs.length > 0) {
        lines.push(`- ATS 投递：${r.ats_jobs.map(j => `${j.title || j.job_id}（${j.dept || '?'}）`).join('、')}——与本岗${atsMatchesTarget(r) ? '一致' : '不一致，人工核'}`);
      }
      lines.push('');
    }
  }
  fs.writeFileSync(outMd, lines.join('\n'), 'utf8');

  const hi = results.filter(r => r.confidence === '高').length;
  const mid = results.filter(r => r.confidence === '中').length;
  console.log(`\n对账完成：高置信度 ${hi} 条、中 ${mid} 条、低 ${results.length - hi - mid} 条`);
  console.log(`清单：${outMd.replace(/\\/g, '/')}`);
}

function atsMatchesTarget(r) {
  // 已由 evaluateConflicts 判过冲突，走到这里=无冲突；投递含本岗同名即视为一致信号
  const targetLast = String(r.job_dir).split('/').pop();
  return r.ats_jobs.some(j => (j.title || '').includes(targetLast.replace(/（.*）/, '')));
}

/** --impact：新岗冲击清单——撞名邻岗下的历史记录，可能是该归新岗的旧件。 */
function runImpact(jobArg, manifestPath) {
  const manifest = readManifest(manifestPath);
  const jobDirs = discoverJobDirs();
  const groups = buildCollisionGroups(jobDirs);

  const target = jobDirs.find(j => j.job_dir === jobArg) ||
    jobDirs.find(j => j.job_dir.endsWith('/' + jobArg) || j.job_dir.includes(jobArg));
  if (!target) {
    console.error(`未找到岗位目录：${jobArg}（可先跑 --collisions 看现有岗位路径）`);
    process.exit(2);
  }
  const group = collisionGroupOf(target.job_dir, groups);
  console.log(`目标新岗：${target.job_dir}`);
  if (!group) {
    console.log('不在任何撞名群中——无历史冲击，无需复核。');
    return;
  }
  const siblings = group.members.filter(m => m !== target.job_dir);
  console.log(`撞名群（${group.kind}）：\n${group.members.map(m => `  - ${m}${m === target.job_dir ? '  ← 新岗' : ''}`).join('\n')}\n`);

  const signals = loadSignals();
  const settled = Object.values(manifest.records || {}).filter(r => ['archived', 'validated'].includes(r.status));
  const rows = [];
  for (const r of settled) {
    const jd = jobDirFromPath(r.archived_path || r.target_dir);
    if (!siblings.includes(jd)) continue;
    const name = (r.candidate_name || '').trim();
    const conflict = evaluateConflicts({ name, targetJobDir: jd, jobDirs, signals, atsJobs: [] });
    rows.push({ name, job_dir: jd, received_at: r.received_at, conflict });
  }
  if (rows.length === 0) {
    console.log(`邻岗（${siblings.join('、')}）下无归档记录，无冲击。`);
    return;
  }
  console.log(`⚠️ 冲击清单：邻岗下 ${rows.length} 条归档记录，归档早于新岗建立的可能本属于新岗：\n`);
  for (const row of rows) {
    const flag = row.conflict ? `【信号反证：${row.conflict.detail}】` : '';
    console.log(`  - ${row.name}（${row.job_dir}，收到 ${row.received_at || '?'}）${flag}`);
  }
  console.log(`\n处置：结合群消息/ATS 逐条人工核；确属新岗的走既有挪岗流程（本命令不挪）。`);
}

// ---- 入口 ----
function main() {
  const args = process.argv.slice(2);
  const manifestPath = getArg(args, '--manifest') || MANIFEST_DEFAULT;
  if (args.includes('--collisions')) {
    const jobDirs = discoverJobDirs();
    printCollisions(jobDirs, buildCollisionGroups(jobDirs));
    return;
  }
  const impact = getArg(args, '--impact');
  if (impact) { runImpact(impact, manifestPath); return; }
  if (args.includes('--audit')) { runAudit(manifestPath, args); return; }
  console.log('用法：archive_audit.mjs --collisions | --audit [--no-ats] [--ats-limit N] | --impact <岗位路径>');
  process.exit(2);
}

const _isDirectRun = isDirectRun(import.meta.url);
if (_isDirectRun) main();

export { main, selectHighRisk };
