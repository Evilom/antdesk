import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

interface Todo {
  id: string;
  name: string;
  status: boolean;
}

const MAX_VISIBLE = 6;

export default function NotepadPanel() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Fetch incomplete todos ──
  const fetchTodos = useCallback(async () => {
    try {
      const raw = await invoke<string>("fetch_notion", {
        path: "/v1/databases/2d51ba51-3457-8125-9d4c-f28ffa2fff14/query",
        method: "POST",
        body: JSON.stringify({
          filter: { property: "Status", checkbox: { equals: false } },
          sorts: [{ timestamp: "created_time", direction: "descending" }],
          page_size: MAX_VISIBLE,
        }),
      });
      const data = JSON.parse(raw);
      const items: Todo[] = data.results.map((page: any) => ({
        id: page.id,
        name: page.properties.Name?.title?.[0]?.plain_text || "",
        status: false,
      }));
      setTodos(items);
    } catch (e) {
      console.error("Notepad fetchTodos error:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Load on mount + refresh when shown ──
  useEffect(() => {
    fetchTodos();
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen("notepad-shown", () => {
          fetchTodos();
          setNewName("");
        });
      } catch {}
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [fetchTodos]);

  // ── Close on blur (click outside) ──
  useEffect(() => {
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!payload) {
        setTimeout(async () => {
          try {
            await getCurrentWindow().hide();
          } catch {}
        }, 150);
      }
    });
    return () => {
      unlistenPromise.then((fn) => fn());
    };
  }, []);

  // ── Toggle todo (mark complete → strikethrough + fade out) ──
  const handleToggle = useCallback(async (id: string) => {
    setExiting((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setTodos((prev) => prev.filter((t) => t.id !== id));
      setExiting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 300);
    try {
      await invoke("fetch_notion", {
        path: `/v1/pages/${id}`,
        method: "PATCH",
        body: JSON.stringify({ properties: { Status: { checkbox: true } } }),
      });
    } catch (e) {
      console.error("Toggle failed:", e);
    }
  }, []);

  // ── Create new todo ──
  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const name = newName.trim();
      if (!name) return;
      setNewName("");
      try {
        const raw = await invoke<string>("fetch_notion", {
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
        const page = JSON.parse(raw);
        const newTodo: Todo = { id: page.id, name, status: false };
        setTodos((prev) => [newTodo, ...prev.slice(0, MAX_VISIBLE - 1)]);
      } catch (e) {
        console.error("Create todo failed:", e);
      }
    },
    [newName]
  );

  return (
    <div className="notepad-panel">
      {/* Todo list — no header, clean sticky-note style */}
      {loading ? (
        <div className="notepad-loading">...</div>
      ) : todos.length === 0 ? (
        <div className="notepad-empty">全部完成 ✓</div>
      ) : (
        <div className="notepad-list">
          {todos.map((todo, index) => {
            const isExiting = exiting.has(todo.id);
            return (
              <div
                key={todo.id}
                className={`notepad-item ${isExiting ? "exiting" : ""}`}
                style={{ animationDelay: `${0.03 + index * 0.03}s` }}
              >
                <button
                  className="notepad-check"
                  onClick={() => handleToggle(todo.id)}
                  title="完成"
                />
                <span className="notepad-name">{todo.name}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Input — Enter to add */}
      <form className="notepad-input-bar" onSubmit={handleCreate}>
        <input
          ref={inputRef}
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="+ 添加..."
          className="notepad-input"
        />
      </form>
    </div>
  );
}
