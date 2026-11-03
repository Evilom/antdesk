// Small, offline PMO policy. It produces reasons and proposals; it never calls
// an assistant or turns an assistant's opinion into a human decision.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const text = (value, limit = 6000) => typeof value === 'string' ? value.slice(0, limit) : '';
const choices = (value, values, fallback) => values.includes(value) ? value : fallback;
const integer = (value, fallback, max = 10080) => Number.isFinite(Number(value)) ? Math.max(0, Math.min(max, Math.round(Number(value)))) : fallback;
const strings = (value, limit = 2000) => Array.isArray(value) ? [...new Set(value.filter(v => typeof v === 'string' && v.length && v.length <= 1000).slice(0, limit))] : [];
const timestamp = value => {
  const date = typeof value === 'number' ? new Date(value) : typeof value === 'string' ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
};
const sequence = value => Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.length && v.length <= 1000).slice(0, 15000) : [];
const clone = value => JSON.parse(JSON.stringify(value));
export const SCORE_WEIGHTS = Object.freeze({business: 30, urgency: 25, readiness: 20, efficiency: 15, reuse: 10});
const TIERS = ['P0', 'P1', 'P2', 'P3'];

export function normalizeScores(value) {
  const input = object(value), result = {};
  for (const key of Object.keys(SCORE_WEIGHTS)) {
    const score = Number(input[key]);
    if (Number.isInteger(score) && score >= 1 && score <= 5) result[key] = score;
  }
  return Object.keys(result).length ? result : undefined;
}

export function scorePriority(value) {
  const scores = normalizeScores(value);
  if (!scores || Object.keys(SCORE_WEIGHTS).some(key => !own(scores, key))) return null;
  return Math.round(Object.entries(SCORE_WEIGHTS).reduce((sum, [key, weight]) => sum + scores[key] * weight, 0) / 5);
}

export function sanitizePmoTaskMeta(value) {
  const input = object(value), result = {};
  for (const key of ['acceptanceCriteria', 'evidence', 'owner', 'changeReason']) if (own(input, key)) result[key] = text(input[key], key === 'owner' ? 160 : 6000);
  if (own(input, 'scope')) result.scope = choices(input.scope, ['committed', 'candidate', 'later'], 'candidate');
  if (own(input, 'verification')) result.verification = choices(input.verification, ['confirmed', 'needs_check'], 'needs_check');
  if (own(input, 'sourceRefs')) result.sourceRefs = strings(input.sourceRefs, 40);
  if (own(input, 'pmoPriority')) result.pmoPriority = choices(input.pmoPriority, TIERS, 'P3');
  if (own(input, 'scores')) result.scores = normalizeScores(input.scores) || {};
  if (own(input, 'spentMinutes')) result.spentMinutes = integer(input.spentMinutes, 0, 1000000);
  return result;
}

function normalizeProject(value) {
  const input = object(value);
  return {
    id: text(input.id, 256), name: text(input.name, 200) || '未命名项目',
    role: choices(input.role, ['main', 'support', 'paused'], 'paused'),
    priority: choices(input.priority, TIERS, 'P3'),
    weeklyBudgetMinutes: integer(input.weeklyBudgetMinutes, 0),
    goal: text(input.goal), definitionOfDone: text(input.definitionOfDone),
    scopeFrozen: input.scopeFrozen === true,
    stage: choices(input.stage, ['prototype', 'quality', 'release'], 'prototype'),
    ...(normalizeScores(input.scores) ? {scores: normalizeScores(input.scores)} : {}),
    decisionReason: text(input.decisionReason),
  };
}

function normalizeReview(value) {
  const input = object(value);
  const result = {
    id: text(input.id, 256), kind: choices(input.kind, ['daily', 'weekly', 'task', 'priority'], 'task'),
    text: text(input.text || input.summary, 12000), outcome: choices(input.outcome, ['note', 'accepted', 'changes_requested'], 'note'),
    createdAt: timestamp(input.createdAt),
  };
  for (const key of ['projectId', 'taskId', 'source', 'decisionReason']) if (input[key]) result[key] = text(input[key], key === 'decisionReason' ? 6000 : 256);
  if (input.decidedAt) result.decidedAt = timestamp(input.decidedAt);
  if (result.kind === 'priority') {
    result.status = choices(input.status, ['pending', 'accepted', 'rejected'], 'pending');
    result.baseOrder = sequence(input.baseOrder);
    result.proposedOrder = sequence(input.proposedOrder);
    if (Number.isSafeInteger(input.baseRevision) && input.baseRevision >= 0) result.baseRevision = input.baseRevision;
  }
  return result;
}

