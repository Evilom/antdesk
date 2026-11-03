import {create} from 'zustand';
import {
  applyPlannerChange, buildPlan, emptyPlanner, moveBefore, normalizePlanner, rebasePlanner, sanitizeTaskMeta, undoPlanner,
  type PlannerPayload, type TaskMeta, type TaskState,
} from '../lib/planner-model.mjs';
import {loadPlannerSnapshot, savePlannerSnapshot, type PlannerSnapshot} from '../lib/planner';
import {
  patchProject, replaceMainProject as replaceMain, projectPolicyIssue, taskTransitionIssue, taskAmendmentIssue, proposeScopeChange,
  decideScopeChange as decideScope, addReviewRecord, decidePriorityReview, projectTier,
  type PmoProject, type PmoReviewInput,
} from '../lib/pmo-model.mjs';
import {useAppStore} from './appStore';

export interface NewPlannerTask extends TaskMeta {title: string}
interface PlannerStore {
  payload: PlannerPayload;
  revision: number;
  initialized: boolean;
  loading: boolean;
  saving: boolean;
  dirty: boolean;
  error: string;
  conflict: boolean;
  canUndo: boolean;
  initialize: () => Promise<void>;
  addTask: (input: string | NewPlannerTask) => string;
  updateTask: (id: string, patch: TaskMeta) => void;
  setTaskState: (id: string, state: TaskState) => void;
  focus: (id: string | null) => void;
  moveTask: (id: string, beforeId?: string | null) => void;
  setDailyMinutes: (minutes: number) => void;
  updateProject: (id: string, patch: Partial<PmoProject>) => void;
  replaceMainProject: (id: string, reason: string, patch?: Partial<PmoProject>) => void;
  setWeeklyCapacity: (minutes: number) => void;
  requestScopeChange: (projectId: string, taskId: string, reason: string) => string;
  decideScopeChange: (id: string, approved: boolean, decisionReason: string) => void;
  recordReview: (input: PmoReviewInput) => string;
  decideReview: (id: string, accepted: boolean, reason: string) => void;
  undo: () => void;
  retrySave: () => Promise<void>;
  reload: () => Promise<void>;
}

const DRAFT_KEY = 'antdesk_planner_pending_v1';
let base: PlannerSnapshot = {revision: 0, payload: emptyPlanner()};
let initializePromise: Promise<void> | null = null;
let savePromise: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let mutationsDuringLoad: Array<(payload: PlannerPayload) => PlannerPayload> = [];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const canUndo = (payload: PlannerPayload) => payload.history.some(item => item.before);
const newId = (prefix: string) => prefix + (globalThis.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2));

function backup() {
  const state = usePlannerStore.getState();
  // Do not replace a previous crash-recovery draft before it has been read.
  if (!state.initialized || state.loading) return;
  try {
    if (state.dirty) localStorage.setItem(DRAFT_KEY, JSON.stringify({base, payload: state.payload}));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* The primary commit still runs. Its failure is shown in the UI. */ }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {void flush();}, 220);
}

function change(label: string, mutate: (payload: PlannerPayload) => void) {
  const operation = (payload: PlannerPayload) => applyPlannerChange(payload, label, mutate);
  const state = usePlannerStore.getState();
  const payload = operation(state.payload);
  if (!state.initialized || state.loading) mutationsDuringLoad.push(operation);
  if (JSON.stringify(payload) === JSON.stringify(state.payload)) return;
  usePlannerStore.setState({payload, dirty: true, canUndo: canUndo(payload), error: state.conflict ? state.error : ''});
  backup();
  if (!state.initialized) void usePlannerStore.getState().initialize();
  else if (!state.loading && !state.conflict) scheduleSave();
}

