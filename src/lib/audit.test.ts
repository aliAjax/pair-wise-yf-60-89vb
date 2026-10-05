import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeIssueStatus,
  computeStats,
  createIssue,
  mergeIssues,
  migrate,
  recomputeStep,
  seedState,
  splitIssue,
  type WorkbenchState
} from './audit.js';

function stateWith(issues: WorkbenchState['issues']): WorkbenchState {
  return { issues, events: [], schemaVersion: 2 };
}

function issue(overrides: Partial<WorkbenchState['issues'][number]> & { id: string }): WorkbenchState['issues'][number] {
  return {
    title: `问题${overrides.id}`,
    flow: '流程',
    steps: '复现步骤',
    impactGroup: '读屏用户',
    severity: 'serious',
    status: 'open',
    version: 1,
    fixNote: '',
    retestNote: '',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('重复合并', () => {
  it('合并后来源问题挂到主问题下，状态置为 merged，复测结论作废并留存快照', () => {
    const state = stateWith([
      issue({ id: 'a', status: 'triaged' }),
      issue({ id: 'b', status: 'verifying', retestNote: '来源的最后结论' })
    ]);
    const result = mergeIssues(state, 'b', 'a');
    assert.equal(result.ok, true);
    const b = state.issues.find((i) => i.id === 'b')!;
    assert.equal(b.canonicalId, 'a');
    assert.equal(b.status, 'merged');
    assert.equal(b.retestNote, '');
    assert.equal(b.mergedSnapshot?.status, 'verifying');
    assert.equal(b.mergedSnapshot?.retestNote, '来源的最后结论');
    assert.equal(b.version, 2);
    assert.equal(state.events.length, 2);
  });

  it('不能合并到自己', () => {
    const state = stateWith([issue({ id: 'a' })]);
    const result = mergeIssues(state, 'a', 'a');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'self');
  });

  it('挂起的问题不能合并', () => {
    const state = stateWith([
      issue({ id: 'a' }),
      issue({ id: 'b', canonicalId: 'gone', suspended: true, suspendReason: '主问题不存在' })
    ]);
    const result = mergeIssues(state, 'b', 'a');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'source-suspended');
  });

  it('目标本身是重复项时，顺链合并到根主问题（链式压成一级）', () => {
    const state = stateWith([
      issue({ id: 'a' }),
      issue({ id: 'b', canonicalId: 'a', status: 'merged' }),
      issue({ id: 'c' })
    ]);
    const result = mergeIssues(state, 'c', 'b');
    assert.equal(result.ok, true);
    const c = state.issues.find((i) => i.id === 'c')!;
    assert.equal(c.canonicalId, 'a');
  });
});

describe('并发合并：先到生效，后到退回', () => {
  it('同一条来源问题的两个合并，后到的被 canonicalId 比较并交换退回', () => {
    const state = stateWith([issue({ id: 'a' }), issue({ id: 'b' }), issue({ id: 'c' })]);
    const first = mergeIssues(state, 'b', 'a');
    assert.equal(first.ok, true);
    const second = mergeIssues(state, 'b', 'c');
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, 'already-merged');
      assert.match(second.message, /已被其他审核员合并/);
    }
    // 先到的合并关系保持不变。
    assert.equal(state.issues.find((i) => i.id === 'b')!.canonicalId, 'a');
  });

  it('乐观锁：版本不一致时退回并说明', () => {
    const state = stateWith([issue({ id: 'a' }), issue({ id: 'b' })]);
    const result = mergeIssues(state, 'b', 'a', 999);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, 'version-conflict');
      assert.match(result.message, /已被其他审核员修改/);
    }
  });

  it('两个不同来源合并到同一主问题都生效', () => {
    const state = stateWith([issue({ id: 'a' }), issue({ id: 'b' }), issue({ id: 'c' })]);
    assert.equal(mergeIssues(state, 'b', 'a').ok, true);
    assert.equal(mergeIssues(state, 'c', 'a').ok, true);
    assert.equal(state.issues.filter((i) => i.canonicalId === 'a').length, 2);
  });
});

