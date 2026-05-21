import { useState, useCallback } from "react";
import { useAppStore } from "../stores/appStore";
import { createTodo, toggleTodoStatus } from "../lib/notion";
import type { Priority } from "../types";

type Filter = "all" | "pending" | "done";

const PRIORITY_COLORS: Record<Priority, string> = {
  High: "bg-accent-red/20 text-accent-red",
  Medium: "bg-accent-yellow/20 text-accent-yellow",
  Low: "bg-accent-green/20 text-accent-green",
};

export default function TaskList() {
  const todos = useAppStore((s) => s.todos);
  const addTodo = useAppStore((s) => s.addTodo);
  const updateTodo = useAppStore((s) => s.updateTodo);
  const token = useAppStore((s) => s.settings.notionToken);

  const [filter, setFilter] = useState<Filter>("all");
  const [newName, setNewName] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>("Medium");
  const [adding, setAdding] = useState(false);

  const filtered = todos.filter((t) => {
    if (filter === "pending") return !t.status;
    if (filter === "done") return t.status;
    return true;
  });

  const handleAdd = useCallback(async () => {
    if (!newName.trim() || !token) return;
    setAdding(true);
    try {
      const todo = await createTodo(token, newName.trim(), newPriority);
      addTodo(todo);
      setNewName("");
    } catch (e) {
      console.error("Failed to create todo:", e);
    } finally {
      setAdding(false);
    }
  }, [newName, newPriority, token, addTodo]);

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

      {/* Filters */}
      <div className="flex gap-1.5">
        {(
          [
            { id: "all", label: "全部" },
            { id: "pending", label: "待办" },
            { id: "done", label: "已完成" },
          ] as const
        ).map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-2.5 py-1 text-xs rounded-button transition-colors ${
              filter === f.id
                ? "bg-accent-blue text-white"
                : "bg-bg-card text-text-muted hover:text-text-secondary"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Task List */}
      <div className="space-y-1.5">
        {filtered.length === 0 && (
          <div className="text-center text-text-muted text-xs py-8">
            暂无任务
          </div>
        )}
        {filtered.map((todo) => (
          <div
            key={todo.id}
            className="bg-bg-card rounded-card p-2.5 flex items-center gap-2.5 hover:bg-bg-hover transition-colors group"
          >
            <button
              onClick={() => handleToggle(todo.id, todo.status)}
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
                todo.status
                  ? "line-through text-text-muted"
                  : "text-text-primary"
              }`}
            >
              {todo.name}
            </span>
            <span
              className={`text-[10px] px-1.5 py-0.5 rounded ${
                PRIORITY_COLORS[todo.priority]
              }`}
            >
              {todo.priority === "High"
                ? "紧急"
                : todo.priority === "Medium"
                ? "普通"
                : "低"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
