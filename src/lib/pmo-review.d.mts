import type { PlannerPayload } from './planner-model.mjs';
export interface ReviewTask {
  id: string; title: string; state?: string; stage?: string; priority?: string;
  projectId?: string; projectName?: string; pmoPriority?: string; scope?: string;
  estimateMinutes?: number; verification?: string; acceptanceCriteria?: string;
  evidence?: string; description?: string; dependencies?: string[]; sourceRefs?: string[];
}
export function buildPmoReviewDraft(payload: PlannerPayload, tasks?: ReviewTask[], projectId?: string): string;
export function appendPreparedDraft(previous: string, next: string, limit?: number): { text: string; appended: boolean; error: string };
