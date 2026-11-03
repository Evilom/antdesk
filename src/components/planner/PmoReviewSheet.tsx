import { useState } from 'react';
import { Check, ClipboardCheck } from 'lucide-react';
import type { PmoProject, PmoReviewRecord } from '../../lib/pmo-model.mjs';
import Sheet from './Sheet';
import type { TaskView } from './uiTypes';

export interface PmoReviewInput {
  projectId?: string; taskId?: string; kind: 'daily' | 'weekly' | 'task';
  text: string; outcome: 'note' | 'accepted' | 'changes_requested';
}
export default function PmoReviewSheet({ projects, tasks, review, projectId, onSave, onDecision, onClose }: {
  projects: PmoProject[]; tasks: TaskView[]; review?: PmoReviewRecord; projectId?: string;
  onSave: (input: PmoReviewInput) => void; onDecision: (id: string, accepted: boolean, reason: string) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState<PmoReviewInput>({projectId: projectId || '', kind: 'daily', text: '', outcome: 'note'});
  const [reason, setReason] = useState(''), [error, setError] = useState('');
  const title = (id: string) => tasks.find(task => task.id === id)?.title || '已移出当前队列的事项';
  const submit = () => {
    if (!draft.text.trim()) { setError('写下今天的交付、阻塞或决定。'); return; }
    if (draft.kind === 'task' && !draft.taskId) { setError('请选择这次验收的事项。'); return; }
    try { onSave({...draft, text: draft.text.trim(), projectId: draft.projectId || undefined}); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const decide = (accepted: boolean) => {
    if (!review) return;
    if (!reason.trim()) { setError('请写下采纳或拒绝这次建议的理由。'); return; }
    try { onDecision(review.id, accepted, reason.trim()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <Sheet title={review ? '确认排序建议' : '工作复盘'} onClose={onClose} actions={review
    ? <><button className="pd-secondary" onClick={() => decide(false)}>保持当前排序</button><button className="pd-primary" onClick={() => decide(true)}><Check size={13}/>采纳新排序</button></>
    : <><button className="pd-secondary" onClick={onClose}>取消</button><button className="pd-primary" onClick={submit}><ClipboardCheck size={13}/>保存复盘</button></>}>
    {review ? <>
      <p className="pd-field-hint">{review.source || '助理'}提出 · {new Date(review.createdAt).toLocaleString('zh-CN')}</p>
      <p className="pd-pmo-review-text">{review.text}</p>
      <div className="pd-pmo-order-comparison"><div><h3>当前顺序</h3><ol>{(review.baseOrder || []).map(id => <li key={id}>{title(id)}</li>)}</ol></div><div><h3>建议新顺序</h3><ol>{(review.proposedOrder || []).map((id, index) => <li key={id} data-moved={review.baseOrder?.[index] !== id}>{title(id)}</li>)}</ol></div></div>
      <label htmlFor="pmo-review-decision">决策理由</label><textarea id="pmo-review-decision" rows={3} value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} placeholder="简述采纳或保留现有排序的原因…"/>
      <p className="pd-field-hint">若待办队列在期间发生变化，旧建议将自动失效。</p>
    </> : <>
      <div className="pd-form-grid"><div><label htmlFor="pmo-review-kind">复盘类型</label><select id="pmo-review-kind" value={draft.kind} onChange={e => setDraft({...draft, kind: e.target.value as PmoReviewInput['kind']})}><option value="daily">每日复盘</option><option value="weekly">每周复盘</option><option value="task">事项验收</option></select></div><div><label htmlFor="pmo-review-project">所属项目</label><select id="pmo-review-project" value={draft.projectId} onChange={e => setDraft({...draft, projectId: e.target.value, taskId: undefined})}><option value="">全部项目</option>{projects.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div></div>
      {draft.kind === 'task' && <><label htmlFor="pmo-review-task">验收事项</label><select id="pmo-review-task" value={draft.taskId || ''} onChange={e => setDraft({...draft, taskId: e.target.value || undefined})}><option value="">选择事项…</option>{tasks.filter(task => !draft.projectId || task.projectId === draft.projectId).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></>}
      <label htmlFor="pmo-review-text">完成内容、阻塞与后续计划</label><textarea id="pmo-review-text" data-dialog-autofocus rows={7} maxLength={6000} value={draft.text} onChange={e => setDraft({...draft, text: e.target.value})} placeholder="今天推进了什么？遇到了哪些阻塞？接下来优先做哪几件事？"/>
      <label htmlFor="pmo-review-outcome">结论</label><select id="pmo-review-outcome" value={draft.outcome} onChange={e => setDraft({...draft, outcome: e.target.value as PmoReviewInput['outcome']})}><option value="note">仅记录心得</option><option value="accepted">验收通过</option><option value="changes_requested">需进一步完善</option></select>
      <p className="pd-field-hint">复盘记录仅保存在本地，供日后回顾。</p>
    </>}
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </Sheet>;
}
