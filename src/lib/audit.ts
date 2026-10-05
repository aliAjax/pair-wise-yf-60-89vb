/**
 * 重复合并 / 复测结论 / 概统计的核心逻辑。
 * 纯函数、框架无关：UI 直接操作 store，测试直接构造状态。
 *
 * 规则：
 * - 重复问题合并到主问题后，复测结论只对主问题生效，来源问题的结论作废。
 * - 概览的全部 / 待修复 / 待复测 / 已关闭只按主问题（无根问题）统计。
 * - 主问题状态一变，所有来源问题的复测结论作废并重算。
 * - 合并采用 compare-and-set：canonicalId 先到先得，后到的退回并说明。
 * - 合并做错可拆回：恢复合并前状态与最后一次复测结论。
 * - 旧数据只有一条主问题编号，升级时把链式合并压成一级、补齐来源关系；
 *   解析不了的挂起；重算游标持久化，中断后接着没算完的继续。
 */

export type IssueStatus =
  | 'open'
  | 'triaged'
  | 'fixing'
  | 'verifying'
  | 'closed'
  | 'reopened'
  | 'merged';

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

/** 合并时留存的来源问题快照，拆回时恢复。 */
export interface MergeSnapshot {
  status: IssueStatus;
  retestNote: string;
  mergedAt: string;
}

export interface AuditIssue {
  id: string;
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
  status: IssueStatus;
  /** 合并到哪个主问题；有值即为来源问题。 */
  canonicalId?: string;
  /** 合并前状态与最后一次复测结论，拆回时恢复。 */
  mergedSnapshot?: MergeSnapshot;
  /** 升级时合并链解析不了（循环 / 主问题缺失），挂起。 */
  suspended?: boolean;
  suspendReason?: string;
  /** 乐观锁版本号。 */
  version: number;
  fixNote: string;
  retestNote: string;
  updatedAt: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  issueId: string;
  message: string;
}

export interface WorkbenchState {
  issues: AuditIssue[];
  events: AuditEvent[];
  schemaVersion: number;
  /** 重算游标：升级 / 重算中断后从这里继续。 */
  recomputeCursor?: number;
}

export const STORAGE_KEY = 'a11y-audit-v1';
export const SCHEMA_VERSION = 2;

export const STATUS_LABELS: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开',
  merged: '已合并'
};

export const ACTIVE_STATUSES: IssueStatus[] = ['open', 'triaged', 'fixing', 'reopened'];

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function newId(): string {
  return crypto.randomUUID();
}

export function addEvent(state: WorkbenchState, issueId: string, message: string): void {
  state.events.unshift({ id: newId(), at: new Date().toISOString(), issueId, message });
}

export interface IssueInput {
  title: string;
  flow: string;
  steps: string;
  impactGroup: string;
  severity: Severity;
}

export function createIssue(input: IssueInput): AuditIssue {
  return {
    id: newId(),
    title: input.title,
    flow: input.flow,
    steps: input.steps,
    impactGroup: input.impactGroup,
    severity: input.severity,
    status: 'open',
    version: 1,
    fixNote: '',
    retestNote: '',
    updatedAt: new Date().toISOString()
  };
}

export type RootResolution =
  | { ok: true; root: AuditIssue }
  | { ok: false; reason: 'cycle' | 'missing' };

/** 沿 canonicalId 找根主问题，识别循环和缺失。 */
export function resolveRoot(issues: AuditIssue[], start: AuditIssue): RootResolution {
  const seen = new Set<string>();
  let current: AuditIssue | undefined = start;
  while (current?.canonicalId) {
    if (seen.has(current.id)) return { ok: false, reason: 'cycle' };
    seen.add(current.id);
    const next = issues.find((issue) => issue.id === current!.canonicalId);
    if (!next) return { ok: false, reason: 'missing' };
    current = next;
  }
  return current ? { ok: true, root: current } : { ok: false, reason: 'missing' };
}