export function normalizePmo(value) {
  const input = object(value), projectIds = new Set(), changeIds = new Set(), reviewIds = new Set();
  const reviews = (Array.isArray(input.reviewRecords) ? input.reviewRecords : []).map(normalizeReview)
    .filter(item => item.id && !reviewIds.has(item.id) && reviewIds.add(item.id));
  const pending = reviews.filter(item => item.kind === 'priority' && item.status === 'pending');
  const closed = reviews.filter(item => !(item.kind === 'priority' && item.status === 'pending'));
  const closedSlots = Math.max(0, 200 - pending.length);
  const keepReviews = new Set([...pending, ...(closedSlots ? closed.slice(-closedSlots) : [])].map(item => item.id));
  const changes = (Array.isArray(input.scopeChanges) ? input.scopeChanges : []).map(item => {
    const change = object(item);
    return {id: text(change.id, 256), projectId: text(change.projectId, 256), taskId: text(change.taskId, 256),
      reason: text(change.reason), status: choices(change.status, ['pending', 'approved', 'rejected'], 'pending'),
      createdAt: timestamp(change.createdAt), ...(change.decidedAt ? {decidedAt: timestamp(change.decidedAt)} : {}),
      ...(change.decisionReason ? {decisionReason: text(change.decisionReason)} : {})};
  }).filter(item => item.id && item.projectId && item.taskId && !changeIds.has(item.id) && changeIds.add(item.id));
  const pendingChanges = changes.filter(item => item.status === 'pending'), closedChanges = changes.filter(item => item.status !== 'pending');
  const closedChangeSlots = Math.max(0, 300 - pendingChanges.length);
  const keepChanges = new Set([...pendingChanges, ...(closedChangeSlots ? closedChanges.slice(-closedChangeSlots) : [])].map(item => item.id));
  return {
    enabled: input.enabled === true,
    projects: (Array.isArray(input.projects) ? input.projects : []).slice(0, 200).map(normalizeProject)
      .filter(item => item.id && !projectIds.has(item.id) && projectIds.add(item.id)),
    weeklyCapacityMinutes: integer(input.weeklyCapacityMinutes, 2400),
    focusLimit: Math.max(1, Math.min(3, integer(input.focusLimit, 3, 3))),
    scopeChanges: changes.filter(item => keepChanges.has(item.id)),
    reviewRecords: reviews.filter(item => keepReviews.has(item.id)),
  };
}

export function projectPolicyIssue(value) {
  const pmo = normalizePmo(value);
  if (!pmo.enabled) return '';
  const main = pmo.projects.filter(project => project.role === 'main');
  const supports = pmo.projects.filter(project => project.role === 'support');
  if (main.length !== 1) return '同时保留一个主线项目，请先确定本轮主线。';
  if (supports.length > 2) return '辅助项目最多两个，请先暂停一个项目再启动新项目。';
  const active = [...main, ...supports];
  if (active.some(project => project.weeklyBudgetMinutes <= 0)) return '请为主线和辅助项目填写本周时间预算。';
  if (active.reduce((sum, project) => sum + project.weeklyBudgetMinutes, 0) > pmo.weeklyCapacityMinutes) return '项目预算超过本周可用时间，请先减少投入或暂停项目。';
  return '';
}

export function portfolioSummary(value) {
  const pmo = normalizePmo(value);
  return {main: pmo.projects.find(project => project.role === 'main') || null,
    supports: pmo.projects.filter(project => project.role === 'support'),
    paused: pmo.projects.filter(project => project.role === 'paused'),
    allocatedMinutes: pmo.projects.filter(project => project.role !== 'paused').reduce((sum, project) => sum + project.weeklyBudgetMinutes, 0),
    weeklyCapacityMinutes: pmo.weeklyCapacityMinutes, issue: projectPolicyIssue(pmo)};
}

export function patchProject(value, id, patch) {
  const pmo = normalizePmo(value), previous = pmo.projects.find(project => project.id === id);
  if (!previous) throw new Error('项目已不存在，请刷新项目列表。');
  const next = normalizeProject({...previous, ...object(patch), id: previous.id});
  const changedDecision = ['role', 'priority', 'weeklyBudgetMinutes', 'goal', 'definitionOfDone', 'scopeFrozen', 'stage']
    .some(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]));
  if (changedDecision && !text(patch?.decisionReason).trim()) throw new Error('请写明调整项目安排或范围的原因。');
  pmo.projects = pmo.projects.map(project => project.id === id ? next : project);
  const issue = projectPolicyIssue(pmo);
  if (issue) throw new Error(issue);
  return pmo;
}

