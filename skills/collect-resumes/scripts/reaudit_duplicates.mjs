// reaudit_duplicates.mjs — 重复排除重审（2026-09-16 机制化，用户拍板"同文件名≈简历+作品两份材料，
// 不许按文件名判重，要用机制多检查一遍"）。
//
// 背景：BOSS 邮件附件元数据文件名按职位模板生成（【岗位_城市_薪资】姓名_年限.pdf），
// 同一候选人简历/作品集两封邮件的元数据文件名可完全相同。历史上按"同文件名重发"手工排除的
// 记录从未下载过、没有任何内容证据——候选人07(作品集)/候选人08(作品长图)/候选人09(简历，判反)三起误杀。
//
// 用法:
//   node reaudit_duplicates.mjs [--manifest <path>] [--dry-run]
//
// 重审对象（全部满足才选）:
//   status=excluded 且 exclude_reason.code 是重复类（DUPLICATE_*/SAMEDAY_*）
//   且记录无 sha256（从未下载=排除时无内容证据）
//   且是邮件附件、存在"跨邮件"同人同岗 archived 孪生（同邮件多附件的取舍是另一类决策，不重审）
//
// 判定（下载到临时区，不动归档状态机）:
//   1) SHA 与孪生相同                        → 真重发，维持排除，记录证据 dupe_verified
//   2) 双方是 PDF、页数相同、文本层指纹一致   → 同文档重导出（周童案），维持排除，记录证据
//   3) 其余（SHA 不同且内容不可证同）          → 误杀：resolveRecord(--new-version 语义) 重开到
//      verified，交给 collect 下载阶段正常归档（同名冲突由下载层改名兜住）；>7 天收到的重开件
//      当日 scope 不含，需 collect --backlog
//   下载失败（链接过期等）                    → 维持排除不动，标 dupe_verified 待人工
//
// 本脚本不跑下载归档（重开件由 collect 阶段4 / --backlog 接手）；manifest 只在本进程内写一次。

import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readManifest, writeManifestAtomic, upsertRecord,
} from './lib/manifest.mjs';
import { parseCliJson } from './lib/lark_mail.mjs';
import { runWithRetry } from './lib/retry.mjs';
import { getArg, isDirectRun, runLarkSync } from './lib/cli_helpers.mjs';
import { sha256File, detectTypeFromBuffer } from './lib/file_identity.mjs';
import { resolveRecord, deriveTargetFilename } from './resolve_records.mjs';
import { MANIFEST as MANIFEST_DEFAULT, LARK_CLI as CLI } from './lib/paths.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DUP_CODE_RE = /^(DUPLICATE|SAMEDAY)/;
const RECENT_DAYS = 7;

// ---- 诊断下载（取 URL + 拉 buffer；与 download_attachment 同款命令与限流重试）----
function fetchAttachmentBuffer(rec) {
  return runWithRetry(async () => {
    const params = JSON.stringify({ user_mailbox_id: 'me', message_id: rec.message_id, attachment_ids: rec.attachment_id });
    const cmd = `${CLI} mail user_mailbox.message.attachments download_url --as user --params "${params.replace(/"/g, '\\"')}" --format json`;
    let raw;
    try {
      raw = runLarkSync(cmd);
    } catch (e) {
      throw new Error((e.message || '') + ' ' + (e.stderr || ''));
    }
    const urlResp = parseCliJson(raw);
    const url = urlResp.data?.download_urls?.[0]?.download_url;
    if (!url) throw new Error('NO_DOWNLOAD_URL');
    return await downloadBuffer(url);
  }, { onRetry: (e, attempt, delay) => process.stderr.write(`  ⚠️ 重审下载限流/失败，${delay / 1000}s 后重试 (${attempt}/3): ${String(e.message).slice(0, 60)}\n`) });
}

function downloadBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirectsLeft > 0) {
        r.resume();
        return downloadBuffer(r.headers.location, redirectsLeft - 1).then(resolve).catch(reject);
      }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const declared = r.headers['content-length'] ? parseInt(r.headers['content-length'], 10) : null;
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (declared !== null && buf.length !== declared) return reject(new Error(`LEN_MISMATCH ${buf.length}/${declared}`));
        resolve(buf);
      });
      r.on('error', reject);
    }).on('error', reject);
  });
}

