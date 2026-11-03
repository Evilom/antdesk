import type {PmoState, PmoTaskFields, PmoRole, PmoPortfolio, PmoScope, PmoPriority} from './pmo-model.mjs';
export type TaskPriority = 'high' | 'medium' | 'low';
export type TaskState = 'inbox' | 'ready' | 'doing' | 'waiting' | 'review' | 'done' | 'archived';
export interface TaskMeta extends PmoTaskFields {
  title?: string;
  priority?: TaskPriority;
  state?: TaskState;
  estimateMinutes?: number;
  dueDate?: string;
  deadline?: string;
  plannedDay?: string;
  earliestStart?: string;
  notBefore?: string;
  dependencies?: string[];
  description?: string;
  note?: string;
  waitingReason?: string;
  pinned?: boolean;
  archived?: boolean;
  projectId?: string;
}
export interface LocalTask extends TaskMeta {
  id: string;
  title: string;
  state: TaskState;
  priority: TaskPriority;
  createdAt: string;
  updatedAt: string;
}
export interface PlannerHistory {
  id: string;
  label: string;
  at: string;
  before?: PlannerData;
}
export interface PlannerData {
  schemaVersion: 1;
  localTasks: LocalTask[];
  overrides: Record<string, TaskMeta>;
  order: string[];
  focusId: string | null;
  dailyMinutes: number;
  pmo: PmoState;
}
export interface PlannerPayload extends PlannerData {
  history: PlannerHistory[];
}
export interface SourceTodo {
  id: string;
  name: string;
  status: boolean;
  priority: string;
  tags?: string[];
  paused?: boolean;
  projectId?: string;
  dueDate?: string;
  createdTime?: string;
}
export interface SourceProject {
  id: string;
  name: string;
  archived?: boolean;
}
export interface WorkItem extends PmoTaskFields {
  id: string;
  source: 'local' | 'notion';
  sourceId?: string;
  title: string;
  priority: TaskPriority;
  state: TaskState;
  estimateMinutes: number;
  estimateIsDefault: boolean;
  dueDate?: string;
  deadline?: string;
  plannedDay?: string;
  earliestStart?: string;
  notBefore?: string;
  dependencies: string[];
  description: string;
  note: string;
  waitingReason: string;
  projectId?: string;
  projectName?: string;
  pinned: boolean;
  archived: boolean;
  paused: boolean;
  createdAt: string;
  updatedAt: string;
  reason: string;
  blockedReason: string;
  isOverdue: boolean;
  isDueToday: boolean;
  scheduled: boolean;
  localStateOverride: boolean;
  acceptanceCriteria: string;
  evidence: string;
  owner: string;
  scope: PmoScope;
  verification: 'confirmed' | 'needs_check';
  sourceRefs: string[];
  pmoPriority: PmoPriority;
  spentMinutes: number;
  priorityScore: number | null;
  projectRole?: PmoRole;
}
export interface PlannerView {
  all: WorkItem[];
  priority: WorkItem[];
  ready: WorkItem[];
  now: WorkItem | null;
  next: WorkItem[];
  waiting: WorkItem[];
  inbox: WorkItem[];
  done: WorkItem[];
  review: WorkItem[];
  scheduled: WorkItem[];
  archived: WorkItem[];
  usedMinutes: number;
  remainingMinutes: number;
  totalMinutes: number;
  overflow: WorkItem[];
  dailyMinutes: number;
  dailyFocus: WorkItem[];
  portfolio: PmoPortfolio;
}
export function emptyPlanner(): PlannerPayload;
export function normalizePlanner(value: unknown): PlannerPayload;
export function buildPlan(todos: SourceTodo[], projects: SourceProject[], payload: PlannerPayload, now?: number | Date): PlannerView;
export function applyPlannerChange(payload: PlannerPayload, label: string, mutate: (draft: PlannerPayload) => void, at?: string): PlannerPayload;
export function undoPlanner(payload: PlannerPayload): PlannerPayload;
export function moveBefore(order: string[], id: string, beforeId?: string | null): string[];
export function localDay(value?: number | Date): string;
export function sanitizeTaskMeta(value: unknown): TaskMeta;
export function rebasePlanner(base: PlannerPayload, local: PlannerPayload, remote: PlannerPayload): {payload: PlannerPayload; conflicts: string[]};
