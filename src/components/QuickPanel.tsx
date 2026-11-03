import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconArrowRight, IconCheck, IconEdit, IconLock, IconRefresh, IconUnlock, IconX } from "./Icons";
import { getLocalNotionToken } from "../lib/localSettings";

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

const priorityOrder: Record<string, number> = { High: 0, Medium: 1, Low: 2 };
const MAX_FOCUS_ITEMS = 4;

export default function QuickPanel() {
  const [allTodos, setAllTodos] = useState<Todo[]>([]);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [bgAlpha, setBgAlpha] = useState(0.6);
  const [filterTag, setFilterTag] = useState<string>("all");
  const [direction, setDirection] = useState<"above" | "below">("below");
  const [side, setSide] = useState<"left" | "right" | "top" | "bottom">("right");
  const [locked, setLocked] = useState(false);
  const [actionError, setActionError] = useState("");
  const panelRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<{ todos: Todo[]; archived: Set<string> } | null>(null);


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
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const off = await listen<{ transparency: number }>("settings-changed", (e) => {
          setBgAlpha((255 - (e.payload.transparency ?? 100)) / 255);
        });
        if (disposed) off(); else unlisten = off;
      } catch {}
    })();
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);

  // ── Direction (above/below) from Rust ──
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let unlistenPlacement: (() => void) | null = null;
    (async () => {
      try {
        const off = await listen<string>("quick-panel-direction", (e) => {
          setDirection(e.payload as "above" | "below");
        });
        if (disposed) off(); else unlisten = off;
        const offPlacement = await listen<{ side: "left" | "right" | "top" | "bottom"; vertical: "above" | "below" }>("companion-placement", (e) => {
          setSide(e.payload.side);
          setDirection(e.payload.vertical);
        });
        if (disposed) offPlacement(); else unlistenPlacement = offPlacement;
      } catch {}
    })();
    return () => { disposed = true; if (unlisten) unlisten(); if (unlistenPlacement) unlistenPlacement(); };
  }, []);

  // ── ResizeObserver: auto-fit window height + reposition ──
  useEffect(() => {
    if (!panelRef.current) return;
    let previousHeight = 0;
    const observer = new ResizeObserver(async (entries) => {
      // Measure layout, not the animated transform; viewport-based caps create a shrink loop.
      const h = entries[0]?.borderBoxSize?.[0]?.blockSize || panelRef.current?.offsetHeight;
      if (!h || h < 10) return;
      const height = Math.ceil(h + 26);
      if (height === previousHeight) return;
      previousHeight = height;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalSize } = await import("@tauri-apps/api/dpi");
        await getCurrentWindow().setSize(new LogicalSize(300, height));
        // Reposition after resize so panel doesn't cover FAB
        await invoke("update_quick_panel_position").catch(() => {});
      } catch {}
    });
    observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, []);

  // ── Fetch all todos ──
  const fetchAll = useCallback(async () => {
    try {
      const token = getLocalNotionToken();
      if (!token) {
        setError("未配置 Notion Token");
        setAllTodos([]);
        setLoading(false);
        return;
      }
      setError("");
      const projRaw = await invoke<string>("fetch_notion", {
        path: "/v1/databases/2d51ba51-3457-8127-840e-d8b43c0e5e21/query",
        method: "POST",
        body: JSON.stringify({ page_size: 50 }),
        token,
      });
      const projData = JSON.parse(projRaw);
      const archived = new Set<string>();
      for (const page of projData.results) {
        if (page.archived) archived.add(page.id);
      }
      setArchivedIds(archived);

      const todoRaw = await invoke<string>("fetch_notion", {
        path: "/v1/databases/2d51ba51-3457-8125-9d4c-f28ffa2fff14/query",
        method: "POST",
        body: JSON.stringify({
          filter: { property: "Status", checkbox: { equals: false } },
          sorts: [{ property: "Priority", direction: "ascending" }],
          page_size: 100,
        }),
        token,
      });
      const todoData = JSON.parse(todoRaw);
      const items: Todo[] = todoData.results
        .map((page: any) => ({
          id: page.id,
          name: page.properties.Name?.title?.[0]?.plain_text || "",
          status: page.properties.Status?.checkbox === true,
          priority: page.properties.Priority?.select?.name || "Medium",
          tags: page.properties.Tags?.multi_select?.map((t: any) => t.name) || [],
          projectId: page.properties.Project?.relation?.[0]?.id || undefined,
        }))
        .filter((t: Todo) => !(t.projectId && archived.has(t.projectId)));

      dataRef.current = { todos: items, archived };
      setAllTodos(items);
    } catch (e) {
      console.error("QuickPanel fetchAll error:", e);
      setError("快捷面板加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Initial load + refresh on panel show ──
  useEffect(() => {
    fetchAll();
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const off = await listen("quick-panel-shown", () => {
          setActionError("");
          fetchAll();
        });
        if (disposed) off(); else unlisten = off;
      } catch {}
    })();
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, [fetchAll]);

  // ── Client-side filter ──
  const displayTodos = useMemo(() => {
    return allTodos
      .filter((t) => filterTag === "all" || t.tags.includes(filterTag))
      .sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1))
      .slice(0, MAX_FOCUS_ITEMS);
  }, [allTodos, filterTag]);

  const visibleCount = displayTodos.length;
  const highCount = allTodos.filter((t) => t.priority === "High").length;

  // ── Listen for pie menu filter ──
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const off = await listen<{ tag: string }>("pie-filter-changed", (e) => {
          setFilterTag(e.payload.tag);
        });
        if (disposed) off(); else unlisten = off;
      } catch {}
    })();
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, []);

  const handleClose = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().hide();
    } catch (e) { setActionError(`关闭失败：${String(e)}`); }
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); void handleClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleClose]);

  // ── NO auto-close on blur — DesktopAnt behavior: stay open until explicitly closed ──
  // Only close on explicit "close-panel" event from Rust
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        const off = await listen("close-quick-panel", () => {
          handleClose();
        });
        if (disposed) off(); else unlisten = off;
      } catch {}
    })();
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, [handleClose]);

  const handleOpenMain = useCallback(async () => {
    try {
      await invoke("open_full_panel");
      await handleClose();
    } catch {}
  }, [handleClose]);

  const handleOpenNotepad = useCallback(async () => {
    try {
      await handleClose();
      await invoke("toggle_notepad");
    } catch {}
  }, [handleClose]);

  // Keep the task visible until the save succeeds; failed requests remain retryable.
  const completing = useRef(new Set<string>());
  const handleToggle = useCallback(async (id: string) => {
    if (completing.current.has(id)) return;
    completing.current.add(id);
    setExiting(new Set(completing.current)); setActionError("");
    try {
      const token = getLocalNotionToken();
      if (!token) throw new Error("请先连接 Notion");
      await invoke("fetch_notion", {
        path: `/v1/pages/${id}`, method: "PATCH",
        body: JSON.stringify({ properties: { Status: { checkbox: true } } }), token,
      });
      setAllTodos(current => current.filter(todo => todo.id !== id));
    } catch (e) { setActionError(`任务未完成，请重试：${String(e)}`); }
    finally { completing.current.delete(id); setExiting(new Set(completing.current)); }
  }, []);

  const panelClasses = [
    "quick-panel",
    direction,
    side,
    locked ? "tasks-locked" : "",
  ].filter(Boolean).join(" ");

  return (
    <div
      ref={panelRef}
      className={panelClasses}
      data-side={side}
      style={{ "--bg-alpha": bgAlpha } as React.CSSProperties}
    >
      <div className="quick-head">
        <div className="quick-title">
          <span>快捷待办</span>
          <small>{filterTag === "all" ? "高优优先" : filterTag}</small>
        </div>
        <div className="quick-actions">
          <button className="quick-icon-btn" onClick={fetchAll} title="刷新">
            <IconRefresh size={12} />
          </button>
          <button
            className={`quick-icon-btn ${locked ? "locked" : ""}`}
            onClick={() => setLocked(!locked)}
            title={locked ? "解锁任务" : "锁定任务（防止误操作）"}
            aria-pressed={locked}
          >
            {locked ? <IconLock size={12} /> : <IconUnlock size={12} />}
          </button>
          <button className="quick-icon-btn" onClick={handleClose} title="关闭面板">
            <IconX size={12} />
          </button>
        </div>
      </div>

      <div className="quick-meta">
        <span className={highCount > 0 ? "urgent" : ""}>{highCount > 0 ? `${highCount} 项高优` : "无高优事项"}</span>
        <i>{side === "left" ? "左侧" : side === "right" ? "右侧" : side === "top" ? "顶部" : "底部"}</i>
      </div>

      <div className="quick-shortcuts">
        <button className="quick-shortcut primary" onClick={handleOpenMain}>
          <span>打开主面板</span>
          <IconArrowRight size={12} />
        </button>
        <button className="quick-shortcut" onClick={handleOpenNotepad}>
          <IconEdit size={12} />
          <span>写便签</span>
        </button>
      </div>

      {actionError && <div className="quick-empty" role="status">{actionError}</div>}
      {loading ? (
        <div className="quick-skeleton">
          <span />
          <span />
          <span />
        </div>
      ) : error ? (
        <div className="quick-empty">{error}</div>
      ) : displayTodos.length === 0 ? (
        <div className="quick-empty">
          <IconCheck size={16} />
          <span>{filterTag === "all" ? "全部完成" : `无 ${filterTag} 待办`}</span>
        </div>
      ) : (
        <div className="quick-list">
          {displayTodos.map((todo, index) => {
            const isExiting = exiting.has(todo.id);
            return (
              <div
                key={todo.id}
                className="quick-bubble"
                style={{ animationDelay: `${0.04 + index * 0.035}s` }}
              >
                <button
                  className={`check ${todo.status ? "done" : ""}`}
                  aria-label={`完成任务：${todo.name}`}
                  disabled={locked || isExiting}
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

      {allTodos.length > visibleCount && !loading && !error && (
        <button className="quick-foot" onClick={handleOpenMain}>
          查看其余 {allTodos.length - visibleCount} 项
          <IconArrowRight size={11} />
        </button>
      )}
    </div>
  );
}
