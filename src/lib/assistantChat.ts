import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentProfile, AgentRun } from './agentHub';

export type ChatStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled';
export interface ChatRoom {
  id: string; kind: 'group' | 'direct'; title: string; memberIds: string[];
  updatedAt: number; lastMessage: string; pendingCount: number; archived?: boolean;
}
export interface ChatMessage {
  id: string; seq: number; roomId: string; role: 'user' | 'assistant';
  authorId: string; authorName: string; text: string; status: ChatStatus;
  createdAt: number; updatedAt: number; mentions: string[];
  replyTo?: string; deliveryId?: string; runId?: string;
  progress?: string; error?: string; attention?: AgentRun['attention'];
}
export interface ChatHistory { messages: ChatMessage[]; hasMore: boolean; nextBefore?: number }
export interface SendChatRequest {
  roomId: string; clientMessageId: string; text: string; mentions: string[]; profiles: AgentProfile[];
}
function requireDesktop() {
  if (!isTauri()) throw new Error('请在 AntDesk 桌面版中和你的助理聊天。');
}
export async function listChatRooms(profiles: AgentProfile[]): Promise<ChatRoom[]> {
  if (!isTauri()) return [{ id: 'team', kind: 'group', title: '助理群', memberIds: profiles.filter(profile => profile.protocol !== 'notion-web').map(profile => profile.id), updatedAt: 0, lastMessage: '', pendingCount: 0 },
    ...profiles.map(profile => ({ id: 'preview:' + profile.id, kind: 'direct' as const, title: profile.name, memberIds: [profile.id], updatedAt: 0, lastMessage: '', pendingCount: 0 }))];
  return invoke('assistant_chat_list_rooms', { profiles });
}
export async function updateChatMembers(profiles: AgentProfile[], memberIds: string[]): Promise<ChatRoom[]> {
  requireDesktop(); return invoke('assistant_chat_set_members', { profiles, memberIds });
}
export async function chatHistory(roomId: string, before?: number): Promise<ChatHistory> {
  if (!isTauri()) return { messages: [], hasMore: false };
  return invoke('assistant_chat_history', { roomId, before, limit: 60 });
}
export async function sendChatMessage(request: SendChatRequest): Promise<{ messageId: string; roomId: string }> {
  requireDesktop(); return invoke('assistant_chat_send', { request });
}
export async function chatDeliveryAction(action: 'cancel' | 'retry' | 'sync', deliveryId: string): Promise<ChatMessage> {
  requireDesktop(); return invoke('assistant_chat_' + action, { deliveryId });
}
export async function subscribeChats(listener: (roomId?: string, message?: ChatMessage) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<{ roomId?: string; message?: ChatMessage }>('chat:changed', event => listener(event.payload.roomId, event.payload.message));
}
