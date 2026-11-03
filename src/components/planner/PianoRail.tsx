import { ArrowUpRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, GripVertical, Layers3, Plus } from 'lucide-react';
import type { CSSProperties, PointerEvent } from 'react';
import { formatDuration, formatTaskDate, localDay, STAGE_LABELS, type TaskView } from './uiTypes';
import { previewRank, rankTier } from '../../lib/planner-agent.mjs';
import { pianoMetrics, usePianoInteraction, type PianoAxis } from './usePianoInteraction';
import './pianoRail.css';

export type PianoEdge = 'left' | 'right' | 'top' | 'bottom';

const EDGE_LABELS: Record<PianoEdge, string> = { left: '左侧', right: '右侧', top: '顶部', bottom: '底部' };

function EdgeArrow({ edge, inward = false, size = 14 }: { edge: PianoEdge; inward?: boolean; size?: number }) {
  const Arrow = edge === 'left' ? inward ? ChevronRight : ChevronLeft
    : edge === 'right' ? inward ? ChevronLeft : ChevronRight
    : edge === 'top' ? inward ? ChevronDown : ChevronUp : inward ? ChevronUp : ChevronDown;
  return <Arrow size={size} aria-hidden="true"/>;
}

function startDockDrag(event: PointerEvent<HTMLElement>, onDockDrag?: () => void) {
  if (event.button !== 0 || !event.isPrimary || !onDockDrag) return;
  event.preventDefault();
  event.stopPropagation();
  onDockDrag();
}

export interface EdgeTabProps {
  edge: PianoEdge;
  count: number;
  title?: string;
  onOpen: () => void;
  onDockDrag?: () => void;
  docking?: boolean;
}

/** A compact edge anchor. Native drag is separate from task reordering. */
export function EdgeTab({ edge, count, title, onOpen, onDockDrag, docking }: EdgeTabProps) {
  return <section className="pd-edge-tab" data-edge={edge} data-docking={Boolean(docking)} aria-label={`${EDGE_LABELS[edge]}待办抽屉`}>
    <button className="pp-edge-open" onClick={onOpen} aria-label="展开待办列表" title={title || '展开待办列表'}>
      <span className="pp-edge-mark" aria-hidden="true"><i/><i/><i/></span>
      <span className="pp-edge-label">待办</span>
      <span className="pp-edge-count">{count > 99 ? '99+' : count}</span>
      <span className="pp-edge-arrow"><EdgeArrow edge={edge} inward/></span>
    </button>
    {onDockDrag && <button className="pd-dock-grip pp-edge-grip" aria-label="拖动抽屉位置" title="拖到屏幕任一边缘自动贴边"
      onPointerDown={event => startDockDrag(event, onDockDrag)}><GripVertical size={13}/></button>}
  </section>;
}

export interface PianoRailProps {
  tasks: TaskView[];
  currentId?: string;
  edge: PianoEdge;
  mode: 'collapsed' | 'peek' | 'expanded';
  onOpen: (id: string) => void;
  onComplete: (id: string) => void;
  onReorder: (id: string, beforeId: string | null) => void;
  onOpenBoard: () => void;
  onCapture: () => void;
  onInteractionChange: (active: boolean) => void;
  onDockDrag?: () => void;
  onCollapse?: () => void;
  docking?: boolean;
  saving?: boolean;
  error?: string;
}

function KeyContent({ task, index, current }: { task: TaskView; index: number; current: boolean }) {
  const futureDay = task.plannedDay && task.plannedDay.slice(0, 10) > localDay() ? task.plannedDay : undefined;
  const futureStart = task.earliestStart && Date.parse(task.earliestStart) > Date.now() ? task.earliestStart : undefined;
  const state = task.waitingReason || (futureDay ? `${formatTaskDate(futureDay)}`
    : futureStart ? `${formatTaskDate(futureStart)} 起`
    : task.blocked && task.stage !== 'inbox' && task.stage !== 'review' ? task.reasons[task.reasons.length - 1] || '等待中'
    : current ? task.stage === 'doing' ? '进行中' : '当前优先' : STAGE_LABELS[task.stage]);
  return <>
    <span className="pp-rank" aria-hidden="true"><span>{String(index + 1).padStart(2, '0')}</span><Check size={13}/></span>
    <span className="pp-copy"><strong>{task.title}</strong><span className="pp-meta">
      <i data-stage={task.stage}/><span>{state}</span>
      <span className="pp-duration">{formatDuration(task.estimateMinutes)}</span>
    </span></span>
    <span className="pp-grip" aria-hidden="true"><GripVertical size={13}/></span>
  </>;
}

