import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type WorkbenchState,
  type Deps,
  type AuditIssue,
  createInitialState,
  createIssue,
  prepareMerge,
  commitMerge,
  unmerge,
  submitRetest,
  transitionStatus,
  runRecomputeTick,
  runMigrationTick,
  upgrade,
  computeStats,
  getView,
  resolveRetestTarget,
  activeMergeForSource,
  isPrimary
} from './audit-domain.ts';

// 可控时钟与 id，测试可复现
function makeDeps(): Deps {
  let n = 0;
  return { now: () => `2026-10-05T0${n % 10}:00:00.000Z`, id: () => `id-${++n}` };
}

function makeIssue(id: string, patch: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id,
    title: `问题${id}`,
    flow: '流程',
    steps: '步骤步骤步骤步骤',
    impactGroup: '键盘与读屏用户',
    severity: 'moderate',
    status: 'open',
    fixNote: '',
    retestNote: '',
    updatedAt: '2026-10-05T00:00:00.000Z',
    ...patch
  };
}

function stateWith(issues: AuditIssue[]): WorkbenchState {
  const state = createInitialState(makeDeps());
  state.issues = issues;
  state.events = [];
  return state;
}

const drainRecompute = (s: WorkbenchState, deps = makeDeps()) => {
  while (runRecomputeTick(s, 1, deps) > 0) {
    /* 全部跑完 */
  }
};
const drainMigration = (s: WorkbenchState, deps = makeDeps()) => {
  while (runMigrationTick(s, 1, deps) > 0) {
    drainRecompute(s, deps);
  }
};
/** 测试辅助：预期合并准备成功并取出请求 */
function mergeRequest(
  s: WorkbenchState,
  input: { sourceId: string; canonicalId: string; reviewer: string }
): Parameters<typeof commitMerge>[1] {
  const r = prepareMerge(s, input);
  if (!r.ok) throw new Error(`prepareMerge 意外失败: ${r.message}`);
  return r.value;
}

test('复测结论只对主问题生效，概览按主问题统计', () => {
  const deps = makeDeps();
  const state = stateWith([
    makeIssue('a', { title: '主问题A', status: 'verifying' }),
    makeIssue('b', { title: '来源B', status: 'verifying' }),
    makeIssue('c', { title: '独立C', status: 'open' })
  ]);

  const prepared = prepareMerge(state, { sourceId: 'b', canonicalId: 'a', reviewer: '甲' });
  assert.equal(prepared.ok, true);
  const committed = commitMerge(state, prepared.ok ? prepared.value : (undefined as never), deps);
  assert.equal(committed.ok, true);
  drainRecompute(state, deps);

  // 来源问题显示为主问题的有效视图
  const viewB = getView(state, 'b')!;
  assert.equal(viewB.kind, 'source');
  assert.equal(viewB.effectiveStatus, 'verifying');
  assert.equal(viewB.effectiveConclusion, undefined); // 主问题还没有终态结论

  // 在来源问题上点复测通过：结论记到主问题
  const retest = submitRetest(state, { issueId: 'b', verdict: 'pass', note: '已修复', actor: '复测员' }, deps);
  assert.equal(retest.ok, true);
  assert.equal(retest.ok ? retest.value.canonical.id : '', 'a');
  assert.equal(state.issues.find((i) => i.id === 'a')!.status, 'closed');
  assert.equal(state.issues.find((i) => i.id === 'b')!.status, 'verifying'); // 自身字段冻结
  drainRecompute(state, deps);

  const viewBAfter = getView(state, 'b')!;
  assert.equal(viewBAfter.effectiveStatus, 'closed');
  assert.equal(viewBAfter.effectiveConclusion?.verdict, 'pass');
  assert.equal(viewBAfter.effectiveConclusion?.kind, 'derived');

  const stats = computeStats(state);
  // 待复测 0、已关闭 1：b 作为来源不重复计数，c 独立计入待修复
  assert.equal(stats.total, 2); // a 与 c
  assert.equal(stats.verifying, 0);
  assert.equal(stats.closed, 1);
  assert.equal(stats.toFix, 1);
  assert.equal(stats.sources, 1);
});

