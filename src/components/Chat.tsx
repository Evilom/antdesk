import { useState, useRef, useCallback, useEffect } from "react";
import { v4 } from "./_uuid";
import { useAppStore } from "../stores/appStore";
import { sendChatMessage } from "../lib/chat";
import type { ChatMessage } from "../types";

export default function Chat() {
  const messages = useAppStore((s) => s.chatMessages);
  const chatLoading = useAppStore((s) => s.chatLoading);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const updateLastAssistantMessage = useAppStore(
    (s) => s.updateLastAssistantMessage
  );
  const setChatLoading = useAppStore((s) => s.setChatLoading);
  const clearChat = useAppStore((s) => s.clearChat);
  const settings = useAppStore((s) => s.settings);
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);

  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || chatLoading) return;

    const userMsg: ChatMessage = {
      id: v4(),
      role: "user",
      content: text,
      timestamp: Date.now(),
    };
    addChatMessage(userMsg);
    setInput("");

    const assistantMsg: ChatMessage = {
      id: v4(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    addChatMessage(assistantMsg);
    setChatLoading(true);

    const history = [...messages, userMsg].slice(-10).map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    }));

    abortRef.current = new AbortController();

    try {
      await sendChatMessage(
        settings.aiEndpoint,
        settings.aiModel,
        history,
        (chunk) => {
          updateLastAssistantMessage(
            (useAppStore.getState().chatMessages.at(-1)?.content || "") + chunk
          );
        },
        abortRef.current.signal
      );
    } catch (e: any) {
      if (e.name !== "AbortError") {
        updateLastAssistantMessage("请求失败: " + e.message);
      }
    } finally {
      setChatLoading(false);
      abortRef.current = null;
    }
  }, [
    input,
    chatLoading,
    messages,
    settings,
    addChatMessage,
    updateLastAssistantMessage,
    setChatLoading,
  ]);

  const handleStop = () => {
    abortRef.current?.abort();
    setChatLoading(false);
  };

  const handleQuickCommand = useCallback(
    async (prompt: string) => {
      if (chatLoading) return;

      const userMsg: ChatMessage = {
        id: v4(),
        role: "user",
        content: prompt,
        timestamp: Date.now(),
      };
      addChatMessage(userMsg);

      const assistantMsg: ChatMessage = {
        id: v4(),
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };
      addChatMessage(assistantMsg);
      setChatLoading(true);

      const history = [...messages, userMsg].slice(-10).map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));

      abortRef.current = new AbortController();

      try {
        await sendChatMessage(
          settings.aiEndpoint,
          settings.aiModel,
          history,
          (chunk) => {
            updateLastAssistantMessage(
              (useAppStore.getState().chatMessages.at(-1)?.content || "") +
                chunk
            );
          },
          abortRef.current.signal
        );
      } catch (e: any) {
        if (e.name !== "AbortError") {
          updateLastAssistantMessage("请求失败: " + e.message);
        }
      } finally {
        setChatLoading(false);
        abortRef.current = null;
      }
    },
    [
      chatLoading,
      messages,
      settings,
      addChatMessage,
      updateLastAssistantMessage,
      setChatLoading,
    ]
  );

  const buildQuickCommands = useCallback(() => {
    const today = new Date().toISOString().slice(0, 10);
    const pendingTodos = todos.filter((t) => !t.status);

    const planToday = () => {
      const list =
        pendingTodos
          .map(
            (t) =>
              `- ${t.name}（优先级: ${t.priority}${t.dueDate ? `，截止: ${t.dueDate}` : ""}）`
          )
          .join("\n") || "（暂无未完成任务）";
      handleQuickCommand(
        `帮我根据以下未完成任务规划今天的优先级:\n${list}`
      );
    };

    const summarizeProjects = () => {
      const lines = projects.map((p) => {
        const projTodos = todos.filter((t) => t.projectId === p.id);
        const done = projTodos.filter((t) => t.status).length;
        return `- ${p.name}: ${done}/${projTodos.length} 已完成`;
      });
      if (pendingTodos.filter((t) => !t.projectId).length > 0) {
        const inboxDone = todos.filter(
          (t) => !t.projectId && t.status
        ).length;
        const inboxTotal = todos.filter((t) => !t.projectId).length;
        lines.push(`- 收件箱（无项目）: ${inboxDone}/${inboxTotal} 已完成`);
      }
      const list = lines.join("\n") || "（暂无项目）";
      handleQuickCommand(`帮我总结以下项目的进展:\n${list}`);
    };

    const generateReport = () => {
      const completed = todos.filter(
        (t) => t.status && t.createdTime?.slice(0, 10) === today
      );
      const list =
        completed.map((t) => `- ${t.name}`).join("\n") ||
        "（今日暂无已完成任务）";
      handleQuickCommand(
        `根据今日完成的任务帮我生成日报:\n${list}`
      );
    };

    return [
      { icon: "📋", label: "规划今日", action: planToday },
      { icon: "📊", label: "总结项目", action: summarizeProjects },
      { icon: "📝", label: "生成日报", action: generateReport },
    ];
  }, [todos, projects, handleQuickCommand]);

  return (
    <div className="flex flex-col h-full fade-in" style={{ height: "calc(100vh - 96px)" }}>
      {/* Quick Commands */}
      <div className="flex gap-1.5 overflow-x-auto pb-2 scrollbar-none -mx-1 px-1">
        {buildQuickCommands().map((cmd) => (
          <button
            key={cmd.label}
            onClick={cmd.action}
            disabled={chatLoading}
            className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 bg-bg-card text-text-secondary text-[11px] rounded-full border border-white/5 hover:border-accent-blue/30 hover:text-text-primary disabled:opacity-40 transition-colors"
          >
            <span className="text-xs">{cmd.icon}</span>
            {cmd.label}
          </button>
        ))}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto space-y-2.5 pb-2">
        {messages.length === 0 && (
          <div className="text-center text-text-muted text-xs py-12 space-y-2">
            <div className="text-2xl">&#129514;</div>
            <div>有什么可以帮你的？</div>
            <div className="text-[10px]">
              输入 /todo 创建任务 · /report 生成日报
            </div>
          </div>
        )}
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${
              msg.role === "user" ? "justify-end" : "justify-start"
            }`}
          >
            <div
              className={`max-w-[85%] rounded-card px-3 py-2 text-xs leading-relaxed ${
                msg.role === "user"
                  ? "bg-accent-blue text-white"
                  : "bg-bg-card text-text-secondary"
              }`}
            >
              {msg.content || (
                <span className="inline-block w-3 h-3 border-2 border-text-muted border-t-transparent rounded-full animate-spin" />
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Input */}
      <div className="flex gap-2 pt-2 border-t border-white/5">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleSend()}
          placeholder="输入消息..."
          disabled={chatLoading}
          className="flex-1 bg-bg-input text-text-primary text-xs rounded-button px-3 py-2 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors placeholder:text-text-muted disabled:opacity-50"
        />
        {chatLoading ? (
          <button
            onClick={handleStop}
            className="px-3 py-2 bg-accent-red text-white text-xs rounded-button hover:bg-accent-red/80 transition-colors"
          >
            停止
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!input.trim()}
            className="px-3 py-2 bg-accent-blue text-white text-xs rounded-button disabled:opacity-40 hover:bg-accent-blue/80 transition-colors"
          >
            发送
          </button>
        )}
      </div>

      {/* Clear */}
      {messages.length > 0 && (
        <button
          onClick={clearChat}
          className="text-[10px] text-text-muted hover:text-text-secondary text-center mt-1 transition-colors"
        >
          清空对话
        </button>
      )}
    </div>
  );
}