export function isRoot(issue: AuditIssue): boolean {
  return !issue.canonicalId && !issue.suspended;
}

export function sourcesOf(state: WorkbenchState, rootId: string): AuditIssue[] {
  return state.issues.filter((issue) => issue.canonicalId === rootId);
}

export interface MergeSuccess {
  ok: true;
  canonical: AuditIssue;
  duplicate: AuditIssue;
}

export interface MergeFailure {
  ok: false;
  reason:
    | 'self'
    | 'source-suspended'
    | 'target-suspended'
    | 'already-merged'
    | 'target-missing'
    | 'version-conflict';
  message: string;
}

export type MergeResult = MergeSuccess | MergeFailure;

/**
 * 把来源问题合并到主问题。
 * compare-and-set：canonicalId 先到先得；后到的合并退回并说明原因。
 * expectedVersion 用于乐观锁：版本不一致说明问题已被其他人改动。
 */
export function mergeIssues(
  state: WorkbenchState,
  sourceId: string,
  targetId: string,
  expectedVersion?: number
): MergeResult {
  const source = state.issues.find((issue) => issue.id === sourceId);
  const target = state.issues.find((issue) => issue.id === targetId);
  if (!source || !target) {
    return { ok: false, reason: 'target-missing', message: '找不到要合并的问题，请刷新后重试' };
  }
  if (source.id === target.id) {
    return { ok: false, reason: 'self', message: '不能把问题合并到它自己' };
  }
  if (source.suspended) {
    return { ok: false, reason: 'source-suspended', message: '该问题处于挂起状态，不能合并' };
  }
  if (target.suspended) {
    return { ok: false, reason: 'target-suspended', message: '主问题处于挂起状态，不能作为合并目标' };
  }
  // 并发控制：先到的合并已经占上 canonicalId，后到的退回。
  if (source.canonicalId) {
    return { ok: false, reason: 'already-merged', message: '该问题已被其他审核员合并，本次合并已退回' };
  }
  if (expectedVersion !== undefined && source.version !== expectedVersion) {
    return { ok: false, reason: 'version-conflict', message: '该问题已被其他审核员修改，本次合并已退回，请刷新后重试' };
  }
  // 目标本身也是重复项时，顺链找到根主问题（链式合并压成一级）。
  const rootResolution = resolveRoot(state.issues, target);
  if (!rootResolution.ok) {
    return { ok: false, reason: 'target-missing', message: '主问题的合并链无法解析，本次合并已退回' };
  }
  const root = rootResolution.root;
  if (root.id === source.id) {
    return { ok: false, reason: 'self', message: '不能把问题合并到它自己' };
  }

  const now = new Date().toISOString();
  source.mergedSnapshot = {
    status: source.status,
    retestNote: source.retestNote,
    mergedAt: now
  };
  source.canonicalId = root.id;
  source.status = 'merged';
  source.retestNote = ''; // 复测结论作废，只保留主问题上的结论
  source.version += 1;
  source.updatedAt = now;

  addEvent(state, source.id, `重复问题已合并到主问题「${root.title}」，原状态与最后一次复测结论已留存，可随时拆回`);
  addEvent(state, root.id, `合并了重复问题「${source.title}」，复测结论只对本问题生效`);
  return { ok: true, canonical: root, duplicate: source };
}

export interface SplitSuccess {
  ok: true;
  issue: AuditIssue;
}

export interface SplitFailure {
  ok: false;
  reason: 'not-merged' | 'suspended';
  message: string;
}

export type SplitResult = SplitSuccess | SplitFailure;

