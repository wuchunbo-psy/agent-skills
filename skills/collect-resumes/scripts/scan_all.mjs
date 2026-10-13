// 全量扫描邮箱，穷尽式（分页到 has_more=false）。
//
// 用法: node scan_all.mjs
// 输出候选邮件清单到 stdout，全量数据原子存 notes/_scan_all.json
// 任何异常都不覆盖上一份完整快照（原子发布 + 诊断文件 + 非零退出）。
// （不支持 --date；日期过滤在 verify_mails --date 做）
//
// 2026-09-30 增量主路径切换为服务端 time_range 过滤（吴增俊漏件事故二轮加固）：
// 增量不再靠"翻到锚点"停止（锚点单调加深→增量页数无界增长，且停止正确性依赖
// 服务器排序稳定性这一黑盒假设），改为 --filter time_range（start=上次扫描开始
// 时刻-1h 余量）让服务器按时间过滤，翻完窗口即穷尽，完整性是 API 契约而非排序推断。
// 防御纵深：①窗口自检（上次快照最新一封必须在窗口结果中，否则判定过滤失效）
// ②锚点模式保留为 meta 缺失时的回退 ③自检失败/锚点兜底触发 → 自动升级全量
// （不再告警完照用） ④24h 每日全量兜底不变。扫描元数据旁挂 _scan_all.meta.json。

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseCliJson } from './lib/lark_mail.mjs';
import { isNotification } from './lib/notifications.mjs';
import { isDirectRun } from './lib/cli_helpers.mjs';
import { LARK_CLI, SCAN_ALL as OUT, DIAG_DIR, MAX_BUFFER } from './lib/paths.mjs';

const MAX_PAGES = 50; // 安全上限（200×50=10000 封）

/**
 * 日期归一化：time_range 走 search 路径返回 ISO UTC（2026-09-30T07:12:36Z），
 * list 路径返回本地格式（2026-09-30 15:12）。快照统一本地格式，避免两种格式混存。
 */
export function normalizeMailDate(d) {
  if (typeof d !== 'string') return d;
  if (!/T\d{2}:\d{2}:\d{2}/.test(d)) return d; // 已是 list 路径格式或其他，不动
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())} ${p(dt.getHours())}:${p(dt.getMinutes())}`;
}

/** 本地格式日期（YYYY-MM-DD HH:mm）→ 毫秒时间戳；不匹配返回 0。 */
function parseLocalDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s || '');
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
}

/** 毫秒时间戳 → 本地时区 ISO（API time_range 要求 2026-09-29T00:00:00+08:00 格式）。 */
export function toLocalIso(ms) {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

/**
 * 执行一次 triage 分页。
 * runner 可注入（测试用），默认 execSync。
 * timeFilter：服务端时间过滤 JSON（time_range 主路径专用，token 走 search: 前缀）。
 */
function fetchPage(pageToken, runner, timeFilter) {
  let cmd = `${LARK_CLI} mail +triage --as user --max 200 --format json`;
  if (timeFilter) {
    // execSync 在 Windows 走 cmd.exe：JSON 里的字面双引号在双引号包裹参数内用 \" 转义
    cmd += ` --filter "${timeFilter.replace(/"/g, '\\"')}"`;
  }
  if (pageToken) {
    cmd += ` --page-token "${pageToken}"`;
  }
  const raw = runner(cmd);
  return parseCliJson(raw); // 严格解析：失败直接抛错
}

/**
 * 核心扫描逻辑（可注入 runner，测试用）。
 *
 * 2026-08-14 增量改造：不再每次全量分页拉几百封（每天固定几分钟）。
 * 传入上次快照的 message_id 集合，triage 分页倒序（新在前）——遇到已见过的
 * message_id 说明后续页全是旧邮件，立即停止翻页，只拉"新邮件"几页。
 * 结果由调用方合并：新邮件 + 旧快照 = 完整快照（新在前，旧在后，按 message_id 去重）。
 *
 * @param {function} runner - (cmdString) => rawStdoutString
 * @param {Set<string>} prevIds - 上次快照的 message_id 集合（可空=全量穷尽，兼容首轮）
 * @param {string|null} prevOldestId - 上次快照最旧一封的 message_id（锚点模式停止条件；
 *        2026-09-30 起锚点模式降级为 meta 缺失时的回退，主路径见 opts.sinceIso）
 * @param {object} opts - { sinceIso?: string } 传了 sinceIso 走 time_range 主路径：
 *        服务端按时间过滤（start=sinceIso），翻完 has_more=false 即窗口穷尽。
 *        完整性由 API 契约保证，与列表排序稳定性无关（吴增俊漏件事故的根因隔离）。
 *        注意：time_range 走 search: 分页路径，token 不可与 list: 混用（每页都带同一 filter）。
 * @returns {{ messages: array, complete: boolean, error?: string, incremental?: boolean, mode?: string, sawPrevOldest?: boolean }}
 *          mode: 'time_range' | 'anchor' | 'full'（escalate 后由调用方标记）
 */
