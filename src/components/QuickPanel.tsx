import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Todo {
  id: string;
  name: string;
  status: boolean;
  priority: string;
}

export default function QuickPanel() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchTodos = useCallback(async () => {
    try {
      const token = await invoke<string>("get_notion_token");
      const body = JSON.stringify({
        filter: { property: "Status", checkbox: { equals: false } },
        sorts: [{ property: "Priority", direction: "ascending" }],
        page_size: 100,
      });
      const raw = await invoke<string>("fetch_notion", {
        path: "/v1/databases/2d51ba51-3457-8125-9d4c-f28ffa2fff14/query",
        method: "POST",
        body,
      });
      const data = JSON.parse(raw);
      const priorityOrder: Record<string, number> = {
        High: 0,
        Medium: 1,
        Low: 2,
      };
      const items: Todo[] = data.results
        .map((page: any) => ({
          id: page.id,
          name: page.properties.Name?.title?.[0]?.plain_text || "",
          status: page.properties.Status?.checkbox === true,
          priority: page.properties.Priority?.select?.name || "Medium",
        }))
        .sort(
          (a: Todo, b: Todo) =>
            (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1)
        );
      setTodos(items);
    } catch (e) {
      console.error("QuickPanel fetch error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTodos();
  }, [fetchTodos]);

  const handleToggle = useCallback(
    async (id: string, current: boolean) => {
      // Optimistic update
      if (current) {
        setTodos((prev) => prev.filter((t) => t.id !== id));
      } else {
        setTodos((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: true } : t))
        );
        // Remove from list after animation
        setTimeout(() => {
          setTodos((prev) => prev.filter((t) => t.id !== id));
        }, 300);
      }
      try {
        const body = JSON.stringify({
          properties: { Status: { checkbox: !current } },
        });
        await invoke("fetch_notion", {
          path: `/v1/pages/${id}`,
          method: "PATCH",
          body,
        });
      } catch (e) {
        console.error("Toggle failed:", e);
        fetchTodos(); // Revert on error
      }
    },
    [fetchTodos]
  );

  const handleExpand = useCallback(async () => {
    try {
      await invoke("open_full_panel");
    } catch (e) {
      console.error("open_full_panel failed:", e);
    }
  }, []);

  const handleAdd = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    setNewName("");
    try {
      const body = JSON.stringify({
        parent: { database_id: "2d51ba51-3457-8125-9d4c-f28ffa2fff14" },
        properties: {
          Name: { title: [{ text: { content: name } }] },
          Priority: { select: { name: "Medium" } },
          Status: { checkbox: false },
        },
      });
      await invoke("fetch_notion", {
        path: "/v1/pages",
        method: "POST",
        body,
      });
      fetchTodos();
    } catch (e) {
      console.error("Add todo failed:", e);
    }
  }, [newName, fetchTodos]);

  const visibleTodos = todos.filter((t) => !t.status);
  const displayTodos = visibleTodos.slice(0, 8);
  const remaining = visibleTodos.length - 8;

  return (
    <div className="quick-panel">
      {/* Header */}
      <div className="quick-header">
        <div>
          <span className="title">待办</span>
          <span className="count">· {visibleTodos.length}</span>
        </div>
        <button className="expand-btn" onClick={handleExpand}>
          展开 →
        </button>
      </div>

      {/* Task list */}
      {loading ? (
        <div className="quick-loading">加载中...</div>
      ) : visibleTodos.length === 0 ? (
        <div className="quick-empty">🎉 全部完成</div>
      ) : (
        <div className="quick-list">
          {displayTodos.map((todo) => (
            <div key={todo.id} className="quick-task">
              <button
                className={`check ${todo.status ? "done" : ""}`}
                onClick={() => handleToggle(todo.id, todo.status)}
              />
              <span className={`name ${todo.status ? "done-text" : ""}`}>
                {todo.name}
              </span>
              <span className={`dot dot-${todo.priority.toLowerCase()}`} />
            </div>
          ))}
          {remaining > 0 && (
            <div className="quick-more">... 还有 {remaining} 项</div>
          )}
        </div>
      )}

      {/* Quick add */}
      <div className="quick-add">
        <input
          ref={inputRef}
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          placeholder="快速新增任务..."
        />
      </div>
    </div>
  );
}
