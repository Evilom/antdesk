import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { ArrowDownToLine, ArrowUpToLine, ArrowRight, Check, ChevronLeft, ChevronRight, CircleDot, Clock3, FolderKanban, GripVertical, Inbox, Layers3, LoaderCircle, MessageCircle, PanelLeftClose, Pin, Plus, RefreshCw, Search, Settings2, Undo2, Users } from 'lucide-react';
import type { useDrawer } from '../../lib/useDrawer';
import { usePlannerStore } from '../../stores/plannerStore';
import { buildPmoReviewDraft } from '../../lib/pmo-review.mjs';
import { isActiveRun, runStatusLabel } from '../../lib/assistant-profiles.mjs';
import { usePlannerView } from './usePlannerView';
import { useAgentWorkspace } from './useAgentWorkspace';
import { useAssistantChat } from './useAssistantChat';
import { formatDuration, localDay, type TaskView } from './uiTypes';
import TaskRow from './TaskRow';
import TaskEditor from './TaskEditor';
import Sheet from './Sheet';
import AgentsView, { type AssistantPage } from './AgentsView';
import PianoRail, { EdgeTab } from './PianoRail';
import FocusSummary from './FocusSummary';
import PmoProjects from './PmoProjects';
import PmoProjectEditor from './PmoProjectEditor';
import ScopeChangeSheet from './ScopeChangeSheet';
import PmoReviewSheet from './PmoReviewSheet';
import './pmo.css';

type Tab = 'plan' | 'projects' | 'inbox' | 'waiting' | 'agents';
type Modal = { kind: 'task'; id: string; error?: string }
  | {kind: 'project'; id: string} | {kind: 'scope'; projectId: string; taskId?: string; changeId?: string}
  | {kind: 'review'; projectId?: string; reviewId?: string}
  | {kind: 'reviewTarget'; projectId?: string}
  | { kind: 'capacity' | 'weeklyCapacity' | 'history' | 'search' | 'edge' | 'done' } | null;
