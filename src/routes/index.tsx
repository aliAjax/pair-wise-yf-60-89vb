import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from 'solid-js';
import { createStore, produce } from 'solid-js/store';
import { createForm, zodForm } from '@modular-forms/solid';
import { Tabs } from '@ark-ui/solid';
import { flatten, resolveTemplate, translator } from '@solid-primitives/i18n';
import { z } from 'zod';
import {
  type AuditIssue,
  type IssueStatus,
  type MergeRequest,
  type RetestVerdict,
  type Severity,
  type WorkbenchState,
  LEGACY_STORAGE_KEY,
  STORAGE_KEY,
  commitMerge,
  computeStats,
  createInitialState,
  createIssue as domainCreateIssue,
  getView,
  prepareMerge,
  runMigrationTick,
  runRecomputeTick,
  submitRetest,
  transitionStatus,
  unmerge,
  upgrade
} from '../lib/audit-domain';

const issueSchema = z.object({
  title: z.string().min(4, '标题至少4个字'),
  flow: z.string().min(2, '请输入业务流程'),
  steps: z.string().min(8, '请写清复现步骤'),
  impactGroup: z.string().min(2, '请选择受影响人群'),
  severity: z.enum(['critical', 'serious', 'moderate', 'minor'])
});
type IssueForm = z.infer<typeof issueSchema>;

const dictionaries = {
  zh: flatten({ title: '无障碍人工审计协作工作台', subtitle: '问题、合并关系与复测结论', issues: '审计问题', merge: '重复合并', events: '操作时间线' }),
  en: flatten({ title: 'Accessibility Audit Workbench', subtitle: 'Issues, merge links and retest verdicts', issues: 'Audit issues', merge: 'Duplicate merge', events: 'Activity timeline' })
};

const STATUS_LABEL: Record<IssueStatus, string> = {
  open: '待分诊',
  triaged: '已分诊',
  fixing: '修复中',
  verifying: '待复测',
  closed: '已关闭',
  reopened: '重新打开'
};

function loadState(): WorkbenchState {
  if (typeof localStorage === 'undefined') return createInitialState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    return upgrade(raw ? JSON.parse(raw) : null) ?? createInitialState();
  } catch {
    return createInitialState();
  }
}

