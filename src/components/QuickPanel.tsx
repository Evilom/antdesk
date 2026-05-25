import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface Todo {
  id: string;
  name: string;
  status: boolean;
  priority: string;
  tags: string[];
  projectId?: string;
}

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

export default function QuickPanel() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [tagFilter, setTagFilter] = useState<string>("all");
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
        nameMap.set(page.id, page.properties.Name?.title?.[0]?.plain_text || "");
        if (page.archived) archived.add(page.id);
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
        .sort((a: Todo, b: Todo) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
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

  // Listen for pie menu filter events from FAB
  useEffect(() => {
    const unlisten = listen<{ tag: string }>("pie-filter-changed", (event) => {
      setTagFilter(event.payload.tag);
    });
    return () => { unlisten.then(fn => fn()); };
  }, []);

  // Close on blur
  useEffect(() => {
    let blurTimer: ReturnType<typeof setTimeout>;
    const handleBlur = () => {
      blurTimer = setTimeout(async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().hide();
        } catch {}
      }, 200);
    };
    const handleFocus = () => clearTimeout(blurTimer);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    return () => {
      clearTimeout(blurTimer);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
    };
  }, []);

  const handleToggle = useCallback(async (id: string) => {
    setExiting((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setTodos((prev) => prev.filter((t) => t.id !== id));
      setExiting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 280);
    try {
      await invoke("fetch_notion", {
        path: `/v1/pages/${id}`,
        method: "PATCH",
        body: JSON.stringify({ properties: { Status: { checkbox: true } } }),
      });
    } catch (e) {
      console.error("Toggle failed:", e);
      fetchTodos();
    }
  }, [fetchTodos]);

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
      await invoke("fetch_notion", {
        path: "/v1/pages",
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: "2d51ba51-3457-8125-9d4c-f28ffa2fff14" },
          properties: {
            Name: { title: [{ text: { content: name } }] },
            Priority: { select: { name: "Medium" } },
            Status: { checkbox: false },
          },
        }),
      });
      fetchTodos();
    } catch (e) {
      console.error("Add todo failed:", e);
    }
  }, [newName, fetchTodos]);

  const visibleTodos = todos.filter((t) => {
    if (t.status) return false;
    if (tagFilter === "all") return true;
    return t.tags.includes(tagFilter);
  });
  const displayTodos = visibleTodos.slice(0, 6);

  return (
    <div className="quick-panel">
      {/* Header */}
      <div className="quick-header">
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="title">待办</span>
          <span className="count">{visibleTodos.length}</span>
          {tagFilter !== "all" && (
            <span className="filter-badge" onClick={() => setTagFilter("all")}>
              {tagFilter} ✕
            </span>
          )}
        </div>
        <button className="expand-btn" onClick={handleExpand}>
          展开 ↗
        </button>
      </div>

      {/* Task list — compact, no wasted space */}
      {loading ? (
        <div className="quick-loading">加载中</div>
      ) : displayTodos.length === 0 ? (
        <div className="quick-empty">🎉 全部完成</div>
      ) : (
        <div className="quick-list">
          {displayTodos.map((todo, index) => {
            const isExiting = exiting.has(todo.id);
            return (
              <div
                key={todo.id}
                className={`quick-bubble ${isExiting ? "exit" : ""}`}
                style={{ animationDelay: `${0.04 + index * 0.035}s` }}
              >
                <button
                  className={`check ${todo.status ? "done" : ""}`}
                  onClick={() => handleToggle(todo.id)}
                />
                <div className="quick-bubble-info">
                  <span className="name">{todo.name}</span>
                  {todo.tags.length > 0 && (
                    <div className="quick-bubble-meta">
                      {todo.tags.slice(0, 1).map((tag) => (
                        <span
                          key={tag}
                          className="quick-tag"
                          style={{
                            background: `${TAG_COLORS[tag] || "#0a84ff"}18`,
                            color: TAG_COLORS[tag] || "#0a84ff",
                          }}
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <span
                  className="dot"
                  style={{ background: PRIORITY_COLORS[todo.priority] || PRIORITY_COLORS.Medium }}
                />
              </div>
            );
          })}
          {visibleTodos.length > 6 && (
            <div className="quick-more">
              还有 {visibleTodos.length - 6} 项
            </div>
          )}
        </div>
      )}

      {/* Quick add — always at bottom, no gap */}
      <div className="quick-add">
        <input
          ref={inputRef}
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          placeholder="快速新增..."
        />
      </div>
    </div>
  );
}