test('主问题状态一变，来源结论作废并按新状态重算', () => {
  const deps = makeDeps();
  const state = stateWith([makeIssue('a', { title: 'A', status: 'verifying' }), makeIssue('b', { title: 'B' })]);
  commitMerge(state, mergeRequest(state, { sourceId: 'b', canonicalId: 'a', reviewer: '甲' }), deps);
  drainRecompute(state, deps);
  submitRetest(state, { issueId: 'a', verdict: 'pass', note: '通过', actor: 'r' }, deps);
  drainRecompute(state, deps);
  assert.equal(getView(state, 'b')!.effectiveConclusion?.verdict, 'pass');

  // 主问题重新打开
  transitionStatus(state, { issueId: 'a', status: 'fixing', message: '重新修复' }, deps);
  // 作废发生在重算任务执行时；队列里有任务即视为"已作废待重算"
  assert.ok(state.jobs.length > 0);
  drainRecompute(state, deps);
  assert.equal(getView(state, 'b')!.effectiveConclusion, undefined);
  assert.equal(getView(state, 'b')!.effectiveStatus, 'fixing');
  const derived = state.conclusions.filter((c) => c.kind === 'derived');
  assert.equal(derived[0].status, 'voided');
  assert.match(derived[0].voidReason ?? '', /canonical-changed/);

  // 复测失败 -> reopened：来源同步 fail
  submitRetest(state, { issueId: 'a', verdict: 'fail', note: '仍有问题', actor: 'r' }, deps);
  drainRecompute(state, deps);
  assert.equal(getView(state, 'b')!.effectiveStatus, 'reopened');
  assert.equal(getView(state, 'b')!.effectiveConclusion?.verdict, 'fail');
});

test('两名审核员同时提交合并，先到生效、后到退回并说明', () => {
  const deps = makeDeps();
  const state = stateWith([makeIssue('a', { title: '主问题A' }), makeIssue('b', { title: '来源B' })]);

  const p1 = prepareMerge(state, { sourceId: 'b', canonicalId: 'a', reviewer: '审核员一' });
  const p2 = prepareMerge(state, { sourceId: 'b', canonicalId: 'a', reviewer: '审核员二' });
  if (!p1.ok || !p2.ok) throw new Error('并发准备不应失败');
  const req1 = p1.value;
  const req2 = p2.value;
  assert.equal(req1.baseRev, req2.baseRev); // 两人基于同一版本并发提交

  const r1 = commitMerge(state, req1, deps);
  assert.equal(r1.ok, true);
  const r2 = commitMerge(state, req2, deps);
  assert.equal(r2.ok, false);
  if (r2.ok) throw new Error('后到的合并应被退回');
  assert.equal(r2.code, 'SOURCE_ALREADY_MERGED');
  assert.match(r2.message, /先合并/);
  assert.match(r2.message, /退回/);

  assert.equal(state.merges.filter((m) => m.status === 'active').length, 1);
  assert.equal(activeMergeForSource(state, 'b')!.canonicalId, 'a');
});

test('拒绝链式合并：把已合并的来源或主问题再做目标都会被退回', () => {
  const deps = makeDeps();
  const state = stateWith([makeIssue('a'), makeIssue('b'), makeIssue('c')]);
  commitMerge(state, mergeRequest(state, { sourceId: 'b', canonicalId: 'a', reviewer: '甲' }), deps);

  // b 再合到 c：来源已合并，准备阶段就退回
  const again = prepareMerge(state, { sourceId: 'b', canonicalId: 'c', reviewer: '乙' });
  assert.equal(again.ok, false);
  if (again.ok) throw new Error('再次合并应被退回');
  assert.equal(again.code, 'SOURCE_ALREADY_MERGED');
  // c 合到 b：目标 b 自身是来源
  const chain = prepareMerge(state, { sourceId: 'c', canonicalId: 'b', reviewer: '乙' });
  assert.equal(chain.ok, false);
  if (chain.ok) throw new Error('链式合并应被退回');
  assert.equal(chain.code, 'CANONICAL_IS_SOURCE');
});

