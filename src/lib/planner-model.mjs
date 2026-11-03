import {normalizePmo, sanitizePmoTaskMeta, pmoTaskBlockReason, portfolioSummary, scorePriority, projectTier} from './pmo-model.mjs';

const STATES = new Set(['inbox', 'ready', 'doing', 'waiting', 'review', 'done', 'archived']);
const PRIORITIES = new Set(['high', 'medium', 'low']);
const HISTORY_LIMIT = 24;
const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, limit = 4000) => typeof value === 'string' ? value.slice(0, limit) : '';
const list = (value, limit = 1000) => Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v).slice(0, limit))] : [];
const priority = value => PRIORITIES.has(String(value).toLowerCase()) ? String(value).toLowerCase() : 'medium';
const dateValue = value => {
  if (typeof value !== 'string' || !value.trim()) return '';
  const candidate = value.trim();
  return Number.isFinite(Date.parse(candidate)) ? candidate : '';
};
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

export function localDay(value = Date.now()) {
  const day = value instanceof Date ? value : new Date(value);
  return day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
}

export function emptyPlanner() {
  return {schemaVersion: 1, localTasks: [], overrides: {}, order: [], focusId: null, dailyMinutes: 240, pmo: normalizePmo(null), history: []};
}

export function sanitizeTaskMeta(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = {...sanitizePmoTaskMeta(input)};
  for (const key of ['title', 'description', 'waitingReason', 'projectId']) {
    if (own(input, key)) result[key] = text(input[key], key === 'title' ? 300 : 6000);
  }
  if (own(input, 'note') && !own(input, 'description')) result.description = text(input.note, 6000);
  if (own(input, 'priority')) result.priority = priority(input.priority);
  if (STATES.has(input.state)) result.state = input.state;
  if (own(input, 'estimateMinutes')) {
    const minutes = Number(input.estimateMinutes);
    result.estimateMinutes = Number.isFinite(minutes) ? Math.max(5, Math.min(1440, Math.round(minutes))) : 30;
  }
  for (const key of ['dueDate', 'plannedDay', 'earliestStart']) {
    if (own(input, key)) result[key] = dateValue(input[key]);
  }
  if (own(input, 'deadline') && !own(input, 'dueDate')) result.dueDate = dateValue(input.deadline);
  if (own(input, 'notBefore') && !own(input, 'earliestStart')) result.earliestStart = dateValue(input.notBefore);
  if (own(input, 'dependencies')) result.dependencies = list(input.dependencies);
  for (const key of ['pinned', 'archived']) if (own(input, key)) result[key] = input[key] === true;
  return result;
}

function normalizeData(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const result = emptyPlanner();
  const seen = new Set();
  result.localTasks = (Array.isArray(input.localTasks) ? input.localTasks : []).slice(0, 10000)
    .filter(item => {
      if (!item || typeof item.id !== 'string' || !item.id.startsWith('local:') || seen.has(item.id)) return false;
      seen.add(item.id); return true;
    })
    .map(item => ({
      ...sanitizeTaskMeta(item), id: item.id, title: text(item.title, 300) || '未命名事项',
      state: STATES.has(item.state) ? item.state : 'ready', priority: priority(item.priority),
      createdAt: dateValue(item.createdAt) || new Date(0).toISOString(),
      updatedAt: dateValue(item.updatedAt) || dateValue(item.createdAt) || new Date(0).toISOString(),
    }));
  const overrides = input.overrides && typeof input.overrides === 'object' && !Array.isArray(input.overrides) ? input.overrides : {};
  for (const [id, meta] of Object.entries(overrides).slice(0, 15000)) {
    if (id.startsWith('local:') || id.startsWith('notion:')) result.overrides[id] = sanitizeTaskMeta(meta);
  }
  result.order = list(input.order, 15000);
  result.focusId = typeof input.focusId === 'string' ? input.focusId : null;
  const minutes = Number(input.dailyMinutes);
  result.dailyMinutes = Number.isFinite(minutes) ? Math.max(0, Math.min(1440, Math.round(minutes))) : 240;
  result.pmo = normalizePmo(input.pmo);
  return result;
}

export function normalizePlanner(value) {
  const result = normalizeData(value);
  result.history = (Array.isArray(value?.history) ? value.history : []).slice(-HISTORY_LIMIT).map(item => ({
    id: text(item?.id, 150), label: text(item?.label, 200) || '调整安排',
    at: dateValue(item?.at) || new Date(0).toISOString(),
    ...(item?.before && typeof item.before === 'object' ? {before: dataOnly(normalizeData(item.before))} : {}),
  }));
  while (result.history.length > 1 && JSON.stringify(result.history).length > 600000) result.history.shift();
  return result;
}

function dataOnly(payload) {
  const {history, ...data} = payload;
  return clone(data);
}