export function runScan(runner, prevIds = null, prevOldestId = null, opts = {}) {
  runner = runner || ((cmd) => execSync(cmd, { encoding: 'utf8', maxBuffer: MAX_BUFFER }));

  const timeFilter = opts.sinceIso ? `{"time_range":{"start_time":"${opts.sinceIso}"}}` : null;

  const allMessages = [];
  const seenIds = new Set();
  let pageToken = '';
  let prevToken = null;
  let page = 0;
  let hitPrevBoundary = false; // 已遇到上次快照的邮件 → 后续（若排序稳定）全是旧的
  let sawPrevOldest = false;   // 已见到上次快照最旧一封 → 覆盖完整性有硬保证（仅锚点模式）
  let quietPages = 0; // 边界命中后连续"0 新邮件"页数（防排序扰动：回复置顶/线程聚合会把新邮件排进旧区）
  const QUIET_PAGES_TO_STOP = 4; // 兜底用：从 2 提到 4（吴增俊漏在静默第 3 页之后）
  const MAX_INC_PAGES = 15;      // 增量翻页成本护栏：没见到锚点也别无限翻，触发后由调用方升级全量

  while (true) {
    page++;
    const j = fetchPage(pageToken, runner, timeFilter);

    const rawItems = j.messages || j.data?.messages || [];
    const items = rawItems.map((it) => ({ ...it, date: normalizeMailDate(it.date) }));
    let newCount = 0;
    for (const it of items) {
      const id = it.message_id;
      if (id && !seenIds.has(id)) {
        seenIds.add(id);
        allMessages.push(it);
        newCount++;
      }
      if (timeFilter) continue; // time_range 主路径：服务端已按时间圈定窗口，无需客户端边界判定
      // 增量边界（仅锚点回退模式）：本页出现上次快照已有的邮件
      if (prevIds && id && prevIds.has(id)) {
        hitPrevBoundary = true;
      }
      if (prevOldestId && id === prevOldestId) {
        sawPrevOldest = true;
      }
    }
    if (newCount > 0) quietPages = 0; else quietPages++;

    process.stderr.write(`page ${page}: 本页${items.length}封(新增${newCount}) 累计${allMessages.length} has_more=${j.has_more}${timeFilter ? ' [time_range窗口]' : hitPrevBoundary ? ` 边界命中${sawPrevOldest ? '(已见最旧✓)' : `(静默页${quietPages}/${QUIET_PAGES_TO_STOP})`}` : ''}\n`);

    if (timeFilter) {
      // 主路径：窗口穷尽即完整（服务端契约），锚点/静默页启发式全部不适用
      if (!j.has_more) {
        return { messages: allMessages, complete: true, incremental: true, mode: 'time_range' };
      }
    } else if (sawPrevOldest) {
      // 锚点硬保证停止：上次快照最旧一封已入眼，其后（无论服务器怎么排序）不可能再有
      // 上次快照之外的旧邮件 → 新邮件 100% 已覆盖。
      return { messages: allMessages, complete: true, incremental: true, mode: 'anchor', sawPrevOldest: true };
    } else if (hitPrevBoundary && (quietPages >= QUIET_PAGES_TO_STOP || page >= MAX_INC_PAGES)) {
      // 锚点兜底停止（最旧一封始终没出现：可能被删/折叠，或翻页成本超限）。
      // 2026-09-30 起不再"告警完照用"：调用方见 sawPrevOldest=false 自动升级全量。
      process.stderr.write(`⚠️ 锚点模式兜底停止（page=${page}, 静默=${quietPages}）：始终未见到上次快照最旧邮件` +
        `(${String(prevOldestId || '?').slice(0, 12)}…)，本次覆盖不保证完整 → 自动升级全量重扫\n`);
      return { messages: allMessages, complete: true, incremental: true, mode: 'anchor', sawPrevOldest: false };
    }

    if (!j.has_more) {
      // 正常结束：完整穷尽（首轮或新邮件量小无边界命中）
      return { messages: allMessages, complete: true, incremental: false, mode: 'full' };
    }

    const nextToken = j.page_token;
    // 分页游标异常 → 必须 STOP（继续会无限重复拉第1页）
    if (!nextToken) {
      return {
        messages: allMessages,
        complete: false,
        error: `page ${page}: has_more=true 但 page_token 为空，分页游标失效。已停止，前 ${allMessages.length} 封有效。`,
      };
    }
    if (nextToken === prevToken) {
      return {
        messages: allMessages,
        complete: false,
        error: `page ${page}: page_token 与上一页相同，游标未推进（疑似API异常）。已停止，前 ${allMessages.length} 封有效。`,
      };
    }
    prevToken = pageToken;
    pageToken = nextToken;

    if (page >= MAX_PAGES) {
      return {
        messages: allMessages,
        complete: false,
        error: `安全停止: 达到 MAX_PAGES=${MAX_PAGES}（${allMessages.length} 封），但 has_more 仍为 true。`,
      };
    }
  }
}

