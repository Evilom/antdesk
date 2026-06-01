import { useEffect, useCallback, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { useAppStore, applyTheme } from "./stores/appStore";
import { getNotionToken, fetchTodos, fetchReports, fetchProjects } from "./lib/notion";
import ProjectView from "./components/ProjectView";
import Reports from "./components/Reports";
import Agenda from "./components/Agenda";
import Settings from "./components/Settings";
import SearchModal from "./components/SearchModal";
import type { Page } from "./types";

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: "agenda", label: "日程", icon: "\u{1F4C5}" },
  { id: "reports", label: "日报", icon: "\u{1F4DD}" },
  { id: "goals", label: "目标", icon: "\u{1F4CB}" },
];

const PAGE_INDEX: Record<Page, number> = { agenda: 0, reports: 1, goals: 2 };

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
  const settings = useAppStore((s) => s.settings);
  const todos = useAppStore((s) => s.todos);
  const [pageKey, setPageKey] = useState(0);
  const [direction, setDirection] = useState<"left" | "right">("right");
  const navRef = useRef<HTMLDivElement>(null);

  // Apply theme on mount and when settings change
  useEffect(() => {
    applyTheme(settings);

    // Listen for system theme changes (auto mode)
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (settings.theme === "auto") applyTheme(settings);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [settings.theme, settings.accent, settings.fontSize, settings.glass]);

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
    checkForUpdates();
  }, [loadData]);

  const checkForUpdates = useCallback(async () => {
    // 跳过开发模式（web dev server 或 Tauri dev mode）
    if (
      window.location.hostname === "localhost" ||
      window.location.protocol === "http:" ||
      window.location.protocol === "tauri:" ||
      !(window as any).__TAURI_INTERNALS__
    )
      return;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update?.available) {
        try {
          await update.downloadAndInstall();
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        } catch (e) {
          console.log("Auto-update install failed:", e);
        }
      }
    } catch (e) {
      console.log("Update check skipped:", e);
    }
  }, []);

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

    const saved = localStorage.getItem(KEY);
    if (saved) {
      try {
        const { width, height, x, y } = JSON.parse(saved);
        if (width && height) win.setSize(new LogicalSize(width, height));
        if (x != null && y != null) win.setPosition(new LogicalPosition(x, y));
      } catch {}
    }

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
    try { await invoke("window_close"); } catch {}
  };

  const handleMinimize = async () => {
    try { await invoke("window_minimize"); } catch {}
  };

  const handleNavClick = (id: Page) => {
    if (id !== currentPage) {
      setDirection(PAGE_INDEX[id] > PAGE_INDEX[currentPage] ? "left" : "right");
      setPageKey((k) => k + 1);
      setCurrentPage(id);
    }
  };

  const renderPage = () => {
    switch (currentPage) {
      case "agenda":
        return <Agenda onRefresh={loadData} />;
      case "goals":
        return <ProjectView />;
      case "reports":
        return <Reports />;
    }
  };

  return (
    <div className="h-screen flex flex-col text-text-primary">
      {/* Title Bar */}
      <div
        className="titlebar flex items-center justify-between px-4 shrink-0"
        style={{ background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.06)", height: "36px" }}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm">&#129514;</span>
          <span className="text-xs font-medium text-text-secondary">AntDesk</span>
          <span className={`w-1.5 h-1.5 rounded-full transition-colors duration-500 ${notionConnected ? "bg-accent-green" : "bg-accent-red"}`} />
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setShowSearch(true); setShowSettings(false); }}
            className="titlebar-btn w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary"
            title="搜索 (Ctrl+K)"
          >
            &#128269;
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`titlebar-btn w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary ${showSettings ? "active" : ""}`}
          >
            &#x2699;
          </button>
          <button
            onClick={handleMinimize}
            className="titlebar-btn w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary"
          >
            &#x2013;
          </button>
          <button
            onClick={handleClose}
            className="titlebar-btn w-6 h-6 flex items-center justify-center rounded-md text-text-muted hover:text-white"
            style={{ "--hover-bg": "rgba(255,59,48,0.8)" } as React.CSSProperties}
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Content — animated page transition */}
      <div className="flex-1 overflow-y-auto p-4">
        {!notionConnected && todos.length === 0 ? (
          <div className="space-y-3">
            <div className="skeleton h-14" />
            <div className="skeleton h-24" />
            <div className="skeleton h-20" />
            <div className="skeleton h-20" />
            <div className="skeleton h-12" />
          </div>
        ) : (
          <div key={pageKey} className={direction === "left" ? "page-enter-left" : "page-enter-right"}>
            {renderPage()}
          </div>
        )}
      </div>

      {/* Bottom Nav */}
      <div
        ref={navRef}
        className="relative flex items-center justify-around shrink-0 py-2"
        style={{ background: "rgba(255,255,255,0.03)", borderTop: "1px solid rgba(255,255,255,0.06)" }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = currentPage === item.id;
          return (
            <button
              key={item.id}
              onClick={() => handleNavClick(item.id)}
              className={`nav-item flex flex-col items-center gap-0.5 px-3 py-1 rounded-xl ${
                isActive ? "text-accent-blue nav-item-active" : "text-text-muted hover:text-text-secondary"
              }`}
            >
              <span className="text-sm leading-none">{item.icon}</span>
              <span className="text-[10px]">{item.label}</span>
            </button>
          );
        })}
        <div
          className="nav-indicator"
          style={{
            left: `${PAGE_INDEX[currentPage] * 33.33 + 10}%`,
            width: "16%",
          }}
        />
      </div>

      {/* Settings Slide-over */}
      {showSettings && (
        <div className="absolute inset-0 z-50 flex justify-end settings-backdrop" onClick={() => setShowSettings(false)}>
          <div
            className="w-72 h-full overflow-y-auto p-4 settings-panel"
            style={{ background: "rgba(15,15,20,0.95)", backdropFilter: "blur(30px)", borderLeft: "1px solid rgba(255,255,255,0.08)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <Settings />
          </div>
        </div>
      )}

      {/* Search Modal */}
      {showSearch && <SearchModal onClose={() => setShowSearch(false)} />}
    </div>
  );
}
