import { invoke, isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';

export type RuntimeProviderId = 'grok-direct' | 'dots-direct' | 'muse-personal' | 'muse-code' | 'deepseek-harness' | 'notion-web';
export type RuntimeReadiness = 'ready' | 'connecting' | 'needs_model' | 'needs_login' | 'needs_api_key' | 'needs_install' | 'needs_validation' | 'invalid_credentials' | 'needs_agent_connection' | 'needs_configuration' | 'needs_subscription' | 'needs_public_url' | 'blocked' | 'unavailable';
export type RuntimeAuthMode = 'account' | 'api_key';
export interface RuntimeDiagnostic { stage: string; code: string; retryable: boolean; httpStatus?: number }
export interface RuntimeProvider {
  id: RuntimeProviderId; protocol: RuntimeProviderId; name: string; official: boolean;
  installed: boolean; readiness: RuntimeReadiness; message: string; version?: string;
  authentication?: { mode: RuntimeAuthMode; state?: string; code?: string };
  diagnostic?: RuntimeDiagnostic;
  models?: { id: string; name?: string }[];
  modelsSource?: 'account' | 'catalog' | 'unavailable';
  account?: { id: string; name?: string };
  workspaces?: { id: string; name: string; aiAvailable?: boolean }[];
  workspaceId?: string; model?: string; aiVerified?: boolean; lastVerifiedAt?: number;
  transport?: 'events' | 'direct';
  tunnel?: { installed: boolean; configured: boolean; state: 'idle' | 'starting' | 'ready' | 'failed'; version?: string | null; tunnelId?: string | null; error?: string | null };
  subscriptionCount?: number; setupMessage?: string; connectionIdentity?: string;
}
export interface RuntimeLogin {
  state: 'pending' | 'ready' | 'failed' | 'idle'; url?: string; browserOpened?: boolean; message: string; expiresAt?: string | number;
  userCode?: string; diagnostic?: RuntimeDiagnostic;
}
export interface RuntimeAgent { id: string; name: string; description?: string }
export interface RuntimeSession { id: string; title?: string; updatedAt?: string | number }
export interface RuntimeResponse { attentionId: string; decision?: string; answers?: Record<string, string>; text?: string }

/** The native proxy supplies the local connection credential. Secrets never enter browser storage. */
async function request<T>(method: 'GET' | 'POST', path: string, body?: object): Promise<T> {
  if (!isTauri()) throw new Error('在 AntDesk 桌面版中连接助理；当前网页为界面预览。');
  return invoke<T>('assistant_runtime_request', { request: { method, path, ...(body ? { body } : {}) } });
}
const providerPath = (id: RuntimeProviderId) => '/api/runtime/providers/' + encodeURIComponent(id);
export async function listRuntimeProviders(): Promise<RuntimeProvider[]> {
  const result = await request<{ providers: RuntimeProvider[] }>('GET', '/api/runtime/providers');
  return result.providers;
}
export const startRuntimeLogin = (id: RuntimeProviderId) => request<RuntimeLogin>('POST', providerPath(id) + '/login/start');
export const runtimeLoginStatus = (id: RuntimeProviderId) => request<RuntimeLogin>('GET', providerPath(id) + '/login/status');
export const cancelRuntimeLogin = (id: RuntimeProviderId) => request<RuntimeLogin>('POST', providerPath(id) + '/login/cancel');
export const logoutRuntime = (id: RuntimeProviderId) => request<unknown>('POST', providerPath(id) + '/logout');
export const configureRuntime = (id: RuntimeProviderId, value: { apiKey?: string; model?: string; workspaceId?: string; authMode?: RuntimeAuthMode; transport?: 'events' | 'direct'; tunnelId?: string; tunnelApiKey?: string; action?: 'start' | 'stop' | 'refresh' }) => request<RuntimeProvider>('POST', providerPath(id) + '/configure', value);
export async function listRuntimeAgents(id: RuntimeProviderId): Promise<RuntimeAgent[]> {
  return (await request<{ agents: RuntimeAgent[] }>('GET', providerPath(id) + '/agents')).agents;
}
export async function listRuntimeSessions(id: RuntimeProviderId, agentId?: string): Promise<RuntimeSession[]> {
  return (await request<{ sessions: RuntimeSession[] }>('GET', providerPath(id) + '/sessions' + (agentId ? '?agentId=' + encodeURIComponent(agentId) : ''))).sessions;
}
export const respondRuntimeRun = (runId: string, response: RuntimeResponse) => request<unknown>('POST', '/api/runtime/runs/' + encodeURIComponent(runId) + '/respond', response);

/** A user-started login may deliver its URL later. Passive status checks must never open a browser. */
export async function openAssistantUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('登录服务没有返回可用的地址，请重新发起登录。'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    throw new Error('登录地址不受支持，请重新发起登录。');
  }
  if (isTauri()) await open(url.toString());
  else window.open(url.toString(), '_blank', 'noopener,noreferrer');
}
export const runtimeReadinessLabel = (readiness?: RuntimeReadiness) => ({
  ready: '已就绪', needs_login: '等待登录', needs_api_key: '等待 API Key',
  connecting: '正在连接', needs_model: '需要选择模型',
  needs_validation: '等待验证', invalid_credentials: '授权未通过',
  needs_agent_connection: '选择原助理', blocked: '当前账号暂不可用',
  needs_subscription: '等待助理订阅', needs_public_url: '等待连接地址',
  needs_configuration: '等待配置',
  needs_install: '需要安装', unavailable: '暂不可用',
}[readiness || 'unavailable']);