// venv python（同 collect.mjs 口径：PATH python 常缺 PyMuPDF）
function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  const candidates = ['python'];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* 继续下一个 */ }
  }
  return 'python';
}

function pdfFingerprint(pdfPaths) {
  const helper = path.join(SCRIPTS_DIR, 'lib', 'pdf_text_fingerprint.py');
  const r = spawnSync(resolvePython(), [helper, ...pdfPaths], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`pdf_text_fingerprint 失败: ${r.stderr?.slice(0, 200)}`);
  const arr = JSON.parse(r.stdout);
  return new Map(arr.map(x => [x.path, x]));
}

const normJob = (j) => String(j || '').split('/').pop();

// manifest 的 target_path/target_filename 是"陈旧快照"高发区：批次目录收敛改名（_6份→_7份）
// 不回写、评估流程还会改文件名（岗位简称化）和打包。唯一稳定锚点 = 归档命名规范的
// 姓名前缀（{姓名}_ 开头）。target_path 失效时向上找 已收集简历 根，按姓名前缀定位候选 PDF。
function locateTwinFiles(twin) {
  if (twin.target_path && fs.existsSync(twin.target_path)) return [twin.target_path];
  const name = (twin.candidate_name || '').trim();
  if (!name || !twin.target_dir) return [];
  let cur = twin.target_dir.replace(/\\/g, '/');
  let root = null;
  while (cur && cur !== path.parse(cur).root) {
    if (cur.endsWith('/已收集简历')) { root = cur; break; }
    cur = path.dirname(cur);
  }
  if (!root) return [];
  const found = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith(`${name}_`) && e.name.toLowerCase().endsWith('.pdf')) found.push(p);
    }
  };
  walk(root);
  return found;
}

