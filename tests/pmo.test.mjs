import {test} from 'node:test';
import assert from 'node:assert/strict';
import {emptyPlanner, normalizePlanner, buildPlan, applyPlannerChange, undoPlanner, rebasePlanner} from '../src/lib/planner-model.mjs';
import {
  normalizePmo, scorePriority, patchProject, replaceMainProject, projectPolicyIssue,
  taskTransitionIssue, taskAmendmentIssue, proposeScopeChange, decideScopeChange,
  addReviewRecord, priorityProposalIssue, decidePriorityReview,
} from '../src/lib/pmo-model.mjs';

const at = '2026-11-03T04:00:00.000Z';
const NOW = new Date(at).getTime();
const project = (id, role = 'paused', priority = 'P3', minutes = 0) => ({id, name: id, role, priority, weeklyBudgetMinutes: minutes,
  goal: '完成本轮交付', definitionOfDone: '记录可运行包和验收结果', scopeFrozen: true, stage: 'release', decisionReason: '本轮聚焦'});
const pmo = () => normalizePmo({enabled: true, weeklyCapacityMinutes: 2400, projects: [
  project('pmo:main', 'main', 'P0', 1920), project('pmo:tool', 'support', 'P1', 240),
  project('pmo:wrap', 'support', 'P2', 240), project('pmo:parked')], reviewRecords: [], scopeChanges: []});
const task = (id, overrides = {}) => ({id: 'local:' + id, title: id, state: 'ready', priority: 'medium', projectId: 'pmo:main',
  scope: 'committed', acceptanceCriteria: '核对真实流程并保存证据', estimateMinutes: 60, owner: '我',
  createdAt: at, updatedAt: at, ...overrides});
const payload = (...tasks) => ({...emptyPlanner(), pmo: pmo(), localTasks: tasks});
const plan = value => buildPlan([], [], value, NOW);
const ids = tasks => tasks.map(item => item.id);
const proposal = (order, proposed = order) => ({id: 'review:priority', kind: 'priority', source: '助理 MCP',
  text: '先完成可验收事项', outcome: 'note', status: 'pending', baseOrder: order, proposedOrder: proposed, createdAt: NOW, baseRevision: 25});

test('five explicit ratings produce the agreed weighted score; missing ratings stay unscored', () => {
  assert.equal(scorePriority({business: 5, urgency: 5, readiness: 4, efficiency: 4, reuse: 4}), 91);
  assert.equal(scorePriority(undefined), null);
  assert.equal(scorePriority({business: 5, urgency: 5}), null);
  assert.equal(scorePriority({business: 6, urgency: 5, readiness: 4, efficiency: 4, reuse: 4}), null);
  assert.equal(scorePriority({business: 1, urgency: 1, readiness: 1, efficiency: 1, reuse: 1}), 20);
});

test('PMO metadata survives serialization, undo and independent merge with a new assistant proposal', () => {
  const base = payload(task('one', {sourceRefs: ['docs/acceptance.md'], verification: 'needs_check', spentMinutes: 15}));
  const local = applyPlannerChange(base, '调整负责人', draft => {draft.overrides['local:one'] = {owner: '制作人', evidence: '录屏已核对'};});
  const remote = applyPlannerChange(base, '接收排序意见', draft => {draft.pmo.reviewRecords.push(proposal(['local:one']));});
  const rebased = rebasePlanner(base, local, remote);
  assert.deepEqual(rebased.conflicts, []);
  const taskView = plan(JSON.parse(JSON.stringify(rebased.payload))).all[0];
  assert.equal(taskView.owner, '制作人'); assert.equal(taskView.evidence, '录屏已核对');
  assert.deepEqual(taskView.sourceRefs, ['docs/acceptance.md']);
  assert.equal(taskView.spentMinutes, 15); assert.equal(taskView.priorityScore, null);
  assert.equal(rebased.payload.pmo.reviewRecords[0].createdAt, at);
  assert.deepEqual(undoPlanner(rebased.payload), normalizePlanner(remote));
});

test('pending ideas, parked projects and unassigned work cannot become today by dragging', () => {
  const value = payload(task('main'), task('candidate', {scope: 'candidate'}), task('later', {scope: 'later'}),
    task('paused', {projectId: 'pmo:parked'}), task('unassigned', {projectId: ''}), task('no-criteria', {acceptanceCriteria: ''}));
  value.order = ['local:paused', 'local:candidate', 'local:later', 'local:unassigned', 'local:no-criteria', 'local:main'];
  const result = plan(value);
  assert.deepEqual(ids(result.ready), ['local:main']);
  assert.equal(result.now.id, 'local:main');
  assert.match(result.all.find(item => item.id === 'local:candidate').blockedReason, /范围已冻结/);
  assert.match(result.all.find(item => item.id === 'local:paused').blockedReason, /暂停/);
  assert.match(result.all.find(item => item.id === 'local:unassigned').blockedReason, /归入项目/);
});

