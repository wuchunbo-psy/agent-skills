// batch_download_links.mjs — 批量下载 QQ/网易大附件链接（Playwright 驱动）
//
// 解决"逐个手动浏览器下载"问题：一个脚本批量处理多个链接。
//
// 用法:
//   # 从 manifest 读所有 verified 的 link 记录批量下载（清历史积压）
//   node batch_download_links.mjs --manifest <PROJECT_ROOT>/notes/collection_manifest.json
//
//   # 指定 record ID（逗号分隔）——当天收简历推荐，精准只下今天的
//   node batch_download_links.mjs --records "sha256:xxx,sha256:yyy" --manifest <path>
//
//   # 直接传 URL（绕过 manifest，不进状态闭环）
//   node batch_download_links.mjs --urls "https://wx.mail.qq.com/..." "https://..."
//
// 输出到 Downloads 目录。下载成功自动写 result.json + 移文件到 target_dir
// + 自动合并推进 archived；链接确认失效的记录推进 blocked（LINK_EXPIRED），
// 让闸门能发现"人没归档"的缺失，而不是永远静默重试。

import fs from 'node:fs';
import path from 'node:path';
import { DOWNLOADS_DIR, MANIFEST as MANIFEST_DEFAULT, RESULTS_DIR, PLAYWRIGHT_FALLBACK } from './lib/paths.mjs';
import { sha256File, detectTypeFromBuffer } from './lib/file_identity.mjs';
import { getArg, isDirectRun } from './lib/cli_helpers.mjs';
import { readManifest, writeManifestAtomic, transitionRecord, upsertRecord, transitionToExcluded } from './lib/manifest.mjs';
import { mergeResults } from './merge_results.mjs';
import { findMovedTwin } from './download_attachment.mjs';

const DOWNLOAD_TRIGGER_TIMEOUT = 15_000; // 点击后等待 download 事件触发的超时（正常1-2秒触发，15秒没触发=有问题）
const DOWNLOAD_COMPLETE_TIMEOUT = 300_000; // 下载传输完成的超时（大文件5分钟）

/**
 * 解析 CLI 参数为下载任务列表。
 * @returns {{ tasks: array, manifestPath: string, manifestDriven: boolean }}
 */
export function buildTasks(args) {
  const manifestPath = getArg(args, '--manifest') || MANIFEST_DEFAULT;
  const recordsFlag = getArg(args, '--records');

  let tasks = [];

  if (args.includes('--urls')) {
    const urls = args.filter((a, i) => i > args.indexOf('--urls') && !a.startsWith('--'));
    tasks = urls.map((url, i) => ({ url, name: `link_${i + 1}`, filename: null }));
    return { tasks, manifestPath, manifestDriven: false };
  }

  const mf = readManifest(manifestPath);
  const recs = Object.values(mf.records || {});
  const linkRecs = recs.filter(r => r.source_type === 'link' && r.source_url);
  let target;
  if (recordsFlag) {
    const ids = new Set(recordsFlag.split(',').map(s => s.trim()));
    // 跳过已 archived：重跑 --records 不重复下载已闭环的记录
    target = linkRecs.filter(r => ids.has(r.record_id) && r.status !== 'archived');
  } else {
    target = linkRecs.filter(r => r.status === 'verified');
  }
  tasks = target.map(r => ({
    url: r.source_url,
    name: r.candidate_name || r.record_id.slice(7, 19),
    filename: r.target_filename || null,
    record_id: r.record_id,
    target_dir: r.target_dir || null,
    target_filename: r.target_filename || null,
    // 2026-08-20：链接旁的原始附件名+大小（verify_mails 提取），用于下载前查 Downloads 本地复用
    original_filename: r.original_filename || null,
    attach_size_mb: r.attach_size_mb || null,
  }));
  return { tasks, manifestPath, manifestDriven: true };
}