export default function AuditWorkbench() {
  const [language, setLanguage] = createSignal<'zh' | 'en'>('zh');
  const t = createMemo(() => translator(() => dictionaries[language()], resolveTemplate));
  const [state, setState] = createStore<WorkbenchState>(loadState());
  const [selectedId, setSelectedId] = createSignal(state.issues[0]?.id ?? '');
  const [mergeInto, setMergeInto] = createSignal('');
  const [retestNote, setRetestNote] = createSignal('');
  const [notice, setNotice] = createSignal<{ tone: 'ok' | 'err'; text: string } | null>(null);

  // 所有领域写操作走同一入口：produce 内执行，统一提示
  const mutate = (fn: (draft: WorkbenchState) => ({ ok: boolean; message: string })) => {
    let result: { ok: boolean; message: string } | undefined;
    setState(produce((draft) => { result = fn(draft); }));
    if (!result) return;
    setNotice(result.ok ? { tone: 'ok', text: result.message } : { tone: 'err', text: result.message });
  };

  // 旧数据升级与来源结论重算：分批后台跑，刷新/中断后从 remaining 续跑
  const pumpBackground = () => {
    let changed = false;
    setState(
      produce((draft) => {
        if (draft.migration.status === 'running') changed = runMigrationTick(draft, 2) > 0 || changed;
        if (draft.jobs.length > 0) changed = runRecomputeTick(draft, 2) > 0 || changed;
      })
    );
    return changed;
  };
  onMount(() => {
    // 先同步跑一批，保证首次渲染就能看到迁移结果
    pumpBackground();
    const timer = window.setInterval(pumpBackground, 250);
    onCleanup(() => window.clearInterval(timer));
  });

  createEffect(() => {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  });

  const stats = createMemo(() => computeStats(state));
  const selected = createMemo(() => {
    const explicit = getView(state, selectedId());
    if (explicit) return explicit;
    return state.issues[0] ? getView(state, state.issues[0].id) : undefined;
  });

  const [form, { Form: AuditForm, Field: AuditField }] = createForm<IssueForm>({
    initialValues: { title: '', flow: '', steps: '', impactGroup: '键盘与读屏用户', severity: 'serious' },
    validate: zodForm(issueSchema)
  });

  const createNewIssue = (values: IssueForm) => {
    let created: AuditIssue | undefined;
    setState(produce((draft) => { created = domainCreateIssue(draft, values); }));
    if (created) {
      setSelectedId(created.id);
      setNotice({ tone: 'ok', text: '问题已创建' });
    }
  };

  const doMerge = (reviewer: string) => {
    const view = selected();
    if (!view) return;
    // 先按最新状态准备请求（携带 baseRev），提交时再校验：两人同时提交时后到者在 commit 时被退回
    const prepared = prepareMerge(state, { sourceId: view.issue.id, canonicalId: mergeInto(), reviewer });
    if (!prepared.ok) {
      setNotice({ tone: 'err', text: prepared.message });
      return;
    }
    const mergeRequest = prepared.value;
    const canonicalId = mergeRequest.canonicalId;
    setState(
      produce((draft) => {
        const r = commitMerge(draft, mergeRequest);
        if (r.ok) {
          setNotice({ tone: 'ok', text: `合并成功：${view.issue.title} 已并入主问题，复测结论今后只对主问题生效` });
          setSelectedId(canonicalId);
          setMergeInto('');
        } else {
          setNotice({ tone: 'err', text: r.message });
        }
      })
    );
  };

  /** 两名审核员基于同一状态并发提交：先到的落库，后到的提交时被退回并给出说明 */
  const simulateConcurrentMerge = () => {
    const view = selected();
    if (!view || view.kind !== 'primary') return;
    const targetId = mergeInto();
    if (!targetId) return;
    // 两份请求都基于提交前的同一状态（同一 baseRev）
    const p1 = prepareMerge(state, { sourceId: view.issue.id, canonicalId: targetId, reviewer: '审核员一' });
    const p2 = prepareMerge(state, { sourceId: view.issue.id, canonicalId: targetId, reviewer: '审核员二' });
    if (!p1.ok) {
      setNotice({ tone: 'err', text: p1.message });
      return;
    }
    if (!p2.ok) {
      setNotice({ tone: 'err', text: p2.message });
      return;
    }
    const messages: string[] = [];
    setState(produce((draft) => {
      const r1 = commitMerge(draft, p1.value);
      messages.push(r1.ok ? '审核员一：合并已生效（先到）' : `审核员一被退回：${r1.message}`);
      const r2 = commitMerge(draft, p2.value);
      messages.push(r2.ok ? '审核员二：合并已生效' : `审核员二（后到）已退回：${r2.message}`);
    }));
    setNotice({ tone: 'ok', text: messages.join('　') });
  };

  const doUnmerge = (sourceId: string) => {
    mutate((draft) => {
      const r = unmerge(draft, sourceId, '审核主管');
      return r.ok ? { ok: true, message: '已拆回独立问题，原状态与最后一次复测结论已恢复' } : { ok: false, message: r.message };
    });
  };

  const doTransition = (issueId: string, status: IssueStatus, fixNote: string | undefined, message: string) => {
    mutate((draft) => {
      const r = transitionStatus(draft, { issueId, status, fixNote, message });
      return r.ok ? { ok: true, message } : { ok: false, message: r.message };
    });
  };

  const doRetest = (issueId: string, verdict: RetestVerdict) => {
    const note = retestNote().trim() || (verdict === 'pass' ? '键盘、读屏和错误提示均已通过' : '焦点顺序仍不正确');
    mutate((draft) => {
      const r = submitRetest(draft, { issueId, verdict, note });
      if (!r.ok) return { ok: false, message: r.message };
      const redirected = r.value.canonical.id !== issueId;
      setRetestNote('');
      return {
        ok: true,
        message: redirected
          ? `复测结论已只对主问题《${r.value.canonical.title}》生效，来源问题等待重算同步`
          : verdict === 'pass'
            ? '复测通过，主问题已关闭；来源问题结论正在作废重算'
            : '复测失败，主问题已重新打开；来源问题结论已作废并重算'
      };
    });
  };

  onMount(() => {
    const shortcut = (event: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (event.key.toLowerCase() === 'n' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('#issue-title')?.focus();
      }
    };
    window.addEventListener('keydown', shortcut);
    onCleanup(() => window.removeEventListener('keydown', shortcut));
  });

  const seedLegacyDemo = () => {
    // 构造 v1 旧数据：含一级合并、链式合并、缺失目标与环，便于观察升级
    const now = Date.now();
    const mk = (id: string, status: IssueStatus, canonicalId?: string, retestNote = ''): AuditIssue => ({
      id, title: `旧问题${id}`, flow: '旧流程', steps: '旧复现步骤旧复现步骤', impactGroup: '键盘与读屏用户',
      severity: 'serious', status, canonicalId, fixNote: '', retestNote, updatedAt: new Date(now).toISOString()
    });
    const legacy = {
      issues: [
        mk('old-a', 'closed', undefined, '历史复测通过'),
        mk('old-b', 'closed', 'old-a'),
        mk('old-c', 'fixing', 'old-a'),
        mk('old-d', 'open', 'old-c'), // d→c→a 链
        mk('old-e', 'open', 'gone'),  // 目标缺失
        mk('old-f', 'open', 'old-g'), // f→g→f 环
        mk('old-g', 'open', 'old-f')
      ],
      events: []
    };
    const upgraded = upgrade(legacy);
    setState(upgraded as WorkbenchState);
    setSelectedId('old-a');
    setNotice({ tone: 'ok', text: '已载入 v1 旧数据：升级任务正在后台分批执行，链式合并将压成一级，分不完的会挂起' });
  };

  const migrationProgress = () => {
    const m = state.migration;
    return m.status === 'running' ? `${m.processed}/${m.total}` : null;
  };

  return (
    <>
      <a class="skip-link" href="#main-content">跳到主要内容</a>
      <main class="shell" id="main-content">
        <header class="hero">
          <div>
            <span class="badge">WCAG 人工审计协作</span>
            <h1>{t()('title')}</h1>
            <p>{t()('subtitle')} · 复测结论只挂主问题 · 快捷键 N 聚焦新建问题，Ctrl+Enter 提交</p>
          </div>
          <button class="secondary" onClick={() => setLanguage(language() === 'zh' ? 'en' : 'zh')}>{language() === 'zh' ? 'English' : '中文'}</button>
        </header>

        <Show when={notice()}>
          <p class={notice()!.tone === 'ok' ? 'notice ok' : 'notice err'} role="status" aria-live="polite">{notice()!.text}</p>
        </Show>

        <section class="stats" aria-label="审计概览（按主问题统计）">
          <div class="card"><span>主问题/独立问题</span><strong>{stats().total}</strong></div>
          <div class="card"><span>待修复</span><strong>{stats().toFix}</strong></div>
          <div class="card"><span>待复测</span><strong>{stats().verifying}</strong></div>
          <div class="card"><span>已关闭</span><strong>{stats().closed}</strong></div>
        </section>
        <p class="meta-line" role="status" aria-live="polite">
          已并入主问题的来源 {stats().sources} 个（不重复计入统计） · 挂起 {stats().suspended} 个
          <Show when={stats().recomputePending > 0}> · 来源结论作废/重算待处理 {stats().recomputePending} 项</Show>
          <Show when={migrationProgress()}> · 旧数据升级中 {migrationProgress()}</Show>
        </p>

        <div class="grid">
          <section class="card" aria-labelledby="issue-list-title">
            <h2 id="issue-list-title">{t()('issues')}</h2>
            <For each={state.issues}>{(issue) => {
              const view = () => getView(state, issue.id);
              return (
                <article class="issue">
                  <h3>
                    <button class="secondary" onClick={() => setSelectedId(issue.id)} aria-current={selectedId() === issue.id ? 'true' : undefined}>
                      {issue.title}
                    </button>
                  </h3>
                  <div class="meta">
                    <span class="badge">{view()!.kind === 'source' ? `跟随主问题：${STATUS_LABEL[view()!.effectiveStatus]}` : view()!.kind === 'suspended' ? '已挂起' : STATUS_LABEL[view()!.effectiveStatus]}</span>
                    <span class="badge">{issue.severity}</span>
                    <span>{issue.flow}</span>
                    <span>{issue.impactGroup}</span>
                    <Show when={view()!.kind === 'source'}><span class="badge">来源于 {view()!.canonical?.title}</span></Show>
                    <Show when={view()!.kind === 'suspended'}><span class="badge danger-badge">{view()!.issue.suspendReason}</span></Show>
                  </div>
                </article>
              );
            }}</For>
          </section>

          <section class="card" aria-labelledby="detail-title">
            <h2 id="detail-title">问题详情与状态流转</h2>
            <Show when={selected()} fallback={<p role="status">暂无审计问题。</p>}>
              {(v) => {
                const view = v();
                const issue = view.issue;
                return <>
                  <h3>{issue.title}</h3>
                  <p><strong>复现步骤：</strong>{issue.steps}</p>
                  <Show when={view.kind === 'source'}>
                    <p class="callout" role="note">
                      该问题已合并到主问题《{view.canonical?.title}》。它自身的状态保持合并时快照，
                      页面状态与复测结论一律跟随主问题；要单独处理请先拆回。
                    </p>
                  </Show>
                  <p><strong>修复记录：</strong>{view.kind === 'source' ? view.canonical?.fixNote || '尚未填写' : issue.fixNote || '尚未填写'}</p>
                  <p>
                    <strong>复测记录：</strong>
                    <Show when={view.effectiveConclusion} fallback={<span>尚无有效结论{view.kind === 'source' ? '（主问题未到终态或重算中）' : ''}</span>}>
                      <span class={view.effectiveConclusion!.verdict === 'pass' ? 'verdict pass' : 'verdict fail'}>
                        {view.effectiveConclusion!.verdict === 'pass' ? '复测通过' : '复测失败'}
                        （{view.effectiveConclusion!.kind === 'own' ? '主问题自身结论' : view.effectiveConclusion!.kind === 'derived' ? '由主问题同步，主问题变更即作废' : '拆回恢复的历史结论'}）
                        ：{view.effectiveConclusion!.note}
                      </span>
                    </Show>
                  </p>

                  <Show when={view.kind !== 'suspended'}>
                    <Show
                      when={view.kind === 'primary'}
                      fallback={<p class="callout" role="note">来源问题状态已锁定：只能在主问题上流转；需要独立处理请先拆回。</p>}
                    >
                      <div role="group" aria-label="问题状态操作">
                        <button onClick={() => doTransition(issue.id, 'triaged', undefined, '审核员完成分诊')}>确认问题</button>{' '}
                        <button onClick={() => doTransition(issue.id, 'fixing', '修复进行中，等待提交复测版本', '开发人员开始修复')}>开始修复</button>{' '}
                        <button onClick={() => doTransition(issue.id, 'verifying', undefined, '开发人员提交修复，进入复测')}>提交复测</button>
                      </div>
                    </Show>
                    <hr />
                    <label>
                      复测说明（结论只对主问题生效）
                      <textarea rows="2" value={retestNote()} onInput={(e) => setRetestNote(e.currentTarget.value)} />
                    </label>
                    <div role="group" aria-label="复测结论操作">
                      <button onClick={() => doRetest(issue.id, 'pass')}>复测通过</button>{' '}
                      <button class="danger" onClick={() => doRetest(issue.id, 'fail')}>复测失败</button>
                    </div>
                    <Show when={view.kind === 'source'}>
                      <p class="meta-line">在来源问题上提交复测，结论只记录到主问题；主问题状态变化后此结论自动作废并重算。</p>
                    </Show>
                  </Show>

                  <hr />
                  <Show when={view.kind === 'primary'} fallback={<Show when={view.kind === 'source'}>
                    <button class="danger" onClick={() => doUnmerge(issue.id)}>拆回独立问题（恢复原状态与最后一次结论）</button>
                  </Show>}>
                    <fieldset class="merge-box">
                      <legend>{t()('merge')}</legend>
                      <label>
                        选择要并入本问题的重复问题
                        <select value={mergeInto()} onChange={(event) => setMergeInto(event.currentTarget.value)}>
                          <option value="">选择问题</option>
                          <For each={state.issues.filter((item) => item.id !== issue.id && getView(state, item.id)?.kind === 'primary')}>
                            {(item) => <option value={item.id}>{item.title}</option>}
                          </For>
                        </select>
                      </label>
                      <div role="group" aria-label="合并提交">
                        <button disabled={!mergeInto()} onClick={() => doMerge('审核员甲')}>确认重复合并（审核员甲）</button>{' '}
                        <button class="secondary" disabled={!mergeInto()} onClick={simulateConcurrentMerge}>模拟两人同时提交</button>
                      </div>
                      <p class="meta-line">两名审核员同时提交时，只有先到的合并关系生效，后到的会被退回并提示原因；系统不产生链式合并。</p>
                    </fieldset>
                  </Show>
                </>;
              }}
            </Show>
          </section>
        </div>

        <div class="grid" style="margin-top:18px">
          <section class="card">
            <h2>新建审计问题</h2>
            <AuditForm onSubmit={createNewIssue} style="margin-top:12px">
              <AuditField name="title">{ (field, props) => <label>问题标题<input id="issue-title" {...props} value={field.value} aria-invalid={field.error ? 'true' : undefined} aria-describedby={field.error ? 'title-error' : undefined} /><Show when={field.error}><p class="error" id="title-error" role="alert">{field.error}</p></Show></label> }</AuditField>
              <AuditField name="flow">{ (field, props) => <label>业务流程<input {...props} value={field.value} /></label> }</AuditField>
              <AuditField name="steps">{ (field, props) => <label>复现步骤<textarea {...props} rows="4" value={field.value} /></label> }</AuditField>
              <AuditField name="impactGroup">{ (field, props) => <label>影响人群<select {...props} value={field.value}><option>键盘与读屏用户</option><option>低视力用户</option><option>认知障碍用户</option><option>行动障碍用户</option></select></label> }</AuditField>
              <AuditField name="severity">{ (field, props) => <label>严重程度<select {...props} value={field.value}><option value="critical">阻断</option><option value="serious">严重</option><option value="moderate">中等</option><option value="minor">轻微</option></select></label> }</AuditField>
              <button type="submit">创建问题</button>
            </AuditForm>
            <p class="meta-line"><button class="secondary" onClick={seedLegacyDemo}>载入 v1 旧数据演示（链/环/缺失编号）</button></p>
          </section>

          <section class="card tabs">
            <h2>{t()('events')}</h2>
            <Tabs.Root defaultValue="activity">
              <Tabs.List><Tabs.Trigger value="activity">操作记录</Tabs.Trigger><Tabs.Trigger value="keyboard">键盘说明</Tabs.Trigger></Tabs.List>
              <Tabs.Content value="activity"><div class="timeline" aria-live="polite"><For each={state.events.slice(0, 14)}>{(event) => <div style="margin-bottom:12px"><strong>{new Date(event.at).toLocaleString()}</strong><div>{event.message}</div></div>}</For></div></Tabs.Content>
              <Tabs.Content value="keyboard"><ul><li><kbd>N</kbd>：聚焦新建问题标题</li><li><kbd>Tab</kbd> / <kbd>Shift+Tab</kbd>：按可见顺序移动焦点</li><li><kbd>Ctrl+Enter</kbd>：表单支持键盘提交</li><li>所有错误消息使用 <code>role="alert"</code> 并通过描述关系关联字段</li></ul></Tabs.Content>
            </Tabs.Root>
          </section>
        </div>
      </main>
    </>
  );
}
