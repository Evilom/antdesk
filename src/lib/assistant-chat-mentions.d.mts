import type { ProfileData } from './assistant-profiles.mjs';
export function resolveChatMentions(text: string, profiles: Pick<ProfileData, 'id' | 'name' | 'protocol'>[], extras?: Pick<ProfileData, 'id' | 'name' | 'protocol'>[]): { ids: string[]; unknown: string[]; broadcast: boolean };
export function insertChatMention(text: string, name: string, selectionStart?: number, selectionEnd?: number): { text: string; caret: number };
