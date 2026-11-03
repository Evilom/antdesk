export type AssistantProtocol = 'openai' | 'grok-webhook' | 'dots-mcp' | 'muse-manual' | 'grok-direct' | 'dots-direct' | 'muse-personal' | 'muse-code' | 'deepseek-harness' | 'notion-web';
export interface ProfileData {
  id: string; name: string; endpoint: string; model: string; protocol: AssistantProtocol;
  description?: string; agentRef?: string; webhookUrl?: string; sessionId?: string;
}
export const BRIDGE_ENDPOINT: string;
export const PROTOCOLS: Record<AssistantProtocol, { label: string; detail: string; badge: string; official: boolean }>;
export const RUNTIME_PROTOCOLS: readonly AssistantProtocol[];
export const PERSONAL_ASSISTANT_PROTOCOLS: readonly AssistantProtocol[];
export function isPersonalAssistant(profile: { protocol?: string } | undefined): boolean;
export function personalAssistantProfiles(profiles: ProfileData[]): ProfileData[];
export function isNativeProfile(profile: { protocol?: string } | undefined): boolean;
export function isRuntimeProfile(profile: { protocol?: string } | undefined): boolean;
export function defaultProfiles(): ProfileData[];
export function normalizeProfiles(saved: unknown, legacy?: { aiEndpoint?: string; aiModel?: string }): ProfileData[];
export function validateProfile(profile: ProfileData): ProfileData;
export function isProfileConfigured(profile: ProfileData): boolean;
export function credentialScopeKey(profile: ProfileData): string;
export function connectionKey(profile: ProfileData): string;
export function isActiveRun(run: { status: string; protocol?: string; externalRunId?: string; sessionId?: string }): boolean;
export function runStatusLabel(run: { status: string; protocol?: string; progress?: string; deliveryStatus?: string; externalRunId?: string; sessionId?: string; reviewDecision?: string; reviewed?: boolean; handedOff?: boolean; attention?: { kind: string }; remoteStopped?: boolean }): string;