export function applyPlannerChange(payload, label, mutate, at = new Date().toISOString()) {
  const before = normalizePlanner(payload);
  const draft = clone(before);
  mutate(draft);
  const changed = normalizePlanner(draft);
  if (JSON.stringify(dataOnly(before)) === JSON.stringify(dataOnly(changed))) return before;
  changed.history = [...before.history, {
    id: String(Date.parse(at)) + '-' + Math.random().toString(36).slice(2, 9),
    label: text(label, 200), at, before: dataOnly(before),
  }].slice(-HISTORY_LIMIT);
  return normalizePlanner(changed);
}

export function undoPlanner(payload) {
  const current = normalizePlanner(payload);
  let index = current.history.length - 1;
  while (index >= 0 && !current.history[index].before) index--;
  if (index < 0) return current;
  const restored = normalizeData(current.history[index].before);
  restored.history = current.history.slice(0, index);
  return restored;
}

export function moveBefore(order, id, beforeId = null) {
  if (!id || id === beforeId) return list(order, 15000);
  const next = list(order, 15000).filter(item => item !== id);
  const index = beforeId ? next.indexOf(beforeId) : -1;
  if (beforeId && index < 0) next.push(id, beforeId);
  else next.splice(index < 0 ? next.length : index, 0, id);
  return next;
}

export function rebasePlanner(baseValue, localValue, remoteValue) {
  const base = normalizePlanner(baseValue), local = normalizePlanner(localValue), remote = normalizePlanner(remoteValue);
  const merged = clone(remote);
  const conflicts = [];
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const merge = (original, desired, current, path) => {
    if (equal(original, desired)) return current;
    if (equal(original, current) || equal(desired, current)) return desired;
    conflicts.push(path); return current;
  };
  const baseTasks = new Map(base.localTasks.map(item => [item.id, item]));
  const localTasks = new Map(local.localTasks.map(item => [item.id, item]));
  const remoteTasks = new Map(remote.localTasks.map(item => [item.id, item]));
  merged.localTasks = [...new Set([...remoteTasks.keys(), ...localTasks.keys()])]
    .map(id => merge(baseTasks.get(id), localTasks.get(id), remoteTasks.get(id), '事项 ' + id))
    .filter(Boolean);
  for (const id of new Set([...Object.keys(base.overrides), ...Object.keys(local.overrides), ...Object.keys(remote.overrides)])) {
    const previous = base.overrides[id] || {}, desired = local.overrides[id] || {}, current = remote.overrides[id] || {};
    const fields = {};
    for (const key of new Set([...Object.keys(previous), ...Object.keys(desired), ...Object.keys(current)])) {
      const value = merge(previous[key], desired[key], current[key], id + ' 的 ' + key);
      if (value !== undefined) fields[key] = value;
    }
    if (Object.keys(fields).length) merged.overrides[id] = fields; else delete merged.overrides[id];
  }
  for (const key of ['order', 'focusId', 'dailyMinutes']) merged[key] = merge(base[key], local[key], remote[key], key);
  for (const key of ['enabled', 'weeklyCapacityMinutes', 'focusLimit']) merged.pmo[key] = merge(base.pmo[key], local.pmo[key], remote.pmo[key], 'pmo.' + key);
  for (const key of ['projects', 'scopeChanges', 'reviewRecords']) {
    const previous = new Map(base.pmo[key].map(item => [item.id, item]));
    const desired = new Map(local.pmo[key].map(item => [item.id, item]));
    const current = new Map(remote.pmo[key].map(item => [item.id, item]));
    merged.pmo[key] = [...new Set([...current.keys(), ...desired.keys()])]
      .map(id => merge(previous.get(id), desired.get(id), current.get(id), 'pmo.' + key + '.' + id)).filter(Boolean);
  }
  if (conflicts.length) return {payload: local, conflicts};
  const payload = applyPlannerChange(remote, '恢复未保存的安排', draft => {
    Object.assign(draft, dataOnly(merged));
  });
  return {payload, conflicts: []};
}

function dueFlags(due, now, today) {
  if (!due) return {isOverdue: false, isDueToday: false};
  if (/^\d{4}-\d{2}-\d{2}$/.test(due)) return {isOverdue: due < today, isDueToday: due === today};
  const time = Date.parse(due);
  return {
    isOverdue: Number.isFinite(time) && time < now,
    isDueToday: Number.isFinite(time) && localDay(time) === today,
  };
}

