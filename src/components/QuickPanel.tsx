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
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [bgAlpha, setBgAlpha] = useState(0.6);
  const [filterTag, setFilterTag] = useState<string>("all");
  const [direction, setDirection] = useState<"above" | "below">("below");
  const panelRef = useRef<HTMLDivElement>(null);
  const fetchingRef = useRef(false);
  const filterTagRef = useRef(filterTag);
  filterTagRef.current = filterTag;

  // ── Transparency ──
  useEffect(() => {
    const loadAlpha = () => {
      try {
        const raw = localStorage.getItem("antdesk_settings") || localStorage.getItem("antdesk-settings");
        if (raw) {
          const s = JSON.parse(raw);
          setBgAlpha((255 - (s.transparency ?? 100)) / 255);
        }
      } catch {}
    };
    loadAlpha();
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen<{ transparency: number }>("settings-changed", (e) => {
          setBgAlpha((255 - (e.payload.transparency ?? 100)) / 255);
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ── Direction (above/below) from Rust ──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen<string>("quick-panel-direction", (e) => {
          setDirection(e.payload as "above" | "below");
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ── ResizeObserver: auto-fit window height ──
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

  // ── Fetch helpers ──
  const fetchProjects = useCallback(async () => {
    try {
      const raw = await invoke<string>("fetch_notion", {
        path: "/v1/databases/2d51ba51-3457-8127-840e-d8b43c0e5e21/query",
        method: "POST",
        body: JSON.stringify({ page_size: 50 }),
      });
      const data = JSON.parse(raw);
      const archived = new Set<string>();
      for (const page of data.results) {
        if (page.archived) archived.add(page.id);
      }
      setArchivedIds(archived);
      return archived;
    } catch (e) {
      console.error("QuickPanel fetchProjects error:", e);
      return new Set<string>();
    }
  }, []);

  const doFetchTodos = useCallback(async (archived: Set<string>, tag: string) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    try {
      const raw = await invoke<string>("fetch_notion", {
        path: "/v1/databases/2d51ba51-3457-8125-9d4c-f28ffa2fff14/query",
        method: "POST",
        body: JSON.stringify({
          filter: { property: "Status", checkbox: { equals: false } },
          sorts: [{ property: "Priority", direction: "ascending" }],
          page_size: 100,
        }),
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
        .filter((t: Todo) => {
          if (t.projectId && archived.has(t.projectId)) return false;
          if (tag !== "all" && !t.tags.includes(tag)) return false;
          return true;
        })
        .sort((a: Todo, b: Todo) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));
      setTodos(items);
    } catch (e) {
      console.error("QuickPanel fetch error:", e);
    } finally {
      setLoading(false);
      fetchingRef.current = false;
    }
  }, []);

  // ── Initial load ──
  useEffect(() => {
    (async () => {
      const archived = await fetchProjects();
      await doFetchTodos(archived, "all");
    })();
  }, []);

  // ── Listen for pie filter changes ──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen<{ tag: string }>("pie-filter-changed", async (e) => {
          const tag = e.payload.tag;
          setFilterTag(tag);
          // Re-fetch with new tag immediately (no need to wait for state update)
          await doFetchTodos(archivedIds, tag);
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, [archivedIds, doFetchTodos]);

  // ── Close on blur (with longer delay to avoid race with pie menu) ──
  useEffect(() => {
    let blurTimer: ReturnType<typeof setTimeout>;
    const handleBlur = () => {
      blurTimer = setTimeout(async () => {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          await getCurrentWindow().hide();
        } catch {}
      }, 400);
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

  // ── Toggle todo ──
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
    }
  }, []);

  const displayTodos = todos.filter((t) => !t.status).slice(0, 10);

  return (
    <div ref={panelRef} className={`quick-panel ${direction}`} style={{ "--bg-alpha": bgAlpha } as React.CSSProperties}>
      {loading ? (
        <div className="quick-loading">加载中</div>
      ) : displayTodos.length === 0 ? (
        <div className="quick-empty">
          {filterTag === "all" ? "🎉 全部完成" : `无 ${filterTag} 待办`}
        </div>
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
        </div>
      )}
    </div>
  );
}
