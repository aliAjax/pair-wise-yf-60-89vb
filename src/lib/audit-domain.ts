// 审计问题领域核心：问题、合并关系、复测结论、概览统计、旧数据升级。
// 所有命令都在传入的 state 上原地修改（配合 Solid produce 使用），
// 纯数据、无 DOM 依赖，便于单测与断点续算。

export type IssueStatus = 'open' | 'triaged' | 'fixing' | 'verifying' | 'closed' | 'reopened';
export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
export type RetestVerdict = 'pass' | 'fail';

export const TERMINAL_STATUSES: IssueStatus[] = ['closed', 'reopened'];

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  // 独立问题：自身实时状态；来源问题：合并时冻结的原状态（拆回时恢复）
  status: IssueStatus;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
  // 旧版（v1）数据的唯一合并字段，升级后删除，以 merges 关系为准
  canonicalId?: string;
  suspended?: boolean;
  suspendReason?: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
  actor?: string;
}

// kind: own=本问题自身复测结论; derived=由主问题同步给来源问题的影子结论; restored=拆回后恢复的历史结论
export interface RetestConclusion {
  id: string;
  issueId: string;
  verdict: RetestVerdict;
  note: string;
  at: string;
  kind: 'own' | 'derived' | 'restored';
  status: 'active' | 'superseded' | 'voided';
  canonicalId?: string; // derived：所属主问题
  derivedFromConclusionId?: string; // derived：来源的主问题结论 id
  voidReason?: string;
  voidedAt?: string;
}

export interface MergeSnapshot {
  status: IssueStatus;
  retestNote: string;
  verdict: { verdict: RetestVerdict; note: string; at: string } | null;
}

export interface MergeRelation {
  id: string;
  sourceId: string;
  canonicalId: string;
  mergedAt: string;
  mergedBy: string;
  status: 'active' | 'undone';
  snapshot: MergeSnapshot;
  undoneAt?: string;
  undoneBy?: string;
}

export interface RecomputeJob {
  id: string;
  canonicalId: string;
  trigger: string;
  remainingSourceIds: string[]; // 断点：剩余未重算的来源问题
  createdAt: string;
}

export interface MigrationPlanItem {
  sourceId: string;
  canonicalId: string | null; // null 表示无法归并，需要挂起
  reason: string | null;
}

export interface MigrationState {
  status: 'running' | 'done';
  pending: MigrationPlanItem[];
  total: number;
  processed: number;
  suspendedIssueIds: string[];
  finalizedAt?: string;
}

export interface WorkbenchState {
  version: 2;
  rev: number; // 乐观并发版本号，每次提交 +1
  issues: AuditIssue[];
  merges: MergeRelation[];
  conclusions: RetestConclusion[];
  events: AuditEvent[];
  jobs: RecomputeJob[];
  migration: MigrationState;
}

export const STATE_VERSION = 2;
export const STORAGE_KEY = 'a11y-audit-v2';
export const LEGACY_STORAGE_KEY = 'a11y-audit-v1';

export interface Deps {
  now: () => string;
  id: () => string;
}

const defaultDeps: Deps = {
  now: () => new Date().toISOString(),
  id: () => (globalThis.crypto?.randomUUID?.() ?? `id-${Math.random().toString(36).slice(2)}`)
};

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type CommandResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string };

// ---------- 查询 ----------

export const getIssue = (state: WorkbenchState, id: string) => state.issues.find((i) => i.id === id);

export function activeMergeForSource(state: WorkbenchState, sourceId: string): MergeRelation | undefined {
  return state.merges.find((m) => m.status === 'active' && m.sourceId === sourceId);
}

export function activeMergesInto(state: WorkbenchState, canonicalId: string): MergeRelation[] {
  return state.merges.filter((m) => m.status === 'active' && m.canonicalId === canonicalId);
}

export function isSuspended(issue: AuditIssue): boolean {
  return issue.suspended === true;
}

/** 主问题/独立问题：未挂起、且不是任何有效合并关系的来源方 */
export function isPrimary(state: WorkbenchState, issue: AuditIssue): boolean {
  return !isSuspended(issue) && !activeMergeForSource(state, issue.id);
}

