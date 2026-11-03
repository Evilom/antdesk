import { useState } from 'react';
import { Check, LockKeyhole } from 'lucide-react';
import { scorePriority, type PmoProject, type PmoScores } from '../../lib/pmo-model.mjs';
import Sheet from './Sheet';
import { ROLE_LABELS } from './uiTypes';

const SCORE_FIELDS: Array<{key: keyof PmoScores; label: string; weight: string}> = [
  {key: 'business', label: '商业价值', weight: '30%'},
  {key: 'urgency', label: '交付紧迫性', weight: '25%'},
  {key: 'readiness', label: '完成接近度', weight: '20%'},
  {key: 'efficiency', label: '投入效率', weight: '15%'},
  {key: 'reuse', label: '战略复用', weight: '10%'},
];
export default function PmoProjectEditor({ project, onSave, onClose }: {
  project: PmoProject; onSave: (patch: Partial<PmoProject>) => void; onClose: () => void;
}) {
  const [draft, setDraft] = useState(project), [error, setError] = useState(''), [reason, setReason] = useState('');
  const patch = <K extends keyof PmoProject>(key: K, value: PmoProject[K]) => setDraft(previous => ({...previous, [key]: value}));
  const score = scorePriority(draft.scores);
  const save = () => {
    if (!draft.name.trim()) { setError('请输入项目名称。'); return; }
    try { onSave({...draft, decisionReason: reason.trim()}); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return <Sheet title="项目设置" onClose={onClose} actions={<><button className="pd-secondary" onClick={onClose}>取消</button><button className="pd-primary" onClick={save}><Check size={13}/>保存设置</button></>}>
    <label htmlFor="pmo-project-name">项目名称</label><input id="pmo-project-name" data-dialog-autofocus value={draft.name} maxLength={160} onChange={e => patch('name', e.target.value)}/>
    <div className="pd-form-grid">
      <div><label htmlFor="pmo-project-role">当前角色</label><select id="pmo-project-role" value={draft.role} onChange={e => patch('role', e.target.value as PmoProject['role'])}>{Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
      <div><label htmlFor="pmo-project-priority">项目优先级</label><select id="pmo-project-priority" value={draft.priority} onChange={e => patch('priority', e.target.value as PmoProject['priority'])}>{['P0', 'P1', 'P2', 'P3'].map(value => <option key={value}>{value}</option>)}</select></div>
      <div><label htmlFor="pmo-project-budget">每周预算（分钟）</label><input id="pmo-project-budget" type="number" min={0} max={10080} step={30} value={draft.weeklyBudgetMinutes} onChange={e => patch('weeklyBudgetMinutes', Number(e.target.value))}/></div>
      <div><label htmlFor="pmo-project-stage">当前阶段</label><select id="pmo-project-stage" value={draft.stage} onChange={e => patch('stage', e.target.value as PmoProject['stage'])}><option value="prototype">原型探索</option><option value="quality">质量打磨</option><option value="release">准备发布</option></select></div>
    </div>
    {project.role !== 'main' && draft.role === 'main' && <p className="pd-pmo-policy-error">保存后本项目将设为核心主线，原主线将转为已暂停。请在下方写明切换原因。</p>}
    <label htmlFor="pmo-project-goal">阶段核心目标</label><textarea id="pmo-project-goal" rows={3} value={draft.goal} maxLength={4000} onChange={e => patch('goal', e.target.value)} placeholder="说明本阶段重点推进的核心成果…"/>
    <label htmlFor="pmo-project-done">阶段交付标准 (DoD)</label><textarea id="pmo-project-done" rows={3} value={draft.definitionOfDone} maxLength={6000} onChange={e => patch('definitionOfDone', e.target.value)} placeholder="说明阶段交付的明确标准（如：通过核心验收、无阻断缺陷等）…"/>
    <label className="pd-pmo-check"><input type="checkbox" checked={draft.scopeFrozen} onChange={e => patch('scopeFrozen', e.target.checked)}/><LockKeyhole size={14}/><span>锁定本期范围</span></label>
    <p className="pd-field-hint">锁定后，新任务需通过范围调整申请方可排入本期。</p>
    <details className="pd-pmo-details"><summary>优先级评分 <span>{score === null ? '未评分' : score + '/100'}</span></summary>
      <p className="pd-field-hint">每项 1–5 分。评分辅助判断，不替代主线、依赖和你的排序。</p>
      {SCORE_FIELDS.map(({key, label, weight}) => <div className="pd-pmo-score-input" key={key}><label htmlFor={'pmo-score-' + key}>{label}<small>{weight}</small></label><input id={'pmo-score-' + key} type="number" min={1} max={5} step={1} value={draft.scores?.[key] ?? ''} onChange={e => patch('scores', {...draft.scores, [key]: e.target.value ? Number(e.target.value) : undefined} as PmoScores)}/></div>)}
    </details>
    <label htmlFor="pmo-project-reason">调整说明</label><textarea id="pmo-project-reason" rows={2} value={reason} maxLength={2000} onChange={e => setReason(e.target.value)} placeholder="简述调整目标、预算或排期的原因…"/>
    {project.decisionReason && <p className="pd-field-hint">上次决定：{project.decisionReason}</p>}
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </Sheet>;
}
