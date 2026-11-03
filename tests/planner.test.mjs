import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPlannerChange, buildPlan, emptyPlanner, localDay, moveBefore,
  normalizePlanner, rebasePlanner, sanitizeTaskMeta, undoPlanner,
} from '../src/lib/planner-model.mjs';

const NOW = new Date(2026, 10, 2, 12).getTime();
const TODAY = localDay(NOW);
const TOMORROW = localDay(new Date(2026, 10, 3, 12));
const YESTERDAY = localDay(new Date(2026, 10, 1, 12));
const task = (id, meta = {}) => ({
  id: 'local:' + id, title: id, state: 'ready', priority: 'medium',
  createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z', ...meta,
});
const payloadWith = (...tasks) => ({...emptyPlanner(), localTasks: tasks});
const ids = items => items.map(item => item.id);
const plan = (payload, todos = [], projects = [], now = NOW) => buildPlan(todos, projects, payload, now);

test('empty and malformed payloads remain usable offline without demo tasks', () => {
  assert.deepEqual(normalizePlanner(null), emptyPlanner());
  const result = plan(normalizePlanner({localTasks: [null, {id: 'bad'}, task('a'), task('a')], dailyMinutes: -10}));
  assert.equal(result.all.length, 1);
  assert.equal(result.dailyMinutes, 0);
  assert.equal(plan(emptyPlanner()).now, null);
  assert.deepEqual(plan(emptyPlanner()).next, []);
});

test('paused, archived, waiting, review and inbox are never current or next', () => {
  const value = payloadWith(task('waiting', {state: 'waiting', waitingReason: '等客户回复'}), task('review', {state: 'review'}), task('inbox', {state: 'inbox'}), task('archived', {archived: true}), task('open'));
  const todos = [{id: 'paused', name: 'Paused', paused: true, status: false, priority: 'High'}, {id: 'project', name: 'Archived project', status: false, priority: 'High', projectId: 'p'}];
  value.focusId = 'notion:paused';
  value.order = ['notion:paused', 'local:waiting', 'local:archived'];
  const result = plan(value, todos, [{id: 'p', name: 'Old project', archived: true}]);
  assert.deepEqual(ids(result.ready), ['local:open']);
  assert.equal(result.now.id, 'local:open');
  assert.equal(result.waiting.find(t => t.id === 'local:waiting').blockedReason, '等客户回复');
  assert.ok(result.waiting.some(t => t.id === 'notion:paused'));
  assert.equal(result.review.length, 1);
  assert.equal(result.inbox.length, 1);
  assert.equal(result.archived.length, 2);
});

test('future planned days and earliest starts are excluded until their actual time', () => {
  const futureTime = new Date(NOW + 60 * 60_000).toISOString();
  const value = payloadWith(task('tomorrow', {plannedDay: TOMORROW, pinned: true}), task('later', {earliestStart: futureTime}), task('today', {plannedDay: TODAY}), task('late', {plannedDay: YESTERDAY}));
  value.focusId = 'local:tomorrow';
  const result = plan(value);
  assert.deepEqual(new Set(ids(result.ready)), new Set(['local:today', 'local:late']));
  assert.deepEqual(new Set(ids(result.scheduled)), new Set(['local:tomorrow', 'local:later']));
  assert.ok(plan(value, [], [], NOW + 60 * 60_000).ready.some(t => t.id === 'local:later'));
  assert.ok(plan(value, [], [], new Date(2026, 10, 3, 0).getTime()).ready.some(t => t.id === 'local:tomorrow'));
});

test('deadlines are separate from planned dates and date-only deadlines expire at local day boundary', () => {
  const value = payloadWith(task('today', {dueDate: TODAY}), task('yesterday', {dueDate: YESTERDAY}), task('plan', {plannedDay: TODAY}), task('passed-time', {dueDate: new Date(NOW - 1).toISOString()}));
  const result = plan(value);
  assert.equal(result.all.find(t => t.id === 'local:today').isOverdue, false);
  assert.equal(result.all.find(t => t.id === 'local:today').isDueToday, true);
  assert.equal(result.all.find(t => t.id === 'local:yesterday').isOverdue, true);
  assert.equal(result.all.find(t => t.id === 'local:passed-time').isOverdue, true);
  assert.equal(result.all.find(t => t.id === 'local:plan').deadline, undefined);
});