export type IssueKind = 'primary' | 'source' | 'suspended';

export interface IssueView {
  issue: AuditIssue;
  kind: IssueKind;
  canonical?: AuditIssue;
  relation?: MergeRelation;
  effectiveStatus: IssueStatus;
  effectiveConclusion?: RetestConclusion;
}

const lastActive = (conclusions: RetestConclusion[], issueId: string, kind: RetestConclusion['kind']) =>
  [...conclusions]
    .filter((c) => c.issueId === issueId && c.kind === kind && c.status === 'active')
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];

export const lastOwnConclusion = (state: WorkbenchState, issueId: string) =>
  [...state.conclusions]
    .filter((c) => c.issueId === issueId && c.kind !== 'derived' && c.status === 'active')
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];

export function getView(state: WorkbenchState, issueId: string): IssueView | undefined {
  const issue = getIssue(state, issueId);
  if (!issue) return undefined;
  if (isSuspended(issue)) {
    return { issue, kind: 'suspended', effectiveStatus: issue.status };
  }
  const relation = activeMergeForSource(state, issue.id);
  if (!relation) {
    return { issue, kind: 'primary', effectiveStatus: issue.status, effectiveConclusion: lastOwnConclusion(state, issue.id) };
  }
  const canonical = getIssue(state, relation.canonicalId);
  const derived = [...state.conclusions]
    .filter((c) => c.issueId === issue.id && c.kind === 'derived' && c.status === 'active' && c.canonicalId === relation.canonicalId)
    .sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  return {
    issue,
    kind: 'source',
    relation,
    canonical,
    // 来源问题的状态与结论一律以主问题为准；自身字段保持冻结快照
    effectiveStatus: canonical?.status ?? relation.snapshot.status,
    effectiveConclusion: derived
  };
}

export interface OverviewStats {
  total: number;
  toFix: number;
  verifying: number;
  closed: number;
  sources: number;
  suspended: number;
  recomputePending: number;
}

/** 概览统计：待复测、已关闭等一律只按主问题/独立问题计算，来源问题与挂起问题不计入 */
export function computeStats(state: WorkbenchState): OverviewStats {
  const primaries = state.issues.filter((i) => isPrimary(state, i));
  return {
    total: primaries.length,
    toFix: primaries.filter((i) => ['open', 'triaged', 'fixing', 'reopened'].includes(i.status)).length,
    verifying: primaries.filter((i) => i.status === 'verifying').length,
    closed: primaries.filter((i) => i.status === 'closed').length,
    sources: state.issues.filter((i) => !isSuspended(i) && activeMergeForSource(state, i.id)).length,
    suspended: state.issues.filter(isSuspended).length,
    recomputePending: state.jobs.reduce((n, job) => n + job.remainingSourceIds.length, 0)
  };
}

// ---------- 事件与基础变更 ----------

export function appendEvent(state: WorkbenchState, issueId: string, message: string, actor?: string): void {
  state.events.unshift({ id: defaultDeps.id(), at: defaultDeps.now(), issueId, message, actor });
}

export function createIssue(
  state: WorkbenchState,
  values: Pick<AuditIssue, 'title' | 'flow' | 'steps' | 'impactGroup' | 'severity'>
): AuditIssue {
  const issue: AuditIssue = {
    id: defaultDeps.id(),
    ...values,
    status: 'open',
    fixNote: '',
    retestNote: '',
    updatedAt: defaultDeps.now()
  };
  state.issues.unshift(issue);
  state.rev += 1;
  appendEvent(state, issue.id, '审计员创建问题并保存证据');
  return issue;
}

// ---------- 合并（先到先得的并发控制） ----------

export interface MergeRequest {
  sourceId: string;
  canonicalId: string;
  reviewer: string;
  at: string;
  baseRev: number;
}

