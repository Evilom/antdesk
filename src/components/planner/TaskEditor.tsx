import { useEffect, useRef, useState } from 'react';
import { Archive, Check, FileCheck2, LockKeyhole } from 'lucide-react';
import Sheet from './Sheet';
import { STAGE_LABELS, SCOPE_LABELS, type TaskDraft, type TaskView, type TaskStage } from './uiTypes';

export default function TaskEditor({ task, tasks, projects = [], pmoEnabled = false, initialError = '', onSave, onClose, onRequestScope }: {
  task: TaskView; tasks: TaskView[]; projects?: Array<{id: string; name: string; scopeFrozen?: boolean}>;
  pmoEnabled?: boolean; initialError?: string; onSave: (draft: TaskDraft) => void; onClose: () => void;
  onRequestScope?: (task: TaskView) => void;
}) {
  const [draft, setDraft] = useState<TaskDraft>({
    title: task.title, description: task.description, stage: task.stage, priority: task.priority,
    estimateMinutes: task.estimateMinutes, dueDate: task.dueDate || '', plannedDay: task.plannedDay || '',
    earliestStart: task.earliestStart || '', dependencies: [...task.dependencies], waitingReason: task.waitingReason || '',
    projectId: task.projectId || '', acceptanceCriteria: task.acceptanceCriteria || '', evidence: task.evidence || '',
    owner: task.owner || '我', changeReason: '', scope: task.scope || 'candidate', verification: task.verification || 'needs_check',
    sourceRefs: task.sourceRefs || [], pmoPriority: task.pmoPriority || 'P2', scores: task.scores, spentMinutes: task.spentMinutes || 0,
  });
  const [error, setError] = useState(initialError);
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) errorRef.current?.scrollIntoView({block: 'nearest'}); }, [error]);
  const change = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const project = projects.find(item => item.id === draft.projectId);
  const scopeApproval = pmoEnabled && project?.scopeFrozen && (task.scope !== 'committed' || task.projectId !== draft.projectId);
  const save = (stage = draft.stage, requestScope = false) => {
    if (!draft.title.trim()) { setError('请输入标题。'); return; }
    if (!Number.isFinite(draft.estimateMinutes) || draft.estimateMinutes < 5 || draft.estimateMinutes > 1440) { setError('时间预算需在 5 到 1440 分钟之间。'); return; }
    try {
      const saved = { ...draft, stage: requestScope && ['doing', 'done'].includes(stage) ? 'inbox' as const : stage,
        scope: requestScope ? 'candidate' as const : draft.scope, title: draft.title.trim(), description: draft.description.trim(), waitingReason: draft.waitingReason?.trim(),
        acceptanceCriteria: draft.acceptanceCriteria?.trim(), evidence: draft.evidence?.trim(), owner: draft.owner?.trim(),
        changeReason: draft.changeReason?.trim(), sourceRefs: draft.sourceRefs?.map(source => source.trim()).filter(Boolean) };
      onSave(saved);
      if (requestScope) onRequestScope?.({...task, ...saved});
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <Sheet title="编辑事项" onClose={onClose} actions={<>
    <button className="pd-delete" onClick={() => save('archived')}><Archive size={13} style={{display: 'inline', marginRight: 4}}/>归档</button>
    <button className="pd-secondary" onClick={onClose}>取消</button><button className="pd-primary" onClick={() => save()}><Check size={14}/>保存</button>
  </>}>
    {error && <div className="pd-pmo-policy-error" ref={errorRef} role="alert"><FileCheck2 size={16}/><span>{error}</span></div>}
    <label htmlFor="task-title">事项名称</label><input id="task-title" data-dialog-autofocus value={draft.title} maxLength={300} onChange={e => change('title', e.target.value)}/>
    {task.source === 'notion' && <p className="pd-field-hint">来自 Notion，排期与验收记录保存在 AntDesk。</p>}
    {pmoEnabled && <div className="pd-form-grid">
      <div><label htmlFor="task-project">所属项目</label><select id="task-project" value={draft.projectId} onChange={e => change('projectId', e.target.value)}><option value="">未分配项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div>
      <div><label htmlFor="task-pmo-priority">优先级</label><select id="task-pmo-priority" value={draft.pmoPriority} onChange={e => change('pmoPriority', e.target.value as TaskDraft['pmoPriority'])}><option value="P0">P0 · 紧急阻塞</option><option value="P1">P1 · 本期核心</option><option value="P2">P2 · 正常排队</option><option value="P3">P3 · 待定储备</option></select></div>
    </div>}
    <label htmlFor="task-description">任务描述</label><textarea id="task-description" rows={3} value={draft.description} maxLength={6000} onChange={e => change('description', e.target.value)} placeholder="补充背景、范围和具体要求…"/>
    {pmoEnabled && <>
      <label htmlFor="task-acceptance">验收标准 (DoD)</label><textarea id="task-acceptance" rows={3} value={draft.acceptanceCriteria} maxLength={6000} onChange={e => change('acceptanceCriteria', e.target.value)} placeholder="简述完成的标准，如：跑通某个流程、提供截图或测试结果…"/>
      <label htmlFor="task-evidence">完成凭证 / 验证记录</label><textarea id="task-evidence" rows={2} value={draft.evidence} maxLength={6000} onChange={e => change('evidence', e.target.value)} placeholder="填写构建版本号、截图/录屏路径或测试日志…"/>
    </>}
    <div className="pd-form-grid">
      <div><label htmlFor="task-stage">执行状态</label><select id="task-stage" value={draft.stage} onChange={e => change('stage', e.target.value as TaskStage)}>{Object.entries(STAGE_LABELS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      {pmoEnabled ? <div><label htmlFor="task-scope">规划范围</label><select id="task-scope" value={draft.scope} onChange={e => change('scope', e.target.value as TaskDraft['scope'])}>{Object.entries(SCOPE_LABELS).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></div>
        : <div><label htmlFor="task-priority">优先级</label><select id="task-priority" value={draft.priority} onChange={e => change('priority', e.target.value as TaskDraft['priority'])}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></div>}
      <div><label htmlFor="task-estimate">预估耗时（分钟）</label><input id="task-estimate" type="number" min={5} max={1440} step={5} value={draft.estimateMinutes} onChange={e => change('estimateMinutes', Number(e.target.value))}/></div>
      <div><label htmlFor="task-planned">计划日期</label><input id="task-planned" type="date" value={draft.plannedDay?.slice(0, 10)} onChange={e => change('plannedDay', e.target.value)}/></div>
    </div>
    {scopeApproval && <div className="pd-pmo-scope-note"><LockKeyhole size={13}/><span>当前项目计划已锁定，保存后需提交调整申请方可排入本期。</span>{onRequestScope && <button type="button" className="pd-link" onClick={() => save(draft.stage, true)}>保存并申请</button>}</div>}
    {pmoEnabled && project?.scopeFrozen && task.scope === 'committed' && <><label htmlFor="task-change-reason">变更原因</label><textarea id="task-change-reason" rows={2} maxLength={2000} value={draft.changeReason} onChange={e => change('changeReason', e.target.value)} placeholder="修改已锁定事项的交付标准或工时时需说明原因…"/></>}
    <details className="pd-pmo-details">
      <summary>更多设置（负责人、核实状态、依赖与参考）</summary>
      {pmoEnabled && <>
        <div className="pd-form-grid"><div><label htmlFor="task-owner">负责人</label><input id="task-owner" value={draft.owner} maxLength={160} onChange={e => change('owner', e.target.value)} placeholder="我 / 开发 / 美术"/></div><div><label htmlFor="task-verification">核实状态</label><select id="task-verification" value={draft.verification} onChange={e => change('verification', e.target.value as TaskDraft['verification'])}><option value="needs_check">待核实</option><option value="confirmed">已核实</option></select></div></div>
        <label htmlFor="task-sources">关联文档 / 参考依据（每行一条）</label><textarea id="task-sources" rows={3} value={(draft.sourceRefs || []).join('\n')} maxLength={12000} onChange={e => change('sourceRefs', e.target.value.split('\n'))} placeholder="需求文档链接、代码分支、参考资料…"/>
        <label htmlFor="task-spent">实际耗时（分钟）</label><input id="task-spent" type="number" min={0} max={1000000} step={5} value={draft.spentMinutes} onChange={e => change('spentMinutes', Number(e.target.value))}/>
      </>}
      <div className="pd-form-grid"><div><label htmlFor="task-due">截止日期</label><input id="task-due" type="date" value={draft.dueDate?.slice(0, 10)} onChange={e => change('dueDate', e.target.value)}/></div><div><label htmlFor="task-earliest">最早开始</label><input id="task-earliest" type="date" value={draft.earliestStart?.slice(0, 10)} onChange={e => change('earliestStart', e.target.value)}/></div></div>
      <label htmlFor="task-waiting">阻塞说明</label><input id="task-waiting" value={draft.waitingReason} maxLength={1000} onChange={e => change('waitingReason', e.target.value)} placeholder="说明等待的对象或阻塞条件…"/>
      <label htmlFor="task-dependency">前置事项</label><select id="task-dependency" value="" onChange={e => { if (e.target.value && !draft.dependencies.includes(e.target.value)) change('dependencies', [...draft.dependencies, e.target.value]); }}><option value="">添加前置事项…</option>{tasks.filter(item => item.id !== task.id && item.stage !== 'archived' && !draft.dependencies.includes(item.id)).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
      {draft.dependencies.map(id => <div key={id} className="pd-dependency"><span>{tasks.find(item => item.id === id)?.title || '未知事项'}</span><button className="pd-link" onClick={() => change('dependencies', draft.dependencies.filter(value => value !== id))}>移除</button></div>)}
    </details>
  </Sheet>;
}
