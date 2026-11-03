import { ArrowUpRight, LockKeyhole, Target, Users } from 'lucide-react';
import type { PmoState } from '../../lib/pmo-model.mjs';
import { formatDuration, type TaskView } from './uiTypes';

export default function FocusSummary({ pmo, tasks, daily, dailyMinutes, onProjects, onReview }: {
  pmo: PmoState; tasks: TaskView[]; daily: TaskView[]; dailyMinutes: number;
  onProjects: () => void; onReview: (projectId?: string) => void;
}) {
  if (!pmo.enabled) return null;
  const main = pmo.projects.find(item => item.role === 'main');
  const supports = pmo.projects.filter(item => item.role === 'support');
  const paused = pmo.projects.filter(item => item.role === 'paused').length;
  const duration = daily.reduce((sum, task) => sum + task.estimateMinutes, 0);
  const pending = tasks.filter(task => main && task.projectId === main.id && task.scope === 'committed' && !['done', 'archived'].includes(task.stage));
  const blocked = pending.filter(task => task.blocked).length;
  const needsCheck = pending.filter(task => task.verification === 'needs_check').length;
  return <section className="pd-pmo-focus" aria-label="今日聚焦">
    <div className="pd-pmo-eyebrow"><span><Target size={13}/>本周主线</span><button className="pd-link" title="主线 + 辅助 + 暂停" onClick={onProjects}>{main ? 1 : 0} + {supports.length} + {paused}<ArrowUpRight size={12}/></button></div>
    <h2>{main?.name || '暂未设定核心主线'}</h2><p className="pd-pmo-goal">{main?.goal || '请在项目看板中设置本周核心目标。'}</p>
    <div className="pd-pmo-focus-meta">{main?.scopeFrozen && <span><LockKeyhole size={11}/>计划已锁定</span>}<span>今日 {daily.length}/{pmo.focusLimit || 3} 项</span><span>{formatDuration(duration)} / {formatDuration(dailyMinutes)}</span></div>
    {supports.length > 0 && <p className="pd-pmo-supports">辅助 · {supports.map(item => item.name).join(' · ')}</p>}
    <div className="pd-pmo-focus-foot"><button className="pd-link" onClick={onProjects}>{blocked ? '主线阻塞 ' + blocked + ' 项' : '查看项目看板'}{needsCheck > 0 && <span> · 主线待核实 {needsCheck} 项</span>}</button><button className="pd-pmo-review-button" onClick={() => onReview(main?.id)}><Users size={12}/>发起评审</button></div>
  </section>;
}
