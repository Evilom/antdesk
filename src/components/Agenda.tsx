import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { sendChatMessage } from "../lib/chat";
import { localDateString } from "../lib/date";
import { IconBrain, IconPlus, IconRefresh, IconReport, IconTarget, IconX } from "./Icons";
import type { Todo, Page } from "../types";

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

function formatChineseDate(d: Date): string {
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEKDAYS[d.getDay()]}`;
}

function todayStr(): string {
  return localDateString();
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

  const today = todayStr();
  const todayDate = new Date();

  // ── Task categorization ──
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
    return Array.from(map.entries())
      .map(([pid, stats]) => {
        const proj = projects.find((p) => p.id === pid);
        return { id: pid, name: proj?.name || "收件箱", ...stats };
      })
      .sort((a, b) => (b.total - b.done) - (a.total - a.done))
      .slice(0, 5);
  }, [activeTodos, projects]);

  // ── AI Suggestion ──
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

  useEffect(() => {
    if ((overdue.length > 0 || dueToday.length > 0 || highPriority.length > 0) && !suggestion && !suggestionDismissed) {
      generateSuggestion();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleAdopt = useCallback(() => { setCurrentPage("goals"); }, [setCurrentPage]);
  const navigate = (page: Page) => setCurrentPage(page);
  const hasUrgentTasks = overdue.length > 0 || dueToday.length > 0 || highPriority.length > 0;

  let idx = 0;
  const delay = () => `${(idx++) * 60}ms`;

  const pendingCount = activeTodos.filter((t) => !t.status).length;
  const doneCount = activeTodos.length - pendingCount;

  return (
    <div className="agenda-console space-y-3 fade-in">
      {/* Date Header */}
      <div className="agenda-hero anim-card" style={{ animationDelay: delay() }}>
        <div className="agenda-hero-main">
          <span className="agenda-kicker">今日控制台</span>
          <h1 className="agenda-date">{formatChineseDate(todayDate)}</h1>
          <p>{pendingCount > 0 ? `${pendingCount} 项待办需要排序推进` : "今天的待办已经清空"}</p>
        </div>
        <button
          onClick={onRefresh}
          className="agenda-refresh btn-ghost text-[10px] px-2 py-1 inline-flex items-center gap-1.5"
          title="刷新数据"
        >
          <IconRefresh size={12} />
          刷新
        </button>
      </div>

      <div className="metrics-strip grid grid-cols-3 gap-2 anim-card" style={{ animationDelay: delay() }}>
        <Metric label="逾期" value={overdue.length} tone="red" />
        <Metric label="今日" value={dueToday.length} tone="yellow" />
        <Metric label="已完成" value={doneCount} tone="green" />
      </div>

      {/* Overdue Tasks */}
      {overdue.length > 0 && (
        <Section title="逾期任务" accent="border-l-accent-red" delay={delay()}>
          <div className="space-y-1">
            {overdue.map((t) => (
              <TaskItem key={t.id} todo={t} dotColor="bg-accent-red" />
            ))}
          </div>
        </Section>
      )}

      {/* Due Today */}
      {dueToday.length > 0 && (
        <Section title="今日截止" accent="border-l-accent-yellow" delay={delay()}>
          <div className="space-y-1">
            {dueToday.map((t) => (
              <TaskItem key={t.id} todo={t} dotColor="bg-accent-yellow" />
            ))}
          </div>
        </Section>
      )}

      {/* High Priority */}
      {highPriority.length > 0 && (
        <Section title="高优先级" accent="border-l-accent-orange" delay={delay()}>
          <div className="space-y-1">
            {highPriority.map((t) => (
              <TaskItem key={t.id} todo={t} dotColor="bg-accent-orange" />
            ))}
          </div>
        </Section>
      )}

      {!hasUrgentTasks && (
        <EmptyPanel
          title={pendingCount > 0 ? "今天没有紧急任务" : "任务已清空"}
          body={pendingCount > 0 ? "可以从项目快览里挑一个推进，或直接记录今天的阶段性进展。" : "现在适合补一篇日报，或者新增下一件明确的小任务。"}
          delay={delay()}
        />
      )}

      {/* Project Overview */}
      {projectOverview.length > 0 && (
        <div className="card project-overview p-3.5 anim-card" style={{ animationDelay: delay() }}>
          <div className="section-title-row">
            <h3 className="text-caption">项目快览</h3>
            <span>{projectOverview.length} 个项目</span>
          </div>
          <div className="space-y-2.5">
            {projectOverview.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </div>
        </div>
      )}

      {/* AI Suggestion Card */}
      {!suggestionDismissed && hasUrgentTasks && (
        <div className="card p-3.5 border-l-2 border-l-accent-blue/30 anim-card" style={{ animationDelay: delay() }}>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-1.5">
              <IconBrain size={14} className="text-accent-blue" />
              <h3 className="text-caption">AI 建议</h3>
            </div>
            <div className="flex items-center gap-1">
              <button onClick={generateSuggestion} disabled={suggestLoading} className="text-text-muted hover:text-accent-blue transition-colors disabled:opacity-40 p-0.5" title="刷新建议">
                <IconRefresh size={12} />
              </button>
              <button onClick={() => setSuggestionDismissed(true)} className="text-text-muted hover:text-text-secondary transition-colors p-0.5" title="关闭">
                <IconX size={12} />
              </button>
            </div>
          </div>
          {suggestLoading ? (
            <div className="flex items-center gap-2 py-1.5">
              <span className="inline-block w-3 h-3 border-[1.5px] border-accent-blue/20 border-t-accent-blue rounded-full animate-spin" />
              <span className="text-body text-text-muted">分析任务中...</span>
            </div>
          ) : suggestion ? (
            <div>
              <p className="text-body leading-relaxed">{suggestion}</p>
              <button onClick={handleAdopt} className="mt-2.5 px-3 py-1 text-[11px] bg-accent-blue/10 text-accent-blue rounded-lg hover:bg-accent-blue/20 transition-colors font-medium">
                采纳 → 查看任务
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-2 anim-card" style={{ animationDelay: delay() }}>
        <button onClick={() => navigate("goals")} className="card p-3 flex items-center justify-center gap-2 hover:bg-bg-card-hover transition-colors">
          <IconPlus size={14} className="text-accent-blue" />
          <span className="text-body">快速新增</span>
        </button>
        <button onClick={() => navigate("reports")} className="card p-3 flex items-center justify-center gap-2 hover:bg-bg-card-hover transition-colors">
          <IconReport size={14} className="text-accent-blue" />
          <span className="text-body">写日报</span>
        </button>
      </div>
    </div>
  );
}

/* ── Sub-components ── */

function Section({ title, accent, delay, children }: { title: string; accent: string; delay: string; children: React.ReactNode }) {
  return (
    <div className={`card focus-section p-3.5 border-l-2 ${accent} anim-card`} style={{ animationDelay: delay }}>
      <div className="section-title-row">
        <h3 className="text-caption">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: number; tone: "red" | "yellow" | "green" }) {
  const color = tone === "red" ? "text-accent-red" : tone === "yellow" ? "text-accent-yellow" : "text-accent-green";
  return (
    <div className={`metric-card card p-2.5 metric-${tone}`}>
      <div className={`text-[17px] leading-none font-semibold tabular-nums ${color}`}>{value}</div>
      <div className="text-[9px] text-text-muted mt-1">{label}</div>
    </div>
  );
}

function EmptyPanel({ title, body, delay }: { title: string; body: string; delay: string }) {
  return (
    <div className="card p-4 anim-card text-center" style={{ animationDelay: delay }}>
      <div className="mx-auto mb-2 w-9 h-9 rounded-[12px] bg-accent-blue/10 text-accent-blue flex items-center justify-center">
        <IconTarget size={18} />
      </div>
      <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
      <p className="text-body mt-1 max-w-[240px] mx-auto">{body}</p>
    </div>
  );
}

function TaskItem({ todo, dotColor }: { todo: Todo; dotColor: string }) {
  return (
    <div className="flex items-center gap-2 text-xs task-row agenda-task-row">
      <span className={`w-[5px] h-[5px] rounded-full flex-shrink-0 ${dotColor}`} />
      <span className="text-text-primary truncate flex-1 font-medium">{todo.name}</span>
      <PriorityBadge priority={todo.priority} />
    </div>
  );
}

function PriorityBadge({ priority }: { priority: Todo["priority"] }) {
  const cls = priority === "High" ? "priority-high" : priority === "Medium" ? "priority-medium" : "priority-low";
  const label = priority === "High" ? "高" : priority === "Medium" ? "中" : "低";
  return <span className={`priority-badge ${cls}`}>{label}</span>;
}

function ProjectRow({ project }: { project: { id: string; name: string; done: number; total: number } }) {
  const pct = project.total > 0 ? (project.done / project.total) * 100 : 0;
  return (
    <div className="project-row flex items-center gap-2.5 text-xs">
      <span className="text-text-primary truncate flex-1 font-medium">{project.name}</span>
      <div className="w-16 h-[3px] bg-bg-hover rounded-full overflow-hidden flex-shrink-0">
        <div className="h-full bg-accent-green rounded-full progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-text-muted flex-shrink-0 tabular-nums text-[10px]">{project.done}/{project.total}</span>
    </div>
  );
}