async function flush(): Promise<void> {
  if (savePromise) return savePromise;
  const start = usePlannerStore.getState();
  if (!start.initialized || start.loading || start.conflict || !start.dirty) return;
  savePromise = (async () => {
    usePlannerStore.setState({saving: true});
    try {
      while (usePlannerStore.getState().dirty && !usePlannerStore.getState().conflict && !usePlannerStore.getState().loading) {
        const current = usePlannerStore.getState();
        const sent = current.payload;
        const saved = await savePlannerSnapshot(current.revision, sent);
        base = saved;
        const latest = usePlannerStore.getState();
        const unchanged = JSON.stringify(latest.payload) === JSON.stringify(sent);
        usePlannerStore.setState({
          revision: saved.revision, payload: unchanged ? saved.payload : latest.payload,
          dirty: !unchanged, error: '', conflict: false,
          canUndo: canUndo(unchanged ? saved.payload : latest.payload),
        });
        backup();
      }
    } catch (error) {
      const detail = message(error);
      usePlannerStore.setState({error: '安排尚未保存：' + detail, dirty: true, conflict: /TASK_HUB_CONFLICT|版本已变化/.test(detail)});
      backup();
    } finally {usePlannerStore.setState({saving: false});}
  })();
  try {await savePromise;} finally {savePromise = null;}
}

async function initialize() {
  if (initializePromise) return initializePromise;
  if (usePlannerStore.getState().initialized) return;
  initializePromise = (async () => {
    usePlannerStore.setState({loading: true, error: ''});
    try {
      const loaded = await loadPlannerSnapshot();
      base = loaded;
      let payload = loaded.payload;
      let dirty = false;
      let conflict = false;
      let error = '';
      try {
        const pendingRaw = localStorage.getItem(DRAFT_KEY);
        if (pendingRaw) {
          const pending = JSON.parse(pendingRaw);
          const pendingPayload = normalizePlanner(pending.payload);
          const pendingBase = normalizePlanner(pending.base?.payload);
          if (pending.base?.revision === loaded.revision) {payload = pendingPayload; dirty = true;}
          else {
            const merged = rebasePlanner(pendingBase, pendingPayload, loaded.payload);
            payload = merged.payload; dirty = true; conflict = merged.conflicts.length > 0;
            if (conflict) {
              base = {revision: Number(pending.base?.revision) || 0, payload: pendingBase};
              error = '保留了未保存草稿，另一处也修改了同一安排。请检查后重试，或重新载入已保存版本。';
            }
          }
        }
      } catch {error = '上次的未保存草稿无法读取，已载入正式保存的安排。';}
      for (const operation of mutationsDuringLoad) {payload = operation(payload); dirty = true;}
      mutationsDuringLoad = [];
      usePlannerStore.setState({
        payload, revision: loaded.revision, initialized: true, loading: false,
        dirty, conflict, error, canUndo: canUndo(payload),
      });
      backup();
      if (dirty && !conflict) scheduleSave();
    } catch (error) {
      usePlannerStore.setState({loading: false, error: '无法读取事项：' + message(error)});
    }
  })();
  try {await initializePromise;} finally {initializePromise = null;}
}