test('project priority precedes manual order while task order inside a project remains explicit', () => {
  const value = payload(task('a'), task('b'), task('tool', {projectId: 'pmo:tool'}), task('wrap', {projectId: 'pmo:wrap'}));
  value.order = ['local:wrap', 'local:tool', 'local:b', 'local:a'];
  assert.deepEqual(ids(plan(value).priority), ['local:b', 'local:a', 'local:tool', 'local:wrap']);
  assert.equal(plan(value).portfolio.main.id, 'pmo:main');
  assert.equal(plan(value).portfolio.allocatedMinutes, 2400);
});

test('unarranged tasks use supplied scores but do not fabricate a score for an unrated task', () => {
  const high = {business: 5, urgency: 5, readiness: 4, efficiency: 4, reuse: 4};
  const low = {business: 2, urgency: 2, readiness: 2, efficiency: 2, reuse: 2};
  const result = plan(payload(task('none'), task('low', {scores: low}), task('high', {scores: high})));
  assert.deepEqual(ids(result.ready), ['local:high', 'local:low', 'local:none']);
  assert.equal(result.all.find(item => item.id === 'local:none').priorityScore, null);
});

test('today contains at most three items and a capacity-bounded prefix, not the entire backlog', () => {
  const value = payload(task('a'), task('b'), task('c'), task('d'));
  value.order = ids(value.localTasks);
  assert.deepEqual(ids(plan(value).dailyFocus), ['local:a', 'local:b', 'local:c']);
  assert.equal(plan(value).ready.length, 4); assert.equal(plan(value).totalMinutes, 180);
  value.dailyMinutes = 90;
  assert.deepEqual(ids(plan(value).dailyFocus), ['local:a']);
  assert.deepEqual(ids(plan(value).overflow), ['local:b', 'local:c', 'local:d']);
  value.dailyMinutes = 30;
  assert.deepEqual(plan(value).dailyFocus, []); assert.equal(plan(value).now, null);
  assert.deepEqual(plan(value).next, []);
});

test('old data with PMO disabled retains legacy queue and does not require invented metadata', () => {
  const value = emptyPlanner(); value.localTasks = [task('old', {projectId: '', acceptanceCriteria: '', scope: undefined})];
  assert.equal(plan(value).now.id, 'local:old');
  assert.equal(taskTransitionIssue(value.pmo, plan(value).now, 'done'), '');
});

test('dependencies still block committed work; an unknown duration is not an explicit budget', () => {
  const unknown = task('unknown'); delete unknown.estimateMinutes;
  const value = payload(task('first'), task('blocked', {dependencies: ['local:first']}), unknown);
  const result = plan(value);
  assert.deepEqual(ids(result.ready), ['local:first']);
  assert.match(result.all.find(item => item.id === 'local:unknown').blockedReason, /时间预算/);
  assert.match(taskTransitionIssue(value.pmo, result.all.find(item => item.id === 'local:blocked'), 'doing', result.all), /前置/);
  value.overrides['local:first'] = {state: 'done', evidence: '已核对'};
  assert.deepEqual(ids(plan(value).ready), ['local:blocked']);
});

test('task transitions require completion evidence and prevent work continuing past its stated budget', () => {
  const value = payload(task('one'));
  const item = plan(value).all[0];
  assert.equal(taskTransitionIssue(value.pmo, item, 'doing', [item]), '');
  assert.match(taskTransitionIssue(value.pmo, item, 'done'), /验收证据/);
  assert.equal(taskTransitionIssue(value.pmo, {...item, evidence: '录屏与构建已验收'}, 'done'), '');
  assert.match(taskTransitionIssue(value.pmo, {...item, spentMinutes: 60}, 'doing', [item]), /用完/);
  assert.match(taskTransitionIssue(value.pmo, {...item, scheduled: true}, 'doing', [item]), /开始时间/);
  assert.match(taskTransitionIssue(value.pmo, {...item, state: 'review'}, 'doing', [item]), /验收/);
});

