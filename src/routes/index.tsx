import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore } from 'solid-js/store';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  STORAGE_KEY,
  STATUS_LABELS,
  addEvent,
  changeIssueStatus,
  computeStats,
  createIssue,
  loadState,
  mergeIssues,
  migrate,
  saveState,
  splitIssue,
  sourcesOf,
  type IssueStatus,
  type StatusPatch,
  type WorkbenchState
} from '~/lib/audit';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({
    title: '无障碍人工审计协作工作台',
    subtitle: '问题、修复与复测协作',
    issues: '审计问题',
    merge: '重复合并',
    events: '操作时间线',
    shortcutHint: '快捷键 N 聚焦新建问题，Ctrl+Enter 提交',
    statsTotal: '全部问题',
    statsFixing: '待修复',
    statsVerifying: '待复测',
    statsClosed: '已关闭',
    statsSuspended: '挂起',
    syncOk: '同步正常',
    syncing: '同步中',
    mergedBadge: '已合并',
    suspendedBadge: '挂起',
    sourceVoidBadge: '结论已作废',
    detailTitle: '问题详情与状态流转',
    noIssues: '暂无审计问题。',
    stepsLabel: '复现步骤',
    fixNoteLabel: '修复记录',
    retestNoteLabel: '复测记录',
    none: '尚未填写',
    statusActions: '问题状态操作',
    confirmIssue: '确认问题',
    startFix: '开始修复',
    submitRetest: '提交复测',
    passRetest: '复测通过',
    failRetest: '复测失败',
    mergeIntoLabel: '合并到主问题',
    mergeSelectPlaceholder: '选择主问题',
    mergeConfirm: '确认重复合并',
    merging: '合并中…',
    mergeRejectedTitle: '本次合并已退回',
    sourcesTitle: '已合并的重复问题',
    sourceVoidNote: '复测结论已作废，以主问题为准',
    splitButton: '拆回独立问题',
    splitConfirm: '拆回后将恢复该问题原来的状态和最后一次复测结论，确认拆回？',
    mergedBanner: '该问题已作为重复项合并到主问题，复测结论只对主问题生效，来源问题的结论已作废。',
    viewCanonical: '查看主问题',
    suspendedBanner: '升级时该问题的合并链无法解析，已挂起，不能流转或合并。',
    suspendReason: '挂起原因',
    originalStatus: '合并前状态',
    mergedAt: '合并时间',
    newIssueTitle: '新建审计问题',
    activityTab: '操作记录',
    keyboardTab: '键盘说明',
    keyboardN: '聚焦新建问题标题',
    keyboardTab2: '按可见顺序移动焦点',
    keyboardCtrl: '表单支持键盘提交',
    keyboardErrors: '所有错误消息使用 role="alert" 并通过描述关系关联字段'
  }),
  en: flatten({
    title: 'Accessibility Audit Workbench',
    subtitle: 'Issues, fixes and retesting',
    issues: 'Audit issues',
    merge: 'Duplicate merge',
    events: 'Activity timeline',
    shortcutHint: 'Press N to focus the new issue form, Ctrl+Enter to submit',
    statsTotal: 'All issues',
    statsFixing: 'Pending fix',
    statsVerifying: 'Pending retest',
    statsClosed: 'Closed',
    statsSuspended: 'Suspended',
    syncOk: 'Synced',
    syncing: 'Syncing',
    mergedBadge: 'Merged',
    suspendedBadge: 'Suspended',
    sourceVoidBadge: 'Conclusion void',
    detailTitle: 'Issue details and status flow',
    noIssues: 'No audit issues yet.',
    stepsLabel: 'Steps to reproduce',
    fixNoteLabel: 'Fix note',
    retestNoteLabel: 'Retest note',
    none: 'Not filled in',
    statusActions: 'Issue status actions',
    confirmIssue: 'Confirm issue',
    startFix: 'Start fixing',
    submitRetest: 'Submit for retest',
    passRetest: 'Pass retest',
    failRetest: 'Retest failed',
    mergeIntoLabel: 'Merge into main issue',
    mergeSelectPlaceholder: 'Select main issue',
    mergeConfirm: 'Confirm duplicate merge',
    merging: 'Merging…',
    mergeRejectedTitle: 'Merge rejected',
    sourcesTitle: 'Merged duplicates',
    sourceVoidNote: 'Retest conclusion voided; the main issue is authoritative',
    splitButton: 'Split back to standalone issue',
    splitConfirm: 'Splitting restores the original status and last retest conclusion. Continue?',
    mergedBanner: 'This issue was merged as a duplicate. Retest conclusions apply to the main issue only; source conclusions are voided.',
    viewCanonical: 'View main issue',
    suspendedBanner: 'This issue could not be resolved during the merge-chain upgrade and is suspended; it cannot flow or be merged.',
    suspendReason: 'Suspend reason',
    originalStatus: 'Status before merge',
    mergedAt: 'Merged at',
    newIssueTitle: 'New audit issue',
    activityTab: 'Activity',
    keyboardTab: 'Keyboard',
    keyboardN: 'Focus new issue title',
    keyboardTab2: 'Move focus in visible order',
    keyboardCtrl: 'Submit forms with the keyboard',
    keyboardErrors: 'All errors use role="alert" and are associated via descriptions'
  })
};

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [mergeError, setMergeError] = createSignal('');
  const [merging, setMerging] = createSignal(false);
  const [focusedIssueId, setFocusedIssueId] = createSignal('');

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const selected = createMemo(() => state.issues.find((issue) => issue.id === selectedId()) ?? state.issues[0]);
  const stats = createMemo(() => computeStats(state));
  const roots = createMemo(() => state.issues.filter((issue) => !issue.canonicalId));
  const suspendedIssues = createMemo(() => state.issues.filter((issue) => issue.suspended));

  createEffect(() => {
    saveState(state);
  });

  // 跨标签页同步：另一位审核员提交合并后本页状态刷新，
  // 这样后到的合并才会被 canonicalId 的比较并交换挡住。
  onMount(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        setState(migrate(JSON.parse(event.newValue)));
      } catch {
        // 损坏数据忽略，不覆盖当前状态。
      }
    };
    window.addEventListener('storage', onStorage);
    onCleanup(() => window.removeEventListener('storage', onStorage));
  });

  const submitCreate = (values: IssueForm) => {
    const issue = createIssue(values);
    setState('issues', (issues) => [issue, ...issues]);
    setSelectedId(issue.id);
    addEvent(state, issue.id, '审计员创建问题并保存证据');
  };

  const act = (patch: StatusPatch, message: string) => {
    const issue = selected();
    if (!issue) return;
    const result = changeIssueStatus(state, issue.id, patch, message);
    if (!result.ok) setMergeError(result.message);
    else setMergeError('');
  };

  // 模拟审核员提交间隔：先到的合并先落库，后到的被比较并交换退回。
  const submitMerge = async () => {
    const source = selected();
    const targetId = mergeInto();
    if (!source || !targetId || merging()) return;
    setMerging(true);
    setMergeError('');
    const expectedVersion = source.version;
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    const result = mergeIssues(state, source.id, targetId, expectedVersion);
    if (!result.ok) {
      setMergeError(result.message);
      addEvent(state, source.id, `合并请求被退回：${result.message}`);
    } else {
      setSelectedId(result.canonical.id);
      setMergeInto('');
    }
    setMerging(false);
  };

  const submitSplit = (sourceId: string) => {
    if (!window.confirm(t()('splitConfirm'))) return;
    const result = splitIssue(state, sourceId);
    if (!result.ok) setMergeError(result.message);
    else setMergeError('');
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === 'n' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div><span class="badge">WCAG 人工审计协作</span><h1>{t()('title')}</h1><p>{t()('subtitle')} · {t()('shortcutHint')}</p></div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <section class="stats" aria-label="审计概览">
          <div class="card"><span>{t()('statsTotal')}</span><strong>{stats().total}</strong></div>
          <div class="card"><span>{t()('statsFixing')}</span><strong>{stats().pendingFix}</strong></div>
          <div class="card"><span>{t()('statsVerifying')}</span><strong>{stats().verifying}</strong></div>
          <div class="card"><span>{t()('statsClosed')}</span><strong>{stats().closed}</strong></div>
          <Show when={stats().suspended > 0}>
            <div class="card"><span>{t()('statsSuspended')}</span><strong>{stats().suspended}</strong></div>
          </Show>
        </section>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')} <small>{state.issues.length ? t()('syncOk') : t()('syncing')}</small></h2>
            <ul class="issue-list">
              <For each={roots()}>{(root) => {
                const subs = () => sourcesOf(state, root.id);
                return (
                  <li>
                    <article class="issue" style={focusedIssueId() === root.id ? 'background:#eefaf8;border-radius:10px;padding-left:12px' : ''}>
                      <h3><button class="secondary" onClick={() => setSelectedId(root.id)} aria-current={selectedId() === root.id ? 'true' : undefined}>{root.title}</button></h3>
                      <div class="meta">
                        <span class="badge">{STATUS_LABELS[root.status as IssueStatus]}</span>
                        <span class="badge">{root.severity}</span>
                        <span>{root.flow}</span>
                      </div>
                    </article>
                    <Show when={subs().length > 0}>
                      <ul class="sub-sources">
                        <For each={subs()}>{(source) => (
                          <li>
                            <article class="issue issue-source">
                              <h3><button class="secondary" onClick={() => setSelectedId(source.id)} aria-current={selectedId() === source.id ? 'true' : undefined}>{source.title}</button></h3>
                              <div class="meta">
                                <span class="badge">{t()('mergedBadge')}</span>
                                <span class="badge">{t()('sourceVoidBadge')}</span>
                                <span>{source.flow}</span>
                              </div>
                            </article>
                          </li>
                        )}</For>
                      </ul>
                    </Show>
                  </li>
                );
              }}</For>
            </ul>
            <Show when={suspendedIssues().length > 0}>
              <h3 class="suspended-title">{t()('statsSuspended')}</h3>
              <ul class="issue-list">
                <For each={suspendedIssues()}>{(issue) => (
                  <li>
                    <article class="issue issue-suspended">
                      <h3><button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>{issue.title}</button></h3>
                      <div class="meta"><span class="badge">{t()('suspendedBadge')}</span><span>{issue.flow}</span></div>
                    </article>
                  </li>
                )}</For>
              </ul>
            </Show>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">{t()('detailTitle')}</h2>
            <Show when={selected()} keyed fallback={<p role="status">{t()('noIssues')}</p>}>
              {(issue) => (
                <Show when={issue.suspended} keyed fallback={
                  <Show when={issue.canonicalId} keyed fallback={
                    <>
                      <h3>{issue.title}</h3>
                      <p><strong>{t()('stepsLabel')}：</strong>{issue.steps}</p>
                      <p><strong>{t()('fixNoteLabel')}：</strong>{issue.fixNote || t()('none')}</p>
                      <p><strong>{t()('retestNoteLabel')}：</strong>{issue.retestNote || t()('none')}</p>
                      <div role="group" aria-label={t()('statusActions')}>
                        <button onClick={() => act({ status: 'triaged' }, '审核员完成分诊')}>{t()('confirmIssue')}</button>{' '}
                        <button onClick={() => act({ status: 'fixing', fixNote: '修复进行中，等待提交复测版本' }, '开发人员开始修复')}>{t()('startFix')}</button>{' '}
                        <button onClick={() => act({ status: 'verifying' }, '开发人员提交修复，进入复测')}>{t()('submitRetest')}</button>{' '}
                        <button onClick={() => act({ status: 'closed', retestNote: '键盘、读屏和错误提示均已通过' }, '复测通过并关闭问题')}>{t()('passRetest')}</button>{' '}
                        <button class="danger" onClick={() => act({ status: 'reopened', retestNote: '焦点顺序仍不正确' }, '复测失败并重新打开')}>{t()('failRetest')}</button>
                      </div>
                      <Show when={sourcesOf(state, issue.id).length > 0}>
                        <hr />
                        <h4>{t()('sourcesTitle')}</h4>
                        <ul class="source-actions">
                          <For each={sourcesOf(state, issue.id)}>{(source) => (
                            <li>
                              <span>{source.title}</span>
                              <span class="badge">{t()('sourceVoidNote')}</span>
                              <button class="secondary" onClick={() => submitSplit(source.id)}>{t()('splitButton')}</button>
                            </li>
                          )}</For>
                        </ul>
                      </Show>
                      <hr />
                      <Show when={mergeError()}><p class="error merge-error" role="alert"><strong>{t()('mergeRejectedTitle')}：</strong>{mergeError()}</p></Show>
                      <label>{t()('mergeIntoLabel')}
                        <select value={mergeInto()} onChange={(event) => { setMergeInto(event.currentTarget.value); setMergeError(''); }}>
                          <option value="">{t()('mergeSelectPlaceholder')}</option>
                          <For each={roots().filter((item) => item.id !== issue.id)}>{(item) => <option value={item.id}>{item.title}</option>}</For>
                        </select>
                      </label>
                      <button disabled={!mergeInto() || merging()} onClick={submitMerge}>{merging() ? t()('merging') : t()('mergeConfirm')}</button>
                    </>
                  }
                >
                  <p class="banner" role="note">{t()('mergedBanner')}</p>
                  <h3>{issue.title}</h3>
                  <p><strong>{t()('originalStatus')}：</strong>{STATUS_LABELS[issue.mergedSnapshot?.status ?? 'open']}</p>
                  <p><strong>{t()('mergedAt')}：</strong>{issue.mergedSnapshot ? new Date(issue.mergedSnapshot.mergedAt).toLocaleString() : '—'}</p>
                  <p><strong>{t()('stepsLabel')}：</strong>{issue.steps}</p>
                  <Show when={mergeError()}><p class="error merge-error" role="alert"><strong>{t()('mergeRejectedTitle')}：</strong>{mergeError()}</p></Show>
                  <div role="group" aria-label={t()('statusActions')}>
                    <button onClick={() => { setMergeError(''); setSelectedId(issue.canonicalId!); }}>{t()('viewCanonical')}</button>
                    <button class="secondary" onClick={() => submitSplit(issue.id)}>{t()('splitButton')}</button>
                  </div>
                </Show>
              }>
                <p class="error banner" role="alert">{t()('suspendedBanner')}</p>
                <h3>{issue.title}</h3>
                <p><strong>{t()('suspendReason')}：</strong>{issue.suspendReason}</p>
                </Show>
              )}
            </Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>{t()('newIssueTitle')}</h2>
            <AuditForm onSubmit={submitCreate} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows={4} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">{t()('activityTab')}</Tabs.Trigger><Tabs.Trigger value="keyboard">{t()('keyboardTab')}</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 12)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：{t()('keyboardN')}</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：{t()('keyboardTab2')}</li><li><kbd>Ctrl+Enter</kbd>：{t()('keyboardCtrl')}</li><li>{t()('keyboardErrors')}</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
