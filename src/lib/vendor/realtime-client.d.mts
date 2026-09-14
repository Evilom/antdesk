export class GatewayAPIError extends Error {
  status: number;
  code: string;
  retryable: boolean;
}
export interface Caption { id: string; role: 'user' | 'assistant'; text: string }
export function captionDelta(previous: Partial<Caption>, event: unknown): Caption | null;
export function encodeEvent(event: unknown): string;
export function decodeEvent(raw: unknown): any;
export class RealtimeAssistant extends EventTarget {
  constructor(options: {
    baseUrl: string; apiKey: string; audioElement?: HTMLAudioElement; context?: string;
    maxReconnects?: number;
    transport?: (path: string, options: {method: string; body?: unknown; timeout: number}) => Promise<{status: number; payload: any}>;
  });
  wanted: boolean;
  pc: RTCPeerConnection | null;
  dc: RTCDataChannel | null;
  stream: MediaStream | null;
  context: string;
  start(options?: {voice?: string; language?: string}): Promise<void>;
  stop(): Promise<void>;
  sendText(text: string): void;
  interrupt(): void;
  mute(value?: boolean): void;
  request(path: string, options?: {method?: string; body?: unknown; timeout?: number}): Promise<any>;
}