describe('复测结论只对主问题生效', () => {
  it('主问题状态变更后，来源问题的复测结论作废并重算', () => {
    const state = stateWith([
      issue({ id: 'a', status: 'verifying', retestNote: '主问题结论' }),
      issue({ id: 'b', status: 'verifying', retestNote: '来源结论' })
    ]);
    mergeIssues(state, 'b', 'a');
    const result = changeIssueStatus(state, 'a', { status: 'closed', retestNote: '复测通过' }, '复测通过并关闭问题');
    assert.equal(result.ok, true);
    const a = state.issues.find((i) => i.id === 'a')!;
    const b = state.issues.find((i) => i.id === 'b')!;
    assert.equal(a.status, 'closed');
    assert.equal(a.retestNote, '复测通过');
    assert.equal(b.retestNote, '');
    assert.ok(state.events.some((event) => event.issueId === 'b' && /作废/.test(event.message)));
  });

  it('主问题重新打开，来源结论同样作废', () => {
    const state = stateWith([
      issue({ id: 'a', status: 'closed', retestNote: '通过' }),
      issue({ id: 'b', canonicalId: 'a', status: 'merged', retestNote: '' })
    ]);
    changeIssueStatus(state, 'a', { status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开');
    assert.equal(state.issues.find((i) => i.id === 'b')!.retestNote, '');
    assert.equal(state.issues.find((i) => i.id === 'a')!.status, 'reopened');
  });

  it('来源问题不能直接流转状态', () => {
    const state = stateWith([
      issue({ id: 'a' }),
      issue({ id: 'b', canonicalId: 'a', status: 'merged' })
    ]);
    const result = changeIssueStatus(state, 'b', { status: 'closed' }, '复测通过');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'merged');
  });
});

describe('概览统计按主问题算', () => {
  it('待复测、已关闭只统计根问题，来源问题不重复计数', () => {
    const state = stateWith([
      issue({ id: 'a', status: 'verifying' }),
      issue({ id: 'b', canonicalId: 'a', status: 'merged' }),
      issue({ id: 'c', status: 'closed' }),
      issue({ id: 'd', canonicalId: 'c', status: 'merged' }),
      issue({ id: 'e', status: 'open' })
    ]);
    const stats = computeStats(state);
    assert.equal(stats.total, 3);
    assert.equal(stats.verifying, 1);
    assert.equal(stats.closed, 1);
    assert.equal(stats.pendingFix, 1);
  });
});

describe('拆回独立问题', () => {
  it('拆回后恢复合并前状态和最后一次复测结论', () => {
    const state = stateWith([
      issue({ id: 'a' }),
      issue({ id: 'b', status: 'verifying', retestNote: '最后一次结论' })
    ]);
    mergeIssues(state, 'b', 'a');
    // 合并后主问题状态变化，来源结论已作废；拆回应恢复合并前留存的结论。
    changeIssueStatus(state, 'a', { status: 'closed', retestNote: '通过' }, '复测通过');
    const result = splitIssue(state, 'b');
    assert.equal(result.ok, true);
    const b = state.issues.find((i) => i.id === 'b')!;
    assert.equal(b.canonicalId, undefined);
    assert.equal(b.mergedSnapshot, undefined);
    assert.equal(b.status, 'verifying');
    assert.equal(b.retestNote, '最后一次结论');
  });

  it('拆回未合并的问题被拒绝', () => {
    const state = stateWith([issue({ id: 'a' })]);
    const result = splitIssue(state, 'a');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, 'not-merged');
  });
});

