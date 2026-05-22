import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

interface Todo {
  id: string;
  name: string;
  status: boolean;
  priority: string;
  tags: string[];
  projectId?: string;
}

interface Project {
  id: string;
  name: string;
  archived: boolean;
}

export default function QuickPanel() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const fetchProjects = useCallback(async () => {
    try {
      const raw = await invoke<string>("fetch_notion", {
        path: "/v1/databases/2d51ba51-3457-8127-840e-d8b43c0e5e21/query",
        method: "POST",
        body: JSON.stringify({ page_size: 50 }),
      });
      const data = JSON.parse(raw);
      const nameMap = new Map<string, string>();
      const archived = new Set<string>();
      for (const page of data.results) {
        const id = page.id;
        const name = page.properties.Name?.title?.[0]?.plain_text || "";
        nameMap.set(id, name);
        if (page.archived) archived.add(id);
      }
      setProjects(nameMap);
      setArchivedIds(archived);
      return archived;
    } catch (e) {
      console.error("QuickPanel fetchProjects error:", e);
      return new Set<string>();
    }
  }, []);

  const fetchTodos = useCallback(async (archived?: Set<string>) => {
    try {
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
      const priorityOrder: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
      const items: Todo[] = data.results
        .map((page: any) => ({
          id: page.id,
          name: page.properties.Name?.title?.[0]?.plain_text || "",
          status: page.properties.Status?.checkbox === true,
          priority: page.properties.Priority?.select?.name || "Medium",
          tags: page.properties.Tags?.multi_select?.map((t: any) => t.name) || [],
          projectId: page.properties.Project?.relation?.[0]?.id || undefined,
        }))
        .filter((t: Todo) => !t.projectId || !(archived || archivedIds).has(t.projectId))
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
  }, [archivedIds]);

  useEffect(() => {
    (async () => {
      const archived = await fetchProjects();
      await fetchTodos(archived);
    })();
  }, []);

  // Close quick panel when window loses focus
  useEffect(() => {
    let blurTimer: ReturnType<typeof setTimeout>;
    const handleBlur = () => {
      // Delay to avoid closing during click interactions
      blurTimer = setTimeout(async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          await win.hide();
          // Show FAB via Rust command
          await invoke("show_fab");
        } catch {}
      }, 200);
    };
    const handleFocus = () => {
      clearTimeout(blurTimer);
    };
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    return () => {
      clearTimeout(blurTimer);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const handleToggle = useCallback(
    async (id: string, current: boolean) => {
      if (current) {
        setTodos((prev) => prev.filter((t) => t.id !== id));
      } else {
        setTodos((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: true } : t))
        );
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
        fetchTodos();
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

  const PRIORITY_COLORS: Record<string, string> = {
    High: "#ff453a",
    Medium: "#ffd60a",
    Low: "#30d158",
  };

  const TAG_COLORS: Record<string, string> = {
    工作: "#0a84ff",
    生活: "#30d158",
    项目: "#ff9f0a",
  };

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
              <div className="quick-task-info">
                <span className={`name ${todo.status ? "done-text" : ""}`}>
                  {todo.name}
                </span>
                <div className="quick-task-meta">
                  {todo.projectId && projects.has(todo.projectId) && (
                    <span className="quick-tag" style={{ background: "rgba(255,255,255,0.08)" }}>
                      {projects.get(todo.projectId)}
                    </span>
                  )}
                  {todo.tags.slice(0, 1).map((tag) => (
                    <span
                      key={tag}
                      className="quick-tag"
                      style={{
                        background: `${TAG_COLORS[tag] || "#0a84ff"}22`,
                        color: TAG_COLORS[tag] || "#0a84ff",
                      }}
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
              <span
                className="dot"
                style={{ background: PRIORITY_COLORS[todo.priority] || PRIORITY_COLORS.Medium }}
              />
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
