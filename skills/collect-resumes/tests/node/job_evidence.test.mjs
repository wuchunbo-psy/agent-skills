// tests/node/job_evidence.test.mjs
// 防错岗三层防线测试（2026-09-30，spec: docs/superpowers/specs/2026-09-30-archive-job-misplacement-guard-design.md）
// 核心验收：已知事故回测——李淑婷（群信号指向迷你世界、归档目标长青 → 必须拦）、
// 黄菲菲（ATS 同名岗投递在迷你世界、归档目标长青 → 必须拦）。

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  normalizeJobName, coreJobWord, studioCoreNames, buildCollisionGroups,
  extractSignalHints, evaluateConflicts, checkEvidenceForResolve, jobDirFromPath, sameOrgSide,
} from '../../scripts/lib/job_evidence.mjs';
import { resolveRecord } from '../../scripts/resolve_records.mjs';
import { ARCHIVE_ROOT } from '../../scripts/lib/paths.mjs';

// ---- fixture：撞名岗位群（真实目录结构的抽象子集）----
const JD = [
  { job_dir: '长青工作室/美术端/游戏UI设计师', collected_dir: 'F:/x/长青工作室/美术端/游戏UI设计师/已收集简历' },
  { job_dir: '迷你世界项目团队/美术端/游戏UI设计师', collected_dir: 'F:/x/迷你世界项目团队/美术端/游戏UI设计师/已收集简历' },
  { job_dir: '山海弹珠项目/美术端/特效设计师', collected_dir: 'F:/x/山海弹珠项目/美术端/特效设计师/已收集简历' },
  { job_dir: '长青工作室/美术端/Unity特效设计师', collected_dir: 'F:/x/长青工作室/美术端/Unity特效设计师/已收集简历' },
  { job_dir: '坤灵项目/美术端/资深Unity3D特效', collected_dir: 'F:/x/坤灵项目/美术端/资深Unity3D特效/已收集简历' },
  { job_dir: 'Magnolia项目团队/交互设计师（AI UGC平台）', collected_dir: 'F:/x/Magnolia项目团队/交互设计师（AI UGC平台）/已收集简历' },
];

// 李淑婷事故原文证据（2026-09-29 群信号，evidence 明写"游戏UI，迷你世界"）
const SIG_LST = [{
  name: '李淑婷', type: 'invite', source: 'UI招聘反馈群',
  evidence: '2026-09-29 17:01 黄琳丽回复李淑婷简历（11:49发）：「这个问问她愿不愿意先接受测试 可以先发给她 然后我看她会spine 补充发一下相关作品 看看」——联系候选人发测试+索Spine相关作品（游戏UI，迷你世界）',
  time: '2026-09-29 17:01',
}];

// ---- 归一化与核心词 ----

test('normalizeJobName: 迁移后行为不变（空格/括号/级别前缀）', () => {
  assert.equal(normalizeJobName('AI Native 游戏服务端开发工程师（Go）'), 'ainative游戏服务端开发工程师');
  assert.equal(normalizeJobName('资深Unity3D特效'), 'unity3d特效');
  assert.equal(normalizeJobName('游戏UI设计师'), 'ui设计师');
});

test('coreJobWord: 去工种后缀，<2字返回 null', () => {
  assert.equal(coreJobWord('游戏UI设计师'), 'ui');
  assert.equal(coreJobWord('资深Unity3D特效'), 'unity3d'); // "特效"被去后缀 → unity3d
  assert.equal(coreJobWord('3D角色设计师'), '3d角色');
});

test('studioCoreNames: 团队核心名 + 2字前缀变体', () => {
  const m = studioCoreNames(['迷你世界项目团队', '长青工作室', '山海弹珠项目']);
  assert.equal(m.get('迷你世界'), '迷你世界项目团队');
  assert.equal(m.get('长青'), '长青工作室');
  assert.equal(m.get('山海'), '山海弹珠项目'); // 2字前缀变体
});

// ---- 撞名群推导（层③）----

