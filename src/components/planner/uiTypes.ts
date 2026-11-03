import type { PmoScores } from '../../lib/pmo-model.mjs';

export type TaskStage = 'inbox' | 'ready' | 'doing' | 'waiting' | 'review' | 'done' | 'archived';
export interface TaskView {
  id: string;
  title: string;
  description: string;
  stage: TaskStage;
  priority: 'high' | 'medium' | 'low';
  estimateMinutes: number;
  estimateIsDefault?: boolean;
  dueDate?: string;
  plannedDay?: string;
  earliestStart?: string;
  dependencies: string[];
  waitingReason?: string;
  projectId?: string;
  projectName?: string;
  acceptanceCriteria?: string;
  evidence?: string;
  owner?: string;
  changeReason?: string;
  scope?: 'committed' | 'candidate' | 'later';
  verification?: 'confirmed' | 'needs_check';
  sourceRefs?: string[];
  pmoPriority?: 'P0' | 'P1' | 'P2' | 'P3';
  scores?: PmoScores;
  spentMinutes?: number;
  priorityScore?: number | null;
  projectRole?: 'main' | 'support' | 'paused';
  source: 'local' | 'notion';
  reasons: string[];
  blocked?: boolean;
}
export type TaskDraft = Pick<TaskView, 'title' | 'description' | 'stage' | 'priority' | 'estimateMinutes' | 'dueDate' | 'plannedDay' | 'earliestStart' | 'dependencies' | 'waitingReason' | 'projectId' | 'acceptanceCriteria' | 'evidence' | 'owner' | 'changeReason' | 'scope' | 'verification' | 'sourceRefs' | 'pmoPriority' | 'scores' | 'spentMinutes'>;
export const SCOPE_LABELS = { committed: '本期计划', candidate: '待规划', later: '暂缓储备' };
export const ROLE_LABELS = { main: '核心主线', support: '辅助项目', paused: '已暂停' };
export const STAGE_LABELS: Record<TaskStage, string> = {
  inbox: '收集箱', ready: '待办', doing: '进行中', waiting: '等待中', review: '待确认', done: '已完成', archived: '已归档',
};
export const PRIORITY_LABELS = { high: '高', medium: '中', low: '低' };
export function formatDuration(minutes: number) {
  return minutes >= 60 ? `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}` : `${minutes} 分钟`;
}
export function formatTaskDate(value?: string) {
  if (!value) return '';
  const day = value.slice(0, 10);
  const date = new Date(`${day}T12:00:00`);
  return Number.isNaN(date.getTime()) ? day : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}
export function localDay(offset = 0) {
  const date = new Date(); date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
