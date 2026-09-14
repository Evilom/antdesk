export interface ChatRequestMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `你是 AntDesk AI 助手，一个 PM 桌面助手的内置 AI。
你帮助用户管理任务、写日报、回答问题。
请用简洁专业的中文回复。
当用户说 /todo 时，帮他们整理任务草稿，提示在任务编辑器中保存，不要宣称已经创建。
当用户说 /report 时，帮他们生成日报。
当用户说 /help 时，列出可用指令。`;

export function buildMessages(
  history: ChatRequestMessage[]
): ChatRequestMessage[] {
  return [{ role: "system", content: SYSTEM_PROMPT }, ...history];
}

export async function sendChatMessage(
  endpoint: string,
  model: string,
  messages: ChatRequestMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal
): Promise<void> {
  if (!endpoint.trim()) {
    throw new Error("AI endpoint is not configured");
  }

  const body = JSON.stringify({
    model,
    messages: buildMessages(messages),
    max_tokens: 2000,
    stream: true,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal,
  });

  if (!response.ok) {
    throw new Error(`Chat API error: ${response.status}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return true;
    let parsed;
    try { parsed = JSON.parse(data); } catch { return false; }
    if (parsed.error) throw new Error(parsed.error.message || 'AI 服务返回错误');
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === 'string') onChunk(delta);
    return false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) if (consume(line)) return;
      if (done) { if (buffer) consume(buffer); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
