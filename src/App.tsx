import { useEffect, useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { useAppStore } from "./stores/appStore";
import { getNotionToken, fetchTodos, fetchReports, fetchProjects } from "./lib/notion";
import Today from "./components/Today";
import ProjectView from "./components/ProjectView";
import Reports from "./components/Reports";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import SearchModal from "./components/SearchModal";
import type { Page } from "./types";

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: "today", label: "今日", icon: "\u{1F4C5}" },
  { id: "projects", label: "项目", icon: "\u{1F4CB}" },
  { id: "reports", label: "日报", icon: "\u{1F4DD}" },
  { id: "chat", label: "助理", icon: "\u{1F916}" },
];

export default function App() {
  const currentPage = useAppStore((s) => s.currentPage);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const setTodos = useAppStore((s) => s.setTodos);
  const setReports = useAppStore((s) => s.setReports);
  const setProjects = useAppStore((s) => s.setProjects);
  const setNotionConnected = useAppStore((s) => s.setNotionConnected);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const notionConnected = useAppStore((s) => s.notionConnected);

  const loadData = useCallback(async () => {
    try {
      const token = await getNotionToken();
      updateSettings({ notionToken: token });
      setNotionConnected(true);

      const [todos, reports, projects] = await Promise.all([
        fetchTodos(token).catch((e) => {
          console.error("fetchTodos error:", e);
          return [];
        }),
        fetchReports(token).catch((e) => {
          console.error("fetchReports error:", e);
          return [];
        }),
        fetchProjects(token).catch((e) => {
          console.error("fetchProjects error:", e);
          return [];
        }),
      ]);
      setTodos(todos);
      setReports(reports);
      setProjects(projects);
    } catch (e) {
      console.error("loadData error:", e);
      setNotionConnected(false);
    }
  }, [setTodos, setReports, setProjects, setNotionConnected, updateSettings]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setShowSearch((v) => !v);
        setShowSettings(false);
      }
      if (e.key === "Escape") {
        if (showSearch) setShowSearch(false);
        else if (showSettings) setShowSettings(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showSearch, showSettings]);

  // Restore and persist window state
  useEffect(() => {
    const win = getCurrentWindow();
    const KEY = "antdesk_window";

    // Restore saved size/position on mount
    const saved = localStorage.getItem(KEY);
    if (saved) {
      try {
        const { width, height, x, y } = JSON.parse(saved);
        if (width && height) win.setSize(new LogicalSize(width, height));
        if (x != null && y != null) win.setPosition(new LogicalPosition(x, y));
      } catch {}
    }

    // Save on resize and move
    const unlistenResize = win.onResized(async () => {
      try {
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const scale = await win.scaleFactor();
        localStorage.setItem(KEY, JSON.stringify({
          width: size.width / scale,
          height: size.height / scale,
          x: pos.x / scale,
          y: pos.y / scale,
        }));
      } catch {}
    });

    const unlistenMove = win.onMoved(async () => {
      try {
        const size = await win.innerSize();
        const pos = await win.outerPosition();
        const scale = await win.scaleFactor();
        localStorage.setItem(KEY, JSON.stringify({
          width: size.width / scale,
          height: size.height / scale,
          x: pos.x / scale,
          y: pos.y / scale,
        }));
      } catch {}
    });

    return () => {
      unlistenResize.then((fn) => fn());
      unlistenMove.then((fn) => fn());
    };
  }, []);

  const handleClose = async () => {
    try {
      await invoke("window_close");
    } catch {}
  };

  const handleMinimize = async () => {
    try {
      await invoke("window_minimize");
    } catch {}
  };

  const renderPage = () => {
    switch (currentPage) {
      case "today":
        return <Today onRefresh={loadData} />;
      case "projects":
        return <ProjectView />;
      case "reports":
        return <Reports />;
      case "chat":
        return <Chat />;
    }
  };

  return (
    <div className="h-screen flex flex-col text-text-primary">
      {/* Title Bar */}
      <div className="titlebar flex items-center justify-between px-4 shrink-0"
        style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.06)", height: "36px" }}>
        <div className="flex items-center gap-2">
          <span className="text-sm">&#129514;</span>
          <span className="text-xs font-medium text-text-secondary">
            AntDesk
          </span>
          <span
            className={`w-1.5 h-1.5 rounded-full ${
              notionConnected ? "bg-accent-green" : "bg-accent-red"
            }`}
          />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setShowSearch(true); setShowSettings(false); }}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary transition-colors"
            style={{ background: "transparent", fontSize: "12px" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            title="搜索 (Ctrl+K)"
          >
            &#128269;
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary transition-colors"
            style={{ background: showSettings ? "rgba(255,255,255,0.08)" : "transparent" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = showSettings ? "rgba(255,255,255,0.08)" : "transparent")}
          >
            &#x2699;
          </button>
          <button
            onClick={handleMinimize}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary transition-colors"
            style={{ background: "transparent" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,0.08)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            &#x2013;
          </button>
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-white transition-colors"
            style={{ background: "transparent" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,59,48,0.8)")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">{renderPage()}</div>

      {/* Bottom Nav */}
      <div className="flex items-center justify-around shrink-0 py-2"
        style={{ background: "rgba(255,255,255,0.03)", borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setCurrentPage(item.id)}
            className={`flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl transition-all duration-150 ${
              currentPage === item.id
                ? "text-accent-blue"
                : "text-text-muted hover:text-text-secondary"
            }`}
            style={currentPage === item.id ? { background: "rgba(0,122,255,0.12)" } : {}}
          >
            <span className="text-sm leading-none">{item.icon}</span>
            <span className="text-[10px]">{item.label}</span>
          </button>
        ))}
      </div>

      {/* Settings Slide-over */}
      {showSettings && (
        <div className="absolute inset-0 z-50 flex justify-end" onClick={() => setShowSettings(false)}>
          <div className="w-72 h-full overflow-y-auto p-4"
            style={{ background: "rgba(15,15,20,0.95)", backdropFilter: "blur(30px)", borderLeft: "1px solid rgba(255,255,255,0.08)" }}
            onClick={(e) => e.stopPropagation()}>
            <Settings />
          </div>
        </div>
      )}

      {/* Search Modal */}
      {showSearch && <SearchModal onClose={() => setShowSearch(false)} />}
    </div>
  );
}