/** A task is a key. Rank is spatial: the first visible key is the highest priority. */
export default function PianoRail(props: PianoRailProps) {
  const { tasks, currentId, edge, mode, onOpen, onComplete, onReorder, onOpenBoard, onCapture, onInteractionChange, onDockDrag, onCollapse, docking, saving, error } = props;
  const panel = mode === 'expanded';
  const axis: PianoAxis = !panel && (edge === 'top' || edge === 'bottom') ? 'x' : 'y';
  const metric = pianoMetrics[axis];
  const pitch = metric.slot + metric.gap;
  const interaction = usePianoInteraction({ ids: tasks.map(task => task.id), panel, axis, onOpen, onReorder, onInteractionChange });
  const { drag } = interaction;
  const lifted = drag ? tasks.find(task => task.id === drag.id) : null;

  const axisStyle: CSSProperties | undefined = axis === 'x'
    ? { '--pp-slot': `${metric.slot}px`, '--pp-gap': `${metric.gap}px` } as CSSProperties
    : undefined;
  return <section className="pd-piano" data-edge={edge} data-axis={axis} data-mode={mode} data-panel={panel} data-count={tasks.length} data-dragging={Boolean(drag)} data-docking={Boolean(docking)} style={axisStyle} aria-label="待办优先级队列">
    {!panel && <header className="pp-header" onPointerDown={event => {
      if (!(event.target as HTMLElement).closest('button')) startDockDrag(event, onDockDrag);
    }}>
      {onDockDrag && <button className="pd-dock-grip pp-header-grip" aria-label="拖动抽屉位置" title="拖到屏幕任一边缘自动贴边"
        onPointerDown={event => startDockDrag(event, onDockDrag)}><GripVertical size={14}/></button>}
      <button className="pp-brand" onClick={onOpenBoard} aria-label="展开主面板"><Layers3 size={16}/><span>ANTDESK<small>待办 · {EDGE_LABELS[edge]}</small></span></button>
      <span className="pp-total" aria-label={`${tasks.length} 项待办`}>{tasks.length}</span>
      {onCollapse && <button className="pp-collapse" onClick={onCollapse} aria-label="收起到屏幕边缘" title="收起到屏幕边缘"><EdgeArrow edge={edge}/></button>}
    </header>}
    <p className="pp-sr-only" id={`piano-help-${panel ? 'panel' : 'edge'}`}>{axis === 'x'
      ? '长按事项后左右拖动调整优先级，越靠左越优先。滚轮可横向浏览。点击编辑。键盘聚焦后，按 Alt 加左右方向键调整位置。'
      : '长按事项后上下拖动调整优先级，越靠上越优先。点击编辑。键盘聚焦后，按 Alt 加上下方向键调整位置。'}</p>
    <div ref={interaction.viewportRef} className="pp-viewport" onPointerMove={interaction.pointerMove} onPointerUp={interaction.pointerUp}
      onPointerCancel={interaction.cancel} onLostPointerCapture={interaction.cancel} onPointerLeave={interaction.pointerLeave}
      onScroll={interaction.scroll}>
      {tasks.length ? <ol className="pp-keys" aria-label="按优先级从高到低排列">{tasks.map((task, index) => {
        const shifted = drag ? index === drag.from ? drag.to - drag.from : index > drag.from && index <= drag.to ? -1 : index < drag.from && index >= drag.to ? 1 : 0 : 0;
        const rank = previewRank(index, drag);
        return <li key={task.id} className="pp-slot" data-task-id={task.id} data-rank-tier={rankTier(rank)} data-lifted={drag?.id === task.id} data-pressing={interaction.pressId === task.id}
          style={{ transform: `translate${axis === 'x' ? 'X' : 'Y'}(${shifted * pitch}px)` }}>
          {drag?.id === task.id && <div className="pp-drop-slot"><span>移到第 {drag.to + 1} 位</span></div>}
          <div className="pp-card">
          <button className="pp-check" aria-label={`完成：${task.title}`} title="标记完成" disabled={saving}
            onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onComplete(task.id); }}/>
          <button ref={element => interaction.bind(task.id, element)} className="pp-key" data-current={task.id === currentId} data-stage={task.stage} data-rank={index < 3 ? index + 1 : undefined}
            aria-label={`第 ${index + 1} 位：${task.title}`} aria-describedby={`piano-help-${panel ? 'panel' : 'edge'}`}
            title={`${task.title} · 长按${axis === 'x' ? '左右' : '上下'}拖动排序`} onPointerDown={event => interaction.pointerDown(event, task.id, index)}
            onClick={event => { if (event.detail === 0 && !drag) onOpen(task.id); }} onKeyDown={event => interaction.keyboard(event, task.id)}
            onFocus={event => interaction.focus(task.id, event.currentTarget)} onBlur={interaction.blur}
            onContextMenu={event => event.preventDefault()}>
            <KeyContent task={task} index={index} current={task.id === currentId}/>
          </button>
          </div>
        </li>;
      })}</ol> : <div className="pp-empty"><span className="pp-empty-keys" aria-hidden="true"><i/><i/><i/></span><strong>暂无待办事项</strong><button onClick={onCapture}>新增待办<ArrowUpRight size={13}/></button></div>}
    </div>
    {!panel && <footer className="pp-footer"><button className="pp-add" onClick={onCapture} aria-label="新增待办"><Plus size={15}/><span>新增待办</span></button><button className="pp-board" onClick={onOpenBoard} aria-label="展开主面板" title="展开主面板"><ArrowUpRight size={16}/></button></footer>}
    <div className="pp-status" role="status" aria-live="polite">{interaction.announcement || error || (saving ? '保存中…' : '')}</div>
    {lifted && drag && <div ref={interaction.floatingRef} className="pp-floating" data-rank-tier={rankTier(drag.to)} aria-hidden="true"><div className="pp-key pp-drag-key" data-current={lifted.id === currentId} data-stage={lifted.stage}><KeyContent task={lifted} index={drag.to} current={lifted.id === currentId}/></div></div>}
  </section>;
}