function validateMerge(state: WorkbenchState, sourceId: string, canonicalId: string): CommandResult<{ source: AuditIssue; canonical: AuditIssue }> {
  const source = getIssue(state, sourceId);
  const canonical = getIssue(state, canonicalId);
  if (!source) return { ok: false, code: 'SOURCE_NOT_FOUND', message: '来源问题不存在，无法合并' };
  if (!canonical) return { ok: false, code: 'CANONICAL_NOT_FOUND', message: '主问题不存在，无法合并' };
  if (source.id === canonical.id) return { ok: false, code: 'SAME_ISSUE', message: '不能把问题合并到自身' };
  if (isSuspended(source)) return { ok: false, code: 'SOURCE_SUSPENDED', message: `来源问题《${source.title}》已挂起，不能合并` };
  if (isSuspended(canonical)) return { ok: false, code: 'CANONICAL_SUSPENDED', message: `主问题《${canonical.title}》已挂起，不能合并` };
  const existing = activeMergeForSource(state, source.id);
  if (existing) {
    const otherCanonical = getIssue(state, existing.canonicalId);
    return {
      ok: false,
      code: 'SOURCE_ALREADY_MERGED',
      message:
        `来源问题《${source.title}》已由「${existing.mergedBy}」先合并到主问题` +
        `《${otherCanonical?.title ?? existing.canonicalId}》，您本次提交退回，不产生合并关系。`
    };
  }
  // 目标自身是来源问题 => 会形成链式合并，拒绝（链只允许在旧数据升级时被压平）
  const targetAsSource = activeMergeForSource(state, canonical.id);
  if (targetAsSource) {
    return {
      ok: false,
      code: 'CANONICAL_IS_SOURCE',
      message: `《${canonical.title}》当前是其他问题的来源，不能作为主问题接收合并（避免链式合并）`
    };
  }
  return { ok: true, value: { source, canonical } };
}

/** 两名审核员可同时准备请求；是否生效以 commit 时的最新状态为准 */
export function prepareMerge(state: WorkbenchState, input: Omit<MergeRequest, 'at' | 'baseRev'>): CommandResult<MergeRequest> {
  const checked = validateMerge(state, input.sourceId, input.canonicalId);
  if (!checked.ok) return checked;
  return {
    ok: true,
    value: { sourceId: input.sourceId, canonicalId: input.canonicalId, reviewer: input.reviewer || '审核员', at: defaultDeps.now(), baseRev: state.rev }
  };
}

export function commitMerge(state: WorkbenchState, request: MergeRequest, deps: Deps = defaultDeps): CommandResult<MergeRelation> {
  // 提交时重新校验：先到的合并已落库，后到的在这里被退回并拿到原因
  const checked = validateMerge(state, request.sourceId, request.canonicalId);
  if (!checked.ok) return checked;
  if (state.rev !== request.baseRev) {
    const existing = activeMergeForSource(state, request.sourceId);
    if (existing) {
      const other = getIssue(state, existing.canonicalId);
      return {
        ok: false,
        code: 'CONFLICT_SOURCE_TAKEN',
        message:
          `提交冲突：来源问题已被「${existing.mergedBy}」先合并到《${other?.title ?? existing.canonicalId}》，` +
          `「${request.reviewer}」后到的合并已退回。`
      };
    }
  }
  const { source, canonical } = checked.value;
  const ownAtMerge = lastOwnConclusion(state, source.id);
  const relation: MergeRelation = {
    id: deps.id(),
    sourceId: source.id,
    canonicalId: canonical.id,
    mergedAt: request.at,
    mergedBy: request.reviewer,
    status: 'active',
    snapshot: {
      status: source.status,
      retestNote: source.retestNote,
      verdict: ownAtMerge ? { verdict: ownAtMerge.verdict, note: ownAtMerge.note, at: ownAtMerge.at } : null
    }
  };
  state.merges.push(relation);
  state.rev += 1;
  appendEvent(state, source.id, `重复问题已合并到主问题《${canonical.title}》；复测结论将只跟随主问题`, request.reviewer);
  appendEvent(state, canonical.id, `「${request.reviewer}」把重复问题《${source.title}》合并进来`, request.reviewer);
  // 新来源立即纳入结论重算（主问题当前若已有终态结论，会同步一份影子结论）
  enqueueRecompute(state, canonical.id, `merge:${source.id}`, deps);
  return { ok: true, value: relation };
}