export default function PlannerDrawer({ drawer, pinned, onPin, onSettings, onChat, onLegacy, onInteractionChange, loading, syncError, connected, voiceActive, onRefresh, updateVersion }: {
  drawer: ReturnType<typeof useDrawer>; pinned: boolean; onPin: () => void; onSettings: () => void; onChat: () => void;
  onLegacy: (page: 'projects' | 'reports') => void; onInteractionChange: (value: boolean) => void;
  loading: boolean; syncError: string; connected: boolean; voiceActive: boolean; onRefresh: () => void; updateVersion: string;
}) {
  const savedPlan = usePlannerView();
  const agents = useAgentWorkspace(savedPlan.all, savedPlan.completePersisted);
  const chat = useAssistantChat(agents.profiles, JSON.stringify(agents.providers.map(provider => [provider.id, provider.connectionIdentity, provider.readiness])));
  // An interrupted native run can still be active remotely. Keep its task
  // delegated until the original run is synchronized or explicitly released.
  const latestRuns = new Map<string, typeof agents.runs[number]>();
  for (const run of agents.runs) if (!latestRuns.has(run.taskId) && (isActiveRun(run) || run.status === 'review' && !run.reviewed && !run.handedOff)) latestRuns.set(run.taskId, run);
  const delegated = new Set<string>();
  const all = savedPlan.all.map(task => {
    const run = latestRuns.get(task.id);
    if (!run || ['done', 'archived'].includes(task.stage)) return task;
    if (isActiveRun(run)) {
      delegated.add(task.id);
      return {...task, stage: 'waiting' as const, blocked: true, waitingReason: `${run.agentName} · ${runStatusLabel(run)}`};
    }
    if (run.status === 'review' && !run.reviewed) {
      delegated.add(task.id);
      return {...task, stage: 'review' as const, blocked: true, waitingReason: `${run.agentName} 已返回结果`};
    }
    return task;
  });
  const byId = new Map(all.map(task => [task.id, task]));
  const queue = savedPlan.priority.map(task => byId.get(task.id) || task);
  const todayFocus = (savedPlan.pmo.enabled ? savedPlan.dailyFocus : savedPlan.priority).map(task => byId.get(task.id) || task);
  const ready = savedPlan.ready.filter(task => !delegated.has(task.id) && (!savedPlan.pmo.enabled || todayFocus.some(item => item.id === task.id)));
  const now = ready.find(task => task.id === savedPlan.current?.id) || ready[0] || null;
  const waitingIds = new Set(savedPlan.waiting.filter(task => !savedPlan.pmo.enabled || task.scope === 'committed' && task.projectRole !== 'paused').map(task => task.id));
  const planner = {...savedPlan, all, priority: queue, today: todayFocus, ready, current: now, next: ready.filter(task => task.id !== now?.id).slice(0, 2),
    inbox: savedPlan.inbox.filter(task => !delegated.has(task.id)), scheduled: savedPlan.scheduled.filter(task => !delegated.has(task.id)),
    waiting: all.filter(task => waitingIds.has(task.id) || delegated.has(task.id)), plannedMinutes: todayFocus.reduce((sum, task) => sum + task.estimateMinutes, 0)};
  const [tab, setTab] = useState<Tab>('plan');
  const [assistantPage, setAssistantPage] = useState<AssistantPage>('chat');
  const [chatInteracting, setChatInteracting] = useState(false);
  const chatting = tab === 'agents' && assistantPage === 'chat';
  const [modal, setModal] = useState<Modal>(null);
  const [capture, setCapture] = useState('');
  const [query, setQuery] = useState('');
  const [capacity, setCapacity] = useState(planner.dailyMinutes);
  const [weeklyCapacity, setWeeklyCapacity] = useState(planner.pmo.weeklyCapacityMinutes);
  const [formError, setFormError] = useState('');
  const [railInteracting, setRailInteracting] = useState(false);
  const [captureRequested, setCaptureRequested] = useState(false);
  const [notice, setNotice] = useState('');
  const captureRef = useRef<HTMLInputElement>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const current = planner.current;
  const reviewing = agents.runs.filter(run => !run.reviewed && !run.handedOff && run.status === 'review');
  const waitingCount = new Set([...planner.waiting.map(task => task.id), ...reviewing.map(run => run.taskId)]).size;
  const activeRuns = agents.runs.filter(isActiveRun);
  const announce = (text: string) => { setNotice(text); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 3500); };
  useEffect(() => () => clearTimeout(noticeTimer.current), []);
  useEffect(() => {
    const open = () => { setTab('agents'); setAssistantPage('connections'); void drawer.change('expanded'); };
    window.addEventListener('antdesk:open-assistants', open);
    return () => window.removeEventListener('antdesk:open-assistants', open);
  }, [drawer.change]);
  useEffect(() => { onInteractionChange(Boolean(modal || agents.modal || railInteracting || chatting && chatInteracting)); return () => onInteractionChange(false); }, [modal, agents.modal, railInteracting, chatting, chatInteracting, onInteractionChange]);
  useEffect(() => {
    if (!isTauri() || planner.loading) return;
    let disposed = false;
    void invoke('drawer_set_item_count', {count: planner.priority.length}).catch(() => {
      if (!disposed) announce('事项已载入，窗口尺寸调整失败；可重新打开抽屉重试。');
    });
    return () => { disposed = true; };
  }, [planner.priority.length, planner.loading]);
  useEffect(() => {
    if (!captureRequested || drawer.mode !== 'expanded') return;
    captureRef.current?.focus(); setCaptureRequested(false);
  }, [captureRequested, drawer.mode]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        if (document.activeElement?.closest('[role="dialog"]') || agents.modal) return;
        event.preventDefault(); void drawer.change('expanded'); setModal({kind: 'search'}); setQuery('');
      }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [drawer.change, agents.modal]);
  const close = () => { setModal(null); setFormError(''); };
  const edit = (task: TaskView) => { void drawer.change('expanded'); setModal({kind: 'task', id: task.id}); };
  const taskFailure = (task: TaskView, cause: unknown) => { const error = cause instanceof Error ? cause.message : String(cause); setModal({kind: 'task', id: task.id, error}); announce(error); void drawer.change('expanded'); };
  const complete = (task: TaskView) => { try { planner.setStage(task.id, task.stage === 'done' ? 'ready' : 'done'); announce(task.stage === 'done' ? '已恢复为待办' : '已标记完成'); } catch (cause) { taskFailure(task, cause); } };
  const focus = (task: TaskView) => { try { planner.focus(task.id); announce('已开始推进'); } catch (cause) { taskFailure(task, cause); } };
  const notionProfile = agents.profiles.find(profile => profile.protocol === 'notion-web');
  const notionReady = agents.providers.some(provider => provider.id === 'notion-web' && provider.readiness === 'ready');
  const prepareReview = (projectId?: string) => { setFormError(''); setModal({kind: 'reviewTarget', projectId}); };
  const chooseReviewer = (target: 'notion' | 'team') => {
    if (modal?.kind !== 'reviewTarget') return;
    if (target === 'notion' && !notionReady && notionProfile) {
      close(); setTab('agents'); setAssistantPage('connections'); agents.configure(notionProfile.id); return;
    }
    const room = target === 'team' ? chat.rooms.find(item => item.id === 'team') : chat.rooms.find(item => item.kind === 'direct' && !item.archived && item.memberIds.includes(notionProfile?.id || ''));
    if (!room) { setFormError('聊天连接正在更新，请稍后重试。'); void chat.refresh(); return; }
    try {
      const prepared = chat.prepareDraft(room.id, buildPmoReviewDraft(usePlannerStore.getState().payload, planner.all, modal.projectId));
      close(); setTab('agents'); setAssistantPage('chat'); if (prepared) announce('评审草稿已就绪，请在助理会话中确认');
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const add = (event: React.FormEvent) => {
    event.preventDefault(); const title = capture.trim(); if (!title || planner.loading) return;
    try { planner.add(title); setCapture(''); announce('已收入收集箱'); } catch (cause) { announce(cause instanceof Error ? cause.message : String(cause)); }
  };
  const row = (task: TaskView) => <TaskRow key={task.id} task={task} onEdit={() => edit(task)} onComplete={() => complete(task)}
    onFocus={!task.blocked && ['ready', 'doing'].includes(task.stage) ? () => focus(task) : undefined}/>;
  const piano = <PianoRail tasks={planner.priority} currentId={current?.stage === 'doing' ? current.id : undefined}
    edge={drawer.edge} mode={drawer.mode} saving={planner.saving} error={planner.error || drawer.error}
    onDockDrag={() => void drawer.startDrag()} docking={drawer.docking} onCollapse={() => void drawer.change('collapsed')}
    onOpen={id => { const task = planner.all.find(item => item.id === id); if (task) edit(task); }}
    onComplete={id => { const task = planner.all.find(item => item.id === id); if (task) complete(task); }}
    onReorder={(id, beforeId) => { try { planner.reorder(id, beforeId); announce('顺序已更新'); } catch (cause) { announce(cause instanceof Error ? cause.message : String(cause)); } }}
    onOpenBoard={() => { setTab('plan'); void drawer.change('expanded'); }}
    onCapture={() => { setTab('inbox'); setCaptureRequested(true); void drawer.change('expanded'); }}
    onInteractionChange={setRailInteracting}/>;
  if (drawer.mode === 'collapsed') return <EdgeTab edge={drawer.edge} count={planner.priority.length}
    title={planner.priority[0]?.title} onOpen={() => void drawer.change('peek')}
    onDockDrag={() => void drawer.startDrag()} docking={drawer.docking}/>;
  if (drawer.mode === 'peek') return piano;

  const editedTask = modal?.kind === 'task' ? savedPlan.all.find(task => task.id === modal.id) : undefined;
  const editedProject = modal?.kind === 'project' ? planner.pmo.projects.find(project => project.id === modal.id) : undefined;
  const scopeProject = modal?.kind === 'scope' ? planner.pmo.projects.find(project => project.id === modal.projectId) : undefined;
  const scopeChange = modal?.kind === 'scope' ? planner.pmo.scopeChanges.find(change => change.id === modal.changeId) : undefined;
  const reviewRecord = modal?.kind === 'review' ? planner.pmo.reviewRecords.find(review => review.id === modal.reviewId) : undefined;
  const searchResults = query.trim() ? planner.all.filter(task => `${task.title} ${task.description} ${task.projectName || ''}`.toLowerCase().includes(query.trim().toLowerCase())) : planner.all.filter(task => !['done', 'archived'].includes(task.stage));
  return <>
    <section className="pd-surface pd-expanded" data-chat={chatting} data-pmo={planner.pmo.enabled} inert={Boolean(modal || agents.modal)}>
      <header className="pd-topbar"><button className="pd-icon pd-window-grip" aria-label="拖动抽屉，自动贴边" title="按住拖动 · 松开自动贴边"
        onPointerDown={event => { if (event.button === 0) { event.preventDefault(); void drawer.startDrag(); } }}
        onClick={event => { if (event.detail === 0) setModal({kind: 'edge'}); }}><GripVertical size={15}/></button>
        <div className="pd-brand"><Layers3 size={16}/>ANTDESK<span className="pd-brand-detail">{new Date().toLocaleDateString('zh-CN', {month: 'numeric', day: 'numeric', weekday: 'short'})}</span></div>
        <button className="pd-icon" title="搜索 · Ctrl K" aria-label="搜索事项" onClick={() => {setModal({kind: 'search'}); setQuery('');}}><Search size={15}/></button>
        <button className="pd-icon" title={pinned ? '取消固定展开' : '固定展开'} aria-label="固定展开" aria-pressed={pinned} onClick={onPin}><Pin size={14}/></button>
        <button className="pd-icon" title="设置" aria-label="设置" onClick={onSettings}><Settings2 size={15}/></button>
        <button className="pd-icon" title="收起 · Esc" aria-label="收起抽屉" onClick={() => void drawer.change('collapsed')}><PanelLeftClose size={15}/></button>
      </header>
      <nav className="pd-tabs" data-pmo={planner.pmo.enabled} aria-label="事项分类" role="tablist">
        {([{id: 'plan', label: planner.pmo.enabled ? '今日聚焦' : '待办', Icon: CircleDot, count: planner.priority.length}, ...(planner.pmo.enabled ? [{id: 'projects' as const, label: '项目看板', Icon: FolderKanban, count: 0}] : []), {id: 'inbox', label: '收集箱', Icon: Inbox, count: planner.inbox.length}, {id: 'waiting', label: '等待中', Icon: Clock3, count: waitingCount}, {id: 'agents', label: '助理', Icon: Users, count: activeRuns.length}] as const).map(({id, label, Icon, count}) => <button key={id} className="pd-tab" role="tab" aria-selected={tab === id} aria-controls={`panel-${id}`} id={`tab-${id}`} onClick={() => setTab(id)}><Icon size={13}/>{label}{count > 0 && <small>{count}</small>}</button>)}
      </nav>
      {(planner.error || drawer.error) && <div className="pd-notice" role="alert"><span>{planner.error || drawer.error}</span><button onClick={() => planner.error ? void planner.retrySave() : void drawer.change(drawer.mode)}>重试</button>{planner.conflict && <button onClick={() => {if (window.confirm('本地草稿尚未保存。要放弃这份草稿并重新载入已保存的记录吗？')) void planner.reload();}}>重新载入</button>}</div>}
      {syncError && <div className="pd-notice" role="status"><span>{syncError}</span><button onClick={onRefresh} disabled={loading}>同步</button></div>}
      {planner.pmo.enabled && planner.portfolio.issue && <div className="pd-notice" role="alert"><span>{planner.portfolio.issue}</span><button onClick={() => setTab('projects')}>查看项目看板</button></div>}
      <main className={'pd-scroll' + (chatting ? ' pd-chat-scroll' : '')} id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {planner.loading ? <div className="pd-empty"><LoaderCircle className="pd-busy" size={23}/><p>正在加载…</p></div> : <>
          {tab === 'plan' && <>
            <FocusSummary pmo={planner.pmo} tasks={planner.all} daily={planner.today} dailyMinutes={planner.dailyMinutes} onProjects={() => setTab('projects')} onReview={prepareReview}/>
            {planner.pmo.enabled && !planner.priority.length ? <div className="pd-pmo-empty-focus"><strong>先解开一个阻塞</strong>{savedPlan.ready[0] && savedPlan.ready[0].estimateMinutes > planner.dailyMinutes ? <><p>当前第一项待办预计耗时 {formatDuration(savedPlan.ready[0].estimateMinutes)}，超出今日可用时间。建议拆分或调高今日容量。</p><button className="pd-link" onClick={() => edit(savedPlan.ready[0])}>编辑首个事项<ArrowRight size={12}/></button></> : <><p>今日暂无满足开始条件的待办。</p><button className="pd-link" onClick={() => setTab('projects')}>查看项目看板<ArrowRight size={12}/></button></>}</div> : piano}
            {planner.pmo.enabled && <div className="pd-pmo-next-note"><span>今日优先处理 {planner.today.length} 项，下方按优先级展示全部待办</span><button onClick={() => setTab('projects')}>项目看板</button></div>}
            {current && <section className="pd-current-strip"><div><span>{current.stage === 'doing' ? '进行中' : '当前优先'}</span><strong>{current.title}</strong></div><button className="pd-primary" onClick={() => current.stage === 'doing' ? complete(current) : focus(current)}>{current.stage === 'doing' ? <Check size={13}/> : <ArrowRight size={13}/>}{current.stage === 'doing' ? '完成' : '开始'}</button><button className="pd-secondary" onClick={() => agents.dispatch(current.id)}>派发给助理</button></section>}
            <div className="pd-capacity" data-over={planner.plannedMinutes > planner.dailyMinutes}><div className="pd-capacity-label"><span>预计 {formatDuration(planner.plannedMinutes)}</span><button onClick={() => { setCapacity(planner.dailyMinutes); setModal({kind: 'capacity'}); }}>容量 {formatDuration(planner.dailyMinutes)}</button></div><div className="pd-capacity-track"><span style={{width: `${Math.min(100, planner.plannedMinutes / Math.max(1, planner.dailyMinutes) * 100)}%`}}/></div>{planner.plannedMinutes > planner.dailyMinutes && <p className="pd-field-hint">超出今日设定时长 {formatDuration(planner.plannedMinutes - planner.dailyMinutes)}</p>}</div>
            {reviewing.length > 0 && <button className="pd-review-banner" onClick={() => setTab('waiting')}><span>{reviewing.length} 项助理执行完毕，等待确认</span><ChevronRight size={14}/></button>}
            <div className="pd-bottom-links"><button onClick={() => setModal({kind: 'done'})}>已完成 {planner.done.length}</button><button onClick={() => planner.pmo.enabled ? setTab('projects') : onLegacy('projects')}>{planner.pmo.enabled ? '项目看板' : '项目'}</button><button onClick={() => planner.pmo.enabled ? setModal({kind: 'review'}) : onLegacy('reports')}>{planner.pmo.enabled ? '工作复盘' : '日报'}</button><button onClick={() => setModal({kind: 'history'})}>操作日志</button></div>
          </>}
          {tab === 'projects' && <PmoProjects pmo={planner.pmo} tasks={[...planner.priority, ...planner.all.filter(task => task.stage === 'done' || task.stage === 'archived')]} onEditProject={project => setModal({kind: 'project', id: project.id})} onEditTask={edit} onComplete={complete} onFocus={focus} onReview={prepareReview}
            onScopeChange={(project, taskId) => setModal({kind: 'scope', projectId: project.id, taskId})} onDecideScope={change => setModal({kind: 'scope', projectId: change.projectId, changeId: change.id})}
            onRecordReview={projectId => setModal({kind: 'review', projectId})} onDecideReview={review => setModal({kind: 'review', reviewId: review.id})}
            onCapacity={() => { setWeeklyCapacity(planner.pmo.weeklyCapacityMinutes); setFormError(''); setModal({kind: 'weeklyCapacity'}); }}/>}
          {tab === 'inbox' && <>
            <div className="pd-section-heading"><h2>收集箱</h2><span>{planner.inbox.length}</span></div>
            {planner.inbox.length ? planner.inbox.map(task => <div className="pd-inbox-item" key={task.id}>{row(task)}<div className="pd-inbox-actions"><button className="pd-link" onClick={() => { if (planner.pmo.enabled) {edit(task); return;} try {planner.update(task.id, {stage: 'ready', plannedDay: localDay()}); announce('已移入今日待办');} catch (cause) {taskFailure(task, cause);} }}>{planner.pmo.enabled ? '完善并排期' : '移入今日'}<ArrowRight size={11}/></button>{planner.pmo.enabled ? task.scope !== 'committed' && planner.pmo.projects.some(project => project.id === task.projectId) && <button className="pd-link" onClick={() => setModal({kind: 'scope', projectId: task.projectId! , taskId: task.id})}>申请加入本期</button> : <button className="pd-link" onClick={() => agents.dispatch(task.id)}>派发给助理</button>}</div></div>) : <div className="pd-empty"><Inbox size={24}/><h2>收集箱为空</h2><p>灵感和待办随手记，稍后整理与排期。</p></div>}
            {planner.scheduled.length > 0 && <><div className="pd-section-heading"><h2>后续日程</h2><span>{planner.scheduled.length}</span></div>{planner.scheduled.map(task => row(task))}</>}
          </>}
          {tab === 'waiting' && <>
            <div className="pd-section-heading"><h2>待确认结果</h2><span>{reviewing.length}</span></div>
            {reviewing.length ? reviewing.map(run => <button className="pd-review-card" key={run.id} onClick={() => agents.showResult(run.id)}><span className="pd-agent-avatar">{run.agentName.slice(0, 1).toUpperCase()}</span><span><strong>{run.taskTitle}</strong><small>{run.agentName} · 待确认</small></span><ChevronRight size={14}/></button>) : <p className="pd-empty-inline">暂无待确认的助理结果。</p>}
            <div className="pd-section-heading"><h2>阻塞与等待</h2><span>{planner.waiting.length}</span></div>{planner.waiting.length ? planner.waiting.map(task => row(task)) : <p className="pd-empty-inline">暂无阻塞或等待中的事项。</p>}
          </>}
          {tab === 'agents' && <AgentsView agents={agents} chat={chat} page={assistantPage} onPageChange={setAssistantPage} onInteractionChange={setChatInteracting} onChat={onChat} voiceActive={voiceActive}/>}
        </>}
      </main>
      {!chatting && <form className="pd-capture" onSubmit={add}><Plus size={15}/><input ref={captureRef} aria-label="添加待办" placeholder="随手记待办或想法，回车保存…" value={capture} maxLength={300} onChange={event => setCapture(event.target.value)} disabled={planner.loading}/><button aria-label="收入收集箱" type="submit" disabled={!capture.trim() || planner.loading}><ArrowRight size={15}/></button></form>}
      <footer className="pd-footer"><i className={`pd-status-dot ${planner.error ? 'off' : ''}`}/><span role="status" aria-live="polite">{notice || (planner.saving ? '保存中…' : planner.error ? '未保存' : connected ? 'Notion 已同步' : '本地模式')}</span>
        {planner.canUndo && <button aria-label="撤销上一步" title="撤销上一步" onClick={() => {planner.undo(); announce('已撤销');}}><Undo2 size={12}/></button>}
        <button aria-label="停靠位置" title="停靠位置" onClick={() => setModal({kind: 'edge'})}><Layers3 size={12}/></button><button aria-label="同步 Notion" title="同步 Notion" disabled={loading} onClick={onRefresh}><RefreshCw size={12} className={loading ? 'pd-busy' : ''}/></button><button aria-label="语音与速记" title="语音与速记" onClick={onChat}><MessageCircle size={13}/>{voiceActive && <i className="pd-voice-dot"/>}</button>
      </footer>
    </section>
    {editedTask && <TaskEditor key={editedTask.id + ':' + (modal?.kind === 'task' ? modal.error || '' : '')} task={editedTask} tasks={savedPlan.all} projects={planner.pmo.enabled ? planner.pmo.projects : planner.projects} pmoEnabled={planner.pmo.enabled} initialError={modal?.kind === 'task' ? modal.error : ''} onClose={close} onSave={draft => { planner.update(editedTask.id, draft); close(); announce('已保存'); }} onRequestScope={task => { if (task.projectId && planner.pmo.projects.some(project => project.id === task.projectId)) setModal({kind: 'scope', projectId: task.projectId, taskId: task.id}); }}/>}
    {editedProject && <PmoProjectEditor project={editedProject} onClose={close} onSave={patch => { if (editedProject.role !== 'main' && patch.role === 'main') planner.replaceMainProject(editedProject.id, patch.decisionReason || '', patch); else planner.updateProject(editedProject.id, patch); close(); announce('项目决定已保存'); }}/>}
    {scopeProject && <ScopeChangeSheet project={scopeProject} tasks={savedPlan.all} taskId={modal?.kind === 'scope' ? modal.taskId : undefined} change={scopeChange} onClose={close}
      onSubmit={(taskId, reason) => { planner.requestScopeChange(scopeProject.id, taskId, reason); close(); announce('调整申请已保存，等待确认'); }} onDecision={(id, approved, reason) => { planner.decideScopeChange(id, approved, reason); close(); announce(approved ? '已同意加入本期' : '已保留原有计划'); }}/>}
    {modal?.kind === 'reviewTarget' && <Sheet title="交给谁评审" onClose={close}>
      <p className="pd-field-hint">整理当前项目的目标、范围、待办与证据，放入所选聊天的草稿。检查后再发送。</p>
      <div className="pd-review-targets">
        {notionProfile && <button className="pd-review-target" onClick={() => chooseReviewer('notion')}><span className="pd-agent-avatar">N</span><span><strong>{notionReady ? 'Notion AI 私聊评审' : '连接 Notion AI'}</strong><small>{notionReady ? '使用当前工作区的网页会员权益' : '先登录有 AI 权益的 Notion 工作区'}</small></span><ChevronRight size={15}/></button>}
        <button className="pd-review-target" onClick={() => chooseReviewer('team')}><span className="pd-agent-avatar"><Users size={17}/></span><span><strong>当前助理群</strong><small>{agents.profiles.filter(profile => chat.rooms.find(room => room.id === 'team')?.memberIds.includes(profile.id)).map(profile => profile.name).join(' · ') || '按已选择的群成员评审'}</small></span><ChevronRight size={15}/></button>
      </div>
      <p className="pd-field-hint">助理提出建议；调整优先级、扩展范围和验收交付仍由你决定。</p>
      {formError && <p className="pd-inline-error" role="alert">{formError}</p>}
    </Sheet>}
    {modal?.kind === 'review' && <PmoReviewSheet projects={planner.pmo.projects} tasks={savedPlan.all} projectId={modal.projectId} review={reviewRecord} onClose={close}
      onSave={input => { planner.recordReview(input); close(); announce('复盘已保存'); }} onDecision={(id, accepted, reason) => { usePlannerStore.getState().decideReview(id, accepted, reason); close(); announce(accepted ? '已采纳排序建议' : '已保留原有排序'); }}/>}
    {modal?.kind === 'weeklyCapacity' && <Sheet title="每周可用时间" onClose={close} actions={<button className="pd-primary" onClick={() => {try {planner.setWeeklyCapacity(weeklyCapacity); close(); announce('每周预算已更新');} catch (cause) {setFormError(cause instanceof Error ? cause.message : String(cause));}}}>保存</button>}><label htmlFor="weekly-capacity">每周可用总时长（分钟）</label><input id="weekly-capacity" type="number" min={60} max={10080} step={60} value={weeklyCapacity} onChange={event => setWeeklyCapacity(Number(event.target.value))}/><p className="pd-field-hint">所有活跃项目的周预算总和不可超出此上限。</p>{formError && <p className="pd-inline-error" role="alert">{formError}</p>}</Sheet>}
    {modal?.kind === 'capacity' && <Sheet title="每日工作时长" onClose={close} actions={<button className="pd-primary" onClick={() => { try {planner.setCapacity(capacity); close(); announce('每日时长已更新');} catch (cause) {setFormError(cause instanceof Error ? cause.message : String(cause));} }}>保存</button>}><label htmlFor="daily-capacity">每日计划时长（分钟）</label><input id="daily-capacity" type="number" min={15} max={1440} step={15} value={capacity} onChange={event => setCapacity(Math.max(15, Math.min(1440, Number(event.target.value) || 15)))}/><p className="pd-field-hint">今日聚焦按优先级最多挑选 3 项，总时长不超出设定时间。</p>{formError && <p className="pd-inline-error" role="alert">{formError}</p>}</Sheet>}
    {modal?.kind === 'edge' && <Sheet title="停靠位置" onClose={close}><div className="pd-edge-options">{([{id: 'left', title: '左侧', Icon: ChevronLeft}, {id: 'top', title: '顶部', Icon: ArrowDownToLine}, {id: 'bottom', title: '底部', Icon: ArrowUpToLine}, {id: 'right', title: '右侧', Icon: ChevronRight}] as const).map(({id, title, Icon}) => <button key={id} aria-pressed={drawer.edge === id} onClick={() => {void drawer.change('expanded', id); close();}}><Icon size={20}/><span>{title}</span>{drawer.edge === id && <Check size={13}/>}</button>)}</div><p className="pd-field-hint">拖动顶部把手或边签可贴靠屏幕四边。{drawer.shortcut ? `快捷键 ${drawer.shortcut.split("+").join(" + ")}` : "点击边签唤出"}，按 Esc 收起。{pinned ? '当前已固定展开。' : ''}</p>{updateVersion && <button className="pd-link" onClick={onSettings}>v{updateVersion} 可更新 · 打开设置</button>}</Sheet>}
    {modal?.kind === 'search' && <Sheet title="搜索" onClose={close}><label className="sr-only" htmlFor="planner-search">搜索</label><input id="planner-search" data-dialog-autofocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索标题、备注或项目…"/>{searchResults.slice(0, 60).map(task => row(task))}{!searchResults.length && <p className="pd-empty-inline">无匹配结果。</p>}</Sheet>}
    {modal?.kind === 'history' && <Sheet title="操作日志" onClose={close}>{planner.history.length ? [...planner.history].reverse().slice(0, 50).map(item => <div key={item.id} className="pd-history">{item.label}<time>{new Date(item.at).toLocaleString('zh-CN')}</time></div>) : <p className="pd-empty-inline">暂无操作日志。</p>}</Sheet>}
    {modal?.kind === 'done' && <Sheet title="已完成" onClose={close}>{planner.done.length ? planner.done.map(task => row(task)) : <p className="pd-empty-inline">暂无已完成事项。</p>}</Sheet>}
    {agents.dialogs}
  </>;
}
