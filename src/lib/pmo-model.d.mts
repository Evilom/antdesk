export type PmoPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type PmoRole = 'main' | 'support' | 'paused';
export type PmoScope = 'committed' | 'candidate' | 'later';
export type PmoScores = Partial<Record<'business' | 'urgency' | 'readiness' | 'efficiency' | 'reuse', number>>;
export interface PmoProject {
  id: string; name: string; role: PmoRole; priority: PmoPriority; weeklyBudgetMinutes: number;
  goal: string; definitionOfDone: string; scopeFrozen: boolean; stage: 'prototype' | 'quality' | 'release';
  scores?: PmoScores; decisionReason: string;
}
export interface PmoScopeChange {
  id: string; projectId: string; taskId: string; reason: string; status: 'pending' | 'approved' | 'rejected';
  createdAt: string; decidedAt?: string; decisionReason?: string;
}
export interface PmoReviewInput {
  projectId?: string; taskId?: string; kind: 'daily' | 'weekly' | 'task' | 'priority'; text: string;
  outcome: 'note' | 'accepted' | 'changes_requested'; source?: string;
  baseOrder?: string[]; proposedOrder?: string[]; baseRevision?: number;
}
export interface PmoReviewRecord extends PmoReviewInput {
  id: string; createdAt: string; status?: 'pending' | 'accepted' | 'rejected'; decidedAt?: string; decisionReason?: string;
}
export interface PmoState {
  enabled: boolean; projects: PmoProject[]; weeklyCapacityMinutes: number; focusLimit: number;
  scopeChanges: PmoScopeChange[]; reviewRecords: PmoReviewRecord[];
}
export interface PmoTaskFields {
  acceptanceCriteria?: string; evidence?: string; owner?: string; changeReason?: string; scope?: PmoScope;
  verification?: 'confirmed' | 'needs_check'; sourceRefs?: string[]; pmoPriority?: PmoPriority;
  scores?: PmoScores; spentMinutes?: number;
}
export interface PmoPolicyTask extends PmoTaskFields {
  id: string; projectId?: string; state?: string; stage?: string; estimateMinutes?: number; estimateIsDefault?: boolean;
  archived?: boolean; paused?: boolean; scheduled?: boolean; dependencies?: string[];
}
export interface PmoPortfolio {
  main: PmoProject | null; supports: PmoProject[]; paused: PmoProject[];
  allocatedMinutes: number; weeklyCapacityMinutes: number; issue: string;
}
export const SCORE_WEIGHTS: Readonly<Record<keyof PmoScores, number>>;
export function normalizeScores(value: unknown): PmoScores | undefined;
export function scorePriority(value: unknown): number | null;
export function sanitizePmoTaskMeta(value: unknown): PmoTaskFields;
export function normalizePmo(value: unknown): PmoState;
export function projectPolicyIssue(value: unknown): string;
export function portfolioSummary(value: unknown): PmoPortfolio;
export function patchProject(value: unknown, id: string, patch: Partial<PmoProject>): PmoState;
export function replaceMainProject(value: unknown, id: string, reason: string, patch?: Partial<PmoProject>): PmoState;
export function taskAmendmentIssue(value: unknown, previous: PmoPolicyTask | undefined, patch: PmoTaskFields & {title?: string; description?: string; projectId?: string; estimateMinutes?: number}): string;
export function pmoTaskBlockReason(value: unknown, task: PmoPolicyTask): string;
export function taskTransitionIssue(value: unknown, task: PmoPolicyTask | undefined, targetState: string, allTasks?: PmoPolicyTask[]): string;
export function proposeScopeChange(value: unknown, projectId: string, taskId: string, reason: string, id: string, at?: string): {pmo: PmoState; id: string};
export function decideScopeChange(value: unknown, id: string, approved: boolean, decisionReason: string, at?: string): PmoState;
export function addReviewRecord(value: unknown, input: PmoReviewInput, id: string, at?: string): PmoState;
export function projectTier(task: PmoPolicyTask, projects: PmoProject[]): number;
export function priorityProposalIssue(record: PmoReviewRecord | undefined, currentOrder: string[], tasks?: PmoPolicyTask[], projects?: PmoProject[]): string;
export function decidePriorityReview(value: unknown, id: string, accepted: boolean, reason: string, currentOrder: string[], tasks?: PmoPolicyTask[], at?: string): {pmo: PmoState; order: string[] | null};