/** 拆回独立问题：关系作废，恢复来源原来的状态与最后一次结论 */
export function unmerge(state: WorkbenchState, sourceId: string, actor = '审核员', deps: Deps = defaultDeps): CommandResult<MergeRelation> {
  const relation = activeMergeForSource(state, sourceId);
  if (!relation) return { ok: false, code: 'NOT_MERGED', message: '该问题当前不是任何主问题的来源，无需拆回' };
  const source = getIssue(state, sourceId);
  const canonical = getIssue(state, relation.canonicalId);
  relation.status = 'undone';
  relation.undoneAt = deps.now();
  relation.undoneBy = actor;

  // 主问题同步过来的影子结论全部作废
  for (const c of state.conclusions) {
    if (c.issueId === sourceId && c.kind === 'derived' && c.status === 'active') {
      c.status = 'voided';
      c.voidedAt = deps.now();
      c.voidReason = 'merge-undone';
    }
  }
  // 从重算队列里摘掉该来源
  for (const job of state.jobs) job.remainingSourceIds = job.remainingSourceIds.filter((id) => id !== sourceId);
  state.jobs = state.jobs.filter((job) => job.remainingSourceIds.length > 0);

  if (source) {
    source.status = relation.snapshot.status;
    source.retestNote = relation.snapshot.retestNote;
    source.updatedAt = deps.now();
    // 历史自身结论在合并期间保留不动；若没有（如旧数据升级而来），按快照补恢复一条
    if (relation.snapshot.verdict && !lastOwnConclusion(state, sourceId)) {
      const v = relation.snapshot.verdict;
      state.conclusions.push({
        id: deps.id(),
        issueId: sourceId,
        verdict: v.verdict,
        note: v.note,
        at: v.at,
        kind: 'restored',
        status: 'active'
      });
    }
  }
  state.rev += 1;
  appendEvent(state, sourceId, `合并已拆回，恢复为独立问题，原状态「${relation.snapshot.status}」与最后一次复测结论已恢复`, actor);
  if (canonical) appendEvent(state, canonical.id, `重复问题《${source?.title ?? sourceId}》已拆回独立问题`, actor);
  return { ok: true, value: relation };
}

// ---------- 复测结论（只对主问题生效）+ 断点重算 ----------

/** 复测操作目标解析：在来源问题上复测时，结论记到主问题 */
export function resolveRetestTarget(state: WorkbenchState, issueId: string): AuditIssue | undefined {
  const issue = getIssue(state, issueId);
  if (!issue || isSuspended(issue)) return undefined;
  const relation = activeMergeForSource(state, issueId);
  return relation ? getIssue(state, relation.canonicalId) : issue;
}

export function enqueueRecompute(state: WorkbenchState, canonicalId: string, trigger: string, deps: Deps = defaultDeps): void {
  const sourceIds = activeMergesInto(state, canonicalId).map((m) => m.sourceId);
  if (sourceIds.length === 0) return;
  // 同一主问题已排队则并入（去重），避免重复作废/生成
  const existing = state.jobs.find((j) => j.canonicalId === canonicalId);
  if (existing) {
    const merged = [...existing.remainingSourceIds];
    for (const id of sourceIds) if (!merged.includes(id)) merged.push(id);
    existing.remainingSourceIds = merged;
    existing.trigger = trigger;
    return;
  }
  state.jobs.push({ id: deps.id(), canonicalId, trigger, remainingSourceIds: sourceIds, createdAt: deps.now() });
}