test('拆回独立问题：恢复原状态与最后一次结论', () => {
  const deps = makeDeps();
  const state = stateWith([
    makeIssue('a', { title: 'A', status: 'fixing' }),
    makeIssue('b', { title: 'B', status: 'reopened', retestNote: '焦点还是错' })
  ]);
  // b 合并前有一条自身 fail 结论
  submitRetest(state, { issueId: 'b', verdict: 'fail', note: '焦点还是错', actor: 'r' }, deps);
  assert.equal(getView(state, 'b')!.effectiveStatus, 'reopened');

  commitMerge(state, mergeRequest(state, { sourceId: 'b', canonicalId: 'a', reviewer: '甲' }), deps);
  // 主问题复测通过，b 同步 pass
  submitRetest(state, { issueId: 'a', verdict: 'pass', note: '修好了', actor: 'r' }, deps);
  drainRecompute(state, deps);
  assert.equal(getView(state, 'b')!.effectiveConclusion?.verdict, 'pass');
  assert.equal(getView(state, 'b')!.effectiveStatus, 'closed');
  assert.equal(isPrimary(state, state.issues.find((i) => i.id === 'b')!), false);

  const undone = unmerge(state, 'b', '审核主管', deps);
  assert.equal(undone.ok, true);
  const viewB = getView(state, 'b')!;
  assert.equal(viewB.kind, 'primary');
  assert.equal(viewB.effectiveStatus, 'reopened'); // 恢复合并前状态
  assert.equal(state.issues.find((i) => i.id === 'b')!.retestNote, '焦点还是错');
  assert.equal(viewB.effectiveConclusion?.verdict, 'fail');
  assert.equal(state.merges[0].status, 'undone');
  // 主问题不受影响
  assert.equal(getView(state, 'a')!.effectiveStatus, 'closed');
  assert.equal(getView(state, 'a')!.effectiveConclusion?.verdict, 'pass');

  // 拆回后 b 重新成为独立问题，可以再合并到别处
  assert.equal(prepareMerge(state, { sourceId: 'b', canonicalId: 'a', reviewer: '甲' }).ok, true);
});

test('旧数据升级：链式合并压成一级，来源关系补齐', () => {
  const deps = makeDeps();
  // v1：b→a（一级）、d→c→a（链 d→c→a，根为 a）、e→x（目标缺失，挂起）、f→g→f（环，挂起）
  const v1 = {
    issues: [
      makeIssue('a', { status: 'closed', retestNote: '历史通过' }),
      makeIssue('b', { canonicalId: 'a', status: 'closed' }),
      makeIssue('c', { canonicalId: 'a', status: 'fixing' }),
      makeIssue('d', { canonicalId: 'c', status: 'open' }),
      makeIssue('e', { canonicalId: 'missing', status: 'open' }),
      makeIssue('f', { canonicalId: 'g', status: 'open' }),
      makeIssue('g', { canonicalId: 'f', status: 'open' })
    ],
    events: []
  };
  const state = upgrade(v1);
  assert.equal(state.migration.status, 'running');
  assert.equal(state.migration.total, 6); // b,d,e,f,g 以及链首 c 共六个带 canonicalId 的（c→a 也是一条边）
  drainMigration(state, deps);

  assert.equal(state.migration.status, 'done');
  const b = activeMergeForSource(state, 'b')!;
  assert.equal(b.canonicalId, 'a');
  assert.equal(b.mergedBy, '系统升级');
  const d = activeMergeForSource(state, 'd')!;
  assert.equal(d.canonicalId, 'a'); // 链压成一级，直接指根
  assert.equal(activeMergeForSource(state, 'c')!.canonicalId, 'a');
  // 一级：没有任何 active 关系的主问题自身又是来源的情况
  for (const m of state.merges) {
    if (m.status !== 'active') continue;
    assert.equal(activeMergeForSource(state, m.canonicalId), undefined);
  }
  // 挂起
  assert.ok(state.issues.find((i) => i.id === 'e')!.suspended);
  assert.match(state.issues.find((i) => i.id === 'e')!.suspendReason ?? '', /不存在/);
  assert.ok(state.issues.find((i) => i.id === 'f')!.suspended);
  assert.ok(state.issues.find((i) => i.id === 'g')!.suspended);
  assert.deepEqual(state.migration.suspendedIssueIds.sort(), ['e', 'f', 'g']);

  // 主问题历史结论补齐，来源结论通过重算同步
  drainRecompute(state, deps);
  assert.equal(getView(state, 'a')!.effectiveConclusion?.verdict, 'pass');
  assert.equal(getView(state, 'b')!.effectiveConclusion?.kind === 'derived', true);
  assert.equal(getView(state, 'b')!.effectiveConclusion?.verdict, 'pass');
  assert.equal(getView(state, 'd')!.effectiveConclusion?.verdict, 'pass');
  // 挂起问题不参与统计
  const stats = computeStats(state);
  assert.equal(stats.closed, 1); // 只算主问题 a
  assert.equal(stats.suspended, 3);
  assert.ok(!state.issues.some((i) => i.canonicalId)); // 旧字段已清除
});

