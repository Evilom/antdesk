import { useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import type { Todo, Page } from "../types";

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

export default function Today({ onRefresh }: Props) {
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);
  const notionConnected = useAppStore((s) => s.notionConnected);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);

  const today = todayStr();

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

  const navigate = (page: Page) => setCurrentPage(page);

  // Section counter for stagger
  let cardIndex = 0;

  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="bg-bg-card rounded-card p-3 flex items-center justify-between anim-card" style={{ "--delay": "0s" } as React.CSSProperties}>
        <h1 className="text-sm font-semibold text-text-primary">
          今日 · {formatChineseDate(new Date())}
        </h1>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full transition-colors duration-500 ${notionConnected ? "bg-accent-green" : "bg-accent-red"}`} />
          <button
            onClick={onRefresh}
            className="text-xs text-accent-blue hover:text-accent-blue/80 transition-colors"
          >
            刷新
          </button>
        </div>
      </div>

      {/* Overdue */}
      {overdue.length > 0 && (
        <Section title="逾期任务" accent="border-accent-red" delay={++cardIndex}>
          {overdue.map((t) => (
            <TaskItem key={t.id} todo={t} dotColor="bg-accent-red" />
          ))}
        </Section>
      )}

      {/* Due Today */}
      {dueToday.length > 0 && (
        <Section title="今日截止" accent="border-accent-yellow" delay={++cardIndex}>
          {dueToday.map((t) => (
            <TaskItem key={t.id} todo={t} dotColor="bg-accent-yellow" />
          ))}
        </Section>
      )}

      {/* High Priority */}
      {highPriority.length > 0 && (
        <Section title="高优先级" accent="border-accent-orange" delay={++cardIndex}>
          {highPriority.map((t) => (
            <TaskItem key={t.id} todo={t} dotColor="bg-accent-orange" />
          ))}
        </Section>
      )}

      {/* Project Overview */}
      {projectOverview.length > 0 && (
        <div className="bg-bg-card rounded-card p-3 anim-card" style={{ "--delay": `${++cardIndex * 0.06}s` } as React.CSSProperties}>
          <h3 className="text-xs font-medium text-text-secondary mb-2">项目快览</h3>
          <div className="space-y-2">
            {projectOverview.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </div>
        </div>
      )}

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-2 anim-card" style={{ "--delay": `${++cardIndex * 0.06}s` } as React.CSSProperties}>
        <button
          onClick={() => navigate("projects")}
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
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`bg-bg-card rounded-card p-3 border-l-2 ${accent} anim-card`}
      style={{ "--delay": `${delay * 0.06}s` } as React.CSSProperties}
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
        <div
          className="h-full bg-accent-green rounded-full progress-fill"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-text-muted flex-shrink-0">
        {project.done}/{project.total}
      </span>
    </div>
  );
}
