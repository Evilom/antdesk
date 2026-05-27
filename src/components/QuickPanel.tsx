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

export default function QuickPanel() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [projects, setProjects] = useState<Map<string, string>>(new Map());
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [bgAlpha, setBgAlpha] = useState(0.6);


  // Read transparency from localStorage (shared with main panel)
  useEffect(() => {
    const loadAlpha = () => {
      try {
        // Try both keys (underscore from appStore, hyphen legacy)
        const raw = localStorage.getItem("antdesk_settings") || localStorage.getItem("antdesk-settings");
        if (raw) {
          const s = JSON.parse(raw);
          const t = s.transparency ?? 100;
          setBgAlpha((255 - t) / 255);
        }
      } catch {}
    };
    loadAlpha();
    // Also listen for Tauri event from main window
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<{ transparency: number }>("settings-changed", (e) => {
          const t = e.payload.transparency ?? 100;
          setBgAlpha((255 - t) / 255);
        });
      } catch {}
    })();
    // And storage events (same-origin only, won't work cross-webview)
    const onStorage = (e: StorageEvent) => {
      if (e.key === "antdesk_settings" && e.newValue) {
        try {
          const s = JSON.parse(e.newValue);
          const t = s.transparency ?? 100;
          setBgAlpha((255 - t) / 255);
        } catch {}
      }
    };
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      if (unlisten) unlisten();
    };
  }, []);

  // Listen for drawer direction from Rust positioning
  const [direction, setDirection] = useState<"above" | "below">("below");
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<string>("quick-panel-direction", (e) => {
          setDirection(e.payload as "above" | "below");
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // Dynamic window height: resize to fit content
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!panelRef.current) return;
    const observer = new ResizeObserver(async (entries) => {
      const h = entries[0]?.contentRect?.height;
      if (!h || h < 10) return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalSize } = await import("@tauri-apps/api/dpi");
        await getCurrentWindow().setSize(new LogicalSize(260, Math.ceil(h + 8)));
      } catch {}
    });
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);

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

  // Re-fetch todos when window becomes visible (e.g. main window added a todo)
  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlistenFn = await win.onFocusChanged(({ payload: focused }) => {
        if (focused) {
          // Re-fetch on focus to pick up changes from main window
          (async () => {
            try {
              const archived = await fetchProjects();
              await fetchTodos(archived);
            } catch {}
          })();
        }
      });
    })();
    return () => { if (unlistenFn) unlistenFn(); };
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

  const visibleTodos = todos.filter((t) => !t.status);
  const displayTodos = visibleTodos.slice(0, 10);

  return (
    <div ref={panelRef} className={`quick-panel ${direction}`} style={{ "--bg-alpha": bgAlpha } as React.CSSProperties}>
      {/* Pure bubbles — no header, no input */}
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
              还有 {visibleTodos.length - 10} 项
            </div>
          )}
        </div>
      )}

    </div>
  );
}