test('frozen committed tasks cannot silently move the finish line and old reasons cannot authorize another edit', () => {
  const previous = task('one', {changeReason: '以前的修改理由'});
  assert.match(taskAmendmentIssue(pmo(), previous, {acceptanceCriteria: '多做十个系统'}), /本次调整理由/);
  assert.match(taskAmendmentIssue(pmo(), previous, {estimateMinutes: 600}), /本次调整理由/);
  assert.equal(taskAmendmentIssue(pmo(), previous, {estimateMinutes: 90, changeReason: '实测需补30分钟并保持范围'}), '');
  assert.equal(taskAmendmentIssue(pmo(), previous, {evidence: '截图', spentMinutes: 45}), '');
  assert.match(taskAmendmentIssue(pmo(), task('idea', {scope: 'candidate'}), {scope: 'committed', changeReason: '有理由'}), /范围申请/);
});

test('scope requests are durable, require a reason and have a single explicit decision', () => {
  assert.throws(() => proposeScopeChange(pmo(), 'pmo:main', 'local:idea', '', 'scope:1'), /说明/);
  const first = proposeScopeChange(pmo(), 'pmo:main', 'local:idea', '修复已验证的发布阻塞', 'scope:1', at);
  const repeat = proposeScopeChange(first.pmo, 'pmo:main', 'local:idea', '重复', 'scope:2', at);
  assert.equal(repeat.id, 'scope:1'); assert.equal(repeat.pmo.scopeChanges.length, 1);
  assert.throws(() => decideScopeChange(first.pmo, 'scope:1', true, ''), /理由/);
  const approved = decideScopeChange(first.pmo, 'scope:1', true, '占用本周预留修复时间', at);
  assert.equal(approved.scopeChanges[0].status, 'approved');
  assert.equal(first.pmo.scopeChanges[0].status, 'pending');
  assert.throws(() => decideScopeChange(approved, 'scope:1', true, '再次'), /已处理/);
});

test('project edits enforce one main, at most two supports, a reason and the weekly budget', () => {
  assert.throws(() => patchProject(pmo(), 'pmo:tool', {role: 'main', decisionReason: '新想法'}), /一个主线/);
  assert.throws(() => patchProject(pmo(), 'pmo:parked', {role: 'support', weeklyBudgetMinutes: 60, decisionReason: '想启动'}), /最多两个/);
  assert.throws(() => patchProject(pmo(), 'pmo:tool', {weeklyBudgetMinutes: 600, decisionReason: '增加'}), /超过本周/);
  assert.throws(() => patchProject(pmo(), 'pmo:main', {scopeFrozen: false}), /原因/);
  const paused = patchProject(pmo(), 'pmo:wrap', {role: 'paused', decisionReason: '优先主线'});
  assert.equal(projectPolicyIssue(paused), '');
  assert.equal(pmo().projects.find(item => item.id === 'pmo:wrap').role, 'support');
});

test('a deliberate main-project replacement is atomic and can include its new weekly budget', () => {
  const original = pmo();
  const changed = replaceMainProject(original, 'pmo:parked', '线上紧急交付，原主线暂停一天', {weeklyBudgetMinutes: 1920});
  assert.equal(changed.projects.filter(item => item.role === 'main').length, 1);
  assert.equal(changed.projects.find(item => item.id === 'pmo:parked').priority, 'P0');
  assert.equal(changed.projects.find(item => item.id === 'pmo:main').role, 'paused');
  assert.equal(original.projects.find(item => item.id === 'pmo:main').role, 'main');
});

test('invalid imported portfolios are visible and block execution rather than silently choosing a winner', () => {
  const value = payload(task('one'));
  value.pmo.projects[1].role = 'main';
  const result = plan(value);
  assert.equal(normalizePlanner(value).pmo.projects.filter(item => item.role === 'main').length, 2);
  assert.deepEqual(result.ready, []); assert.match(result.portfolio.issue, /一个主线/);
});

test('assistant ordering is a proposal, requires a human reason and refuses stale or incomplete queues', () => {
  const order = ['local:a', 'local:b'];
  const record = proposal(order, [...order].reverse());
  let state = pmo(); state.reviewRecords = [record];
  assert.equal(priorityProposalIssue(record, order), '');
  assert.match(priorityProposalIssue(record, [...order].reverse()), /过期/);
  assert.match(priorityProposalIssue({...record, proposedOrder: ['local:a']}, order), /完整保留/);
  assert.match(priorityProposalIssue({...record, proposedOrder: ['local:a', 'local:a']}, order), /重复/);
  assert.throws(() => decidePriorityReview(state, record.id, true, '', order), /理由/);
  const accepted = decidePriorityReview(state, record.id, true, '先收敛验收范围', order, [task('a'), task('b')], at);
  assert.deepEqual(accepted.order, ['local:b', 'local:a']);
  assert.equal(accepted.pmo.reviewRecords[0].status, 'accepted');
  assert.equal(state.reviewRecords[0].status, 'pending');
  assert.throws(() => decidePriorityReview(state, record.id, true, '仍采纳', ['local:a']), /过期/);
  assert.equal(decidePriorityReview(state, record.id, false, '队列已变化', ['local:a'], [], at).order, null);
});