function normalizeItem(base, meta, projects, now, today) {
  const merged = {...base, ...sanitizeTaskMeta(meta)};
  const project = projects.get(merged.projectId);
  const estimateIsDefault = !Number.isFinite(Number(merged.estimateMinutes)) || !own(merged, 'estimateMinutes');
  const due = dateValue(merged.dueDate);
  const flags = dueFlags(due, now, today);
  const earliest = dateValue(merged.earliestStart);
  const planned = dateValue(merged.plannedDay);
  const state = STATES.has(merged.state) ? merged.state : 'ready';
  const deferredStart = Boolean(earliest && (/^\d{4}-\d{2}-\d{2}$/.test(earliest) ? earliest > today : Date.parse(earliest) > now));
  const deferredDay = Boolean(planned && (/^\d{4}-\d{2}-\d{2}$/.test(planned) ? planned > today : localDay(Date.parse(planned)) > today));
  return {
    id: base.id, source: base.source, sourceId: base.sourceId,
    title: text(merged.title, 300) || '未命名事项', state, priority: priority(merged.priority),
    estimateMinutes: estimateIsDefault ? 30 : Math.max(5, Math.min(1440, Math.round(Number(merged.estimateMinutes)))),
    estimateIsDefault, dueDate: due || undefined, deadline: due || undefined,
    plannedDay: planned || undefined, earliestStart: earliest || undefined, notBefore: earliest || undefined,
    dependencies: list(merged.dependencies), description: text(merged.description, 6000), note: text(merged.description, 6000),
    waitingReason: text(merged.waitingReason, 6000), projectId: merged.projectId || undefined, projectName: project?.name,
    acceptanceCriteria: text(merged.acceptanceCriteria, 6000), evidence: text(merged.evidence, 6000), owner: text(merged.owner, 160),
    changeReason: text(merged.changeReason, 6000),
    scope: merged.scope || 'candidate', verification: merged.verification || 'needs_check', sourceRefs: list(merged.sourceRefs, 40),
    pmoPriority: merged.pmoPriority || project?.priority || 'P3', scores: merged.scores, spentMinutes: merged.spentMinutes || 0,
    priorityScore: scorePriority(merged.scores), projectRole: project?.role,
    pinned: merged.pinned === true, archived: merged.archived === true || state === 'archived' || project?.archived === true,
    paused: base.paused === true, createdAt: base.createdAt, updatedAt: merged.updatedAt || base.createdAt,
    reason: '', blockedReason: '', ...flags, scheduled: deferredStart || deferredDay,
    localStateOverride: base.source === 'notion' && own(meta || {}, 'state'),
  };
}

