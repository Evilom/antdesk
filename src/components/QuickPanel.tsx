import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { IconArrowRight, IconCheck, IconLock, IconRefresh, IconUnlock, IconX } from "./Icons";
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
const FILTERS = [
  { tag: "all", label: "全部" },
  { tag: "工作", label: "工作" },
  { tag: "生活", label: "生活" },
  { tag: "项目", label: "项目" },
];

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
  const [hiding, setHiding] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dataRef = useRef<{ todos: Todo[]; archived: Set<string> } | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

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
    let unlistenPlacement: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen<string>("quick-panel-direction", (e) => {
          setDirection(e.payload as "above" | "below");
        });
        unlistenPlacement = await listen<{ side: "left" | "right" | "top" | "bottom"; vertical: "above" | "below" }>("companion-placement", (e) => {
          setSide(e.payload.side);
          setDirection(e.payload.vertical);
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); if (unlistenPlacement) unlistenPlacement(); };
  }, []);

  // ── ResizeObserver: auto-fit window height + reposition ──
  useEffect(() => {
    if (!panelRef.current) return;
    const observer = new ResizeObserver(async (entries) => {
      const rect = entries[0]?.target.getBoundingClientRect();
      const h = rect?.height;
      if (!h || h < 10) return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const { LogicalSize } = await import("@tauri-apps/api/dpi");
        await getCurrentWindow().setSize(new LogicalSize(300, Math.ceil(h + 26)));
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
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen("quick-panel-shown", () => {
          setHiding(false);
          fetchAll();
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, [fetchAll]);

  // ── Client-side filter ──
  const displayTodos = useMemo(() => {
    return allTodos
      .filter((t) => filterTag === "all" || t.tags.includes(filterTag))
      .sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1))
      .slice(0, 10);
  }, [allTodos, filterTag]);

  const visibleCount = displayTodos.length;
  const highCount = allTodos.filter((t) => t.priority === "High").length;

  // ── Listen for pie menu filter ──
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen<{ tag: string }>("pie-filter-changed", (e) => {
          setFilterTag(e.payload.tag);
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ── NO auto-close on blur — DesktopAnt behavior: stay open until explicitly closed ──
  // Only close on explicit "close-panel" event from Rust
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen("close-quick-panel", () => {
          handleClose();
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, []);

  // ── Close with animation ──
  const handleClose = useCallback(async () => {
    setHiding(true);
    hideTimerRef.current = setTimeout(async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().hide();
        setHiding(false);
      } catch {}
    }, 200);
  }, []);

  const handleOpenMain = useCallback(async () => {
    try {
      await invoke("open_full_panel");
    } catch {}
  }, []);

  // ── Toggle todo ──
  const handleToggle = useCallback(async (id: string) => {
    setExiting((prev) => new Set(prev).add(id));
    setAllTodos((prev) => prev.filter((t) => t.id !== id));
    setTimeout(() => {
      setExiting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 280);
    try {
      const token = getLocalNotionToken();
      if (!token) {
        setError("未配置 Notion Token");
        return;
      }
      await invoke("fetch_notion", {
        path: `/v1/pages/${id}`,
        method: "PATCH",
        body: JSON.stringify({ properties: { Status: { checkbox: true } } }),
        token,
      });
    } catch (e) {
      console.error("Toggle failed:", e);
    }
  }, []);

  const panelClasses = [
    "quick-panel",
    direction,
    side,
    hiding ? "hiding" : "",
    locked ? "passthrough" : "",
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
          <em>Focus Queue</em>
          <span>快捷面板</span>
          <small>{visibleCount} / {allTodos.length} 个任务</small>
        </div>
        <div className="quick-actions">
          <button className="quick-icon-btn" onClick={fetchAll} title="刷新">
            <IconRefresh size={12} />
          </button>
          <button
            className={`quick-icon-btn ${locked ? "locked" : ""}`}
            onClick={() => setLocked(!locked)}
            title={locked ? "解锁（恢复正常交互）" : "锁定（鼠标穿透）"}
          >
            {locked ? <IconLock size={12} /> : <IconUnlock size={12} />}
          </button>
          <button className="quick-icon-btn" onClick={handleClose} title="关闭面板">
            <IconX size={12} />
          </button>
        </div>
      </div>

      <div className="quick-meta">
        <span className={highCount > 0 ? "urgent" : ""}>{highCount > 0 ? `${highCount} 个高优先级` : "无高优先级"}</span>
        <i>{side === "left" ? "左侧吸附" : side === "right" ? "右侧吸附" : side === "top" ? "上方吸附" : "下方吸附"}</i>
        <button onClick={handleOpenMain}>主面板 <IconArrowRight size={11} /></button>
      </div>

      <div className="quick-filters">
        {FILTERS.map((f) => (
          <button
            key={f.tag}
            className={filterTag === f.tag ? "active" : ""}
            onClick={() => setFilterTag(f.tag)}
          >
            {f.label}
          </button>
        ))}
      </div>

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
