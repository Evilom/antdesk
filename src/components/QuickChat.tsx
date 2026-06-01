/**
 * QuickChat — Inline panel that slides out from the pet
 *
 * 4 tabs: 聊天 | 待办 | 看板 | 项目
 * Renders inside the pet window (no separate Tauri window)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useKanbanStore } from "../stores/kanbanStore";
import type { KanbanAction } from "../types/kanban";

type Tab = "chat" | "todos" | "kanban" | "projects";

interface QuickChatProps {
  open: boolean;
  onClose: () => void;
}

// ── Kanban Tab ──

function KanbanTab() {
  const data = useKanbanStore((s) => s.data);
  const connected = useKanbanStore((s) => s.connected);

  const active = data.actions.filter((a) => a.status === "active");
  const blocked = data.actions.filter((a) => a.status === "blocked");
  const pending = data.actions.filter((a) => a.status === "pending");

  if (!connected) {
    return (
      <div className="qc-empty">
        <span className="qc-empty-icon">📡</span>
        <span>未连接看板</span>
        <span className="qc-empty-hint">在设置中配置看板端点</span>
      </div>
    );
  }

  if (data.actions.length === 0 && data.completedToday.length === 0) {
    return (
      <div className="qc-empty">
        <span className="qc-empty-icon">✨</span>
        <span>看板清空了！</span>
      </div>
    );
  }

  return (
    <div className="qc-kanban">
      {blocked.length > 0 && (
        <div className="qc-kanban-section">
          <div className="qc-kanban-header blocked">
            <span className="dot blocked" /> 已阻塞 ({blocked.length})
          </div>
          {blocked.map((a) => (
            <KanbanItem key={a.id} action={a} />
          ))}
        </div>
      )}

      {active.length > 0 && (
        <div className="qc-kanban-section">
          <div className="qc-kanban-header active">
            <span className="dot active" /> 进行中 ({active.length})
          </div>
          {active.map((a) => (
            <KanbanItem key={a.id} action={a} />
          ))}
        </div>
      )}

      {pending.length > 0 && (
        <div className="qc-kanban-section">
          <div className="qc-kanban-header pending">
            <span className="dot pending" /> 待处理 ({pending.length})
          </div>
          {pending.slice(0, 8).map((a) => (
            <KanbanItem key={a.id} action={a} />
          ))}
          {pending.length > 8 && (
            <div className="qc-kanban-more">还有 {pending.length - 8} 项...</div>
          )}
        </div>
      )}

      {data.completedToday.length > 0 && (
        <div className="qc-kanban-section">
          <div className="qc-kanban-header done">
            <span className="dot done" /> 今日完成 ({data.completedToday.length})
          </div>
          {data.completedToday.slice(0, 5).map((a) => (
            <KanbanItem key={a.id} action={a} done />
          ))}
        </div>
      )}
    </div>
  );
}

function KanbanItem({ action, done }: { action: KanbanAction; done?: boolean }) {
  const priorityColor =
    action.priority >= 8
      ? "var(--accent-red, #ff453a)"
      : action.priority >= 5
        ? "var(--accent-orange, #ff9f0a)"
        : "var(--accent-green, #30d158)";

  return (
    <div className={`qc-kanban-item ${done ? "done" : ""}`}>
      <span
        className="qc-kanban-priority"
        style={{ background: priorityColor }}
      >
        P{action.priority}
      </span>
      <span className="qc-kanban-title">{action.title}</span>
      {action.project && (
        <span className="qc-kanban-project">{action.project}</span>
      )}
    </div>
  );
}

// ── Todos Tab ──

function TodosTab() {
  const [todos, setTodos] = useState<Array<{ id: string; name: string; status: boolean; priority: string }>>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("antdesk_todos");
      if (raw) setTodos(JSON.parse(raw));
    } catch {}
  }, []);

  const pending = todos.filter((t) => !t.status);
  const done = todos.filter((t) => t.status);

  return (
    <div className="qc-todos">
      <div className="qc-todos-summary">
        <span>{pending.length} 待办</span>
        <span className="qc-sep">·</span>
        <span>{done.length} 已完成</span>
      </div>
      {pending.slice(0, 10).map((t) => (
        <div key={t.id} className="qc-todo-item">
          <span className={`qc-todo-priority ${t.priority.toLowerCase()}`}>
            {t.priority === "High" ? "🔴" : t.priority === "Medium" ? "🟡" : "🟢"}
          </span>
          <span className="qc-todo-name">{t.name}</span>
        </div>
      ))}
      {pending.length > 10 && (
        <div className="qc-kanban-more">还有 {pending.length - 10} 项...</div>
      )}
    </div>
  );
}

// ── Chat Tab ──

function ChatTab() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || loading) return;
    const userMsg = input.trim();
    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMsg }]);
    setLoading(true);

    try {
      const settings = JSON.parse(localStorage.getItem("antdesk_settings") || "{}");
      const resp = await fetch(settings.aiEndpoint || "http://evilom.top:6037/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: settings.aiModel || "DeepSeek-V3.2",
          messages: [
            { role: "system", content: "你是 AntDesk 桌面宠物助手，简洁友好地回答问题。" },
            ...messages.map((m) => ({ role: m.role, content: m.content })),
            { role: "user", content: userMsg },
          ],
          max_tokens: 500,
        }),
      });
      const data = await resp.json();
      const reply = data.choices?.[0]?.message?.content || "(无响应)";
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: "⚠️ 请求失败" }]);
    }
    setLoading(false);
  }, [input, loading, messages]);

  useEffect(() => {
    scrollRef.current?.scrollTo(0, scrollRef.current.scrollHeight);
  }, [messages]);

  return (
    <div className="qc-chat">
      <div className="qc-chat-messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="qc-chat-empty">点击发送消息开始聊天~</div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`qc-chat-msg ${m.role}`}>
            {m.content}
          </div>
        ))}
        {loading && <div className="qc-chat-msg assistant loading">思考中...</div>}
      </div>
      <div className="qc-chat-input">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage()}
          placeholder="说点什么..."
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          ↑
        </button>
      </div>
    </div>
  );
}

// ── Projects Tab ──

function ProjectsTab() {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("antdesk_projects");
      if (raw) setProjects(JSON.parse(raw));
    } catch {}
  }, []);

  const todos = (() => {
    try {
      return JSON.parse(localStorage.getItem("antdesk_todos") || "[]");
    } catch {
      return [];
    }
  })();

  return (
    <div className="qc-projects">
      {projects.length === 0 ? (
        <div className="qc-empty">
          <span className="qc-empty-icon">📁</span>
          <span>暂无项目</span>
        </div>
      ) : (
        projects.map((p) => {
          const projectTodos = todos.filter((t: any) => t.projectId === p.id);
          const done = projectTodos.filter((t: any) => t.status).length;
          const total = projectTodos.length;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;

          return (
            <div key={p.id} className="qc-project-item">
              <div className="qc-project-header">
                <span className="qc-project-name">{p.name}</span>
                <span className="qc-project-count">
                  {done}/{total}
                </span>
              </div>
              <div className="qc-project-bar">
                <div
                  className="qc-project-bar-fill"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}

// ── Main QuickChat ──

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "chat", label: "聊天", icon: "💬" },
  { id: "todos", label: "待办", icon: "📋" },
  { id: "kanban", label: "看板", icon: "📊" },
  { id: "projects", label: "项目", icon: "📁" },
];

export default function QuickChat({ open, onClose }: QuickChatProps) {
  const [activeTab, setActiveTab] = useState<Tab>("kanban");

  if (!open) return null;

  return (
    <div className="quickchat-panel" onClick={(e) => e.stopPropagation()}>
      {/* Tab bar */}
      <div className="qc-tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`qc-tab ${activeTab === tab.id ? "active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="qc-tab-icon">{tab.icon}</span>
            <span className="qc-tab-label">{tab.label}</span>
          </button>
        ))}
        <button className="qc-tab qc-close" onClick={onClose}>
          ✕
        </button>
      </div>

      {/* Tab content */}
      <div className="qc-content">
        {activeTab === "chat" && <ChatTab />}
        {activeTab === "todos" && <TodosTab />}
        {activeTab === "kanban" && <KanbanTab />}
        {activeTab === "projects" && <ProjectsTab />}
      </div>
    </div>
  );
}