async function main() {
  const args = process.argv.slice(2);
  const manifestPath = getArg(args, '--manifest') || MANIFEST_DEFAULT;
  const dryRun = args.includes('--dry-run');
  const labelsOnly = args.includes('--labels-only');
  let manifest = readManifest(manifestPath);
  const recs = Object.values(manifest.records || {});

  // ---- 视觉定名应用：看图后一条命令落名 ----
  // 用法: --apply-label <record_id> --apply-verdict portfolio|resume
  const applyLabelId = getArg(args, '--apply-label');
  if (applyLabelId) {
    const applyVerdict = getArg(args, '--apply-verdict');
    if (!['portfolio', 'resume'].includes(applyVerdict)) {
      console.error('用法: --apply-label <record_id> --apply-verdict portfolio|resume');
      process.exit(1);
    }
    const rec = recs.find(r => r.record_id === applyLabelId);
    if (!rec || rec.status !== 'archived') { console.error(`🔴 记录不存在或非 archived: ${applyLabelId.slice(0, 30)}…`); process.exit(2); }
    if (applyVerdict === 'portfolio') {
      manifest = applyPortfolioRename(manifest, rec);
      writeManifestAtomic(manifestPath, manifest);
    } else {
      let fn = rec.target_filename;
      let fp2 = rec.target_path;
      if (/_作品集\.[a-z0-9]+$/i.test(fn) && rec.label_checked && rec.label_checked.verdict === 'portfolio') {
        // 视觉复核推翻自动改名：改回 _2 名
        const back = fn.replace('_作品集', '_2');
        const backPath = path.join(rec.target_dir, back).replace(/\\/g, '/');
        if (fs.existsSync(fp2) && !fs.existsSync(backPath)) fs.renameSync(fp2, backPath);
        fn = back; fp2 = backPath;
        console.log(`↩️ 视觉复核非作品集，已改回 ${back}`);
      }
      manifest = upsertRecord(manifest, { ...rec, target_filename: fn, target_path: fp2, label_checked: { at: new Date().toISOString(), verdict: 'resume' } });
      writeManifestAtomic(manifestPath, manifest);
      if (fn === rec.target_filename) console.log(`⏭️ ${fn} 确认非作品集，保留现名（label_checked 已记录，不再进队列）`);
    }
    cleanupQueueItem(manifestPath, applyLabelId);
    return;
  }

  // ---- 选样：无内容证据的重复类排除 + 存在跨邮件 archived 孪生 ----
  const targets = recs.filter(r => {
    if (r.status !== 'excluded') return false;
    if (!DUP_CODE_RE.test((r.exclude_reason || {}).code || '')) return false;
    if (r.sha256) return false;                      // 有 sha256=下载比对过，排除有据
    if (r.source_type !== 'mail_attachment' || !r.attachment_id || !r.message_id) return false;
    if (!r.candidate_name || !r.job_name) return false; // 重开时无法重新 resolve
    const crossMailTwin = recs.find(o =>
      o.record_id !== r.record_id &&
      o.status === 'archived' &&
      o.message_id !== r.message_id &&               // 同邮件多附件取舍不属"跨邮件判重"，不重审
      (o.candidate_name || '') === (r.candidate_name || '') &&
      normJob(o.job_name) === normJob(r.job_name));
    return !!crossMailTwin;
  });

  let reopened = 0;
  console.log(`\n🔁 重复排除重审：待核验 ${targets.length} 条（无下载证据的重复类排除）`);
  if (!labelsOnly) {
    if (!targets.length) {
      console.log('✅ 无待核验记录');
    } else if (dryRun) {
      for (const r of targets) {
        console.log(`  - ${r.record_id.slice(0, 30)}… ${(r.original_filename || '').slice(0, 50)} [${r.received_at || '?'}] 排除码=${(r.exclude_reason || {}).code}`);
      }
      console.log('（--dry-run，未做任何改动）');
    } else {

  const tmpDir = path.join(path.dirname(manifestPath), '_reaudit_tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  let kept = 0, failed = 0;

  for (const rec of targets) {
    const tag = `${(rec.candidate_name || '?')}·${(rec.original_filename || '').slice(0, 40)}`;
    try {
      // 1) 诊断下载到临时区
      const buf = await fetchAttachmentBuffer(rec);
      if (!buf.length) throw new Error('DOWNLOAD_EMPTY');
      const detected = detectTypeFromBuffer(buf);
      if (detected === 'html' || detected === 'unknown') throw new Error(`内容类型异常: ${detected}`);
      const tmpPath = path.join(tmpDir, `${rec.record_id.replace(/[^a-f0-9]/gi, '').slice(-24)}.${detected === 'zip' ? 'zip' : detected === 'pdf' ? 'pdf' : 'bin'}`);
      fs.writeFileSync(tmpPath, buf);
      const sha = sha256File(tmpPath);

      const twins = recs.filter(o =>
        o.record_id !== rec.record_id &&
        o.status === 'archived' &&
        o.message_id !== rec.message_id &&
        (o.candidate_name || '') === (rec.candidate_name || '') &&
        normJob(o.job_name) === normJob(rec.job_name));
      // 注：文本层比对只依赖孪生文件本身，孪生有无 sha256 不影响（5-6月老记录多缺该字段）；
      // SHA 相同判定只在有 sha256 的孪生间进行。

      // 2) SHA 相同 → 真重发
      const shaTwin = twins.find(o => o.sha256 === sha);
      if (shaTwin) {
        manifest = upsertRecord(manifest, { ...rec, sha256: sha, dupe_verified: { at: new Date().toISOString(), method: 'sha-match', twin_record_id: shaTwin.record_id, sha256: sha } });
        kept++;
        console.log(`  ⏭️ ${tag}：SHA 与孪生一致 → 真重发，维持排除（证据已记录）`);
        continue;
      }

      // 3) 文本层指纹一致（仅文本量足够的 PDF；纯图片型不可证同，宁可重开不漏件）。
      //    孪生按姓名前缀定位（target_path/target_filename 都可能是陈旧快照）。
      let textSame = false;
      if (detected === 'pdf') {
        const pdfTwins = [];
        for (const o of twins) {
          for (const fp of locateTwinFiles(o)) {
            if (!pdfTwins.some(x => x.file === fp)) pdfTwins.push({ twin: o, file: fp });
          }
        }
        if (pdfTwins.length) {
          const fp = pdfFingerprint([tmpPath, ...pdfTwins.map(x => x.file)]);
          const a = fp.get(tmpPath);
          for (const { twin, file } of pdfTwins) {
            const b = fp.get(file);
            if (!a || !b || a.error || b.error) continue;
            if (a.pages === b.pages && a.text === b.text && a.text.length >= 50) {
              textSame = true;
              manifest = upsertRecord(manifest, { ...rec, sha256: sha, dupe_verified: { at: new Date().toISOString(), method: 'text-layer', twin_record_id: twin.record_id, twin_file: file, sha256: sha, pages: a.pages } });
              kept++;
              console.log(`  ⏭️ ${tag}：与孪生 ${path.basename(file)}（${a.pages} 页）文本层逐字一致 → 同文档，维持排除（证据已记录）`);
              break;
            }
          }
        }
      }
      if (textSame) continue;

      // 4) 不可证同 → 误杀，重开走正常归档
      const filename = deriveTargetFilename(rec.original_filename, rec.candidate_name, rec.job_name);
      const result = resolveRecord(manifest, rec.record_id, rec.candidate_name, rec.job_name, filename, undefined, { newVersion: true });
      if (result.status !== 'resolved') {
        throw new Error(`重开失败: ${result.detail || result.status}`);
      }
      manifest = result.manifest;
      reopened++;
      const d = rec.received_at ? new Date(rec.received_at) : null;
      const stale = !d || (Date.now() - d.getTime() > RECENT_DAYS * 24 * 3600 * 1000);
      console.log(`  ✅ ${tag}：SHA 不同且内容不可证同 → 误杀，已重开解析（${result.detail}）${stale ? ' ⚠️ 收到日>7天，需 collect --backlog 完成下载归档' : '，collect 下载阶段将接手'}`);
    } catch (e) {
      failed++;
      manifest = upsertRecord(manifest, { ...rec, dupe_verified: { at: new Date().toISOString(), method: 'error', error: String(e.message || e).slice(0, 200) } });
      console.log(`  ⚠️ ${tag}：核验失败（${String(e.message || e).slice(0, 80)}）→ 维持排除不动，待人工`);
    }
  }

  writeManifestAtomic(manifestPath, manifest);
  // 清理临时区（保留目录，删文件）
  for (const f of fs.readdirSync(tmpDir)) { try { fs.unlinkSync(path.join(tmpDir, f)); } catch { /* 占用则留给下次 */ } }

  console.log(`\n==== 重审完成：⏭️ 维持排除 ${kept} 条（证据已记录） · ✅ 重开 ${reopened} 条 · ⚠️ 待人工 ${failed} 条 ====`);
  } // end else (非 dry-run 且有待核验)
  } // end if (!labelsOnly)

  // ---- 第二部分：冲突件内容定名（_2 → _作品集）----
  // 文本/页数有把握的自动改名；单页/纯图/证据不足的渲染首页进视觉队列（notes/_label_queue/），
  // 由有视觉的主会话看图后 --apply-label 落名。幂等：改过名/label_checked 的不再进。
  if (!dryRun) {
    await labelConflicts(manifestPath);
  }
  process.exit(reopened > 0 ? 2 : 0);
}

// ---- 冲突件内容定名 ----
function isConflictName(fn) {
  return !!fn && /_2\.[a-z0-9]+$/i.test(fn) && !/作品集|portfolio/i.test(fn);
}

function portfolioTargetName(fn) {
  const i = fn.lastIndexOf('.');
  const stem = fn.slice(0, i).replace(/_2$/, '');
  const ext = fn.slice(i);
  return `${stem}_作品集${ext}`;
}

// manifest target_path 陈旧快照兜底：失效时向上找 已收集简历 根，按目标文件名精确找，
// 再退姓名前缀+_2 模式（评估改名场景）。
function locateRecordFile(rec) {
  if (rec.target_path && fs.existsSync(rec.target_path)) return rec.target_path;
  const name = (rec.candidate_name || '').trim();
  if (!name || !rec.target_dir) return null;
  let cur = rec.target_dir.replace(/\\/g, '/');
  let root = null;
  while (cur && cur !== path.parse(cur).root) {
    if (cur.endsWith('/已收集简历')) { root = cur; break; }
    cur = path.dirname(cur);
  }
  if (!root) return null;
  let exact = null, byName = null;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!exact && e.name === rec.target_filename) exact = p;
      else if (!byName && isConflictName(e.name) && e.name.startsWith(`${name}_`)) byName = p;
    }
  };
  walk(root);
  return exact || byName || null;
}

