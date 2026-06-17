export interface ChatRequestMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SYSTEM_PROMPT = `你是 AntDesk AI 助手，一个 PM 桌面助手的内置 AI。
你帮助用户管理任务、写日报、回答问题。
请用简洁专业的中文回复。
当用户说 /todo 时，帮他们创建任务。
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data: ")) continue;
      const data = trimmed.slice(6);
      if (data === "[DONE]") return;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) onChunk(delta);
      } catch {
        // skip malformed JSON
      }
    }
  }
}