/**
 * 在 Downloads 找用户已手动下载的同一附件（2026-08-20 加）。
 * 背景：大附件（QQ 超大附件常 100MB+）浏览器下载受服务器限速动辄几分钟~十几分钟，
 * 用户往往已经手动下载到 Downloads——Agent 不看本地直接重新下载 = 重复劳动。
 * 匹配规则：文件名 == 链接旁的原始附件名（或浏览器重复下载的「base (N).ext」变体），
 * 且（有大小提示时）体积差 ≤ max(2MB, 5%)——防同名不同文件误复用。
 * @returns {string|null} 匹配到的本地文件绝对路径
 */
export function findLocalInDownloads(task, downloadsDir = DOWNLOADS_DIR) {
  if (!task.original_filename || !fs.existsSync(downloadsDir)) return null;
  const dot = task.original_filename.lastIndexOf('.');
  const base = task.original_filename.slice(0, dot);
  const ext = task.original_filename.slice(dot).toLowerCase();
  const candidates = fs.readdirSync(downloadsDir).filter(fn => {
    const low = fn.toLowerCase();
    if (!low.endsWith(ext)) return false;
    const stem = low.slice(0, low.length - ext.length);
    return stem === base.toLowerCase() || new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+\\)$`, 'i').test(stem);
  });
  for (const fn of candidates) {
    const fp = path.join(downloadsDir, fn);
    if (!fs.statSync(fp).isFile()) continue;
    if (task.attach_size_mb) {
      const actualMb = fs.statSync(fp).size / 1048576;
      const tolerance = Math.max(2, task.attach_size_mb * 0.05);
      if (Math.abs(actualMb - task.attach_size_mb) > tolerance) continue;
    }
    return fp;
  }
  return null;
}

/**
 * 查找下载按钮。QQ邮箱文件分享页有文字"下载"的可点击 div。
 */
async function findDownloadButton(page) {
  // QQ邮箱文件分享页：.operate-btn 是下载按钮的外层容器（点击它才触发下载）
  // 内层 .ui-btn-text 只是文字 span，点它不触发
  const selectors = [
    '.operate-btn',              // QQ邮箱专用 class
    'button:has-text("普通下载")',  // 网易超大附件页：精确点「普通下载」（极速下载=会员推广）；必须在 [class*="download"] 之前——该泛匹配会命中下载区容器 div，点了不触发（2026-09-24 王先生 36.9MB 三连 timeout 实证）
    'text="下载"',
    '[class*="download"]',
    'button:has-text("下载")',
  ];
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) return el; // 每个选择器最多等2秒（4个=最坏8秒）
    } catch { /* 继续试下一个 */ }
  }
  return null;
}

async function batchDownload(tasks) {
  if (tasks.length === 0) {
    console.log('没有待下载的链接。');
    return [];
  }

  // playwright 装在项目根 <PROJECT_ROOT>，skill 目录找不到，用 fallback 路径加载
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    ({ chromium } = await import('file:///' + PLAYWRIGHT_FALLBACK.replace(/\\/g, '/')));
  }
  console.log(`启动浏览器，批量下载 ${tasks.length} 个链接...\n`);

  // BROWSER_HEADED=1：有头模式启动。headless 指纹易触发网盘风控页（no_button/下载取消），
  // 反复风控失败时用有头重跑往往一次过（真实浏览器特征）。桌面环境跑批会弹窗，默认仍 headless。
  const headless = process.env.BROWSER_HEADED !== '1';
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const results = [];

  /**
   * 把已落盘的文件（Downloads 或复用件）提交进归档：magic bytes 校正扩展名 → mv 到
   * target_dir/target_filename（已存在不覆盖）→ 写 result.json（merge_results 消费）。
   * 下载完成与 Downloads 本地复用共用此闭环。
   */
  const commitToArchive = (task, savePath, tag) => {
    let finalPath = savePath;
    // 跨批孪生 SHA 判重（2026-09-30 修复，李淑婷案例）：Downloads 复用路径此前只查
    // "目标同名"冲突，不查"同人同岗已归档"——QQ 大附件重发同一文件时复用件被当新材料
    // 二次归档。对齐 download_attachment 语义：同人同岗 archived 孪生 SHA 相同 =
    // 真重发 → 不落盘、不写 result.json，抛 duplicateOf 由调用方排除（--new-version 可重开）。
    const recSha0 = sha256File(savePath);
    const mf = readManifest(MANIFEST_DEFAULT);
    const rec0 = mf.records[task.record_id];
    if (rec0) {
      const normJob = (j) => String(j || '').split('/').pop();
      const twins = Object.values(mf.records || {}).filter(r =>
        r.record_id !== task.record_id &&
        r.status === 'archived' &&
        (r.candidate_name || '') === (rec0.candidate_name || '') &&
        rec0.candidate_name &&  // 无姓名记录（姓名待 resolve）不参与判重，防误杀
        normJob(r.job_name) === normJob(rec0.job_name)
      );
      for (const twin of twins) {
        if (!twin.target_dir || !twin.target_filename) continue;
        const twinPath = findMovedTwin(twin);
        if (!twinPath) continue;
        if (sha256File(twinPath) === recSha0) {
          fs.unlinkSync(savePath);
          throw Object.assign(
            new Error(`DUPLICATE_CONTENT: 与已归档 ${twin.target_filename}（收到 ${twin.received_at || '?'}）SHA 相同，判真重发跳过`),
            { duplicateOf: twin.record_id, sha: recSha0 }
          );
        }
      }
    }
    // magic bytes 校正扩展名（2026-08-17）：QQ 超大附件的 resolve target 扩展名是猜的
    // （PDF/RAR 都可能被存成 .zip），按文件头纠正，并同步回写 manifest 的 target_filename
    // （merge_results 有路径绑定校验，两边不一致会拒合并）
    const detected = detectTypeFromBuffer(fs.readFileSync(savePath));
    if (detected && detected !== 'unknown') {
      const extByType = { pdf: '.pdf', zip: '.zip', rar: '.rar', '7z': '.7z', image: null, video: '.mp4' };
      const wantExt = extByType[detected];
      if (wantExt && !task.target_filename.toLowerCase().endsWith(wantExt)) {
        const base = task.target_filename.replace(/\.[^.]+$/, '');
        const renamed = base + wantExt;
        console.log(`${tag} ℹ 实际类型 ${detected}，扩展名校正: ${path.basename(task.target_filename)} → ${renamed}`);
        const mm = readManifest(MANIFEST_DEFAULT);
        if (mm.records[task.record_id]) {
          mm.records[task.record_id] = { ...mm.records[task.record_id], target_filename: renamed };
          writeManifestAtomic(MANIFEST_DEFAULT, mm);
        }
        task.target_filename = renamed;
        task.record_filename = renamed;
      }
    }
    const dest = path.join(task.target_dir, task.target_filename).replace(/\\/g, '/');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) {
      // 2026-09-16 修复（用户点名"同名简历/作品不得遗漏"）：旧逻辑直接丢弃新件——链接类
      // 同名简历+作品两份材料，第二份（常是作品集）被无声扔掉且 manifest 显示已归档。
      // 现在对齐 download_attachment 语义：SHA 相同=真重发保留原件；SHA 不同=不同材料
      // 一律保留，加 _作品集/_2 后缀改名提交。
      const newSha = sha256File(savePath);
      const existSha = sha256File(dest);
      if (newSha === existSha) {
        console.log(`${tag} ℹ 目标已存在且 SHA 相同（真重发），保留原文件: ${path.basename(dest)}`);
        fs.unlinkSync(savePath);
        finalPath = dest;
      } else {
        const base = task.target_filename.replace(/\.[^.]+$/, '');
        const ext = task.target_filename.slice(base.length);
        const suffix = /作品集|portfolio/i.test(task.target_filename) ? '_2' : '_作品集';
        let alt = `${base}${suffix}${ext}`;
        let n = 2;
        while (fs.existsSync(path.join(task.target_dir, alt))) {
          alt = `${base}${suffix}${n++}${ext}`;
        }
        const altPath = path.join(task.target_dir, alt).replace(/\\/g, '/');
        fs.renameSync(savePath, altPath);
        console.log(`${tag} ♻ 同名不同内容（SHA 不同），改名 ${alt} 归档（不丢件）`);
        finalPath = altPath;
        task.record_filename = alt;
      }
    } else {
      fs.renameSync(savePath, dest);
      finalPath = dest;
    }
    // 写 result.json（格式与 download_attachment.mjs 一致，merge_results.mjs 消费）
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const safeRecordId = task.record_id.replace(/[:*?"<>|]/g, '_');
    const resultPath = path.join(RESULTS_DIR, `${safeRecordId}.result.json`);
    fs.writeFileSync(resultPath, JSON.stringify({
      record_id: task.record_id,
      outcome: 'committed',
      sha256: sha256File(dest),
      target_path: dest,
      at: new Date().toISOString(),
    }, null, 2));
    return finalPath;
  };

  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const tag = `[${i + 1}/${tasks.length}] ${task.name}`;

    // ---- Downloads 本地复用（2026-08-20 加）----
    // 用户手动下载往往比 Playwright 快（QQ 服务器对浏览器限速、无断点续传），
    // 且大附件常是"提醒用户下载→用户已下→Agent 又重下"的重复劳动。
    // 命中（文件名+大小匹配）则直接复用本地件提交归档，跳过浏览器；提交失败回退浏览器。
    let reusedOk = false;
    if (task.record_id && task.target_dir && task.target_filename) {
      const local = findLocalInDownloads(task);
      if (local) {
        const sizeMB = (fs.statSync(local).size / 1048576).toFixed(1);
        console.log(`${tag} ♻️ Downloads 已有同名文件 ${path.basename(local)} (${sizeMB}MB)，复用本地件，跳过浏览器下载`);
        try {
          const finalPath = commitToArchive(task, local, tag);
          results.push({ ...task, status: 'ok', reused: true, file: finalPath });
          reusedOk = true;
        } catch (e) {
          if (e.duplicateOf) {
            // 真重发（孪生 SHA 同）：排除进终态，绝不回退浏览器重下（2026-09-30 李淑婷案例）
            try {
              const m2 = readManifest(MANIFEST_DEFAULT);
              const cur = m2.records[task.record_id];
              if (cur) {
                const updated = transitionToExcluded(cur, 'DUPLICATE_CONTENT', e.message, { sha256: e.sha });
                writeManifestAtomic(MANIFEST_DEFAULT, upsertRecord(m2, updated));
                console.log(`${tag} ⏭️ 内容重复（孪生 SHA 同）已排除: ${task.target_filename}`);
                results.push({ ...task, status: 'duplicate', duplicateOf: e.duplicateOf });
                reusedOk = true; // 已落终态，无需浏览器
                continue;
              }
            } catch (e2) {
              console.log(`${tag} 🔴 重复排除失败: ${e2.message.slice(0, 100)}`);
            }
          }
          console.log(`${tag} ⚠ 本地件提交归档失败（${e.message.slice(0, 80)}），回退浏览器下载`);
        }
      }
    }
    if (reusedOk) continue;

    console.log(`${tag} 打开链接...`);

    try {
      await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

      // SPA 页面 JS 动态渲染内容（失效提示/下载按钮）。QQ 云盘分享页按钮实测 5-6 秒才渲染完
      // （2026-09-11 黄灿辉/李振华/林少芸三连 no_button 复盘：原 2 秒等待时按钮未渲染，全部选择器落空）
      await page.waitForTimeout(5000);

      // 检测"分享已失效"（优先用 page.evaluate 拿完整 body 文本）
      const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
      if (bodyText.includes('失效') || bodyText.includes('已过期')) {
        console.log(`${tag} 🔴 链接已失效，跳过`);
        results.push({ ...task, status: 'expired' });
        continue;
      }

      let btn = await findDownloadButton(page);
      if (!btn) {
        // SPA 渲染慢的兜底：再等 3 秒重试一轮（2026-09-11 加）
        await page.waitForTimeout(3000);
        btn = await findDownloadButton(page);
      }
      if (!btn) {
        console.log(`${tag} ⚠ 未找到下载按钮（可能需登录），跳过`);
        results.push({ ...task, status: 'no_button' });
        continue;
      }

      console.log(`${tag} 点击下载，等待触发...`);
      // QQ邮箱下载通过 popup 触发，download 事件在 page 上触发。
      // 用回调+轮询方式（比 waitForEvent 更可靠，避免事件注册时序问题）
      let downloadObj = null;
      const downloadHandler = (d) => { downloadObj = d; };
      page.on('download', downloadHandler);

      await btn.click();

      // 阶段1：等待 download 事件触发（快速失败：15秒没触发=按钮无效/需登录，不傻等）
      const triggerDeadline = Date.now() + DOWNLOAD_TRIGGER_TIMEOUT;
      while (!downloadObj && Date.now() < triggerDeadline) {
        await page.waitForTimeout(500);
      }
      page.off('download', downloadHandler);

      if (!downloadObj) {
        console.log(`${tag} 🔴 下载未触发（${DOWNLOAD_TRIGGER_TIMEOUT / 1000}s内无响应，按钮可能无效或需登录）`);
        results.push({ ...task, status: 'timeout' });
        continue;
      }

      // 阶段2：等待下载传输完成（大文件允许5分钟）
      const suggested = downloadObj.suggestedFilename();
      const savePath = path.join(DOWNLOADS_DIR, task.filename || suggested);
      try {
        await downloadObj.saveAs(savePath, { timeout: DOWNLOAD_COMPLETE_TIMEOUT });
      } catch (e) {
        console.log(`${tag} 🔴 下载传输失败/超时: ${e.message.slice(0, 100)}`);
        results.push({ ...task, status: 'download_failed', error: e.message });
        continue;
      }
      const sizeMB = (fs.statSync(savePath).size / 1048576).toFixed(1);
      console.log(`${tag} ✅ ${path.basename(savePath)} (${sizeMB}MB)`);
      // 2026-09-15 规则反转：大附件 Agent 默认直接下（96.5/186/189/278.9MB 四次实测全部一次
      // 成功），不再建议转人工。此处只报耗时事实，供会话向用户转述；连续下载失败才升级请用户
      // 从邮箱客户端下载（链接过期/风控连续失败场景，见 SKILL.md 4b）。
      if (parseFloat(sizeMB) > 150) {
        console.log(`  ℹ️ 大附件 ${sizeMB}MB 本次自动下载完成。`);
      }

      // manifest 驱动的记录：提交进归档（与 Downloads 本地复用共用 commitToArchive 闭环：
      // 不写 result.json 状态会永远卡 verified）。--urls 模式（无 record_id）不走 manifest 闭环，
      // 保持原行为（只留 Downloads）。
      let finalPath = savePath;
      let wasDuplicate = false;
      if (task.record_id && task.target_dir && task.target_filename) {
        try {
          finalPath = commitToArchive(task, savePath, tag);
        } catch (moveErr) {
          if (moveErr.duplicateOf) {
            // 真重发：下载的临时件已由 commitToArchive 清掉，记录排除进终态
            try {
              const m2 = readManifest(MANIFEST_DEFAULT);
              const cur = m2.records[task.record_id];
              if (cur) {
                const updated = transitionToExcluded(cur, 'DUPLICATE_CONTENT', moveErr.message, { sha256: moveErr.sha });
                writeManifestAtomic(MANIFEST_DEFAULT, upsertRecord(m2, updated));
                console.log(`${tag} ⏭️ 内容重复（孪生 SHA 同）已排除: ${task.target_filename}`);
                results.push({ ...task, status: 'duplicate', duplicateOf: moveErr.duplicateOf });
                wasDuplicate = true;
              }
            } catch (e2) {
              console.log(`${tag} 🔴 重复排除失败: ${e2.message.slice(0, 100)}`);
            }
          } else {
            console.log(`${tag} ⚠ 移动到归档目录失败，文件保留在 Downloads: ${moveErr.message.slice(0, 80)}`);
          }
        }
      }
      if (!wasDuplicate) results.push({ ...task, status: 'ok', file: finalPath });

    } catch (e) {
      console.log(`${tag} 🔴 失败: ${e.message.slice(0, 150)}`);
      results.push({ ...task, status: 'error', error: e.message });
    }
  }

  await browser.close();

  // 汇总
  const ok = results.filter(r => r.status === 'ok');
  const dups = results.filter(r => r.status === 'duplicate');
  const bad = results.filter(r => r.status !== 'ok' && r.status !== 'duplicate');
  console.log(`\n========== ✅ 成功 ${ok.length} · ⏭️ 重复排除 ${dups.length} · 🔴 失败 ${bad.length} ==========`);
  for (const r of dups) console.log(`  ⏭️ ${r.name}: 与已归档件 SHA 同，判真重发`);
  for (const r of bad) {
    console.log(`  ${r.name}: ${r.status}${r.error ? ' — ' + r.error.slice(0, 80) : ''}`);
  }

  return results;
}

/**
 * 确认失效的链接记录 → blocked（LINK_EXPIRED）。
 * 失效是永久性的，留在 verified 会每次全量扫都白试一遍；
 * 推进 blocked 让闸门能发现"该人材料从未归档"，而不是静默缺失。
 */
function markExpiredRecords(manifestPath, expiredTasks) {
  if (!expiredTasks.length) return;
  let manifest = readManifest(manifestPath);
  for (const t of expiredTasks) {
    const rec = manifest.records[t.record_id];
    if (!rec || rec.status !== 'verified') continue;
    try {
      manifest = upsertRecord(manifest, transitionRecord(rec, 'blocked', {
        code: 'LINK_EXPIRED',
        message: `链接已失效（${t.url.slice(0, 80)}），材料无法下载，需联系候选人重发`,
      }));
    } catch { /* 状态不合法（如已 blocked）则跳过 */ }
  }
  writeManifestAtomic(manifestPath, manifest);
  console.log(`已标记 ${expiredTasks.length} 条失效链接为 blocked（LINK_EXPIRED）`);
}

export async function main() {
  const args = process.argv.slice(2);
  const { tasks, manifestPath, manifestDriven } = buildTasks(args);
  if (tasks.length === 0) {
    console.log('没有待下载的链接。用法:');
    console.log('  node batch_download_links.mjs --manifest <path>');
    console.log('  node batch_download_links.mjs --records "id1,id2" --manifest <path>');
    console.log('  node batch_download_links.mjs --urls "https://..." "https://..."');
    return { ok: 0, failed: 0 };
  }

  const results = await batchDownload(tasks);

  if (manifestDriven) {
    // 失效链接 → blocked；成功记录 → 自动合并推进 archived
    markExpiredRecords(manifestPath, results.filter(r => r.status === 'expired' && r.record_id));
    const okWithRecord = results.filter(r => r.status === 'ok' && r.record_id);
    if (okWithRecord.length) {
      const { merged, skipped, errors } = mergeResults(manifestPath);
      console.log(`自动合并: ${merged} 条推进到 archived，${skipped} 条跳过${errors.length ? `，🔴 ${errors.length} 个合并错误` : ''}`);
      for (const e of errors.slice(0, 5)) console.error(`  - ${e.file}: ${e.error}`);
    }
  }

  const ok = results.filter(r => r.status === 'ok').length;
  return { ok, failed: results.length - ok };
}

const _isDirectRun = isDirectRun(import.meta.url);
if (_isDirectRun) {
  main().then(r => {
    if (r && r.failed) process.exitCode = 3; // 有失败 → 非零退出，但已完成的保留
  }).catch(e => {
    console.error('批量下载异常:', e.message);
    process.exit(1);
  });
}