/** 跑一小批重算，返回本次处理条数；中断后再次调用会从 remainingSourceIds 继续 */
export function runRecomputeTick(state: WorkbenchState, batchSize = 1, deps: Deps = defaultDeps): number {
  let budget = Math.max(1, batchSize);
  let processed = 0;
  while (budget > 0 && state.jobs.length > 0) {
    const job = state.jobs[0];
    const canonical = getIssue(state, job.canonicalId);
    const take = Math.min(budget, job.remainingSourceIds.length);
    const batch = job.remainingSourceIds.slice(0, take);
    job.remainingSourceIds = job.remainingSourceIds.slice(take);
    for (const sourceId of batch) {
      // 主问题状态一变，来源问题此前同步的结论一律作废
      for (const c of state.conclusions) {
        if (c.issueId === sourceId && c.kind === 'derived' && c.status === 'active' && c.canonicalId === job.canonicalId) {
          c.status = 'voided';
          c.voidedAt = deps.now();
          c.voidReason = `canonical-changed:${job.trigger}`;
        }
      }
      // 再按主问题当前状态与最新自身结论重算；非终态不下发结论（作废后保持空）
      const own = canonical ? lastOwnConclusion(state, canonical.id) : undefined;
      const terminalMatch =
        canonical && own && ((canonical.status === 'closed' && own.verdict === 'pass') || (canonical.status === 'reopened' && own.verdict === 'fail'));
      if (canonical && own && terminalMatch) {
        state.conclusions.push({
          id: deps.id(),
          issueId: sourceId,
          canonicalId: canonical.id,
          derivedFromConclusionId: own.id,
          verdict: own.verdict,
          note: own.note,
          at: deps.now(),
          kind: 'derived',
          status: 'active'
        });
      }
    }
    processed += take;
    budget -= take;
    if (job.remainingSourceIds.length === 0) state.jobs.shift();
  }
  return processed;
}

export function transitionStatus(
  state: WorkbenchState,
  input: { issueId: string; status: IssueStatus; fixNote?: string; message: string; actor?: string },
  deps: Deps = defaultDeps
): CommandResult<AuditIssue> {
  const issue = getIssue(state, input.issueId);
  if (!issue) return { ok: false, code: 'NOT_FOUND', message: '问题不存在' };
  if (isSuspended(issue)) return { ok: false, code: 'SUSPENDED', message: '问题已挂起，暂不能流转' };
  const relation = activeMergeForSource(state, input.issueId);
  if (relation) {
    const canonical = getIssue(state, relation.canonicalId);
    return {
      ok: false,
      code: 'SOURCE_LOCKED',
      message: `该问题已合并到主问题《${canonical?.title ?? relation.canonicalId}》，状态只能在主问题上变更`
    };
  }
  issue.status = input.status;
  if (input.fixNote !== undefined) issue.fixNote = input.fixNote;
  issue.updatedAt = deps.now();
  state.rev += 1;
  appendEvent(state, issue.id, input.message, input.actor);
  // 主问题状态一变：来源结论作废并重算（重算为断点任务，中断可续）
  if (activeMergesInto(state, issue.id).length > 0) enqueueRecompute(state, issue.id, `status:${input.status}`, deps);
  return { ok: true, value: issue };
}

export function submitRetest(
  state: WorkbenchState,
  input: { issueId: string; verdict: RetestVerdict; note: string; actor?: string },
  deps: Deps = defaultDeps
): CommandResult<{ canonical: AuditIssue; conclusion: RetestConclusion }> {
  const target = resolveRetestTarget(state, input.issueId);
  const requested = getIssue(state, input.issueId);
  if (!target || !requested) return { ok: false, code: 'NOT_FOUND', message: '问题不存在' };
  if (isSuspended(target)) return { ok: false, code: 'SUSPENDED', message: '主问题已挂起，不能提交复测结论' };

  for (const old of state.conclusions) {
    if (old.issueId === target.id && old.kind !== 'derived' && old.status === 'active') old.status = 'superseded';
  }
  const conclusion: RetestConclusion = {
    id: deps.id(),
    issueId: target.id,
    verdict: input.verdict,
    note: input.note,
    at: deps.now(),
    kind: 'own',
    status: 'active'
  };
  state.conclusions.push(conclusion);
  target.status = input.verdict === 'pass' ? 'closed' : 'reopened';
  target.retestNote = input.note;
  target.updatedAt = deps.now();
  state.rev += 1;

  const redirected = target.id !== input.issueId;
  appendEvent(
    state,
    target.id,
    input.verdict === 'pass' ? `复测通过并关闭主问题：${input.note}` : `复测失败并重新打开主问题：${input.note}`,
    input.actor
  );
  if (redirected) {
    appendEvent(state, input.issueId, `复测结论由来源问题提交，按规则只对主问题《${target.title}》生效`, input.actor);
  }
  if (activeMergesInto(state, target.id).length > 0) enqueueRecompute(state, target.id, `retest:${input.verdict}`, deps);
  return { ok: true, value: { canonical: target, conclusion } };
}

