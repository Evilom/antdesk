import { useEffect, useMemo, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useAppStore } from '../../stores/appStore';
import { usePlannerStore } from '../../stores/plannerStore';
import { buildPlan } from '../../lib/planner-model.mjs';
import { subscribePlanner } from '../../lib/planner';
import type { TaskDraft, TaskStage, TaskView } from './uiTypes';

type WorkItem = ReturnType<typeof buildPlan>['all'][number];
function view(task: WorkItem): TaskView {
  return {
    id: task.id, title: task.title, description: task.description || '', stage: task.archived ? 'archived' : task.state as TaskStage,
    priority: task.priority, estimateMinutes: task.estimateMinutes, estimateIsDefault: task.estimateIsDefault, dueDate: task.dueDate || undefined,
    plannedDay: task.plannedDay || undefined, earliestStart: task.earliestStart || undefined,
    dependencies: task.dependencies || [], waitingReason: task.waitingReason || undefined,
    projectId: task.projectId, projectName: task.projectName, source: task.source,
    acceptanceCriteria: task.acceptanceCriteria, evidence: task.evidence, owner: task.owner,
    scope: task.scope, verification: task.verification, sourceRefs: task.sourceRefs,
    pmoPriority: task.pmoPriority, scores: task.scores, spentMinutes: task.spentMinutes,
    priorityScore: task.priorityScore, projectRole: task.projectRole,
    reasons: [...new Set([task.reason, task.blockedReason].filter(Boolean))], blocked: Boolean(task.blockedReason || task.paused || task.scheduled || task.archived),
  };
}

export function usePlannerView() {
  const store = usePlannerStore();
  const { todos, projects } = useAppStore();
  const [now, setNow] = useState(Date.now());
  useEffect(() => { void store.initialize(); }, [store.initialize]);
  useEffect(() => {
    let off: (() => void) | undefined, disposed = false;
    void subscribePlanner(() => {
      const state = usePlannerStore.getState();
      if (!state.saving && !state.dirty) void state.reload();
    }).then(stop => { if (disposed) stop(); else off = stop; });
    return () => { disposed = true; off?.(); };
  }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const plan = useMemo(() => buildPlan(todos, projects, store.payload, now), [todos, projects, store.payload, now]);
  useEffect(() => {
    if (!isTauri()) return;
    void invoke('assistant_set_queue_cache', {tasks: plan.priority.map(({
      id, title, projectId, projectName, state, priority, pmoPriority, scope, verification,
      estimateMinutes, spentMinutes, owner, acceptanceCriteria, evidence, description,
      dependencies, sourceRefs, blockedReason, scores,
    }) => ({
      id, title, projectId, projectName, state, priority, pmoPriority, scope, verification,
      estimateMinutes, spentMinutes, owner, acceptanceCriteria, evidence, description,
      dependencies, sourceRefs, blockedReason, scores,
    }))});
  }, [plan.priority]);
  const update = (id: string, patch: Partial<TaskDraft>) => {
    const { stage, ...fields } = patch;
    store.updateTask(id, stage ? { ...fields, state: stage, archived: stage === 'archived' } : fields);
  };
  return {
    all: plan.all.map(view), priority: plan.priority.map(view), ready: plan.ready.map(view), current: plan.now ? view(plan.now) : null, next: plan.next.map(view),
    waiting: [...plan.waiting, ...plan.review].map(view), inbox: plan.inbox.map(view), done: plan.done.map(view), scheduled: plan.scheduled.map(view),
    dailyFocus: plan.dailyFocus.map(view), portfolio: plan.portfolio, pmo: store.payload.pmo,
    projects: [...projects.filter(item => !store.payload.pmo.projects.some(project => project.id === item.id)), ...store.payload.pmo.projects],
    plannedMinutes: store.payload.pmo.enabled ? plan.dailyFocus.reduce((sum, task) => sum + task.estimateMinutes, 0) : plan.totalMinutes, dailyMinutes: store.payload.dailyMinutes,
    loading: store.loading || !store.initialized && !store.error, saving: store.saving || store.dirty && !store.error, error: store.error, conflict: store.conflict, canUndo: store.canUndo, history: store.payload.history,
    add: (title: string) => store.addTask({ title, state: 'inbox', scope: 'candidate', verification: 'needs_check' }),
    update, setStage: (id: string, stage: TaskStage) => store.setTaskState(id, stage),
    completePersisted: async (id: string) => {
      store.setTaskState(id, 'done');
      await store.retrySave();
      const latest = usePlannerStore.getState();
      if (latest.error || latest.dirty) throw new Error(latest.error || '事项完成状态尚未保存，请重试。');
    },
    focus: store.focus,
    updateProject: store.updateProject, replaceMainProject: store.replaceMainProject, setWeeklyCapacity: store.setWeeklyCapacity,
    requestScopeChange: store.requestScopeChange, decideScopeChange: store.decideScopeChange, recordReview: store.recordReview,
    reorder: store.moveTask, setCapacity: store.setDailyMinutes, retrySave: store.retrySave, reload: store.reload, undo: store.undo,
  };
}
