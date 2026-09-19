export function voiceContextIntent(text: string): 'remember' | 'lookup' | null;
export class VoiceContextQueue {
  constructor(delay?: number);
  observe(caption: {id: string; text: string}, prepare: (intent: 'remember' | 'lookup', current: () => boolean) => Promise<string | null>, deliver: (text: string) => void, onError: (error: unknown) => void): void;
  cancel(): void;
  reset(): void;
}
export const VOICE_TURN_RULES: string;
export function voiceSessionContext(facts: string, history: string, brief?: boolean): string;
export function voiceLookupContext(question: string, facts: string): string;