export function buildPlan(todos = [], projects = [], value = emptyPlanner(), clock = Date.now()) {
  const payload = normalizePlanner(value);
  const now = clock instanceof Date ? clock.getTime() : Number(clock);
  const today = localDay(now);
  const projectMap = new Map(projects.map(project => [project.id, project]));
  if (payload.pmo.enabled) for (const project of payload.pmo.projects) projectMap.set(project.id, {...projectMap.get(project.id), ...project});
  const all = [];
  const seen = new Set();
  for (const source of todos) {
    if (!source?.id || seen.has(source.id)) continue;
    seen.add(source.id);
    const id = 'notion:' + source.id;
    const base = {
      id, source: 'notion', sourceId: source.id, title: source.name,
      priority: priority(source.priority), state: source.status ? 'done' : 'ready',
      paused: source.paused === true, projectId: source.projectId, dueDate: source.dueDate,
      createdAt: dateValue(source.createdTime) || new Date(0).toISOString(),
    };
    all.push(normalizeItem(base, payload.overrides[id], projectMap, now, today));
  }
  for (const source of payload.localTasks) {
    all.push(normalizeItem({...source, source: 'local', paused: false}, payload.overrides[source.id], projectMap, now, today));
  }
  const byId = new Map(all.map(task => [task.id, task]));
  const order = new Map(payload.order.map((id, index) => [id, index]));
  const unlocks = new Map();
  for (const task of all) {
    if (task.state === 'done' || task.archived) continue;
    for (const id of task.dependencies) unlocks.set(id, (unlocks.get(id) || 0) + 1);
  }
  for (const task of all) {
    const pmoBlock = payload.pmo.enabled && task.state !== 'done' ? pmoTaskBlockReason(payload.pmo, task) : '';
    if (task.archived) task.blockedReason = '已归档';
    else if (task.paused) task.blockedReason = '来源事项已暂停';
    else if (pmoBlock) task.blockedReason = pmoBlock;
    else if (task.state === 'waiting') task.blockedReason = task.waitingReason || '等待外部条件';
    else if (task.state === 'review') task.blockedReason = '有结果等待你确认';
    else if (task.state === 'inbox') task.blockedReason = '待整理后加入安排';
    else if (task.scheduled) task.blockedReason = task.plannedDay && task.plannedDay.slice(0, 10) > today ? '安排在 ' + task.plannedDay.slice(0, 10) : '尚未到开始时间';
    else {
      const pending = task.dependencies.find(id => byId.get(id)?.state !== 'done');
      if (pending) task.blockedReason = byId.has(pending) ? '先完成：' + byId.get(pending).title : '等待尚未同步的前置事项';
    }
    if (task.state === 'done') task.reason = task.localStateOverride ? '已在 AntDesk 完成，原始记录保留' : '已完成';
    else if (task.blockedReason) task.reason = task.blockedReason;
    else if (task.id === payload.focusId || task.state === 'doing') task.reason = '继续当前事项，减少切换';
    else if (task.pinned) task.reason = '你已置顶，保留这项安排';
    else if (order.has(task.id)) task.reason = '按你调整后的顺序推进';
    else if (task.isOverdue) task.reason = '已到截止时间，先处理交付风险';
    else if (task.isDueToday) task.reason = '今天截止，预留 ' + task.estimateMinutes + ' 分钟';
    else if ((unlocks.get(task.id) || 0) > 0) task.reason = '完成后可推进 ' + unlocks.get(task.id) + ' 项后续事项';
    else if (task.priority === 'high') task.reason = '重要事项，适合优先推进';
    else if (task.estimateMinutes <= 20) task.reason = '约 ' + task.estimateMinutes + ' 分钟，可以利用短空档';
    else task.reason = '当前可推进，预计 ' + task.estimateMinutes + ' 分钟';
  }
  const eligible = task => !task.archived && !task.paused && !task.blockedReason && (task.state === 'ready' || task.state === 'doing');
  const taskRank = task => {
    // Physical position is the explicit priority. Focus, pinned flags and
    // automatic scoring only seed items the user has not arranged yet.
    if (order.has(task.id)) return [0, order.get(task.id)];
    if (task.id === payload.focusId) return [1, 0];
    if (task.state === 'doing') return [2, 0];
    if (task.pinned) return [3, 0];
    const deadlineRank = task.isOverdue ? 0 : task.isDueToday ? 1 : 2;
    if (payload.pmo.enabled) return [4 + deadlineRank, ['P0', 'P1', 'P2', 'P3'].indexOf(task.pmoPriority), -(task.priorityScore ?? -1), {high: 0, medium: 1, low: 2}[task.priority], -(unlocks.get(task.id) || 0)];
    return [4 + deadlineRank, {high: 0, medium: 1, low: 2}[task.priority], -(unlocks.get(task.id) || 0)];
  };
  const rank = task => payload.pmo.enabled ? [projectTier(task, payload.pmo.projects), ...taskRank(task)] : taskRank(task);
  const ordered = all.filter(task => task.state !== 'done' && !task.archived).sort((a, b) => {
    const ar = rank(a), br = rank(b);
    for (let index = 0; index < Math.max(ar.length, br.length); index++) {
      const difference = (ar[index] || 0) - (br[index] || 0);
      if (difference) return difference;
    }
    const dueA = a.dueDate ? Date.parse(a.dueDate) : Infinity;
    const dueB = b.dueDate ? Date.parse(b.dueDate) : Infinity;
    if (dueA !== dueB) return dueA - dueB;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
  });
  // Waiting, inbox and future items retain their place in the same priority
  // list, but moving them upward never bypasses their execution conditions.
  const ready = ordered.filter(eligible);
  let usedMinutes = 0;
  const overflow = [];
  const dailyFocus = [];
  let full = false;
  for (const task of ready) {
    if (full || usedMinutes + task.estimateMinutes > payload.dailyMinutes || payload.pmo.enabled && dailyFocus.length >= payload.pmo.focusLimit) { overflow.push(task); full = true; }
    else { usedMinutes += task.estimateMinutes; dailyFocus.push(task); }
  }
  const visible = all.filter(task => !task.archived);
  const todayQueue = payload.pmo.enabled ? dailyFocus : ready;
  return {
    all, priority: ordered, ready, now: todayQueue[0] || null, next: todayQueue.slice(1, 3),
    dailyFocus: dailyFocus.slice(0, payload.pmo.focusLimit), portfolio: portfolioSummary(payload.pmo),
    waiting: visible.filter(task => task.state !== 'done' && task.state !== 'inbox' && task.state !== 'review' && !task.scheduled && (task.state === 'waiting' || task.paused || task.blockedReason)),
    inbox: visible.filter(task => task.state === 'inbox'),
    done: visible.filter(task => task.state === 'done'),
    review: visible.filter(task => task.state === 'review'),
    scheduled: visible.filter(task => task.scheduled && task.state !== 'done'),
    archived: all.filter(task => task.archived),
    usedMinutes, remainingMinutes: Math.max(0, payload.dailyMinutes - usedMinutes),
    totalMinutes: payload.pmo.enabled ? usedMinutes : ready.reduce((sum, task) => sum + task.estimateMinutes, 0),
    overflow, dailyMinutes: payload.dailyMinutes,
  };
}