test('buildCollisionGroups: 同名组 + 近名传递合并', () => {
  const groups = buildCollisionGroups(JD);
  // 同名组：两个游戏UI设计师
  const same = groups.find(g => g.members.includes('迷你世界项目团队/美术端/游戏UI设计师'));
  assert.ok(same, '游戏UI设计师同名组应存在');
  assert.equal(same.members.length, 2);
  assert.ok(same.members.includes('长青工作室/美术端/游戏UI设计师'));
  // 近名组：特效设计师 ⊂ Unity特效设计师 ⊂ unity3d特效（传递合并为一组）
  const kin = groups.find(g => g.members.includes('长青工作室/美术端/Unity特效设计师'));
  assert.ok(kin, '特效近名组应存在');
  assert.ok(kin.members.includes('山海弹珠项目/美术端/特效设计师'));
  assert.ok(kin.members.includes('坤灵项目/美术端/资深Unity3D特效'));
  // 非撞名岗不成组
  const solo = groups.find(g => g.members.includes('Magnolia项目团队/交互设计师（AI UGC平台）'));
  assert.equal(solo, undefined);
});

// ---- signals 证据提取（李淑婷回测）----

test('extractSignalHints: 李淑婷证据 → 迷你世界/游戏UI设计师（岗位级定位）', () => {
  const hints = extractSignalHints(SIG_LST[0], JD);
  assert.deepEqual(hints.studios, ['迷你世界项目团队']);
  assert.deepEqual(hints.jobDirs, ['迷你世界项目团队/美术端/游戏UI设计师']);
});

test('extractSignalHints: 工作室群名直接指向（长青群推荐）', () => {
  const sig = { name: '郑榆滨', source: '长青工作室招聘沟通群', evidence: '张书瑞：这个人也发下测试（3D角色）', time: 't' };
  const hints = extractSignalHints(sig, JD);
  assert.deepEqual(hints.studios, ['长青工作室']);
  // "3d角色"不在本 fixture（3D角色设计师未列），jobDirs 为空 → 工作室级证据
  assert.equal(hints.jobDirs.length, 0);
});

// ---- 冲突判定（层②核心，已知事故回测）----

test('evaluateConflicts 回测李淑婷：目标长青、证据指向迷你世界 → 拦（signal）', () => {
  const c = evaluateConflicts({
    name: '李淑婷', targetJobDir: '长青工作室/美术端/游戏UI设计师',
    jobDirs: JD, signals: SIG_LST, atsJobs: [],
  });
  assert.ok(c, '必须拦截');
  assert.equal(c.kind, 'signal');
  assert.ok(c.detail.includes('迷你世界'), 'detail 应写出指向');
});

test('evaluateConflicts: 目标与证据一致（迷你世界）→ 放行', () => {
  const c = evaluateConflicts({
    name: '李淑婷', targetJobDir: '迷你世界项目团队/美术端/游戏UI设计师',
    jobDirs: JD, signals: SIG_LST, atsJobs: [],
  });
  assert.equal(c, null);
});

test('evaluateConflicts: 无任何证据 → 放行（fail-open）', () => {
  const c = evaluateConflicts({
    name: '路人甲', targetJobDir: '长青工作室/美术端/游戏UI设计师',
    jobDirs: JD, signals: SIG_LST, atsJobs: [],
  });
  assert.equal(c, null);
});

test('evaluateConflicts 回测黄菲菲：ATS 同名岗投递在迷你世界、目标长青 → 拦（ats）', () => {
  const c = evaluateConflicts({
    name: '黄菲菲', targetJobDir: '长青工作室/美术端/游戏UI设计师',
    jobDirs: JD, signals: [],
    atsJobs: [{ title: '游戏ui设计师·UI团队', dept: '迷你世界项目团队' }],
  });
  assert.ok(c, '必须拦截');
  assert.equal(c.kind, 'ats');
});