function applyPortfolioRename(manifest, rec, actualFile) {
  const file = actualFile || rec.target_path;
  const base = path.basename(file);
  const newName = portfolioTargetName(base);
  const newPath = path.join(path.dirname(file), newName).replace(/\\/g, '/');
  if (newPath !== file) {
    if (fs.existsSync(newPath)) throw new Error(`目标名已存在: ${newName}`);
    fs.renameSync(file, newPath);
  }
  console.log(`  🏷 ${base} → ${newName}（内容为作品集）`);
  return upsertRecord(manifest, { ...rec, target_dir: path.dirname(file).replace(/\\/g, '/'), target_filename: newName, target_path: newPath, label_checked: { at: new Date().toISOString(), verdict: 'portfolio' } });
}

function cleanupQueueItem(manifestPath, recordId) {
  const qdir = path.join(path.dirname(manifestPath), '_label_queue');
  try {
    const pj = path.join(qdir, 'pending.json');
    if (fs.existsSync(pj)) {
      const arr = JSON.parse(fs.readFileSync(pj, 'utf8'));
      const item = arr.find(x => x.record_id === recordId);
      if (item && item.png && fs.existsSync(item.png)) fs.unlinkSync(item.png);
      fs.writeFileSync(pj, JSON.stringify(arr.filter(x => x.record_id !== recordId), null, 2));
    }
  } catch { /* 队列文件缺失不阻塞 */ }
}