function updateTask(id: string, patch: TaskMeta) {
  if (!id.startsWith('local:') && !id.startsWith('notion:')) return;
  const safe = sanitizeTaskMeta(patch);
  change(safe.state === 'done' ? '完成事项' : safe.archived ? '归档事项' : '调整事项', payload => {
    const {todos, projects} = useAppStore.getState();
    const before = buildPlan(todos, projects, payload);
    const previous = before.all.find(task => task.id === id);
    if (!previous) throw new Error('事项已不存在，请刷新待办。');
    const targetProject = payload.pmo.projects.find(project => project.id === (safe.projectId ?? previous.projectId));
    const amendmentIssue = taskAmendmentIssue(payload.pmo, previous, safe);
    if (amendmentIssue) throw new Error(amendmentIssue);
    const baselineFields = ['title', 'description', 'acceptanceCriteria', 'estimateMinutes'] as const;
    const altered = baselineFields.filter(key => Object.prototype.hasOwnProperty.call(safe, key) && safe[key] !== previous[key]);
    if (payload.pmo.enabled && targetProject?.scopeFrozen && previous.scope === 'committed' && altered.length) {
      const fieldNames = {title: '标题', description: '说明', acceptanceCriteria: '验收标准', estimateMinutes: '预估耗时'};
      payload.pmo = addReviewRecord(payload.pmo, {kind: 'task', taskId: id, projectId: targetProject.id,
        text: `调整 ${previous.title}：${altered.map(key => fieldNames[key]).join('、')}。原因：${safe.changeReason}`,
        source: '用户在 AntDesk 确认', outcome: 'accepted'}, newId('review:'));
    }
    payload.overrides[id] = {...payload.overrides[id], ...safe};
    if (safe.state === 'doing' || safe.state === 'done') {
      const after = buildPlan(todos, projects, payload);
      const issue = taskTransitionIssue(payload.pmo, after.all.find(task => task.id === id), safe.state, after.all);
      if (issue) throw new Error(issue);
    }
    if ((safe.state && safe.state !== 'doing') || safe.archived) {
      if (payload.focusId === id) payload.focusId = null;
    }
    if (safe.state === 'doing') {
      if (payload.focusId && payload.focusId !== id && before.all.find(task => task.id === payload.focusId)?.state === 'doing') {
        payload.overrides[payload.focusId] = {...payload.overrides[payload.focusId], state: 'ready'};
      }
      payload.focusId = id;
      // Choosing “doing” in the editor starts focus too. Merely editing an
      // already-doing item preserves its manually chosen position.
      if (previous.state !== 'doing') {
        const current = buildPlan(todos, projects, payload).priority.map(task => task.id);
        if (current.includes(id)) {
          const combined = [...current, ...payload.order.filter(taskId => !current.includes(taskId))];
          payload.order = moveBefore(combined, id, current.find(taskId => taskId !== id) || null);
        }
      }
      if (payload.pmo.enabled && previous.state !== 'doing') {
        const focused = buildPlan(todos, projects, payload);
        const task = focused.all.find(item => item.id === id)!;
        if (task.estimateMinutes > payload.dailyMinutes) throw new Error('这项任务的预算超过今日容量，请先拆分任务或调整今日容量。');
        if (!focused.dailyFocus.some(item => item.id === id)) throw new Error('这项任务尚未进入今日聚焦，请先调整执行顺序或项目优先级。');
      }
    }
  });
}

