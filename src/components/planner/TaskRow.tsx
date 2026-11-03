import { ArrowUp, Check, Clock3, GripVertical, Play } from 'lucide-react';
import { formatDuration, formatTaskDate, STAGE_LABELS, type TaskView } from './uiTypes';

export default function TaskRow({ task, onEdit, onComplete, onFocus, onMove, onDrop, onDragStart, onDragEnd, dragging, dropTarget, compact = false }: {
  task: TaskView; onEdit: () => void; onComplete: () => void; onFocus?: () => void; onMove?: (direction: -1 | 1) => void;
  onDrop?: () => void; onDragStart?: () => void; onDragEnd?: () => void; dragging?: boolean; dropTarget?: boolean; compact?: boolean;
}) {
  return <article className="pd-task" data-dragging={dragging} data-drop={dropTarget} draggable={Boolean(onDragStart)}
    onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); onDragStart?.(); }}
    onDragEnd={onDragEnd} onDragOver={event => { if (onDrop) event.preventDefault(); }} onDrop={event => { event.preventDefault(); event.stopPropagation(); onDrop?.(); }}>
    <button className="pd-task-check" title={task.stage === 'done' ? '标记未完成' : '标记完成'} aria-label={`${task.stage === 'done' ? '标记未完成' : '完成'}：${task.title}`} onClick={onComplete}>{task.stage === 'done' && <Check size={12}/>}</button>
    <button className="pd-task-main" onClick={onEdit}><span className="pd-task-title">{task.title}</span><span className="pd-meta">
      <span><i className="pd-priority" data-priority={task.priority}/>{task.projectName || (task.source === 'notion' ? 'Notion' : '本地')}</span>
      {task.projectRole && <span className="pd-pmo-priority-tag" data-tier={task.pmoPriority}>{task.pmoPriority}</span>}
      <span><Clock3 size={10}/>{formatDuration(task.estimateMinutes)}</span>
      {task.verification === 'needs_check' && <span className="pd-pmo-needs-check">待核实</span>}
      {task.dueDate && <span>{formatTaskDate(task.dueDate)} 截止</span>}
      {!['ready', 'doing'].includes(task.stage) && <span>{STAGE_LABELS[task.stage]}</span>}
    </span>{!compact && (task.waitingReason || (task.blocked && task.reasons[0])) && <span className="pd-task-hint">{task.waitingReason || task.reasons[0]}</span>}</button>
    {!compact && <div className="pd-task-actions">
      {onMove && <button className="pd-icon" aria-label={`将 ${task.title} 上移；按 Alt 加方向键调整`} title="上移 · Alt ↑ / ↓" onClick={() => onMove(-1)} onKeyDown={event => { if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); onMove(event.key === 'ArrowUp' ? -1 : 1); } }}><ArrowUp size={12}/></button>}
      {onFocus && <button className="pd-icon" aria-label={`现在做：${task.title}`} title="现在做" onClick={onFocus}><Play size={12}/></button>}
      {onDragStart && <span className="pd-grip" aria-hidden="true"><GripVertical size={12}/></span>}
    </div>}
  </article>;
}