test('升级与重算中断后可接着没算完的继续', () => {
  const deps = makeDeps();
  const v1 = {
    issues: [
      makeIssue('a', { status: 'closed', retestNote: '通过' }),
      makeIssue('b', { canonicalId: 'a' }),
      makeIssue('c', { canonicalId: 'a' }),
      makeIssue('d', { canonicalId: 'a' })
    ],
    events: []
  };
  // 模拟升级只跑了一条就中断：状态序列化后重新加载
  let state = upgrade(v1);
  runMigrationTick(state, 1, deps);
  assert.equal(state.migration.processed, 1);
  const snapshot = JSON.parse(JSON.stringify(state)) as WorkbenchState;

  state = upgrade(snapshot); // v2 原样恢复
  assert.equal(state.migration.status, 'running');
  runMigrationTick(state, 1, deps);
  runMigrationTick(state, 1, deps);
  assert.equal(state.migration.status, 'done');
  assert.equal(state.merges.length, 3);

  // 重算同样可中断续跑（每个来源一条）
  let count = 0;
  count += runRecomputeTick(state, 1, deps);
  assert.equal(count, 1);
  const mid = JSON.parse(JSON.stringify(state)) as WorkbenchState;
  const restored = upgrade(mid);
  const remainingBefore = restored.jobs.reduce((n, j) => n + j.remainingSourceIds.length, 0);
  assert.equal(remainingBefore, 2);
  runRecomputeTick(restored, 1, deps);
  runRecomputeTick(restored, 1, deps);
  assert.equal(restored.jobs.length, 0);
  for (const id of ['b', 'c', 'd']) {
    assert.equal(getView(restored, id)!.effectiveConclusion?.verdict, 'pass');
  }
});

test('空数据与无 canonicalId 的旧数据升级为已完成迁移', () => {
  assert.equal(upgrade(null).migration.status, 'done');
  const s = upgrade({ issues: [makeIssue('x')], events: [] });
  assert.equal(s.migration.status, 'done');
  assert.equal(s.version, 2);
});

test('来源问题的状态流转被锁，只能在主问题上操作', () => {
  const deps = makeDeps();
  const state = stateWith([makeIssue('a', { status: 'triaged' }), makeIssue('b')]);
  commitMerge(state, mergeRequest(state, { sourceId: 'b', canonicalId: 'a', reviewer: '甲' }), deps);
  const r = transitionStatus(state, { issueId: 'b', status: 'closed', message: '试图直接关闭来源' }, deps);
  assert.equal(r.ok, false);
  if (r.ok) throw new Error('来源问题流转应被锁定');
  assert.equal(r.code, 'SOURCE_LOCKED');
  assert.equal(resolveRetestTarget(state, 'b')!.id, 'a');
});

test('createIssue 与统计端到端冒烟', () => {
  const deps = makeDeps();
  const state = createInitialState(deps);
  const initial = state.issues.length;
  createIssue(state, { title: '新建的一个问题', flow: '结算', steps: '步骤步骤步骤步骤', impactGroup: '低视力用户', severity: 'minor' });
  assert.equal(state.issues.length, initial + 1);
  assert.equal(computeStats(state).total, state.issues.length);
});