export const usePlannerStore = create<PlannerStore>(() => ({
  payload: emptyPlanner(), revision: 0, initialized: false, loading: false, saving: false,
  dirty: false, error: '', conflict: false, canUndo: false,
  initialize,
  addTask: input => {
    const details = typeof input === 'string' ? {title: input} : input;
    const title = details.title.trim().slice(0, 300);
    if (!title) return '';
    const id = newId('local:');
    const at = new Date().toISOString();
    change('新增事项', payload => {
      const project = payload.pmo.projects.find(item => item.id === details.projectId);
      if (payload.pmo.enabled && project?.scopeFrozen && details.scope === 'committed') throw new Error('本轮范围已冻结，请先把新需求保存为候选，再申请纳入。');
      payload.localTasks.push({...sanitizeTaskMeta(details), id, title,
        ...(payload.pmo.enabled ? {scope: details.scope || 'candidate'} : {}),
        state: details.state || (payload.pmo.enabled ? 'inbox' : 'ready'), priority: details.priority || 'medium', createdAt: at, updatedAt: at});
      if (details.state === 'doing' || details.state === 'done') {
        const {todos, projects} = useAppStore.getState();
        const plan = buildPlan(todos, projects, payload);
        const issue = taskTransitionIssue(payload.pmo, plan.all.find(task => task.id === id), details.state, plan.all);
        if (issue) throw new Error(issue);
        if (payload.pmo.enabled && details.state === 'doing') {
          const task = plan.all.find(item => item.id === id)!;
          if (task.estimateMinutes > payload.dailyMinutes || !plan.dailyFocus.some(item => item.id === id)) throw new Error('新事项尚未进入今日容量内，请先保存为候选并安排执行顺序。');
          if (payload.focusId && plan.all.find(item => item.id === payload.focusId)?.state === 'doing') payload.overrides[payload.focusId] = {...payload.overrides[payload.focusId], state: 'ready'};
          payload.focusId = id;
        }
      }
    });
    return id;
  },
  updateTask,
  setTaskState: (id, state) => updateTask(id, {state, archived: state === 'archived'}),
  focus: id => change(id ? '开始专注' : '结束专注', payload => {
    const {todos, projects} = useAppStore.getState();
    const before = buildPlan(todos, projects, payload);
    const current = before.priority.map(item => item.id);
    if (id && !current.includes(id)) return;
    if (id) {
      const issue = taskTransitionIssue(payload.pmo, before.all.find(task => task.id === id), 'doing', before.all);
      if (issue) throw new Error(issue);
    }
    if (payload.focusId && payload.focusId !== id && before.all.find(task => task.id === payload.focusId)?.state === 'doing') {
      payload.overrides[payload.focusId] = {...payload.overrides[payload.focusId], state: 'ready'};
    }
    payload.focusId = id;
    if (id) {
      payload.overrides[id] = {...payload.overrides[id], state: 'doing'};
      const combined = [...current, ...payload.order.filter(item => !current.includes(item))];
      payload.order = moveBefore(combined, id, current.find(item => item !== id) || null);
      if (payload.pmo.enabled) {
        const focused = buildPlan(todos, projects, payload);
        const task = focused.all.find(item => item.id === id)!;
        if (task.estimateMinutes > payload.dailyMinutes) throw new Error('这项任务的预算超过今日容量，请先拆分任务或调整今日容量。');
        if (!focused.dailyFocus.some(item => item.id === id)) throw new Error('这项任务尚未进入今日聚焦，请先调整执行顺序或项目优先级。');
      }
    }
  }),
  moveTask: (id, beforeId = null) => change('调整执行顺序', payload => {
    const {todos, projects} = useAppStore.getState();
    const plan = buildPlan(todos, projects, payload);
    const current = plan.priority.map(item => item.id);
    // A task can be completed/removed while a drag is in progress. Do not
    // reintroduce it, or fabricate a target when that stale gesture finishes.
    if (!current.includes(id) || beforeId && !current.includes(beforeId)) return;
    if (payload.pmo.enabled && beforeId) {
      const from = plan.all.find(task => task.id === id), target = plan.all.find(task => task.id === beforeId);
      if (from && target && projectTier(from, payload.pmo.projects) !== projectTier(target, payload.pmo.projects)) throw new Error('当前按项目优先级安排；跨项目调整请先修改项目优先级。');
    }
    const combined = [...current, ...payload.order.filter(item => !current.includes(item))];
    payload.order = moveBefore(combined, id, beforeId);
  }),
  setDailyMinutes: minutes => change('调整今日容量', payload => {
    payload.dailyMinutes = Number.isFinite(minutes) ? Math.max(0, Math.min(1440, Math.round(minutes))) : payload.dailyMinutes;
  }),
  updateProject: (id, patch) => change('调整项目安排', payload => { payload.pmo = patchProject(payload.pmo, id, patch); }),
  replaceMainProject: (id, reason, patch) => change('更换主线并暂停原主线', payload => {payload.pmo = replaceMain(payload.pmo, id, reason, patch);}),
  setWeeklyCapacity: minutes => change('调整每周容量', payload => {
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 10080) throw new Error('每周可用时间须在 0 到 10080 分钟之间。');
    payload.pmo.weeklyCapacityMinutes = Math.round(minutes);
    const issue = projectPolicyIssue(payload.pmo); if (issue) throw new Error(issue);
  }),
  requestScopeChange: (projectId, taskId, reason) => {
    let id = newId('scope:');
    change('申请新增范围', payload => {
      const {todos, projects} = useAppStore.getState();
      const task = buildPlan(todos, projects, payload).all.find(item => item.id === taskId);
      if (!task || task.projectId !== projectId) throw new Error('事项归属已变化，请先保存正确的项目。');
      if (task.scope === 'committed') throw new Error('这项事项已在本轮范围内。新增目标请另建候选事项。');
      const result = proposeScopeChange(payload.pmo, projectId, taskId, reason, id);
      payload.pmo = result.pmo; id = result.id;
    });
    return id;
  },
  decideScopeChange: (id, approved, reason) => change(approved ? '采纳范围申请' : '拒绝范围申请', payload => {
    const request = payload.pmo.scopeChanges.find(item => item.id === id);
    if (!request) throw new Error('范围申请已不存在，请刷新。');
    const {todos, projects} = useAppStore.getState();
    const task = buildPlan(todos, projects, payload).all.find(item => item.id === request.taskId);
    if (approved && (!task || task.projectId !== request.projectId || ['done', 'archived'].includes(task.state))) throw new Error('事项已移动、完成或归档，请重新评审范围。');
    payload.pmo = decideScope(payload.pmo, id, approved, reason);
    if (approved && task) payload.overrides[task.id] = {...payload.overrides[task.id], scope: 'committed', ...(task.state === 'inbox' ? {state: 'ready'} : {})};
  }),
  recordReview: input => {
    const id = newId('review:');
    change('记录评审与复盘', payload => {payload.pmo = addReviewRecord(payload.pmo, input, id);});
    return id;
  },
  decideReview: (id, accepted, reason) => change(accepted ? '采纳助理排序建议' : '拒绝助理排序建议', payload => {
    const {todos, projects} = useAppStore.getState();
    const plan = buildPlan(todos, projects, payload);
    const decision = decidePriorityReview(payload.pmo, id, accepted, reason, plan.priority.map(task => task.id), plan.all);
    payload.pmo = decision.pmo;
    if (decision.order) payload.order = [...decision.order, ...payload.order.filter(taskId => !decision.order!.includes(taskId))];
  }),
  undo: () => {
    const state = usePlannerStore.getState();
    if (!state.canUndo || !state.initialized || state.loading) return;
    const payload = undoPlanner(state.payload);
    usePlannerStore.setState({payload, dirty: true, canUndo: canUndo(payload), error: state.conflict ? state.error : ''});
    backup(); if (!state.conflict) scheduleSave();
  },
  retrySave: async () => {
    if (!usePlannerStore.getState().initialized) {await initialize(); return;}
    if (savePromise) await savePromise;
    try {
      const remote = await loadPlannerSnapshot();
      const current = usePlannerStore.getState();
      if (remote.revision !== current.revision || current.conflict) {
        const merged = rebasePlanner(base.payload, current.payload, remote.payload);
        if (merged.conflicts.length) {
          usePlannerStore.setState({conflict: true, error: '同一安排已在别处修改：' + merged.conflicts.slice(0, 3).join('、') + '。本地草稿已保留，请重新载入后调整。'});
          backup(); return;
        }
        base = remote;
        usePlannerStore.setState({payload: merged.payload, revision: remote.revision, dirty: true, conflict: false, error: '', canUndo: canUndo(merged.payload)});
      } else usePlannerStore.setState({conflict: false, error: ''});
      await flush();
    } catch (error) {usePlannerStore.setState({error: '仍未保存：' + message(error)});}
  },
  reload: async () => {
    clearTimeout(saveTimer);
    mutationsDuringLoad = [];
    usePlannerStore.setState({loading: true});
    if (savePromise) await savePromise;
    try {
      const remote = await loadPlannerSnapshot();
      base = remote;
      let payload = remote.payload;
      const dirty = mutationsDuringLoad.length > 0;
      for (const operation of mutationsDuringLoad) payload = operation(payload);
      mutationsDuringLoad = [];
      usePlannerStore.setState({payload, revision: remote.revision, initialized: true, loading: false, dirty, error: '', conflict: false, canUndo: canUndo(payload)});
      backup();
      if (dirty) scheduleSave();
    } catch (error) {usePlannerStore.setState({loading: false, error: '无法重新载入：' + message(error)});}
  },
}));
