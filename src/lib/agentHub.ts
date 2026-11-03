import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AssistantProtocol, ProfileData } from './assistant-profiles.mjs';

/** Profiles contain routing information only. Credentials stay in the native backend and local encrypted store. */
export interface AgentProfile extends ProfileData {}

export type AgentRunStatus = 'queued' | 'running' | 'review' | 'failed' | 'cancelled' | 'interrupted';
export type ReviewDecision = 'accepted' | 'rejected';
export type ConnectionReadiness = 'ready' | 'connecting' | 'needs_model' | 'needs_configuration' | 'needs_subscription' | 'needs_public_url' | 'needs_agent_connection' | 'needs_login' | 'needs_api_key' | 'needs_install' | 'needs_validation' | 'invalid_credentials' | 'blocked' | 'unavailable';

export interface ProbeResult {
  ok: boolean; message: string; readiness?: ConnectionReadiness; official?: boolean; mcpUrl?: string;
}

export interface AgentRun {
  id: string;
  idempotencyKey: string;
  taskId: string;
  title: string;
  instruction: string;
  agentId: string;
  agentName: string;
  status: AgentRunStatus;
  result: string;
  error: string;
  createdAt: number;
  updatedAt: number;
  parentRunId?: string;
  reviewDecision?: ReviewDecision;
  reviewedAt?: number;
  protocol?: AssistantProtocol;
  progress?: string;
  deliveryStatus?: 'pending' | 'accepted' | 'unknown' | 'rejected';
  externalRunId?: string;
  sessionId?: string;
  turnId?: string;
  cursor?: string;
  attention?: { id: string; kind: 'approval' | 'input' | 'login'; title: string; description?: string; options?: { id: string; label: string }[]; fields?: { id: string; label: string; required?: boolean; secret?: boolean }[] };
  messages?: { id: string; role: 'assistant' | 'tool' | 'user'; text: string; complete?: boolean; updatedAt?: number }[];
  remoteStopped?: boolean;
}

export interface StartRunRequest {
  idempotencyKey: string;
  taskId: string;
  title: string;
  instruction: string;
  profile: AgentProfile;
  context?: string;
  parentRunId?: string;
}

function requireDesktop() {
  if (!isTauri()) throw new Error('助理委派需要在 AntDesk 桌面版中运行。网页预览不会启动助理。');
}

export async function listRuns(): Promise<AgentRun[]> {
  if (!isTauri()) return [];
  return invoke('assistant_list_runs');
}

export async function startRun(request: StartRunRequest): Promise<AgentRun> {
  requireDesktop();
  return invoke('assistant_start_run', { request });
}

export async function cancelRun(runId: string): Promise<AgentRun> {
  requireDesktop();
  return invoke('assistant_cancel_run', { runId });
}

export async function syncRun(runId: string): Promise<AgentRun> {
  requireDesktop();
  return invoke('assistant_sync_run', { runId });
}

export async function reviewRun(runId: string, decision: ReviewDecision): Promise<AgentRun> {
  requireDesktop();
  return invoke('assistant_review_run', { runId, decision });
}

/** Empty apiKey clears the credential. These functions never write browser storage. */
export async function setAgentCredential(profileId: string, apiKey: string): Promise<void> {
  requireDesktop();
  return invoke('assistant_set_credential', { profileId, apiKey });
}

export async function setBridgeCredential(profileId: string, apiKey: string, endpoint?: string): Promise<void> {
  requireDesktop();
  return invoke('assistant_set_bridge_credential', { profileId, apiKey, endpoint });
}

export async function probeAgent(profile: AgentProfile, options: { apiKey?: string; bridgeApiKey?: string; useStoredCredentials?: boolean } = {}): Promise<ProbeResult> {
  requireDesktop();
  return invoke('assistant_probe_agent', { profile, ...options });
}

export async function subscribeRuns(listener: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen('planner:runs-changed', () => listener());
}
