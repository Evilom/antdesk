import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getLocalNotionToken } from "../lib/localSettings";
import { IconEdit, IconPlus, IconRefresh } from "./Icons";

interface Todo {
  id: string;
  name: string;
  status: boolean;
  priority: string;
  tags: string[];
}

const MAX_VISIBLE = 8;
const STORAGE_KEY = "antdesk_notepad_filter";
const DB_ID = "2d51ba51-3457-8125-9d4c-f28ffa2fff14";

const PRIORITY_DOT: Record<string, string> = {
  High: "#ff453a",
  Medium: "#ffd60a",
  Low: "#30d158",
};

const PRIORITY_LABEL: Record<string, string> = {
  High: "高",
  Medium: "中",
  Low: "低",
};

export default function NotepadPanel() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newName, setNewName] = useState("");
  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const [availableTags, setAvailableTags] = useState<string[]>([]);
  const [activeTag, setActiveTag] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) || ""
  );
  const inputRef = useRef<HTMLInputElement>(null);

  // ── Persist filter choice ──
  useEffect(() => {
    if (activeTag) localStorage.setItem(STORAGE_KEY, activeTag);
    else localStorage.removeItem(STORAGE_KEY);
  }, [activeTag]);

  const activeLabel = activeTag || "全部";
  const highCount = todos.filter((todo) => todo.priority === "High").length;

  // ── Fetch available tags from DB schema ──
  useEffect(() => {
    (async () => {
      try {
        const token = getLocalNotionToken();
        if (!token) return;
        const raw = await invoke<string>("fetch_notion", {
          path: `/v1/databases/${DB_ID}`,
          method: "GET",
          token,
        });
        const db = JSON.parse(raw);
        const opts: string[] =
          db.properties?.Tags?.multi_select?.options?.map(
            (o: any) => o.name
          ) || [];
        setAvailableTags(opts);
      } catch (e) {
        console.warn("Failed to fetch tags:", e);
      }
    })();
  }, []);

  // ── Fetch todos (with optional tag filter) ──
  const fetchTodos = useCallback(async (tag?: string) => {
    try {
      const token = getLocalNotionToken();
      if (!token) {
        setError("未配置 Notion Token");
        setTodos([]);
        return;
      }
      setError("");
      const filters: any[] = [
        { property: "Status", checkbox: { equals: false } },
      ];
      const selectedTag = tag ?? activeTag;
      if (selectedTag) {
        filters.push({
          property: "Tags",
          multi_select: { contains: selectedTag },
        });
      }

      const raw = await invoke<string>("fetch_notion", {
        path: `/v1/databases/${DB_ID}/query`,
        method: "POST",
        body: JSON.stringify({
          filter: filters.length > 1 ? { and: filters } : filters[0],
          sorts: [
            { property: "Priority", direction: "ascending" },
            { timestamp: "created_time", direction: "descending" },
          ],
          page_size: MAX_VISIBLE,
        }),
        token,
      });
      const data = JSON.parse(raw);
      const items: Todo[] = data.results.map((page: any) => ({
        id: page.id,
        name: page.properties.Name?.title?.[0]?.plain_text || "",
        status: false,
        priority: page.properties.Priority?.select?.name || "Medium",
        tags:
          page.properties.Tags?.multi_select?.map((t: any) => t.name) || [],
      }));
      setTodos(items);
    } catch (e) {
      console.error("Notepad fetchTodos error:", e);
    } finally {
      setLoading(false);
    }
  }, [activeTag]);

  // ── Re-fetch when filter changes ──
  useEffect(() => {
    setLoading(true);
    fetchTodos(activeTag);
  }, [activeTag, fetchTodos]);

  // ── Refresh when window shown ──
  useEffect(() => {
    fetchTodos();
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await listen("notepad-shown", () => {
          fetchTodos();
          setNewName("");
          setTimeout(() => inputRef.current?.focus(), 80);
        });
      } catch {}
    })();
    return () => { if (unlisten) unlisten(); };
  }, [fetchTodos]);

  // ── Close on blur ──
  useEffect(() => {
    const unlistenPromise = getCurrentWindow().onFocusChanged(({ payload }) => {
      if (!payload) {
        setTimeout(async () => {
          try { await getCurrentWindow().hide(); } catch {}
        }, 150);
      }
    });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  // ── Toggle todo (complete) ──
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

  // ── Create todo (auto-apply active tag) ──
  const handleCreate = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const name = newName.trim();
      if (!name) return;
      const token = getLocalNotionToken();
      if (!token) {
        setError("未配置 Notion Token");
        return;
      }
      setNewName("");
      const props: any = {
        Name: { title: [{ text: { content: name } }] },
        Priority: { select: { name: "Medium" } },
        Status: { checkbox: false },
      };
      if (activeTag) {
        props.Tags = { multi_select: [{ name: activeTag }] };
      }
      try {
        const raw = await invoke<string>("fetch_notion", {
          path: "/v1/pages",
          method: "POST",
          body: JSON.stringify({
            parent: { database_id: DB_ID },
            properties: props,
          }),
          token,
        });
        const page = JSON.parse(raw);
        const newTodo: Todo = {
          id: page.id, name, status: false,
          priority: "Medium",
          tags: activeTag ? [activeTag] : [],
        };
        setTodos((prev) => [newTodo, ...prev.slice(0, MAX_VISIBLE - 1)]);
      } catch (e) {
        console.error("Create todo failed:", e);
      }
    },
    [newName, activeTag]
  );

  const handleRefresh = useCallback(() => {
    setLoading(true);
    fetchTodos(activeTag);
    inputRef.current?.focus();
  }, [activeTag, fetchTodos]);

  return (
    <div className="notepad-panel">
      <header className="notepad-header">
        <div className="notepad-title-mark" aria-hidden="true">
          <IconEdit size={15} />
        </div>
        <div className="notepad-title-copy">
          <div className="notepad-title-row">
            <span className="notepad-title">便签</span>
            <span className="notepad-count">{todos.length}</span>
          </div>
          <div className="notepad-subtitle">
            {highCount > 0 ? `${highCount} 个高优先级` : `${activeLabel}待办`}
          </div>
        </div>
        <button className="notepad-icon-button" onClick={handleRefresh} title="刷新">
          <IconRefresh size={14} />
        </button>
      </header>

      {/* ── Tag filter bar ── */}
      {availableTags.length > 0 && (
        <div className="notepad-filters">
          <button
            className={`notepad-tag ${activeTag === "" ? "active" : ""}`}
            onClick={() => setActiveTag("")}
          >
            全部
          </button>
          {availableTags.map((tag) => (
            <button
              key={tag}
              className={`notepad-tag ${activeTag === tag ? "active" : ""}`}
              onClick={() => setActiveTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}

      {/* ── Todo list ── */}
      {loading ? (
        <div className="notepad-loading" aria-label="加载中">
          <span />
          <span />
          <span />
        </div>
      ) : error ? (
        <div className="notepad-empty">
          <div className="notepad-empty-title">{error}</div>
          <div className="notepad-empty-hint">在设置里连接 Notion 后同步任务</div>
        </div>
      ) : todos.length === 0 ? (
        <div className="notepad-empty">
          <div className="notepad-empty-title">{activeTag ? `${activeTag} 已清空` : "全部完成"}</div>
          <div className="notepad-empty-hint">下面可以继续捕获新任务</div>
        </div>
      ) : (
        <div className="notepad-list">
          {todos.map((todo, index) => {
            const isExiting = exiting.has(todo.id);
            return (
              <div
                key={todo.id}
                className={`notepad-item priority-${todo.priority.toLowerCase()} ${isExiting ? "exiting" : ""}`}
                style={{ animationDelay: `${0.03 + index * 0.03}s` }}
              >
                <button
                  className="notepad-check"
                  onClick={() => handleToggle(todo.id)}
                  title="完成"
                />
                <span className="notepad-content">
                  <span className="notepad-name">{todo.name}</span>
                  {todo.tags.length > 0 && (
                    <span className="notepad-meta">
                      {todo.tags.slice(0, 2).join(" / ")}
                    </span>
                  )}
                </span>
                <span className="notepad-priority">
                  <span
                    className="notepad-priority-dot"
                    style={{ background: PRIORITY_DOT[todo.priority] || PRIORITY_DOT.Medium }}
                  />
                  {PRIORITY_LABEL[todo.priority] || PRIORITY_LABEL.Medium}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Input ── */}
      <form className="notepad-input-bar" onSubmit={handleCreate}>
        <input
          ref={inputRef}
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder={activeTag ? `添加到 ${activeTag}` : "快速记录任务"}
          className="notepad-input"
        />
        <button className="notepad-submit" type="submit" title="添加">
          <IconPlus size={14} />
        </button>
      </form>
    </div>
  );
}