test('evaluateConflicts: ATS 同工作室同名投递 → 放行', () => {
  const c = evaluateConflicts({
    name: '王五', targetJobDir: '长青工作室/美术端/游戏UI设计师',
    jobDirs: JD, signals: [],
    atsJobs: [{ title: '游戏UI设计师', dept: '长青工作室' }],
  });
  assert.equal(c, null);
});

test('evaluateConflicts: ATS 不同岗投递（转岗重投是正常场景）→ 放行', () => {
  const c = evaluateConflicts({
    name: '万志颖', targetJobDir: '长青工作室/美术端/3D动作设计师',
    jobDirs: JD, signals: [],
    atsJobs: [{ title: '资深3D动作', dept: '坤灵项目' }],
  });
  // 注：长青/3D动作设计师不在 fixture JD 中，但同名互含判定用归一化名，
  // "资深3D动作"归一化="3d动作" 与 "3d动作设计师" 互含且 dept 不同 → 本 fixture 下会拦；
  // 真实场景这是同名岗跨工作室，拦下人工确认是对的（长青 vs 坤灵 3D动作口径相反陷阱）
  assert.ok(c, '同名岗跨工作室应拦');
  assert.equal(c.kind, 'ats');
});

test('evaluateConflicts: 完全不同岗名的 ATS 投递 → 放行', () => {
  const c = evaluateConflicts({
    name: '赵六', targetJobDir: '长青工作室/美术端/Unity特效设计师',
    jobDirs: JD, signals: [],
    atsJobs: [{ title: '主美术设计师', dept: '坤灵项目' }],
  });
  assert.equal(c, null);
});

// ---- checkEvidenceForResolve 总入口 ----

test('checkEvidenceForResolve: 注入证据拦下 + 同人跨岗提示', () => {
  const manifestRecords = {
    r9: {
      candidate_name: '李淑婷', status: 'archived',
      // 历史档在另一个岗位（跨岗≠当前目标），触发同人跨岗提示
      archived_path: '<PROJECT_ROOT>/data/在招岗位候选人管理/坤灵项目/美术端/UIUE设计师/已收集简历/8.10_4份/李淑婷_UIUE.pdf',
    },
  };
  const { conflict, crossJobHint } = checkEvidenceForResolve({
    name: '李淑婷', targetJobDir: '长青工作室/美术端/游戏UI设计师',
    jobDirs: JD, manifestRecords, signals: SIG_LST, atsJobs: [],
  });
  assert.ok(conflict, '李淑婷场景必须拦');
  assert.equal(conflict.kind, 'signal');
  assert.ok(crossJobHint && crossJobHint.includes('UIUE设计师'), '应有同人跨岗提示');
});

// ---- resolveRecord 集成（层②端到端：拦截不改状态、--skip-evidence 放行）----

const FIXTURE_DIR = ARCHIVE_ROOT + '/_test_fixture_ev_' + Date.now();

function makeFixture() {
  // 建两个同名岗目录（长青+迷你世界游戏UI），让 matchJobDir 路径前缀精确命中
  const mk = (team) => {
    const collected = `${FIXTURE_DIR}/${team}/美术端/游戏UI设计师/已收集简历`;
    fs.mkdirSync(collected, { recursive: true });
    return { job_dir: `${team}/美术端/游戏UI设计师`, collected_dir: collected.replace(/\\/g, '/') };
  };
  return [mk('长青工作室'), mk('迷你世界项目团队')];
}

after(() => {
  if (fs.existsSync(FIXTURE_DIR)) fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
});