/**
 * 原子发布完整快照：先写 .tmp 再 rename。
 * 只有 complete=true 才调用此函数。
 */
function publishSnapshot(messages) {
  const data = JSON.stringify(messages, null, 2);
  JSON.parse(data); // 写前自校验
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp`;
  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, OUT);
}

/**
 * 把部分/失败结果写到诊断目录（不污染主快照）。
 */
function writeDiagnostic(messages, error) {
  fs.mkdirSync(DIAG_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const diagPath = path.join(DIAG_DIR, `partial_${ts}.json`);
  fs.writeFileSync(diagPath, JSON.stringify({ error, partial_count: messages.length, messages }, null, 2), 'utf8');
  return diagPath;
}

/**
 * 主入口。
 */
export function main(runner) {
  const scanStartAt = new Date(); // 本次扫描开始时刻（下次 time_range 窗口的基准）

  // 每日全量兜底（2026-09-30 吴增俊漏件事故分层防御第 2 层）：距上次全量扫描超过 24h
  // → 本次强制全量。增量只能"尽量不漏"，漏件由每日全量在一天内兜住。
  // 2026-09-30 修：fullDue 提前计算，缓存复用必须让位（原实现复用 return 在检查之前，
  // 连续复用会把全量无限推迟）。
  const FULL_SCAN_STAMP = `${OUT}.fullscan`;
  const FULL_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;
  const fullDue = !fs.existsSync(FULL_SCAN_STAMP) || (Date.now() - fs.statSync(FULL_SCAN_STAMP).mtimeMs) > FULL_SCAN_INTERVAL_MS;

  // --max-age-minutes N：快照在 N 分钟内且未到全量周期则直接复用（跳过 API 分页，冷启动×N页的重复开销）。
  // 默认 0 = 总是扫描（保持旧行为）。用户明确说"刚收到邮件"时勿带本参数。
  const ageArg = process.argv.find(a => a.startsWith('--max-age-minutes'));
  if (ageArg && !fullDue) {
    const maxAgeMin = Number(ageArg.split('=')[1] || process.argv[process.argv.indexOf(ageArg) + 1]) || 0;
    if (maxAgeMin > 0 && fs.existsSync(OUT)) {
      const ageMs = Date.now() - fs.statSync(OUT).mtimeMs;
      if (ageMs < maxAgeMin * 60_000) {
        const cached = JSON.parse(fs.readFileSync(OUT, 'utf8'));
        console.log(`⚡ 快照新鲜（${Math.round(ageMs / 60_000)} 分钟前），--max-age-minutes=${maxAgeMin} 内直接复用: ${OUT}（${cached.length} 封）`);
        return;
      }
    }
  }

  // 增量：读上次快照的 message_id 集合（不存在则全量穷尽，兼容首轮）
  let prevMessages = [];
  if (fs.existsSync(OUT)) {
    try {
      prevMessages = JSON.parse(fs.readFileSync(OUT, 'utf8'));
      if (!Array.isArray(prevMessages)) prevMessages = [];
    } catch (e) {
      console.error(`⚠️ 旧快照解析失败，退回全量扫描: ${e.message}`);
      prevMessages = [];
    }
  }
  const prevIds = new Set(prevMessages.map(m => m && m.message_id).filter(Boolean));
  // 最旧一封 = 快照末尾（新在前旧在后）；锚点回退模式的停止硬边界
  const prevOldestId = prevMessages.length ? (prevMessages[prevMessages.length - 1] || {}).message_id : null;

  // 扫描元数据：上次扫描开始时刻（time_range 窗口基准）。缺失/损坏 → 锚点回退模式。
  const META_PATH = `${OUT}.meta.json`;
  let lastScanAtMs = 0;
  if (fs.existsSync(META_PATH)) {
    try {
      lastScanAtMs = Date.parse(JSON.parse(fs.readFileSync(META_PATH, 'utf8')).last_scan_at || '') || 0;
    } catch { /* meta 损坏按缺失处理 */ }
  }

  const forceFull = fullDue;
  if (forceFull) {
    prevMessages = []; // 清空 → runScan 全量穷尽
    console.log('ℹ️ 距上次全量扫描超 24h（或无记录）→ 本次全量扫描（每日漏件兜底层）');
  }

  // 主路径选择（2026-09-30 吴增俊漏件事故二轮加固）：
  // time_range 服务端过滤（契约驱动）> 锚点翻页（排序假设驱动，仅回退）> 全量
  const TIME_WINDOW_MARGIN_MS = 60 * 60 * 1000; // 1h 余量：覆盖上次扫描进行中的边界竞态 + 同批次时间戳
  const useTimeRange = !forceFull && lastScanAtMs > 0 && prevMessages.length > 0;
  const sinceMs = useTimeRange ? lastScanAtMs - TIME_WINDOW_MARGIN_MS : 0;

  // 升级全量：自检失败/锚点兜底触发时，弃用增量结果进程内重扫（不再"告警完照用"）
  const escalate = (reason) => {
    process.stderr.write(`⚠️ ${reason} → 自动升级全量重扫（增量结果弃用）\n`);
    const r = runScan(runner, new Set(), null);
    if (!r.complete) throw new Error(r.error || '升级全量仍未穷尽');
    r.mode = 'full_escalated';
    return r;
  };

  let result;
  try {
    if (forceFull) {
      result = runScan(runner, new Set(), null);
    } else if (useTimeRange) {
      const sinceIso = toLocalIso(sinceMs);
      console.log(`⏱️ time_range 增量：窗口起点 ${sinceIso}（上次扫描 ${toLocalIso(lastScanAtMs)} − 1h 余量）`);
      result = runScan(runner, prevIds, null, { sinceIso });
      // 窗口自检：上次快照最新一封若落在窗口时间内，必须出现在窗口结果里。
      // 不在 = 服务端时间过滤静默失效（返回空/缺）——吴增俊型静默漏件的防御，
      // 触发即升级全量，不等 24h。
      const newestPrev = prevMessages[0] || {};
      const newestPrevMs = parseLocalDate(newestPrev.date);
      if (newestPrevMs && newestPrevMs >= sinceMs) {
        const inWindow = result.messages.some(m => m.message_id === newestPrev.message_id);
        if (!inWindow) {
          result = escalate(`窗口自检失败：上次快照最新一封 ${String(newestPrev.message_id || '?').slice(0, 12)}…（${newestPrev.date}）未出现在 time_range 窗口结果中，疑似服务端过滤失效`);
        }
      }
    } else {
      console.log('⚓ 锚点回退模式（无扫描元数据：首次运行或 meta 损坏；正常增量不走此路径）');
      result = runScan(runner, prevIds, prevOldestId);
      if (result.mode === 'anchor' && result.sawPrevOldest === false) {
        result = escalate('锚点模式兜底触发');
      }
    }
  } catch (e) {
    // CLI 执行失败或 JSON 解析失败：不覆盖旧快照，写诊断，非零退出
    const diagPath = writeDiagnostic([], e.message);
    console.error(`🔴 扫描失败: ${e.message}`);
    console.error(`   诊断已存: ${diagPath}`);
    console.error(`   主快照 ${OUT} 未被修改（保留上一份完整数据）`);
    process.exit(2);
  }

  if (!result.complete) {
    // 未穷尽：写诊断，不覆盖主快照，非零退出
    const diagPath = writeDiagnostic(result.messages, result.error);
    console.error(`🔴 未穷尽: ${result.error}`);
    console.error(`   部分结果（${result.messages.length} 封）已存诊断: ${diagPath}`);
    console.error(`   主快照 ${OUT} 未被修改——归档决策前必须重试或确认无遗漏`);
    process.exit(2);
  }

  // 合并：新邮件 + 旧快照（新在前，旧在后，按 message_id 去重，新邮件优先覆盖旧字段）
  let merged = result.messages;
  if (result.incremental && prevMessages.length) {
    const newIds = new Set(result.messages.map(m => m.message_id));
    const stale = prevMessages.filter(m => !newIds.has(m.message_id));
    merged = [...result.messages, ...stale];
    console.log(`\n📈 增量扫描: 新增 ${result.messages.length} 封 + 旧快照 ${stale.length} 封 = ${merged.length} 封（跳过历史 ${prevMessages.length - stale.length} 封重复）`);
  }

  // 完整穷尽/增量截断：原子发布
  publishSnapshot(merged);

  // 全量扫描成功 → 记时间戳（每日全量兜底的计时起点；增量扫描与升级全量都不动它，
  // 升级全量虽是全量但由当日兜底周期外的异常触发，不计为"每日兜底已执行"）
  if (!result.incremental && result.mode !== 'full_escalated') {
    fs.writeFileSync(`${OUT}.fullscan`, new Date().toISOString());
  }

  // 扫描元数据（time_range 窗口基准 + 模式记录，供诊断/日报消费；写失败不阻塞主流程）
  try {
    fs.writeFileSync(META_PATH, JSON.stringify({
      last_scan_at: scanStartAt.toISOString(), // 下次增量窗口 = 此时刻 − 1h 余量
      mode: result.mode, // time_range | anchor | full | full_escalated
      snapshot_count: merged.length,
    }, null, 2));
  } catch (e) {
    process.stderr.write(`⚠️ 扫描元数据写入失败（不影响快照，下次增量将回退锚点模式）: ${e.message}\n`);
  }

  // 通知只打标签，不删除
  const enriched = merged.map(m => ({
    ...m,
    is_notification: isNotification(m),
  }));
  const candidates = enriched.filter(m => !m.is_notification);

  console.log(`\n=== 共 ${enriched.length} 封，候选 ${candidates.length} 封，通知 ${enriched.length - candidates.length} 封 ===`);
  // 2026-08-18：stdout 不再倾倒全量候选清单（913 封×每次 collect = 终端噪音）。
  // 增量模式只打新增；全量清单写文件按需查。完整清单永远在快照 JSON 里。
  if (result.incremental && result.messages.length) {
    // 只打"相对上次快照的新邮件"：窗口重叠区/锚点翻到的已见邮件（prevIds 命中）不算新增
    const newCandidates = result.messages.filter(m => !isNotification(m) && !prevIds.has(m.message_id));
    console.log(`本次新增 ${newCandidates.length} 封候选:`);
    newCandidates.forEach(m => {
      console.log(`${m.date} | ${(m.from || '').slice(0, 28).padEnd(28)} | ${m.subject}`);
    });
  } else if (!result.incremental) {
    const listPath = OUT.replace(/\.json$/, '_candidates.txt');
    try {
      fs.writeFileSync(listPath, candidates.map(m => `${m.date} | ${m.from || ''} | ${m.message_id} | ${m.subject}`).join('\n'), 'utf-8');
      console.log(`全量候选清单已写文件: ${listPath}（${candidates.length} 封，不再刷屏）`);
    } catch { /* 写文件失败不阻塞扫描 */ }
  }

  process.stderr.write(`\n快照已原子发布: ${OUT}（${merged.length} 封，已按 message_id 去重，模式=${result.mode}）\n`);
}

// CLI 直接运行时执行 main；被 import 时不自动执行（测试可调 runScan/main）
const _isDirectRun = isDirectRun(import.meta.url);
if (_isDirectRun) {
  main();
}