/** 拆回独立问题，恢复合并前状态与最后一次复测结论。 */
export function splitIssue(state: WorkbenchState, sourceId: string): SplitResult {
  const source = state.issues.find((issue) => issue.id === sourceId);
  if (!source) {
    return { ok: false, reason: 'not-merged', message: '找不到问题' };
  }
  if (source.suspended) {
    return { ok: false, reason: 'suspended', message: '挂起的问题不能拆回' };
  }
  if (!source.canonicalId) {
    return { ok: false, reason: 'not-merged', message: '该问题不是重复合并状态，无需拆回' };
  }

  const now = new Date().toISOString();
  const restored = source.mergedSnapshot;
  const restoredStatus = restored?.status ?? 'open';
  source.canonicalId = undefined;
  source.mergedSnapshot = undefined;
  source.status = restoredStatus;
  source.retestNote = restored?.retestNote ?? '';
  source.version += 1;
  source.updatedAt = now;

  addEvent(state, source.id, `已拆回为独立问题，恢复合并前状态为「${STATUS_LABELS[restoredStatus]}」，最后一次复测结论已恢复`);
  return { ok: true, issue: source };
}

export type StatusPatch = Partial<Pick<AuditIssue, 'status' | 'fixNote' | 'retestNote'>>;

export type StatusResult =
  | { ok: true }
  | { ok: false; reason: 'merged' | 'suspended' | 'not-found'; message: string };

/**
 * 主问题状态流转。主问题状态一变，所有来源问题的复测结论作废并重算。
 * 来源问题不能直接流转状态。
 */
export function changeIssueStatus(
  state: WorkbenchState,
  issueId: string,
  patch: StatusPatch,
  message: string
): StatusResult {
  const issue = state.issues.find((item) => item.id === issueId);
  if (!issue) {
    return { ok: false, reason: 'not-found', message: '找不到问题' };
  }
  if (issue.suspended) {
    return { ok: false, reason: 'suspended', message: '挂起的问题不能流转状态' };
  }
  if (issue.canonicalId) {
    return { ok: false, reason: 'merged', message: '重复问题的状态以主问题为准，请在主问题上操作' };
  }

  const now = new Date().toISOString();
  if (patch.status) issue.status = patch.status;
  if (patch.fixNote !== undefined) issue.fixNote = patch.fixNote;
  if (patch.retestNote !== undefined) issue.retestNote = patch.retestNote;
  issue.version += 1;
  issue.updatedAt = now;
  addEvent(state, issue.id, message);

  // 主问题状态一变，来源问题的结论作废并重算。
  for (const source of sourcesOf(state, issue.id)) {
    source.retestNote = '';
    source.version += 1;
    source.updatedAt = now;
    addEvent(state, source.id, `主问题状态变更为「${STATUS_LABELS[issue.status]}」，本问题复测结论已作废，以主问题为准`);
  }
  return { ok: true };
}

export interface Stats {
  total: number;
  pendingFix: number;
  verifying: number;
  closed: number;
  suspended: number;
}

/** 概览统计：待复测 / 已关闭等只按主问题（无根问题）计算。 */
export function computeStats(state: WorkbenchState): Stats {
  const roots = state.issues.filter(isRoot);
  return {
    total: roots.length,
    pendingFix: roots.filter((issue) => ACTIVE_STATUSES.includes(issue.status)).length,
    verifying: roots.filter((issue) => issue.status === 'verifying').length,
    closed: roots.filter((issue) => issue.status === 'closed').length,
    suspended: state.issues.filter((issue) => issue.suspended).length
  };
}

/**
 * 重算单个问题（游标推进）。升级时把链式合并压成一级、补齐来源关系、
 * 作废来源结论；循环 / 主问题缺失的挂起。中断后下次从游标继续。
 */
export function recomputeStep(state: WorkbenchState): 'done' | 'continue' {
  const cursor = state.recomputeCursor ?? 0;
  if (cursor >= state.issues.length) {
    state.recomputeCursor = undefined;
    return 'done';
  }
  const issue = state.issues[cursor];
  if (issue.canonicalId) {
    const resolution = resolveRoot(state.issues, issue);
    if (!resolution.ok) {
      issue.suspended = true;
      issue.suspendReason =
        resolution.reason === 'cycle'
          ? '合并链存在循环，无法解析主问题'
          : '主问题不存在，合并链无法解析';
    } else {
      issue.canonicalId = resolution.root.id; // 链式合并压成一级
      if (!issue.mergedSnapshot) {
        // 旧数据没有留存快照，以当前状态与结论兜底，拆回时恢复。
        issue.mergedSnapshot = {
          status: issue.status,
          retestNote: issue.retestNote,
          mergedAt: issue.updatedAt
        };
      }
      issue.status = 'merged';
      issue.retestNote = ''; // 来源结论作废
      issue.suspended = false;
      issue.suspendReason = undefined;
    }
  }
  state.recomputeCursor = cursor + 1;
  return 'continue';
}