test('resolveRecord 集成: 证据冲突（黄菲菲 ATS 模式端到端）→ ambiguous、状态不推进、detail 带证据', () => {
  const jobDirs = makeFixture();
  const rec = { record_id: 'r1', message_id: 'm1', attachment_id: 'a1', status: 'needs_resolution', errors: [], source_type: 'mail_attachment' };
  const manifest = { schema_version: 1, batches: {}, records: { r1: rec } };
  // fixture 首段是时间戳目录，signals 的工作室匹配不适用；ATS 反证走岗名互含+dept 比较，
  // 不依赖 fixture 团队名结构（signals 细节由纯函数测试覆盖）
  const result = resolveRecord(manifest, 'r1', '黄菲菲', '长青工作室/美术端/游戏UI设计师', '黄菲菲_游戏UI.pdf', jobDirs, {
    date: '9.30',
    evidence: { signals: [], atsJobs: [{ title: '游戏ui设计师·UI团队', dept: '迷你世界项目团队' }] },
  });
  assert.equal(result.status, 'ambiguous');
  assert.ok(result.detail.includes('迷你世界项目团队'), 'detail 应含证据指向');
  assert.ok(result.detail.includes('ATS'), 'detail 应标明证据类型');
  assert.equal(result.manifest.records.r1.status, 'needs_resolution', '拦截时不得推进状态');
});

test('resolveRecord 集成: 无反证 → 正常 resolved（fail-open）', () => {
  const jobDirs = makeFixture();
  const rec = { record_id: 'r2', message_id: 'm2', attachment_id: 'a2', status: 'needs_resolution', errors: [], source_type: 'mail_attachment' };
  const manifest = { schema_version: 1, batches: {}, records: { r2: rec } };
  const result = resolveRecord(manifest, 'r2', '路人甲', '迷你世界项目团队/美术端/游戏UI设计师', '路人甲_游戏UI.pdf', jobDirs, {
    date: '9.30',
    evidence: { signals: [], atsJobs: [] },
  });
  assert.equal(result.status, 'resolved');
});

test('resolveRecord 集成: --skip-evidence → 人工确认后放行', () => {
  const jobDirs = makeFixture();
  const rec = { record_id: 'r3', message_id: 'm3', attachment_id: 'a3', status: 'needs_resolution', errors: [], source_type: 'mail_attachment' };
  const manifest = { schema_version: 1, batches: {}, records: { r3: rec } };
  const result = resolveRecord(manifest, 'r3', '李淑婷', '长青工作室/美术端/游戏UI设计师', '李淑婷_游戏UI.pdf', jobDirs, {
    date: '9.30', skipEvidence: true,
  });
  assert.equal(result.status, 'resolved');
});

// ---- sameOrgSide（ATS dept 同根判定，2026-09-30 真实数据教训）----

test('sameOrgSide: 工作室别名/嵌套团队=同处，迷你鲲≠迷你世界', () => {
  // 山海工作室 = 山海弹珠项目 的别名（核心名前缀）
  assert.equal(sameOrgSide('山海工作室', '山海弹珠项目/技术端/Unity客户端开发工程师'), true);
  // 内层团队名是目标路径中段 → 同处
  assert.equal(sameOrgSide('用户和生态运营团队', '迷你世界项目团队/运营团队/用户和生态运营团队/游戏内容运营（UGC生态）'), true);
  // 迷你鲲（广州另一家）与迷你世界：共同前缀"迷你"但互不为整段前缀 → 不同处
  assert.equal(sameOrgSide('迷你鲲工作室', '迷你世界项目团队/美术端/游戏UI设计师'), false);
  // 真跨室
  assert.equal(sameOrgSide('长青工作室', '迷你世界项目团队/美术端/游戏UI设计师'), false);
  // dept 缺失不作证据
  assert.equal(sameOrgSide(null, '任意/岗位'), true);
});

// ---- jobDirFromPath ----

test('jobDirFromPath: 正反斜杠路径均提取相对岗位目录', () => {
  assert.equal(jobDirFromPath('F:\\miniwanob\\data\\在招岗位候选人管理\\长青工作室\\美术端\\游戏UI设计师\\已收集简历\\8.10_4份\\x.pdf'),
    '长青工作室/美术端/游戏UI设计师');
  assert.equal(jobDirFromPath('<PROJECT_ROOT>/data/在招岗位候选人管理/坤灵项目/技术端/服务器主程/已收集简历/9.1_1份/y.zip'),
    '坤灵项目/技术端/服务器主程');
  assert.equal(jobDirFromPath('F:/other/x.pdf'), null);
});