async function labelConflicts(manifestPath) {
  let manifest = readManifest(manifestPath);
  const recs = Object.values(manifest.records || {});
  const targets = [];
  for (const r of recs) {
    if (r.status !== 'archived' || !isConflictName(r.target_filename) || r.label_checked) continue;
    const file = locateRecordFile(r);
    if (file) targets.push({ rec: r, file });
  }
  if (!targets.length) { console.log('\n🏷 内容定名：无 _2 冲突件待定名'); return; }
  console.log(`\n🏷 内容定名：${targets.length} 个 _2 冲突件待判定（_2/同名冲突后缀，内容可能是作品集）`);
  const QUEUE_DIR = path.join(path.dirname(manifestPath), '_label_queue');
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const pending = [];
  let renamed = 0, queued = 0, skipped = 0;
  for (const { rec, file } of targets) {
    const ext = path.extname(file).toLowerCase();
    try {
      let verdict = null;
      if (ext === '.pdf') {
        const fp = pdfFingerprint([file]).get(file);
        if (fp && !fp.error && fp.pages >= 10) verdict = 'portfolio';          // 10 页以上≈作品集（8年老简历也能写满5页，候选人V误判教训）
        else if (fp && !fp.error && fp.pages >= 2 && /portfolio|作品集|personal\s*design/i.test(fp.text.slice(0, 200))) verdict = 'portfolio';  // 封面关键词（前200字≈第1页）
      }
      if (verdict === 'portfolio') {
        manifest = applyPortfolioRename(manifest, rec, file);
        renamed++;
        continue;
      }
      // 证据不足 → 视觉队列
      const qpng = path.join(QUEUE_DIR, `${rec.record_id.replace(/[^a-f0-9]/gi, '').slice(-24)}.png`);
      if (ext === '.pdf') {
        const r = spawnSync(resolvePython(), [path.join(SCRIPTS_DIR, 'lib', 'render_page_png.py'), file, qpng, '900'], { encoding: 'utf8' });
        if (r.status !== 0) throw new Error('首页渲染失败: ' + (r.stderr || '').slice(0, 80));
      } else {
        fs.copyFileSync(file, qpng);
      }
      pending.push({ record_id: rec.record_id, candidate: rec.candidate_name, file, png: qpng, target_filename: rec.target_filename });
      queued++;
      console.log(`  👁 ${rec.target_filename} → 视觉队列（${ext === '.pdf' ? '单页/文本证据不足' : '非 PDF'}）`);
    } catch (e) {
      skipped++;
      console.log(`  ⚠️ ${rec.target_filename}: ${String(e.message || e).slice(0, 80)}`);
    }
  }
  writeManifestAtomic(manifestPath, manifest);
  fs.writeFileSync(path.join(QUEUE_DIR, 'pending.json'), JSON.stringify(pending, null, 2));
  console.log(`==== 定名完成：🏷 自动改名 ${renamed} · 👁 待视觉定名 ${queued}（notes/_label_queue/，看图后 --apply-label <record_id> --apply-verdict portfolio|resume） · ⚠️ 跳过 ${skipped} ====`);
}

const _isDirectRun = isDirectRun(import.meta.url);
if (_isDirectRun) {
  main().catch(e => {
    console.error(`🔴 reaudit 异常: ${e.message}`);
    process.exit(1);
  });
}