test('missing dependencies and cycles block work, completed dependencies unlock it', () => {
  let value = payloadWith(task('a'), task('b', {dependencies: ['local:a']}), task('missing', {dependencies: ['notion:unseen']}), task('cycle1', {dependencies: ['local:cycle2']}), task('cycle2', {dependencies: ['local:cycle1']}));
  assert.deepEqual(ids(plan(value).ready), ['local:a']);
  assert.match(plan(value).now.reason, /后续事项/);
  value = applyPlannerChange(value, '完成', draft => {draft.overrides['local:a'] = {state: 'done'};});
  assert.deepEqual(ids(plan(value).ready), ['local:b']);
  assert.match(plan(value).waiting.find(t => t.id === 'local:missing').reason, /尚未同步/);
});

test('manual order is authoritative across focus, doing, pinned and new deadlines after reload', () => {
  let value = payloadWith(task('a', {pinned: true}), task('b', {state: 'doing'}), task('c'), task('urgent', {dueDate: YESTERDAY, priority: 'high'}));
  value.order = moveBefore(['local:a', 'local:b', 'local:c'], 'local:c', 'local:a');
  value.focusId = 'local:b';
  value = JSON.parse(JSON.stringify(normalizePlanner(value)));
  const result = plan(value);
  assert.deepEqual(ids(result.priority), ['local:c', 'local:a', 'local:b', 'local:urgent']);
  assert.deepEqual(ids(result.ready), ids(result.priority));
  assert.equal(result.next.length, 2);
  assert.equal(result.now.id, 'local:c');
  assert.match(result.now.reason, /调整后的顺序/);
  assert.equal(result.all.find(t => t.id === 'local:b').state, 'doing');
});