// ---------- 旧数据（v1：只有一条主问题编号）升级 ----------

interface LegacyState {
  issues?: AuditIssue[];
  events?: AuditEvent[];
}

/** 解析单条 canonicalId 链：压成一级；环 / 目标缺失则返回挂起原因 */
function resolveLegacyChain(issues: AuditIssue[], start: AuditIssue): MigrationPlanItem {
  const seen = new Set<string>([start.id]);
  let current = start;
  while (current.canonicalId) {
    const nextId = current.canonicalId;
    if (seen.has(nextId)) {
      return { sourceId: start.id, canonicalId: null, reason: `链式合并存在环（${nextId}），无法判定主问题` };
    }
    const next = issues.find((i) => i.id === nextId);
    if (!next) {
      return { sourceId: start.id, canonicalId: null, reason: `主问题编号 ${nextId} 不存在` };
    }
    seen.add(next.id);
    current = next;
  }
  if (current.id === start.id) return { sourceId: start.id, canonicalId: null, reason: '未能解析出主问题' };
  return { sourceId: start.id, canonicalId: current.id, reason: null };
}

function emptyMigration(): MigrationState {
  return { status: 'done', pending: [], total: 0, processed: 0, suspendedIssueIds: [] };
}

export function buildMigrationPlan(issues: AuditIssue[]): MigrationPlanItem[] {
  const items: MigrationPlanItem[] = [];
  for (const issue of issues) {
    if (issue.canonicalId) items.push(resolveLegacyChain(issues, issue));
  }
  return items;
}

/** 把任意历史存储内容升级为 v2；v1 数据返回 running 的迁移状态，随后用 runMigrationTick 分批续跑 */
export function upgrade(raw: unknown): WorkbenchState {
  const data = (raw ?? null) as LegacyState | WorkbenchState | null;
  if (data && typeof data === 'object' && (data as WorkbenchState).version === 2) {
    return normalizeV2(data as WorkbenchState);
  }
  const issues: AuditIssue[] = Array.isArray((data as LegacyState | null)?.issues)
    ? (data as LegacyState).issues!.map((i) => ({ ...i }))
    : [];
  const events: AuditEvent[] = Array.isArray((data as LegacyState | null)?.events) ? (data as LegacyState).events!.map((e) => ({ ...e })) : [];
  const plan = buildMigrationPlan(issues);
  for (const issue of issues) delete issue.canonicalId;
  return {
    version: 2,
    rev: 1,
    issues,
    merges: [],
    conclusions: [],
    events,
    jobs: [],
    migration: { status: plan.length === 0 ? 'done' : 'running', pending: plan, total: plan.length, processed: 0, suspendedIssueIds: [] }
  };
}

function normalizeV2(data: WorkbenchState): WorkbenchState {
  return {
    version: 2,
    rev: typeof data.rev === 'number' ? data.rev : 1,
    issues: data.issues ?? [],
    merges: data.merges ?? [],
    conclusions: data.conclusions ?? [],
    events: data.events ?? [],
    jobs: data.jobs ?? [],
    migration: data.migration ?? emptyMigration()
  };
}

function legacyVerdict(issue: AuditIssue): MergeSnapshot['verdict'] {
  if (issue.status === 'closed') return { verdict: 'pass', note: issue.retestNote || '历史数据：复测通过', at: issue.updatedAt };
  if (issue.status === 'reopened') return { verdict: 'fail', note: issue.retestNote || '历史数据：复测失败', at: issue.updatedAt };
  return null;
}