export function replaceMainProject(value, id, reason, patch = {}) {
  const pmo = normalizePmo(value), next = pmo.projects.find(project => project.id === id);
  if (!next) throw new Error('项目已不存在，请刷新项目列表。');
  if (!text(reason).trim()) throw new Error('更换主线前请说明取舍和原主线的处理方式。');
  for (const project of pmo.projects) {
    if (project.id === id) Object.assign(project, normalizeProject({...project, ...object(patch), id, role: 'main', priority: 'P0', decisionReason: reason}));
    else if (project.role === 'main') {project.role = 'paused'; project.decisionReason = '主线切换：' + text(reason);}
  }
  const issue = projectPolicyIssue(pmo); if (issue) throw new Error(issue);
  return pmo;
}

export function taskAmendmentIssue(value, previous, patch) {
  const pmo = normalizePmo(value);
  if (!pmo.enabled || !previous) return '';
  const project = pmo.projects.find(item => item.id === (patch.projectId ?? previous.projectId));
  if (!project?.scopeFrozen) return '';
  if ((patch.scope ?? previous.scope) === 'committed' && (previous.scope !== 'committed' || project.id !== previous.projectId)) return '本轮范围已冻结。先保存为候选事项，再提交范围申请，由你决定是否纳入。';
  const changed = ['title', 'description', 'acceptanceCriteria', 'estimateMinutes'].some(key => own(patch, key) && patch[key] !== previous[key]);
  if (previous.scope === 'committed' && changed && !text(patch.changeReason).trim()) return '本轮目标、验收或预算已冻结。请填写本次调整理由，再由你确认保存。';
  return '';
}

export function pmoTaskBlockReason(value, task) {
  const pmo = normalizePmo(value);
  if (!pmo.enabled) return '';
  const issue = projectPolicyIssue(pmo);
  if (issue) return issue;
  const project = pmo.projects.find(item => item.id === task.projectId);
  if (!project) return '请先将该事项归入项目，再排入本期计划。';
  if (project.role === 'paused') return '所属项目已暂停。';
  if (task.scope !== 'committed') return task.scope === 'later' ? '属于暂缓储备事项，暂不启动。' : project.scopeFrozen ? '当前项目范围已冻结，需先提交申请加入本期。' : '请先确认将该事项排入本期计划。';
  if (!text(task.acceptanceCriteria).trim()) return '请先补充验收标准 (DoD)。';
  if (task.estimateIsDefault === true || !Number.isFinite(Number(task.estimateMinutes)) || Number(task.estimateMinutes) <= 0) return '请先填写时间预算（预估耗时）。';
  return '';
}

export function taskTransitionIssue(value, task, targetState, allTasks = []) {
  const pmo = normalizePmo(value);
  if (!pmo.enabled || !['doing', 'done'].includes(targetState)) return '';
  if (!task) return '事项已不存在，请重新加载。';
  if (targetState === 'done') return text(task.evidence).trim() ? '' : '标记完成前，请补充验收证据（如截图、版本号或测试记录）。';
  const issue = pmoTaskBlockReason(pmo, task);
  if (issue) return issue;
  if (task.archived || task.paused) return '这项事项已归档或暂停，不能直接开始。';
  if (task.scheduled) return '这项事项尚未到安排的开始时间。';
  const state = task.state || task.stage;
  if (['waiting', 'review', 'inbox', 'done', 'archived'].includes(state)) return '先处理当前等待、验收或整理状态，再开始执行。';
  const pending = (task.dependencies || []).find(id => !allTasks.some(item => item.id === id && (item.state || item.stage) === 'done'));
  if (pending) return '前置事项尚未完成，请先处理依赖。';
  if (Number(task.spentMinutes || 0) >= Number(task.estimateMinutes)) return '已用完本项时间预算，请先复盘、缩小范围或明确调整预算。';
  return '';
}

