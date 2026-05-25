import { useState, useCallback, useMemo, useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { createTodo, toggleTodoStatus } from "../lib/notion";
import type { Priority, TodoCategory } from "../types";

type CategoryFilter = "all" | TodoCategory;

const CATEGORY_TABS: { id: CategoryFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "工作", label: "工作" },
  { id: "生活", label: "生活" },
  { id: "项目", label: "项目" },
];

const PRIORITY_COLORS: Record<Priority, string> = {
  High: "bg-accent-red/20 text-accent-red",
  Medium: "bg-accent-yellow/20 text-accent-yellow",
  Low: "bg-accent-green/20 text-accent-green",
};

const PRIORITY_LABELS: Record<Priority, string> = {
  High: "紧急",
  Medium: "普通",
  Low: "低",
};

export default function TaskList() {
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);
  const addTodo = useAppStore((s) => s.addTodo);
  const updateTodo = useAppStore((s) => s.updateTodo);
  const token = useAppStore((s) => s.settings.notionToken);

  const [category, setCategory] = useState<CategoryFilter>("all");
  const [newName, setNewName] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("Medium");
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);
  const [showPaused, setShowPaused] = useState(false);
  const completingIds = useRef(new Set<string>());

  // 项目名映射
  const projectNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    projects.forEach((p) => {
      map[p.id] = p.name;
    });
    return map;
  }, [projects]);

  // 分类过滤
  const categoryFiltered = useMemo(() => {
    if (category === "all") return todos;
    return todos.filter((t) => t.category === category);
  }, [todos, category]);

  // 未完成 + 未暂停（主列表）
  const activeTodos = useMemo(
    () => categoryFiltered.filter((t) => !t.status && !t.paused),
    [categoryFiltered]
  );

  // 已暂停
  const pausedTodos = useMemo(
    () => categoryFiltered.filter((t) => t.paused && !t.status),
    [categoryFiltered]
  );

  // 已完成
  const doneTodos = useMemo(
    () => categoryFiltered.filter((t) => t.status),
    [categoryFiltered]
  );

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !token) return;
    setAdding(true);
    try {
      // 根据当前 Tab 自动设置 category 对应的 tag
      const extraTags: string[] = [];
      if (category === "工作") extraTags.push("工作");
      else if (category === "生活") extraTags.push("生活");

      const todo = await createTodo(
        token,
        newName.trim(),
        newPriority,
        undefined,
        extraTags.length > 0 ? extraTags : undefined
      );
      addTodo(todo);
      setNewName("");
    } catch (e) {
      console.error("Failed to create todo:", e);
    } finally {
      setAdding(false);
    }
  }, [newName, newPriority, token, category, addTodo]);

  const handleToggle = useCallback(
    async (id: string, current: boolean) => {
      if (!token) return;
      if (!current) {
        completingIds.current.add(id);
        setTimeout(() => completingIds.current.delete(id), 600);
      }
      updateTodo(id, { status: !current });
      try {
        await toggleTodoStatus(token, id, !current);
      } catch (e) {
        completingIds.current.delete(id);
        updateTodo(id, { status: current });
        console.error("Failed to toggle todo:", e);
      }
    },
    [token, updateTodo]
  );

  const renderTodo = (todo: (typeof todos)[0]) => {
    const isCompleting = completingIds.current.has(todo.id);
    return (
      <div
        key={todo.id}
        className={`bg-bg-card rounded-card p-2.5 flex items-center gap-2.5 hover:bg-bg-hover transition-colors group ${isCompleting ? "task-completing" : ""}`}
      >
        <button
          onClick={() => handleToggle(todo.id, todo.status)}
          className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
            todo.status
              ? "bg-accent-green border-accent-green check-animate"
              : "border-text-muted hover:border-accent-blue"
          }`}
        >
          {todo.status && (
            <span className="text-[10px] text-white">&#10003;</span>
          )}
        </button>
        <div className="flex-1 min-w-0">
          <span
            className={`task-complete-strike text-xs truncate block ${
              todo.status || todo.paused
                ? "line-through text-text-muted"
                : "text-text-primary"
            }`}
          >
            {todo.name}
          </span>
          {todo.projectId && projectNameMap[todo.projectId] && (
            <span className="text-[10px] text-text-muted truncate block">
              📁 {projectNameMap[todo.projectId]}
            </span>
          )}
        </div>
        {todo.paused && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-input text-text-muted flex-shrink-0">
            暂停
          </span>
        )}
        <span
          className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${PRIORITY_COLORS[todo.priority]}`}
        >
          {PRIORITY_LABELS[todo.priority]}
        </span>
      </div>
    );
  };

  return (
    <div className="space-y-3 fade-in">
      {/* Add Task */}
      <div className="bg-bg-card rounded-card p-3 space-y-2">
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="添加新任务..."
            className="flex-1 bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors placeholder:text-text-muted"
          />
          <select
            value={newPriority}
            onChange={(e) => setNewPriority(e.target.value as Priority)}
            className="bg-bg-input text-text-primary text-xs rounded-button px-2 py-1.5 outline-none border border-white/5 cursor-pointer"
          >
            <option value="High">紧急</option>
            <option value="Medium">普通</option>
            <option value="Low">低</option>
          </select>
          <button
            onClick={handleAdd}
            disabled={adding || !newName.trim()}
            className="px-3 py-1.5 bg-accent-blue text-white text-xs rounded-button disabled:opacity-40 hover:bg-accent-blue/80 transition-colors"
          >
            {adding ? "..." : "+"}
          </button>
        </div>
      </div>

      {/* Category Tabs */}
      <div className="flex gap-1.5">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setCategory(tab.id)}
            className={`px-2.5 py-1 text-xs rounded-button transition-colors ${
              category === tab.id
                ? "bg-accent-blue text-white"
                : "bg-bg-card text-text-muted hover:text-text-secondary"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Active Todos */}
      <div className="space-y-1.5 stagger-children">
        {activeTodos.length === 0 && (
          <div className="text-center text-text-muted text-xs py-6">
            暂无待办
          </div>
        )}
        {activeTodos.map(renderTodo)}
      </div>

      {/* 已暂停 — 折叠区 */}
      {pausedTodos.length > 0 && (
        <div>
          <button
            onClick={() => setShowPaused((v) => !v)}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <span
              className={`inline-block transition-transform ${
                showPaused ? "rotate-90" : ""
              }`}
            >
              ▶
            </span>
            已暂停 ({pausedTodos.length})
          </button>
          {showPaused && (
            <div className="space-y-1.5 mt-1.5">
              {pausedTodos.map(renderTodo)}
            </div>
          )}
        </div>
      )}

      {/* 已完成 — 折叠区 */}
      {doneTodos.length > 0 && (
        <div>
          <button
            onClick={() => setShowDone((v) => !v)}
            className="flex items-center gap-1 text-xs text-text-muted hover:text-text-secondary transition-colors"
          >
            <span
              className={`inline-block transition-transform ${
                showDone ? "rotate-90" : ""
              }`}
            >
              ▶
            </span>
            已完成 ({doneTodos.length})
          </button>
          {showDone && (
            <div className="space-y-1.5 mt-1.5">
              {doneTodos.map(renderTodo)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