describe('旧数据升级：链式合并压成一级、补齐来源关系', () => {
  it('只有一条主问题编号的链式合并，升级后全部指向根主问题', () => {
    const raw = {
      issues: [
        { id: 'a', title: 'A', status: 'open', canonicalId: 'b', fixNote: '', retestNote: 'A的结论', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', title: 'B', status: 'verifying', canonicalId: 'c', fixNote: '', retestNote: 'B的结论', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'c', title: 'C', status: 'closed', fixNote: '', retestNote: 'C的结论', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' }
      ],
      events: [],
      schemaVersion: 1
    };
    const state = migrate(raw);
    assert.equal(state.schemaVersion, 2);
    const a = state.issues.find((i) => i.id === 'a')!;
    const b = state.issues.find((i) => i.id === 'b')!;
    const c = state.issues.find((i) => i.id === 'c')!;
    assert.equal(a.canonicalId, 'c');
    assert.equal(b.canonicalId, 'c');
    assert.equal(a.status, 'merged');
    assert.equal(b.status, 'merged');
    assert.equal(a.retestNote, '');
    assert.equal(b.retestNote, '');
    assert.equal(a.mergedSnapshot?.retestNote, 'A的结论');
    assert.equal(b.mergedSnapshot?.retestNote, 'B的结论');
    assert.equal(c.status, 'closed');
  });

  it('循环链解析不了的挂起', () => {
    const raw = {
      issues: [
        { id: 'a', status: 'open', canonicalId: 'b', fixNote: '', retestNote: '', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'b', status: 'open', canonicalId: 'a', fixNote: '', retestNote: '', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' }
      ],
      events: [],
      schemaVersion: 1
    };
    const state = migrate(raw);
    assert.ok(state.issues.every((i) => i.suspended));
    assert.ok(state.issues.every((i) => /循环/.test(i.suspendReason ?? '')));
  });

  it('主问题缺失的挂起', () => {
    const raw = {
      issues: [
        { id: 'a', status: 'open', canonicalId: 'gone', fixNote: '', retestNote: '', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' }
      ],
      events: [],
      schemaVersion: 1
    };
    const state = migrate(raw);
    assert.equal(state.issues[0].suspended, true);
    assert.match(state.issues[0].suspendReason ?? '', /不存在/);
  });
});

describe('重算中断后接着没算完的', () => {
  it('游标持久化：从断点继续，未处理的来源被压成一级', () => {
    const raw = {
      issues: [
        { id: 'x', status: 'open', fixNote: '', retestNote: '', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'y', status: 'open', canonicalId: 'x', fixNote: '', retestNote: 'y的结论', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'z', status: 'open', canonicalId: 'y', fixNote: '', retestNote: 'z的结论', version: 1, updatedAt: '2026-01-01T00:00:00.000Z' }
      ],
      events: [],
      schemaVersion: 2,
      recomputeCursor: 1
    };
    const state = migrate(raw);
    // 从游标 1 继续：y 指向 x，z 经 y 压成一级指向 x。
    assert.equal(state.issues.find((i) => i.id === 'y')!.canonicalId, 'x');
    assert.equal(state.issues.find((i) => i.id === 'z')!.canonicalId, 'x');
    assert.equal(state.issues.find((i) => i.id === 'z')!.retestNote, '');
    assert.equal(state.recomputeCursor, undefined);
  });

  it('recomputeStep 逐步推进并在完成后清游标', () => {
    const state = stateWith([
      issue({ id: 'a' }),
      issue({ id: 'b', canonicalId: 'a', status: 'open', retestNote: 'x' })
    ]);
    assert.equal(recomputeStep(state), 'continue');
    assert.equal(state.recomputeCursor, 1);
    assert.equal(recomputeStep(state), 'continue');
    assert.equal(state.issues.find((i) => i.id === 'b')!.status, 'merged');
    assert.equal(recomputeStep(state), 'done');
    assert.equal(state.recomputeCursor, undefined);
  });
});

describe('基础', () => {
  it('createIssue 带默认值', () => {
    const created = createIssue({ title: '标题至少四个字', flow: '流程', steps: '步骤', impactGroup: '影响人群', severity: 'minor' });
    assert.equal(created.status, 'open');
    assert.equal(created.version, 1);
    assert.equal(created.retestNote, '');
  });

  it('seedState 是合法的 v2 状态', () => {
    const state = seedState();
    assert.equal(state.schemaVersion, 2);
    assert.ok(state.issues.length >= 2);
    assert.equal(computeStats(state).total, state.issues.length);
  });
});