/** 迁移一小批：链式关系压成一级并补齐来源关系；分不完的挂起。返回本次处理条数，可断点续跑 */
export function runMigrationTick(state: WorkbenchState, batchSize = 1, deps: Deps = defaultDeps): number {
  if (state.migration.status === 'done') return 0;
  const take = Math.min(Math.max(1, batchSize), state.migration.pending.length);
  const items = state.migration.pending.splice(0, take);
  for (const item of items) {
    const source = getIssue(state, item.sourceId);
    state.migration.processed += 1;
    if (!source || !item.canonicalId) {
      if (source) {
        source.suspended = true;
        source.suspendReason = item.reason ?? '主问题无法确定';
      }
      if (!state.migration.suspendedIssueIds.includes(item.sourceId)) state.migration.suspendedIssueIds.push(item.sourceId);
      appendEvent(state, item.sourceId, `旧数据升级挂起：${item.reason ?? '主问题无法确定'}`);
      continue;
    }
    const canonical = getIssue(state, item.canonicalId);
    if (!canonical || canonical.suspended) {
      if (source) {
        source.suspended = true;
        source.suspendReason = '主问题已挂起或不存在';
      }
      if (!state.migration.suspendedIssueIds.includes(item.sourceId)) state.migration.suspendedIssueIds.push(item.sourceId);
      continue;
    }
    // 幂等：断点重跑时同一来源只建一条 active 关系
    if (!activeMergeForSource(state, item.sourceId)) {
      state.merges.push({
        id: deps.id(),
        sourceId: item.sourceId,
        canonicalId: item.canonicalId,
        mergedAt: source.updatedAt || deps.now(),
        mergedBy: '系统升级',
        status: 'active',
        snapshot: { status: source.status, retestNote: source.retestNote, verdict: legacyVerdict(source) }
      });
    }
  }
  if (state.migration.pending.length === 0) finalizeMigration(state, deps);
  return take;
}

/** 迁移收尾：为主问题补历史自身结论，并把来源结论重算任务入队（同样断点可续） */
export function finalizeMigration(state: WorkbenchState, deps: Deps = defaultDeps): void {
  if (state.migration.status === 'done') return;
  const canonicalIds = Array.from(new Set(state.merges.filter((m) => m.status === 'active').map((m) => m.canonicalId)));
  for (const canonicalId of canonicalIds) {
    const canonical = getIssue(state, canonicalId);
    if (!canonical) continue;
    const verdict = legacyVerdict(canonical);
    if (verdict && !state.conclusions.some((c) => c.issueId === canonicalId && c.kind !== 'derived')) {
      state.conclusions.push({
        id: deps.id(),
        issueId: canonicalId,
        verdict: verdict.verdict,
        note: verdict.note,
        at: verdict.at,
        kind: 'own',
        status: 'active'
      });
    }
    enqueueRecompute(state, canonicalId, 'migration-backfill', deps);
  }
  state.migration.status = 'done';
  state.migration.finalizedAt = deps.now();
}

// ---------- 初始数据 ----------

export function createInitialState(deps: Deps = defaultDeps): WorkbenchState {
  const issues: AuditIssue[] = [
    {
      id: 'issue-1',
      title: '结算弹窗关闭后焦点丢失',
      flow: '订单结算',
      steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
      impactGroup: '键盘与读屏用户',
      severity: 'serious',
      status: 'triaged',
      fixNote: '',
      retestNote: '',
      updatedAt: new Date(Date.now() - 3600_000).toISOString()
    },
    {
      id: 'issue-2',
      title: '错误提示未与输入框关联',
      flow: '账户设置',
      steps: '输入无效手机号后使用读屏读取输入框',
      impactGroup: '读屏用户',
      severity: 'moderate',
      status: 'fixing',
      fixNote: '已增加 aria-describedby，等待构建',
      retestNote: '',
      updatedAt: new Date(Date.now() - 7200_000).toISOString()
    }
  ];
  return {
    version: 2,
    rev: 1,
    issues,
    merges: [],
    conclusions: [],
    events: [
      { id: deps.id(), at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
      { id: deps.id(), at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
    ],
    jobs: [],
    migration: emptyMigration()
  };
}
