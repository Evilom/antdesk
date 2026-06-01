import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { sendChatMessage } from "../lib/chat";
import type { Todo, Page, ChatMessage } from "../types";
import { v4 } from "./_uuid";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function formatChineseDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

interface Props {
  onRefresh: () => void;
}

export default function Agenda({ onRefresh }: Props) {
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);
  const notionConnected = useAppStore((s) => s.notionConnected);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);
  const settings = useAppStore((s) => s.settings);
  const addChatMessage = useAppStore((s) => s.addChatMessage);
  const updateLastAssistantMessage = useAppStore((s) => s.updateLastAssistantMessage);
  const chatMessages = useAppStore((s) => s.chatMessages);

  const today = todayStr();

  // ── Task categorization (from Today.tsx) ──
  const archivedProjectIds = useMemo(
    () => new Set(projects.filter((p) => p.archived).map((p) => p.id)),
    [projects]
  );
  const activeTodos = useMemo(
    () => todos.filter((t) => !t.projectId || !archivedProjectIds.has(t.projectId)),
    [todos, archivedProjectIds]
  );

  const overdue = useMemo(
    () => activeTodos.filter((t) => !t.status && t.dueDate && t.dueDate < today),
    [activeTodos, today]
  );

  const dueToday = useMemo(
    () => activeTodos.filter((t) => !t.status && t.dueDate === today),
    [activeTodos, today]
  );

  const highPriority = useMemo(
    () => activeTodos.filter((t) => !t.status && t.priority === "High" && !(t.dueDate && t.dueDate <= today)),
    [activeTodos, today]
  );

  const projectOverview = useMemo(() => {
    const map = new Map<string, { done: number; total: number }>();
    for (const t of activeTodos) {
      const pid = t.projectId || "__inbox__";
      if (!map.has(pid)) map.set(pid, { done: 0, total: 0 });
      const e = map.get(pid)!;
      e.total++;
      if (t.status) e.done++;
    }
    return Array.from(map.entries()).map(([pid, stats]) => {
      const proj = projects.find((p) => p.id === pid);
      return { id: pid, name: proj?.name || "待办", ...stats };
    });
  }, [activeTodos, projects]);

  // ── AI Suggestion Card ──
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestionDismissed, setSuggestionDismissed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const generateSuggestion = useCallback(async () => {
    if (suggestLoading) return;
    setSuggestLoading(true);
    setSuggestion(null);

    const overdueList = overdue.map((t) => `- [逾期] ${t.name}（优先级: ${t.priority}）`).join("\n");
    const dueList = dueToday.map((t) => `- [今日截止] ${t.name}（优先级: ${t.priority}）`).join("\n");
    const highList = highPriority.map((t) => `- [高优] ${t.name}`).join("\n");
    const taskSummary = [overdueList, dueList, highList].filter(Boolean).join("\n") || "（暂无紧急任务）";

    const prompt = `根据以下任务状态，给出今天的工作建议（简洁，2-3句话，估算处理时间）：\n${taskSummary}`;

    const userMsg: ChatMessage = { id: v4(), role: "user", content: prompt, timestamp: Date.now() };
    const assistantMsg: ChatMessage = { id: v4(), role: "assistant", content: "", timestamp: Date.now() };

    abortRef.current = new AbortController();
    let result = "";

    try {
      await sendChatMessage(
        settings.aiEndpoint,
        settings.aiModel,
        [{ role: "user", content: prompt }],
        (chunk) => { result += chunk; },
        abortRef.current.signal
      );
      setSuggestion(result || "暂无建议");
    } catch {
      setSuggestion("获取建议失败，请稍后重试");
    } finally {
      setSuggestLoading(false);
      abortRef.current = null;
    }
  }, [overdue, dueToday, highPriority, settings, suggestLoading]);

  // Auto-generate suggestion on mount if there are actionable tasks
  useEffect(() => {
    if ((overdue.length > 0 || dueToday.length > 0 || highPriority.length > 0) && !suggestion && !suggestionDismissed) {
      generateSuggestion();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdopt = useCallback(() => {
    // Sort tasks: overdue first, then due today, then high priority
    // This is a UX hint — just navigate to projects with the suggestion context
    setCurrentPage("goals");
  }, [setCurrentPage]);

  const navigate = (page: Page) => setCurrentPage(page);
  const hasUrgentTasks = overdue.length > 0 || dueToday.length > 0 || highPriority.length > 0;

  let idx = 0;
  const delay = () => `${(idx++) * 0.06}s`;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="bg-bg-card rounded-card p-3 flex items-center justify-between anim-card" style={{ animationDelay: "0s" }}>
        <h1 className="text-sm font-semibold text-text-primary">
          日程 · {formatChineseDate(new Date())}
        </h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full transition-colors duration-500 ${notionConnected ? "bg-accent-green" : "bg-accent-red"}`} />
          <button onClick={onRefresh} className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors">
            刷新
          </button>
        </div>
      </div>

      {/* Overdue */}
      {overdue.length > 0 && (
        <Section title={`逾期任务 (${overdue.length})`} accent="border-accent-red" delay={delay()}>
          {overdue.map((t) => (
            <TaskItem key={t.id} todo={t} dotColor="bg-accent-red" />
          ))}
        </Section>
      )}

      {/* Due Today */}
      {dueToday.length > 0 && (
        <Section title={`今日截止 (${dueToday.length})`} accent="border-accent-yellow" delay={delay()}>
          {dueToday.map((t) => (
            <TaskItem key={t.id} todo={t} dotColor="bg-accent-yellow" />
          ))}
        </Section>
      )}

      {/* High Priority */}
      {highPriority.length > 0 && (
        <Section title={`高优先级 (${highPriority.length})`} accent="border-accent-orange" delay={delay()}>
          {highPriority.map((t) => (
            <TaskItem key={t.id} todo={t} dotColor="bg-accent-orange" />
          ))}
        </Section>
      )}

      {/* Empty state */}
      {!hasUrgentTasks && (
        <div className="bg-bg-card rounded-card p-6 text-center anim-card" style={{ animationDelay: delay() }}>
          <div className="text-2xl mb-2">✨</div>
          <div className="text-xs text-text-secondary">今天没有紧急任务</div>
          <div className="text-[10px] text-text-muted mt-1">可以处理低优先级事项或休息一下</div>
        </div>
      )}

      {/* Project Overview */}
      {projectOverview.length > 0 && (
        <div className="bg-bg-card rounded-card p-3 anim-card" style={{ animationDelay: delay() }}>
          <h3 className="text-xs font-medium text-text-secondary mb-2">项目快览</h3>
          <div className="space-y-2">
            {projectOverview.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </div>
        </div>
      )}

      {/* AI Suggestion Card */}
      {!suggestionDismissed && hasUrgentTasks && (
        <div
          className="bg-bg-card rounded-card p-3 border-l-2 border-accent-blue/40 anim-card"
          style={{ animationDelay: delay() }}
        >
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <span className="text-sm"> </span>
              <h3 className="text-xs font-medium text-text-secondary">AI 建议</h3>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={generateSuggestion}
                disabled={suggestLoading}
                className="text-[10px] text-text-muted hover:text-accent-blue transition-colors disabled:opacity-40"
                title="刷新建议"
              >
                ↻
              </button>
              <button
                onClick={() => setSuggestionDismissed(true)}
                className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                title="关闭"
              >
                ✕
              </button>
            </div>
          </div>
          {suggestLoading ? (
            <div className="flex items-center gap-2 py-2">
              <span className="inline-block w-3 h-3 border-2 border-accent-blue/30 border-t-accent-blue rounded-full animate-spin" />
              <span className="text-[11px] text-text-muted">分析任务中...</span>
            </div>
          ) : suggestion ? (
            <div>
              <p className="text-[11px] text-text-secondary leading-relaxed">{suggestion}</p>
              <button
                onClick={handleAdopt}
                className="mt-2 px-3 py-1 text-[10px] bg-accent-blue/15 text-accent-blue rounded-lg hover:bg-accent-blue/25 transition-colors"
              >
                采纳 → 查看任务
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-2 anim-card" style={{ animationDelay: delay() }}>
        <button
          onClick={() => navigate("goals")}
          className="bg-bg-card rounded-card p-3 flex items-center justify-center gap-1.5 hover:bg-bg-hover transition-colors"
        >
          <span className="text-sm">➕</span>
          <span className="text-xs text-text-secondary">快速新增</span>
        </button>
        <button
          onClick={() => navigate("reports")}
          className="bg-bg-card rounded-card p-3 flex items-center justify-center gap-1.5 hover:bg-bg-hover transition-colors"
        >
          <span className="text-sm"> </span>
          <span className="text-xs text-text-secondary">写日报</span>
        </button>
      </div>
    </div>
  );
}

/* ---------- sub-components ---------- */

function Section({
  title,
  accent,
  delay,
  children,
}: {
  title: string;
  accent: string;
  delay: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`bg-bg-card rounded-card p-3 border-l-2 ${accent} anim-card`}
      style={{ animationDelay: delay }}
    >
      <h3 className="text-xs font-medium text-text-secondary mb-2">{title}</h3>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

function TaskItem({ todo, dotColor }: { todo: Todo; dotColor: string }) {
  return (
    <div className="flex items-center gap-2 text-xs task-row">
      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dotColor}`} />
      <span className="text-text-primary truncate flex-1">{todo.name}</span>
      <PriorityBadge priority={todo.priority} />
    </div>
  );
}

function PriorityBadge({ priority }: { priority: Todo["priority"] }) {
  const cls =
    priority === "High"
      ? "bg-accent-red/20 text-accent-red"
      : priority === "Medium"
        ? "bg-accent-yellow/20 text-accent-yellow"
        : "bg-bg-hover text-text-muted";
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${cls}`}>
      {priority === "High" ? "高" : priority === "Medium" ? "中" : "低"}
    </span>
  );
}

function ProjectRow({
  project,
}: {
  project: { id: string; name: string; done: number; total: number };
}) {
  const pct = project.total > 0 ? (project.done / project.total) * 100 : 0;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-text-primary truncate flex-1">{project.name}</span>
      <div className="w-16 h-1.5 bg-bg-hover rounded-full overflow-hidden flex-shrink-0">
        <div className="h-full bg-accent-green rounded-full progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-text-muted flex-shrink-0">{project.done}/{project.total}</span>
    </div>
  );
}