test('an assistant priority proposal cannot push a supporting project ahead of the main project', () => {
  const order = ['local:a', 'local:tool'];
  const value = pmo(), record = proposal(order, ['local:tool', 'local:a']);
  value.reviewRecords = [record];
  assert.throws(() => decidePriorityReview(value, record.id, true, '采纳', order,
    [task('a'), task('tool', {projectId: 'pmo:tool'})], at), /项目优先级/);
});

test('numeric server timestamps normalize and pending proposals survive history trimming', () => {
  const records = [proposal(['local:a'])];
  for (let i = 0; i < 250; i++) records.push({id: 'review:' + i, kind: 'daily', text: '当日复盘', outcome: 'note', createdAt: NOW + i});
  const normalized = normalizePmo({...pmo(), reviewRecords: records});
  assert.equal(normalized.reviewRecords.length, 200);
  assert.equal(normalized.reviewRecords[0].id, 'review:priority');
  assert.equal(normalized.reviewRecords[0].createdAt, at);
  const full = {...pmo(), reviewRecords: Array.from({length: 200}, (_, i) => ({...proposal(['local:a']), id: 'pending:' + i}))};
  assert.equal(normalizePmo(full).reviewRecords.length, 200);
  assert.throws(() => addReviewRecord(full, {kind: 'priority', text: '建议', outcome: 'note', baseOrder: ['local:a'], proposedOrder: ['local:a']}, 'pending:new', at), /上限/);
});

test('a full pending-review queue cannot report a successful note that normalization would discard', () => {
  const full = {...pmo(), reviewRecords: Array.from({length: 200}, (_, i) => ({...proposal(['local:a']), id: 'pending:' + i}))};
  for (const kind of ['daily', 'weekly', 'task']) {
    assert.throws(() => addReviewRecord(full, {kind, text: '已核对交付证据', outcome: 'note'}, 'review:' + kind, at), /上限/);
  }
  const resolved = decidePriorityReview(full, 'pending:0', false, '先整理现有队列', ['local:a'], [], at).pmo;
  const saved = addReviewRecord(resolved, {kind: 'daily', text: '已核对交付证据', outcome: 'note'}, 'review:daily', at);
  assert.equal(saved.reviewRecords.length, 200);
  assert.equal(saved.reviewRecords.filter(record => record.status === 'pending').length, 199);
  assert.equal(saved.reviewRecords.find(record => record.id === 'review:daily')?.text, '已核对交付证据');
});

test('concurrent project edits and assistant suggestions merge; competing changes to a decision do not', () => {
  const base = payload(task('a'));
  const local = applyPlannerChange(base, '修改项目', draft => {draft.pmo.projects[0].goal = '真机验收';});
  const remote = applyPlannerChange(base, '助理建议', draft => {draft.pmo.reviewRecords.push(proposal(['local:a']));});
  const result = rebasePlanner(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.payload.pmo.projects[0].goal, '真机验收');
  assert.equal(result.payload.pmo.reviewRecords.length, 1);
  const competing = applyPlannerChange(base, '另一个目标', draft => {draft.pmo.projects[0].goal = '扩展新系统';});
  assert.match(rebasePlanner(base, local, competing).conflicts.join(','), /pmo.projects/);
});

test('archived source projects remain archived when their PMO portfolio entry has the same id', () => {
  const value = payload();
  const result = buildPlan([{id: 'source-task', name: '原记录', status: false, priority: 'High', projectId: 'pmo:main'}],
    [{id: 'pmo:main', name: '来源项目', archived: true}], value, NOW);
  assert.equal(result.archived.length, 1); assert.equal(result.now, null);
});

test('pending scope requests cannot be silently trimmed by a long decision history', () => {
  const value = pmo();
  value.scopeChanges = [{id: 'scope:old', projectId: 'pmo:main', taskId: 'local:old', reason: '尚待决策', status: 'pending', createdAt: NOW},
    ...Array.from({length: 350}, (_, i) => ({id: 'scope:closed-' + i, projectId: 'pmo:main', taskId: 'local:' + i,
      reason: '已评审', status: 'rejected', createdAt: NOW + i}))];
  const normalized = normalizePmo(value);
  assert.equal(normalized.scopeChanges.length, 300);
  assert.equal(normalized.scopeChanges[0].id, 'scope:old');
  assert.equal(normalized.scopeChanges[0].createdAt, at);
});
