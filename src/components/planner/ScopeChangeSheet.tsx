import { useState } from 'react';
import { Check, GitPullRequest } from 'lucide-react';
import type { PmoProject, PmoScopeChange } from '../../lib/pmo-model.mjs';
import Sheet from './Sheet';
import { formatDuration, type TaskView } from './uiTypes';

export default function ScopeChangeSheet({ project, tasks, taskId = '', change, onSubmit, onDecision, onClose }: {
  project: PmoProject; tasks: TaskView[]; taskId?: string; change?: PmoScopeChange;
  onSubmit: (taskId: string, reason: string) => void;
  onDecision: (id: string, approved: boolean, reason: string) => void; onClose: () => void;
}) {
  const [selected, setSelected] = useState(change?.taskId || taskId), [reason, setReason] = useState(''), [error, setError] = useState('');
  const task = tasks.find(item => item.id === selected);
  const candidates = tasks.filter(item => item.projectId === project.id && !['done', 'archived'].includes(item.stage) && item.scope !== 'committed');
  const decide = (approved: boolean) => {
    if (!change) return;
    if (!reason.trim()) { setError('请写下这次采纳或拒绝的理由。'); return; }
    try { onDecision(change.id, approved, reason.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const submit = () => {
    if (!selected || !reason.trim()) { setError('请选择候选事项，并说明为什么现在需要做。'); return; }
    try { onSubmit(selected, reason.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <Sheet title={change ? '确认范围变更' : '申请排入本期'} onClose={onClose} actions={change
    ? <><button className="pd-secondary" onClick={() => decide(false)}>暂缓</button><button className="pd-primary" onClick={() => decide(true)}><Check size={13}/>同意排入</button></>
    : <><button className="pd-secondary" onClick={onClose}>取消</button><button className="pd-primary" onClick={submit}><GitPullRequest size={13}/>提交申请</button></>}>
    <div className="pd-pmo-dialog-context"><span>{project.priority} · {project.name}</span><p>{project.goal}</p></div>
    {!change && <><label htmlFor="pmo-scope-task">待规划事项</label><select id="pmo-scope-task" data-dialog-autofocus value={selected} onChange={e => setSelected(e.target.value)}><option value="">选择待规划的事项…</option>{candidates.map(item => <option value={item.id} key={item.id}>{item.title}</option>)}</select>{!candidates.length && <p className="pd-field-hint">可先在收集箱创建事项，并归入本项目。</p>}</>}
    {task && <div className="pd-pmo-change-task"><strong>{task.title}</strong><small>预算 {formatDuration(task.estimateMinutes)} · {task.owner || '尚未指定负责人'}</small><p>{task.acceptanceCriteria || '尚未填写验收标准，建议排入后补齐。'}</p></div>}
    {change && <><label>申请理由</label><p className="pd-pmo-review-text">{change.reason}</p></>}
    <label htmlFor="pmo-scope-reason">{change ? '审批说明' : '申请原因'}</label><textarea id="pmo-scope-reason" rows={4} value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} placeholder="说明排入本期的必要性，或对整体排期的影响…"/>
    <p className="pd-field-hint">批准后任务将排入本期计划。</p>
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </Sheet>;
}
