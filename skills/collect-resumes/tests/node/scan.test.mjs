import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runScan, normalizeMailDate } from '../../scripts/scan_all.mjs';

// 伪造分页 runner：按页返回预设响应
function makePageRunner(pages) {
  let call = 0;
  return (_cmd) => {
    const p = pages[Math.min(call, pages.length - 1)];
    call++;
    return typeof p === 'string' ? p : JSON.stringify(p);
  };
}

test('complete scan returns all messages when has_more=false', () => {
  const runner = makePageRunner([
    { ok: true, has_more: true, page_token: 'tok2', messages: [{ message_id: 'm1', subject: 'A', from: 'x', date: '2026-07-10' }] },
    { ok: true, has_more: false, page_token: '', messages: [{ message_id: 'm2', subject: 'B', from: 'y', date: '2026-07-10' }] },
  ]);
  const result = runScan(runner);
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 2);
});

test('API business error (ok=false) throws, does not return partial silently', () => {
  const runner = makePageRunner([{ ok: false, error: { message: 'access denied' } }]);
  assert.throws(() => runScan(runner), /API_ERROR.*denied/);
});

test('malformed JSON on page 2 throws (fail-closed)', () => {
  const runner = makePageRunner([
    { ok: true, has_more: true, page_token: 'tok2', messages: [{ message_id: 'm1', subject: 'A' }] },
    'THIS IS NOT JSON {{{',
  ]);
  assert.throws(() => runScan(runner), /INVALID_JSON/);
});

test('empty page_token with has_more=true returns incomplete', () => {
  const runner = makePageRunner([
    { ok: true, has_more: true, page_token: '', messages: [{ message_id: 'm1' }] },
  ]);
  const result = runScan(runner);
  assert.equal(result.complete, false);
  assert.match(result.error, /page_token 为空/);
  assert.equal(result.messages.length, 1);
});

test('duplicate page_token returns incomplete', () => {
  const runner = makePageRunner([
    { ok: true, has_more: true, page_token: 'same', messages: [{ message_id: 'm1' }] },
    { ok: true, has_more: true, page_token: 'same', messages: [{ message_id: 'm2' }] },
  ]);
  const result = runScan(runner);
  assert.equal(result.complete, false);
  assert.match(result.error, /page_token 与上一页相同/);
});

test('deduplicates by message_id across pages', () => {
  const runner = makePageRunner([
    { ok: true, has_more: true, page_token: 't2', messages: [{ message_id: 'm1', subject: 'A' }] },
    { ok: true, has_more: false, messages: [{ message_id: 'm1', subject: 'A dup' }] },
  ]);
  const result = runScan(runner);
  assert.equal(result.messages.length, 1);
});

// ===== 2026-09-30 time_range 主路径 + 锚点回退（吴增俊漏件二轮加固）=====

test('time_range mode: exhausts window pages, returns mode time_range, normalizes ISO dates', () => {
  const cmds = [];
  const runner = (cmd) => {
    cmds.push(cmd);
    return JSON.stringify({
      ok: true, has_more: cmds.length === 1, page_token: cmds.length === 1 ? 'search:t2' : '',
      messages: [{ message_id: 'm1', date: '2026-09-30T07:12:36Z', from: 'BOSS <cv@x.com>', subject: 'S' }],
    });
  };
  const result = runScan(runner, new Set(['old1']), null, { sinceIso: '2026-09-30T10:00:00+08:00' });
  assert.equal(result.complete, true);
  assert.equal(result.incremental, true);
  assert.equal(result.mode, 'time_range');
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].date, '2026-09-30 15:12'); // ISO UTC → 本地格式
  // 每页都带同一 filter（search: token 不可与 list: 混用）
  assert.ok(cmds.every(c => c.includes('--filter') && c.includes('time_range') && c.includes('start_time')));
  assert.ok(cmds[1].includes('--page-token "search:t2"'));
});

test('time_range mode does not stop on prev-snapshot boundary (server filter is the contract)', () => {
  // 窗口内全是已见邮件（重叠区）：不触发任何客户端停止启发式，翻完窗口即返回
  const runner = makePageRunner([
    { ok: true, has_more: false, messages: [{ message_id: 'seen1', date: '2026-09-30 10:00' }] },
  ]);
  const result = runScan(runner, new Set(['seen1']), 'oldest1', { sinceIso: '2026-09-30T09:00:00+08:00' });
  assert.equal(result.mode, 'time_range');
  assert.equal(result.complete, true);
});

test('anchor fallback: stops immediately when prevOldestId is seen', () => {
  const runner = makePageRunner([
    { ok: true, has_more: true, page_token: 't2', messages: [
      { message_id: 'new1' }, { message_id: 'old1' }, { message_id: 'OLDEST' },
    ] },
  ]);
  const result = runScan(runner, new Set(['old1', 'OLDEST']), 'OLDEST');
  assert.equal(result.mode, 'anchor');
  assert.equal(result.sawPrevOldest, true);
  assert.equal(result.complete, true);
});

test('anchor fallback: quiet pages without anchor → bail with sawPrevOldest=false (caller escalates)', () => {
  // 注：quietPages 统计"本次扫描首见为 0"的页（旧快照邮件首见也算新增，2026-08-14 以来语义），
  // 所以用空页累积静默；makePageRunner 超页会重复末页 token，须在触发兜底前结束。
  const runner = makePageRunner([
    { ok: true, has_more: true, page_token: 't2', messages: [{ message_id: 'new1' }, { message_id: 'old1' }] },
    { ok: true, has_more: true, page_token: 't3', messages: [] },
    { ok: true, has_more: true, page_token: 't4', messages: [] },
    { ok: true, has_more: true, page_token: 't5', messages: [] },
    { ok: true, has_more: true, page_token: 't6', messages: [] },
  ]);
  const result = runScan(runner, new Set(['old1']), 'OLDEST_NEVER_SEEN');
  assert.equal(result.mode, 'anchor');
  assert.equal(result.sawPrevOldest, false);
  assert.equal(result.complete, true); // 数据由调用方决定弃用并升级全量
});

test('normalizeMailDate keeps list-path format untouched', () => {
  assert.equal(normalizeMailDate('2026-09-30 15:12'), '2026-09-30 15:12');
  assert.equal(normalizeMailDate('2026-07-10'), '2026-07-10');
  assert.equal(normalizeMailDate(undefined), undefined);
});
