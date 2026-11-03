import { useState } from 'react';
import { ArrowUpRight, ChevronDown, ClipboardCheck, GitPullRequest, LockKeyhole, Pause, Search, Settings2, Users } from 'lucide-react';
import { scorePriority, type PmoState, type PmoProject, type PmoScopeChange, type PmoReviewRecord } from '../../lib/pmo-model.mjs';
import TaskRow from './TaskRow';
import { formatDuration, ROLE_LABELS, type TaskView } from './uiTypes';

type Filter = 'all' | 'committed' | 'needs_check' | 'pool';
const filterLabels: Record<Filter, string> = {all: '全部', committed: '本期计划', needs_check: '待核实', pool: '待办池'};
const kindLabels = {daily: '每日复盘', weekly: '每周复盘', task: '事项验收', priority: '排序建议'};
export default function PmoProjects({ pmo, tasks, onEditProject, onEditTask, onComplete, onFocus, onReview, onScopeChange, onDecideScope, onRecordReview, onDecideReview, onCapacity }: {
  pmo: PmoState; tasks: TaskView[]; onEditProject: (project: PmoProject) => void; onEditTask: (task: TaskView) => void;
  onComplete: (task: TaskView) => void; onFocus: (task: TaskView) => void; onReview: (projectId?: string) => void;
  onScopeChange: (project: PmoProject, taskId?: string) => void; onDecideScope: (change: PmoScopeChange) => void;
  onRecordReview: (projectId?: string) => void; onDecideReview: (review: PmoReviewRecord) => void; onCapacity: () => void;
}) {
  const main = pmo.projects.find(project => project.role === 'main');
  const [open, setOpen] = useState<string[]>(main ? [main.id] : []), [filter, setFilter] = useState<Filter>('all'), [query, setQuery] = useState(''), [showDone, setShowDone] = useState(false);
  const matches = (task: TaskView) => task.stage !== 'archived' && (showDone || task.stage !== 'done')
    && (filter === 'all' || filter === 'committed' && task.scope === 'committed' || filter === 'needs_check' && task.verification === 'needs_check' || filter === 'pool' && (task.scope !== 'committed' || task.projectRole === 'paused'))
    && (!query.trim() || (task.title + ' ' + task.description + ' ' + (task.projectName || '')).toLowerCase().includes(query.trim().toLowerCase()));
  const projects = [...pmo.projects].sort((a, b) => ({main: 0, support: 1, paused: 2}[a.role] - {main: 0, support: 1, paused: 2}[b.role]) || a.priority.localeCompare(b.priority));
  const allocated = pmo.projects.filter(project => project.role !== 'paused').reduce((sum, project) => sum + project.weeklyBudgetMinutes, 0);
  const pendingReviews = pmo.reviewRecords.filter(review => review.kind === 'priority' && review.status === 'pending');
  const history = pmo.reviewRecords.filter(review => review.kind !== 'priority' || review.status !== 'pending').slice(-12).reverse();
  const row = (task: TaskView) => <TaskRow key={task.id} task={task} onEdit={() => onEditTask(task)} onComplete={() => onComplete(task)} onFocus={!task.blocked && ['ready', 'doing'].includes(task.stage) ? () => onFocus(task) : undefined}/>;
  const unassigned = tasks.filter(task => !pmo.projects.some(project => project.id === task.projectId) && matches(task));
  return <div className="pd-pmo-projects">
    <header className="pd-pmo-projects-head"><div><span className="pd-pmo-eyebrow">项目看板</span><h2>聚焦主线，稳步交付</h2></div><button className="pd-icon" title="每周时间预算" aria-label="每周时间预算" onClick={onCapacity}><Settings2 size={15}/></button></header>
    <div className="pd-pmo-portfolio-bar"><span><b>{pmo.projects.filter(project => project.role === 'main').length}</b> 主线</span><span><b>{pmo.projects.filter(project => project.role === 'support').length}/2</b> 辅助</span><button onClick={onCapacity}>周预算 {formatDuration(allocated)} / {formatDuration(pmo.weeklyCapacityMinutes)}</button></div>
    <label className="pd-pmo-search"><Search size={13}/><input aria-label="搜索项目待办" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索项目、事项或完成标准…"/></label>
    <div className="pd-pmo-filters" role="group" aria-label="项目事项筛选">{(Object.keys(filterLabels) as Filter[]).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{filterLabels[value]}</button>)}<label><input type="checkbox" checked={showDone} onChange={e => setShowDone(e.target.checked)}/>已完成</label></div>
    {pendingReviews.length > 0 && <section className="pd-pmo-pending-reviews" aria-label="待决定的排序建议"><h3><ClipboardCheck size={13}/>{pendingReviews.length} 条排序建议等待确认</h3>{pendingReviews.map(review => <button key={review.id} className="pd-pmo-review-item" onClick={() => onDecideReview(review)}><span><strong>{review.source || '助理'}的排序建议</strong><small>{review.text}</small></span><ArrowUpRight size={14}/></button>)}</section>}
    {projects.map(project => {
      const projectTasks = tasks.filter(task => task.projectId === project.id && task.stage !== 'archived');
      const visible = projectTasks.filter(matches), expanded = open.includes(project.id) || Boolean(query.trim());
      const committed = projectTasks.filter(task => task.scope === 'committed'), completed = committed.filter(task => task.stage === 'done');
      const pending = pmo.scopeChanges.filter(change => change.projectId === project.id && change.status === 'pending');
      const score = scorePriority(project.scores);
      if (query.trim() && !visible.length) return null;
      return <section className="pd-pmo-project" data-role={project.role} key={project.id}>
        <button className="pd-pmo-project-toggle" aria-expanded={expanded} onClick={() => setOpen(previous => previous.includes(project.id) ? previous.filter(id => id !== project.id) : [...previous, project.id])}>
          <span className="pd-pmo-project-mark">{project.role === 'paused' ? <Pause size={14}/> : project.priority}</span><span className="pd-pmo-project-heading"><strong>{project.name}</strong><small>{ROLE_LABELS[project.role]} · {visible.length} 项{project.scopeFrozen && ' · 计划锁定'}</small></span><span className="pd-pmo-project-score">{score === null ? '未评' : score}<small>{score === null ? '' : '/100'}</small></span><ChevronDown size={14} className={expanded ? 'is-open' : ''}/>
        </button>
        {expanded && <div className="pd-pmo-project-content">
          <p className="pd-pmo-project-goal">{project.goal || '暂未填写阶段目标'}</p>
          <div className="pd-pmo-project-metrics"><span>本期已完成 {completed.length}/{committed.length}</span><span>每周 {formatDuration(project.weeklyBudgetMinutes)}</span></div>
          {project.definitionOfDone && <details className="pd-pmo-project-definition"><summary><LockKeyhole size={11}/>阶段交付标准 (DoD)</summary><p>{project.definitionOfDone}</p></details>}
          <div className="pd-pmo-project-actions"><button className="pd-link" onClick={() => onEditProject(project)}><Settings2 size={12}/>项目设置</button><button className="pd-link" onClick={() => onScopeChange(project)}><GitPullRequest size={12}/>范围调整</button><button className="pd-link" onClick={() => onReview(project.id)}><Users size={12}/>发起评审</button></div>
          {pending.map(change => <button className="pd-pmo-scope-pending" key={change.id} onClick={() => onDecideScope(change)}><GitPullRequest size={13}/><span><strong>{tasks.find(task => task.id === change.taskId)?.title || '范围变更'}</strong><small>{change.reason}</small></span><ArrowUpRight size={13}/></button>)}
          <div className="pd-pmo-project-tasks">{visible.length ? visible.map(row) : <p className="pd-empty-inline">当前筛选下没有事项。</p>}</div>
        </div>}
      </section>;
    })}
    {unassigned.length > 0 && <section className="pd-pmo-unassigned"><h3>待分配项目 <small>{unassigned.length}</small></h3>{unassigned.map(row)}</section>}
    <div className="pd-pmo-review-bar"><button className="pd-secondary" onClick={() => onRecordReview(main?.id)}><ClipboardCheck size={13}/>写复盘</button><button className="pd-link" onClick={() => onReview()}>发起全局评审<ArrowUpRight size={12}/></button></div>
    {history.length > 0 && <details className="pd-pmo-review-history"><summary>复盘与决策记录 · {history.length}</summary>{history.map(review => <article key={review.id}><header><strong>{kindLabels[review.kind]}</strong><time>{new Date(review.createdAt).toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric'})}</time><span>{review.status === 'rejected' ? '已拒绝' : review.status === 'accepted' ? '已采纳' : review.outcome === 'accepted' ? '已通过' : review.outcome === 'changes_requested' ? '需修改' : '记录'}</span></header>{review.projectId && <small>{pmo.projects.find(project => project.id === review.projectId)?.name || '原项目'}</small>}<p>{review.text}</p>{review.decisionReason && <small>{review.decisionReason}</small>}</article>)}</details>}
  </div>;
}
