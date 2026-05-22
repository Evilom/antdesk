import { useState, useCallback, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import { createTodo, toggleTodoStatus, closeProject, fetchProjects } from "../lib/notion";
import type { Todo, Priority } from "../types";

const PRIORITY_COLORS: Record<Priority, string> = {
  High: "bg-accent-red/20 text-accent-red",
  Medium: "bg-accent-yellow/20 text-accent-yellow",
  Low: "bg-accent-green/20 text-accent-green",
};

const PRIORITY_LABELS: Record<Priority, string> = {
  High: "高",
  Medium: "中",
  Low: "低",
};

type PriorityFilter = "all" | Priority;

interface ProjectGroup {
  id: string;
  name: string;
  todos: Todo[];
  doneCount: number;
  totalCount: number;
}

export default function ProjectView() {
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);
  const addTodo = useAppStore((s) => s.addTodo);
  const updateTodo = useAppStore((s) => s.updateTodo);
  const token = useAppStore((s) => s.settings.notionToken);
  const setProjects = useAppStore((s) => s.setProjects);

  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [showCompleted, setShowCompleted] = useState<Set<string>>(new Set());
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("Medium");
  const [newProjectId, setNewProjectId] = useState("");
  const [adding, setAdding] = useState(false);

  const groups = useMemo((): ProjectGroup[] => {
    const filtered =
      priorityFilter === "all"
        ? todos
        : todos.filter((t) => t.priority === priorityFilter);

    const map = new Map<string, Todo[]>();
    for (const t of filtered) {
      const pid = t.projectId || "__inbox__";
      if (!map.has(pid)) map.set(pid, []);
      map.get(pid)!.push(t);
    }

    const result: ProjectGroup[] = [];
    // Inbox first
    if (map.has("__inbox__")) {
      const inboxTodos = map.get("__inbox__")!;
      result.push({
        id: "__inbox__",
        name: "收件箱",
        todos: inboxTodos,
        doneCount: inboxTodos.filter((t) => t.status).length,
        totalCount: inboxTodos.length,
      });
    }
    // Then projects in order (skip archived)
    for (const proj of projects) {
      if (proj.archived) continue;
      const projTodos = map.get(proj.id);
      if (projTodos) {
        result.push({
          id: proj.id,
          name: proj.name,
          todos: projTodos,
          doneCount: projTodos.filter((t) => t.status).length,
          totalCount: projTodos.length,
        });
      }
    }
    return result;
  }, [todos, projects, priorityFilter]);

  const toggleCollapse = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleShowCompleted = useCallback((id: string) => {
    setShowCompleted((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleToggle = useCallback(
    async (id: string, current: boolean) => {
      if (!token) return;
      updateTodo(id, { status: !current });
      try {
        await toggleTodoStatus(token, id, !current);
      } catch (e) {
        updateTodo(id, { status: current });
        console.error("Failed to toggle todo:", e);
      }
    },
    [token, updateTodo]
  );

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !token) return;
    setAdding(true);
    try {
      const todo = await createTodo(
        token,
        newName.trim(),
        newPriority,
        newProjectId || undefined
      );
      addTodo(todo);
      setNewName("");
      setShowAddForm(false);
    } catch (e) {
      console.error("Failed to create todo:", e);
    } finally {
      setAdding(false);
    }
  }, [newName, newPriority, newProjectId, token, addTodo]);

  const handleCloseProject = useCallback(
    async (projectId: string) => {
      if (!token || projectId.startsWith("__")) return;
      if (!confirm("确定关闭此项目？项目将在 Notion 中归档。")) return;
      try {
        await closeProject(token, projectId);
        const fresh = await fetchProjects(token);
        setProjects(fresh);
      } catch (e) {
        console.error("Failed to close project:", e);
      }
    },
    [token, setProjects]
  );

  return (
    <div className="space-y-3 fade-in">
      {/* Top Bar */}
      <div className="bg-bg-card rounded-card p-3 flex items-center justify-between">
        <h1 className="text-sm font-semibold text-text-primary">项目</h1>
        <div className="flex items-center gap-2">
          <select
            value={priorityFilter}
            onChange={(e) => setPriorityFilter(e.target.value as PriorityFilter)}
            className="bg-bg-input text-text-primary text-xs rounded-button px-2 py-1 outline-none border border-white/5 cursor-pointer"
          >
            <option value="all">全部优先级</option>
            <option value="High">高</option>
            <option value="Medium">中</option>
            <option value="Low">低</option>
          </select>
          <button className="w-6 h-6 flex items-center justify-center text-text-muted hover:text-text-secondary transition-colors">
            <span className="text-xs">&#128269;</span>
          </button>
        </div>
      </div>

      {/* Project Groups */}
      {groups.length === 0 && (
        <div className="text-center text-text-muted text-xs py-8">
          暂无任务
        </div>
      )}

      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.id);
        const isShowCompleted = showCompleted.has(group.id);
        const incomplete = group.todos.filter((t) => !t.status);
        const completed = group.todos.filter((t) => t.status);
        const pct =
          group.totalCount > 0
            ? (group.doneCount / group.totalCount) * 100
            : 0;

        return (
          <div key={group.id} className="bg-bg-card rounded-card overflow-hidden">
            {/* Project Header */}
            <button
              onClick={() => toggleCollapse(group.id)}
              className="w-full p-3 flex items-center gap-2 hover:bg-bg-hover transition-colors text-left group"
            >
              <span
                className="text-[10px] text-text-muted transition-transform"
                style={{
                  transform: isCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                }}
              >
                &#9662;
              </span>
              <span className="text-xs font-medium text-text-primary flex-1 truncate">
                {group.name}
              </span>
              <div className="w-16 h-1.5 bg-bg-hover rounded-full overflow-hidden flex-shrink-0">
                <div
                  className="h-full bg-accent-green rounded-full transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-[10px] text-text-muted flex-shrink-0">
                {group.doneCount}/{group.totalCount}
              </span>
              {!group.id.startsWith("__") && (
                <button
                  onClick={(e) => { e.stopPropagation(); handleCloseProject(group.id); }}
                  className="w-5 h-5 flex items-center justify-center text-text-muted hover:text-accent-red transition-colors opacity-0 group-hover:opacity-100"
                  title="关闭项目"
                >
                  <span className="text-[10px]">&#10005;</span>
                </button>
              )}
            </button>

            {/* Tasks */}
            {!isCollapsed && (
              <div className="px-3 pb-3 space-y-1">
                {incomplete.map((todo) => (
                  <TaskRow
                    key={todo.id}
                    todo={todo}
                    onToggle={handleToggle}
                  />
                ))}

                {completed.length > 0 && (
                  <button
                    onClick={() => toggleShowCompleted(group.id)}
                    className="w-full text-[10px] text-text-muted hover:text-text-secondary py-1 transition-colors"
                  >
                    {isShowCompleted
                      ? "收起已完成"
                      : `已完成(${completed.length})`}
                  </button>
                )}

                {isShowCompleted &&
                  completed.map((todo) => (
                    <TaskRow
                      key={todo.id}
                      todo={todo}
                      onToggle={handleToggle}
                    />
                  ))}
              </div>
            )}
          </div>
        );
      })}

      {/* Add Task */}
      {showAddForm ? (
        <div className="bg-bg-card rounded-card p-3 space-y-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="任务名称..."
            autoFocus
            className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors placeholder:text-text-muted"
          />
          <div className="flex gap-2">
            <select
              value={newPriority}
              onChange={(e) => setNewPriority(e.target.value as Priority)}
              className="flex-1 bg-bg-input text-text-primary text-xs rounded-button px-2 py-1.5 outline-none border border-white/5 cursor-pointer"
            >
              <option value="High">高</option>
              <option value="Medium">中</option>
              <option value="Low">低</option>
            </select>
            <select
              value={newProjectId}
              onChange={(e) => setNewProjectId(e.target.value)}
              className="flex-1 bg-bg-input text-text-primary text-xs rounded-button px-2 py-1.5 outline-none border border-white/5 cursor-pointer"
            >
              <option value="">待办</option>
              {projects.filter(p => !p.archived).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => {
                setShowAddForm(false);
                setNewName("");
              }}
              className="px-3 py-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleAdd}
              disabled={adding || !newName.trim()}
              className="px-3 py-1.5 bg-accent-blue text-white text-xs rounded-button disabled:opacity-40 hover:bg-accent-blue/80 transition-colors"
            >
              {adding ? "..." : "添加"}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="w-full bg-bg-card rounded-card p-3 flex items-center justify-center gap-1.5 hover:bg-bg-hover transition-colors text-accent-blue"
        >
          <span className="text-sm">➕</span>
          <span className="text-xs">新增任务</span>
        </button>
      )}
    </div>
  );
}

function TaskRow({
  todo,
  onToggle,
}: {
  todo: Todo;
  onToggle: (id: string, current: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-2 py-1 group">
      <button
        onClick={() => onToggle(todo.id, todo.status)}
        className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
          todo.status
            ? "bg-accent-green border-accent-green"
            : "border-text-muted hover:border-accent-blue"
        }`}
      >
        {todo.status && (
          <span className="text-[10px] text-white">&#10003;</span>
        )}
      </button>
      <span
        className={`flex-1 text-xs truncate ${
          todo.status ? "line-through text-text-muted" : "text-text-primary"
        }`}
      >
        {todo.name}
      </span>
      <span
        className={`text-[10px] px-1.5 py-0.5 rounded ${
          PRIORITY_COLORS[todo.priority]
        }`}
      >
        {PRIORITY_LABELS[todo.priority]}
      </span>
    </div>
  );
}