test('one priority list includes waiting, inbox and future work without bypassing conditions', () => {
  let value = payloadWith(task('first'), task('waiting', {state: 'waiting'}), task('inbox', {state: 'inbox'}), task('future', {plannedDay: TOMORROW}), task('blocked', {dependencies: ['local:first']}), task('review', {state: 'review'}), task('done', {state: 'done'}), task('archived', {archived: true}), task('next'));
  value.order = ['local:blocked', 'local:waiting', 'local:inbox', 'local:future', 'local:review', 'local:next', 'local:first', 'local:done', 'local:archived'];
  let result = plan(value);
  assert.deepEqual(ids(result.priority), value.order.slice(0, 7));
  assert.deepEqual(ids(result.ready), ['local:next', 'local:first']);
  value = applyPlannerChange(value, '完成前置', draft => { draft.overrides['local:first'] = {state: 'done'}; });
  result = plan(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(ids(result.ready), ['local:blocked', 'local:next']);
  assert.equal(result.priority[0].id, 'local:blocked');
});

test('focus still seeds the queue before manual arrangement exists', () => {
  const value = payloadWith(task('focused'), task('urgent', {dueDate: YESTERDAY, priority: 'high'}));
  value.focusId = 'local:focused';
  assert.equal(plan(value).now.id, 'local:focused');
  assert.match(plan(value).now.reason, /继续当前/);
});

test('moving a large priority list preserves the full saved order', () => {
  const tasks = Array.from({length: 1100}, (_, index) => task(String(index)));
  const value = payloadWith(...tasks);
  value.order = moveBefore(ids(tasks), 'local:1099', 'local:0');
  const restored = normalizePlanner(JSON.parse(JSON.stringify(value)));
  assert.deepEqual(ids(plan(restored).priority), value.order);
  assert.equal(restored.order.length, 1100);
});

test('manual movement to end retains all positions and duplicates are removed', () => {
  assert.deepEqual(moveBefore(['a', 'b', 'c', 'a'], 'a', null), ['b', 'c', 'a']);
  assert.deepEqual(moveBefore(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveBefore(['a', 'b'], 'a', 'a'), ['a', 'b']);
});

test('capacity reports a stable queue prefix and never hides overflow', () => {
  const value = payloadWith(task('a', {estimateMinutes: 45}), task('b', {estimateMinutes: 45}), task('c', {estimateMinutes: 10}));
  value.order = ['local:a', 'local:b', 'local:c'];
  value.dailyMinutes = 60;
  const result = plan(value);
  assert.equal(result.usedMinutes, 45);
  assert.equal(result.remainingMinutes, 15);
  assert.equal(result.totalMinutes, 100);
  assert.deepEqual(ids(result.overflow), ['local:b', 'local:c']);
  assert.equal(result.ready.length, 3);
  assert.equal(plan({...value, dailyMinutes: 0}).overflow.length, 3);
});

test('unknown duration is explicitly a 30-minute estimate; invalid edits are bounded', () => {
  const result = plan(payloadWith(task('unknown'), task('known', {estimateMinutes: 15})));
  assert.equal(result.all[0].estimateMinutes, 30);
  assert.equal(result.all[0].estimateIsDefault, true);
  assert.equal(result.all[1].estimateIsDefault, false);
  assert.equal(sanitizeTaskMeta({estimateMinutes: -80}).estimateMinutes, 5);
  assert.equal(sanitizeTaskMeta({estimateMinutes: 99999}).estimateMinutes, 1440);
  assert.equal(sanitizeTaskMeta({dueDate: 'not a date'}).dueDate, '');
});

test('Notion local completion stays an override and fresh source data cannot erase local arrangements', () => {
  const todo = {id: 'n', name: 'Original', status: false, priority: 'High', createdTime: '2026-11-01T00:00:00Z'};
  const value = emptyPlanner();
  value.overrides['notion:n'] = {state: 'done', plannedDay: TODAY, estimateMinutes: 60};
  const before = JSON.stringify(todo);
  const result = plan(value, [todo]);
  assert.equal(result.done[0].localStateOverride, true);
  assert.match(result.done[0].reason, /原始记录保留/);
  assert.equal(JSON.stringify(todo), before);
  assert.equal(plan(value, [{...todo, name: 'Updated upstream'}]).done[0].title, 'Updated upstream');
  assert.equal(plan(value, [{...todo, name: 'Updated upstream'}]).done[0].estimateMinutes, 60);
  assert.deepEqual(plan(value, [todo]).ready, []);
});

test('arrangement undo restores a single atomic operation without touching source records', () => {
  const original = payloadWith(task('a'), task('b'));
  const changed = applyPlannerChange(original, '开始专注', draft => {draft.focusId = 'local:a'; draft.overrides['local:a'] = {state: 'doing'};});
  assert.equal(changed.history.length, 1);
  assert.equal(changed.history[0].label, '开始专注');
  assert.deepEqual(undoPlanner(changed), normalizePlanner(original));
  assert.equal(applyPlannerChange(changed, '无变化', () => {}).history.length, 1);
});

test('history stays bounded and redo is not invented', () => {
  let value = emptyPlanner();
  for (let i = 1; i <= 35; i++) value = applyPlannerChange(value, '容量', draft => {draft.dailyMinutes = i;});
  assert.equal(value.history.length, 24);
  assert.equal(undoPlanner(value).dailyMinutes, 34);
  assert.deepEqual(undoPlanner(emptyPlanner()), emptyPlanner());
});

test('non-overlapping concurrent edits merge without overwriting the other writer', () => {
  const base = payloadWith(task('a'));
  const local = applyPlannerChange(base, '本地安排', draft => {draft.overrides['local:a'] = {plannedDay: TODAY};});
  const remote = applyPlannerChange(base, '远端安排', draft => {draft.dailyMinutes = 90; draft.overrides['local:a'] = {priority: 'high'};});
  const result = rebasePlanner(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.payload.dailyMinutes, 90);
  assert.deepEqual(result.payload.overrides['local:a'], {priority: 'high', plannedDay: TODAY});
  assert.deepEqual(undoPlanner(result.payload), normalizePlanner(remote));
});

test('same-field conflicts and competing task order changes keep the local draft uncommitted', () => {
  const base = payloadWith(task('a'), task('b'));
  const local = applyPlannerChange(base, '本地', draft => {draft.dailyMinutes = 60; draft.order = ['local:a', 'local:b'];});
  const remote = applyPlannerChange(base, '别处', draft => {draft.dailyMinutes = 120; draft.order = ['local:b', 'local:a'];});
  const result = rebasePlanner(base, local, remote);
  assert.deepEqual(new Set(result.conflicts), new Set(['order', 'dailyMinutes']));
  assert.deepEqual(result.payload, normalizePlanner(local));
  assert.equal(remote.dailyMinutes, 120);
});

test('concurrent new local tasks both survive and an identical change does not conflict', () => {
  const base = emptyPlanner();
  const local = payloadWith(task('a'));
  const remote = payloadWith(task('b'));
  local.dailyMinutes = remote.dailyMinutes = 120;
  const result = rebasePlanner(base, local, remote);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(new Set(ids(result.payload.localTasks)), new Set(['local:a', 'local:b']));
  assert.equal(result.payload.dailyMinutes, 120);
});