/** 从当前游标开始，把没算完的重算接着算完。 */
export function recomputeAll(state: WorkbenchState): void {
  let guard = 0;
  while (recomputeStep(state) === 'continue' && guard <= state.issues.length + 1) guard += 1;
}

function normalizeIssue(raw: Partial<AuditIssue>): AuditIssue {
  return {
    id: raw.id ?? newId(),
    title: raw.title ?? '未命名问题',
    flow: raw.flow ?? '',
    steps: raw.steps ?? '',
    impactGroup: raw.impactGroup ?? '',
    severity: raw.severity ?? 'moderate',
    status: raw.status ?? 'open',
    canonicalId: raw.canonicalId || undefined,
    mergedSnapshot: raw.mergedSnapshot,
    suspended: raw.suspended ?? false,
    suspendReason: raw.suspendReason,
    version: raw.version ?? 1,
    fixNote: raw.fixNote ?? '',
    retestNote: raw.retestNote ?? '',
    updatedAt: raw.updatedAt ?? new Date(0).toISOString()
  };
}

function isEvent(value: unknown): value is AuditEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AuditEvent).id === 'string' &&
    typeof (value as AuditEvent).issueId === 'string' &&
    typeof (value as AuditEvent).message === 'string'
  );
}

/** 升级旧数据 / 归一化状态；重算游标未完成时接着算。 */
export function migrate(raw: unknown): WorkbenchState {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorkbenchState>;
  const needsUpgrade = !obj.schemaVersion || obj.schemaVersion < SCHEMA_VERSION;
  const state: WorkbenchState = {
    issues: Array.isArray(obj.issues) ? obj.issues.map((issue) => normalizeIssue(issue as Partial<AuditIssue>)) : [],
    events: Array.isArray(obj.events) ? (obj.events as unknown[]).filter(isEvent) : [],
    schemaVersion: SCHEMA_VERSION,
    recomputeCursor: needsUpgrade ? 0 : obj.recomputeCursor
  };
  recomputeAll(state);
  return state;
}

export function seedState(): WorkbenchState {
  const state: WorkbenchState = {
    issues: [
      {
        id: 'issue-1',
        title: '结算弹窗关闭后焦点丢失',
        flow: '订单结算',
        steps: '1. 打开结算弹窗\n2. 按 Esc 关闭\n3. 按 Tab 检查焦点',
        impactGroup: '键盘与读屏用户',
        severity: 'serious',
        status: 'triaged',
        version: 1,
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
        version: 1,
        fixNote: '已增加 aria-describedby，等待构建',
        retestNote: '',
        updatedAt: new Date(Date.now() - 7200_000).toISOString()
      }
    ],
    events: [
      { id: 'e-1', at: new Date(Date.now() - 3600_000).toISOString(), issueId: 'issue-1', message: '审核员确认问题有效并进入修复中' },
      { id: 'e-2', at: new Date(Date.now() - 7000_000).toISOString(), issueId: 'issue-2', message: '开发人员提交焦点管理修复' }
    ],
    schemaVersion: SCHEMA_VERSION
  };
  return migrate(state);
}

export function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return seedState();
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (!text) return seedState();
    const state = migrate(JSON.parse(text));
    saveState(state);
    return state;
  } catch {
    return seedState();
  }
}

export function saveState(state: WorkbenchState): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 存储不可用时静默失败，不影响协作流程。
  }
}

export { clone };