export function proposeScopeChange(value, projectId, taskId, reason, id, at = new Date().toISOString()) {
  const pmo = normalizePmo(value);
  if (!pmo.enabled || !pmo.projects.some(project => project.id === projectId)) throw new Error('先为事项选择一个受管理的项目。');
  if (!text(reason).trim()) throw new Error('请说明新增范围的价值、必要性和影响。');
  const existing = pmo.scopeChanges.find(change => change.taskId === taskId && change.projectId === projectId && change.status === 'pending');
  if (existing) return {pmo, id: existing.id};
  if (pmo.scopeChanges.filter(change => change.status === 'pending').length >= 300) throw new Error('待处理范围申请已达上限，请先处理已有申请。');
  const change = {id: text(id, 256), projectId, taskId, reason: text(reason), status: 'pending', createdAt: timestamp(at)};
  if (!change.id || !change.taskId) throw new Error('范围申请缺少事项编号。');
  pmo.scopeChanges.push(change);
  return {pmo: normalizePmo(pmo), id: change.id};
}

export function decideScopeChange(value, id, approved, decisionReason, at = new Date().toISOString()) {
  const pmo = normalizePmo(value), change = pmo.scopeChanges.find(item => item.id === id);
  if (!change || change.status !== 'pending') throw new Error('这项范围申请已处理或不存在，请刷新。');
  if (!text(decisionReason).trim()) throw new Error('请记录采纳或拒绝这次范围变更的理由。');
  change.status = approved ? 'approved' : 'rejected'; change.decisionReason = text(decisionReason); change.decidedAt = timestamp(at);
  return pmo;
}

export function addReviewRecord(value, input, id, at = new Date().toISOString()) {
  const pmo = normalizePmo(value);
  if (!text(input?.text).trim()) throw new Error('请记录本次评审的结论、阻塞或下一步。');
  const record = normalizeReview({...object(input), id, createdAt: at});
  if (pmo.reviewRecords.some(item => item.id === record.id)) throw new Error('这条评审记录已经存在。');
  if (pmo.reviewRecords.filter(item => item.kind === 'priority' && item.status === 'pending').length >= 200) throw new Error('待处理排序建议已达上限，请先采纳或拒绝已有建议，再保存新的评审记录。');
  if (record.kind === 'priority') {
    record.status = 'pending'; record.outcome = 'note';
    const issue = priorityProposalIssue(record, record.baseOrder);
    if (issue) throw new Error(issue);
  }
  pmo.reviewRecords.push(record);
  return normalizePmo(pmo);
}

export function projectTier(task, projects) {
  const project = projects.find(item => item.id === task.projectId);
  if (!project) return 4;
  return TIERS.indexOf(project.priority);
}

export function priorityProposalIssue(record, currentOrder, tasks = [], projects = []) {
  if (!record || record.kind !== 'priority' || record.status !== 'pending') return '这份排序建议已处理或不存在。';
  if (!Array.isArray(record.baseOrder) || JSON.stringify(record.baseOrder) !== JSON.stringify(currentOrder)) return '队列已发生变化，这份建议已过期，请重新评审。';
  const proposed = record.proposedOrder;
  if (!Array.isArray(proposed) || proposed.length !== currentOrder.length || new Set(proposed).size !== proposed.length || proposed.some(id => !currentOrder.includes(id))) return '排序建议必须完整保留当前事项，不能增加、遗漏或重复事项。';
  if (tasks.length && projects.length) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    let last = -1;
    for (const id of proposed) {
      const task = byId.get(id);
      if (!task) return '事项已经变化，请重新评审。';
      const tier = projectTier(task, projects);
      if (tier < last) return '这份建议跨越了项目优先级。请先由你调整项目优先级，再重新评审。';
      last = tier;
    }
  }
  return '';
}

export function decidePriorityReview(value, id, accepted, reason, currentOrder, tasks = [], at = new Date().toISOString()) {
  const pmo = normalizePmo(value), record = pmo.reviewRecords.find(item => item.id === id);
  if (!record || record.kind !== 'priority' || record.status !== 'pending') throw new Error('这份排序建议已处理或不存在。');
  if (!text(reason).trim()) throw new Error('请记录采纳或拒绝排序建议的理由。');
  if (accepted) {
    const issue = priorityProposalIssue(record, currentOrder, tasks, pmo.projects);
    if (issue) throw new Error(issue);
  }
  record.status = accepted ? 'accepted' : 'rejected'; record.outcome = accepted ? 'accepted' : 'changes_requested';
  record.decisionReason = text(reason); record.decidedAt = timestamp(at);
  return {pmo, order: accepted ? clone(record.proposedOrder) : null};
}
