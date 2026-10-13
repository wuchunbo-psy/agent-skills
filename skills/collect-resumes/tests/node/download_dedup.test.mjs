// 2026-09-20 三坑修复回归：
// ① 重复类排除码必须带内容证据（谢平鑫案例：前置自愈无 SHA 排除）
// ② 同批并发下载互查 SHA（唐诗晨案例：同人同日双邮件同内容双双入库）
// ③ 孪生路径分档分发后失明（谢平鑫案例暴露：findMovedTwin 兜底）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { transitionToExcluded } from '../../scripts/lib/manifest.mjs';
import {
  batchCommittedIndex,
  batchDupKey,
  lookupBatchDuplicate,
  findMovedTwin,
} from '../../scripts/download_attachment.mjs';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'collect-dedup-'));

test('duplicate-code exclusion requires content evidence (state-machine guard)', () => {
  const rec = { record_id: 'r1', status: 'verified' };
  assert.throws(() => transitionToExcluded(rec, 'DUPLICATE_ALREADY_ARCHIVED', '同人同岗'), /EXCLUDE_NO_EVIDENCE/);
  assert.throws(() => transitionToExcluded(rec, 'DUPLICATE_CONTENT', 'SHA 相同'), /EXCLUDE_NO_EVIDENCE/);
  assert.throws(() => transitionToExcluded(rec, 'SAMEDAY_CONFLICT', '同日冲突'), /EXCLUDE_NO_EVIDENCE/);
  // 非重复码不受限（背调材料/链接失效等人工排除照常）
  assert.equal(transitionToExcluded(rec, 'NOT_RESUME', '背调材料').status, 'excluded');
  // 调用方带 SHA 证据 → 放行，且证据落到记录上
  const ok = transitionToExcluded(rec, 'DUPLICATE_CONTENT', 'SHA 相同', { sha256: 'a'.repeat(64) });
  assert.equal(ok.status, 'excluded');
  assert.equal(ok.sha256, 'a'.repeat(64));
  assert.equal(ok.exclude_reason.code, 'DUPLICATE_CONTENT');
  // 记录自带 sha256（下载过）→ 放行
  const rec2 = { record_id: 'r2', status: 'verified', sha256: 'b'.repeat(64) };
  assert.equal(transitionToExcluded(rec2, 'DUPLICATE_CONTENT', 'x').status, 'excluded');
  // reaudit 正向证据 dupe_verified → 放行；method=error 不是正证据 → 拒绝
  const rec3 = { record_id: 'r3', status: 'verified', dupe_verified: { method: 'sha-match' } };
  assert.equal(transitionToExcluded(rec3, 'DUPLICATE_CONTENT', 'x').status, 'excluded');
  const rec4 = { record_id: 'r4', status: 'verified', dupe_verified: { method: 'error', error: 'LINK_EXPIRED' } };
  assert.throws(() => transitionToExcluded(rec4, 'DUPLICATE_CONTENT', 'x'), /EXCLUDE_NO_EVIDENCE/);
});

test('batch registry catches same-content twin within one batch, ignores self/other content/person', () => {
  const index = new Map();
  const a = { record_id: 'ra', candidate_name: '唐诗晨', job_name: '坤灵项目/美术端/资深2D角色原画' };
  const b = { record_id: 'rb', candidate_name: '唐诗晨', job_name: '资深2D角色原画' }; // 末级岗位名同即同岗
  const sha = '5'.repeat(64);
  assert.equal(lookupBatchDuplicate(index, a, sha), null);
  index.set(batchDupKey(a, sha), { record_id: 'ra', target_filename: '唐诗晨_资深2D角色原画_4年.pdf' });
  // 同人同岗同内容（跨末级岗位前缀）→ 命中先提交者
  assert.equal(lookupBatchDuplicate(index, b, sha).record_id, 'ra');
  // 自身命中不算重复（幂等重跑）
  assert.equal(lookupBatchDuplicate(index, a, sha), null);
  // 不同内容 / 不同人 → 不命中
  assert.equal(lookupBatchDuplicate(index, b, 'f'.repeat(64)), null);
  const c = { record_id: 'rc', candidate_name: '张凌霄', job_name: '资深2D角色原画' };
  assert.equal(lookupBatchDuplicate(index, c, sha), null);
  // 模块级注册表可独立使用（downloadByRecord 的真实写入目标）
  assert.equal(typeof batchCommittedIndex.set, 'function');
});

test('findMovedTwin locates twin after finalize distribution moved it into tier subdirs', () => {
  const dir = tempDir();
  const batchDir = path.join(dir, 'batch');
  const tierDir = path.join(batchDir, '待定');
  fs.mkdirSync(tierDir, { recursive: true });
  const fname = '谢平鑫_3D角色设计师_简历加作品.pdf';
  fs.writeFileSync(path.join(tierDir, fname), 'pdf-bytes');

  // 直拼路径已失效（文件被挪进档次子夹），manifest 不回写 → 兜底按文件名定位
  const moved = findMovedTwin({ target_dir: batchDir.replace(/\\/g, '/'), target_filename: fname });
  assert.ok(moved, 'should locate moved twin');
  assert.equal(path.basename(moved), fname);
  assert.ok(moved.includes('待定'));

  // 未被挪动的孪生：直拼路径命中
  const dir2 = tempDir();
  fs.writeFileSync(path.join(dir2, fname), 'pdf-bytes');
  const direct = findMovedTwin({ target_dir: dir2.replace(/\\/g, '/'), target_filename: fname });
  assert.equal(direct, path.join(dir2, fname).replace(/\\/g, '/'));

  // 真不存在 → null
  const dir3 = tempDir();
  assert.equal(findMovedTwin({ target_dir: dir3.replace(/\\/g, '/'), target_filename: 'none.pdf' }), null);
});
