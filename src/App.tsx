import { useEffect, useCallback, useState } from "react";
import { getCurrentWindow, LogicalSize, LogicalPosition } from "@tauri-apps/api/window";
import { useAppStore, applyTheme } from "./stores/appStore";
import { getNotionToken, fetchTodos, fetchReports, fetchProjects } from "./lib/notion";
import ProjectView from "./components/ProjectView";
import Reports from "./components/Reports";
import Agenda from "./components/Agenda";
import Settings from "./components/Settings";
import SearchModal from "./components/SearchModal";
import { IconCalendar, IconEdit, IconMinimize, IconSearch, IconSettings, IconTarget, IconX } from "./components/Icons";
import type { Page } from "./types";

const NAV_ITEMS = [
  { id: "agenda" as Page, label: "日程", Icon: IconCalendar },
  { id: "reports" as Page, label: "日报", Icon: IconEdit },
  { id: "goals" as Page, label: "目标", Icon: IconTarget },
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
  const settings = useAppStore((s) => s.settings);
  const todos = useAppStore((s) => s.todos);

  // Apply theme on mount and when settings change
  useEffect(() => {
    applyTheme(settings);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => { if (settings.theme === "auto") applyTheme(settings); };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [settings.theme, settings.accent, settings.fontSize, settings.glass]);

  const loadData = useCallback(async () => {
    try {
      const token = await getNotionToken();
      updateSettings({ notionToken: token });
      setNotionConnected(true);

      const [todos, reports, projects] = await Promise.all([
        fetchTodos(token).catch((e) => { console.error("fetchTodos error:", e); return []; }),
        fetchReports(token).catch((e) => { console.error("fetchReports error:", e); return []; }),
        fetchProjects(token).catch((e) => { console.error("fetchProjects error:", e); return []; }),
      ]);
      setTodos(todos);
      setReports(reports);
      setProjects(projects);
    } catch (e) {
      console.error("loadData error:", e);
      setNotionConnected(false);
    }
  }, [setTodos, setReports, setProjects, setNotionConnected, updateSettings]);

  useEffect(() => { loadData(); checkForUpdates(); }, [loadData]);

  const checkForUpdates = useCallback(async () => {
    if (window.location.hostname === "localhost" || window.location.protocol === "http:" || window.location.protocol === "tauri:" || !(window as any).__TAURI_INTERNALS__) return;
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update?.available) {
        try {
          await update.downloadAndInstall();
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        } catch (e) { console.log("Auto-update install failed:", e); }
      }
    } catch (e) { console.log("Update check skipped:", e); }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") { e.preventDefault(); setShowSearch((v) => !v); setShowSettings(false); }
      if (e.key === "Escape") { if (showSearch) setShowSearch(false); else if (showSettings) setShowSettings(false); }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showSearch, showSettings]);

  // Window state persistence
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
    const save = async () => {
      try {
        const [size, pos] = await Promise.all([win.innerSize(), win.outerPosition()]);
        localStorage.setItem(KEY, JSON.stringify({ width: size.width, height: size.height, x: pos.x, y: pos.y }));
      } catch {}
    };
    const unlistenResize = win.onResized(save);
    const unlistenMove = win.onMoved(save);
    return () => { unlistenResize.then((f) => f()); unlistenMove.then((f) => f()); };
  }, []);

  const handleMinimize = useCallback(() => getCurrentWindow().minimize(), []);
  const handleClose = useCallback(() => getCurrentWindow().hide(), []);

  const renderPage = () => {
    switch (currentPage) {
      case "agenda": return <Agenda onRefresh={loadData} />;
      case "reports": return <Reports />;
      case "goals": return <ProjectView />;
      default: return <Agenda onRefresh={loadData} />;
    }
  };

  return (
    <div className="flex flex-col h-screen relative overflow-hidden">
      {/* Titlebar */}
      <div className="titlebar">
        {/* Left: Brand */}
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-[9px] bg-accent-blue/10 flex items-center justify-center shadow-sm">
            <IconTarget size={15} className="text-accent-blue" />
          </div>
          <div className="flex flex-col">
            <span className="text-[12px] font-semibold text-text-primary tracking-tight leading-tight">AntDesk</span>
            <div className="flex items-center gap-1.5">
              <span className={`w-[5px] h-[5px] rounded-full ${notionConnected ? "bg-accent-green animate-pulse" : "bg-accent-red"}`} />
              <span className="text-[9px] text-text-muted font-medium">{notionConnected ? "Connected" : "Offline"}</span>
            </div>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => { setShowSearch(true); setShowSettings(false); }}
            className="h-7 px-2.5 flex items-center gap-1.5 rounded-full bg-bg-card border border-border-card text-text-muted hover:text-text-primary hover:border-border-hover transition-all"
          >
            <IconSearch size={13} />
            <span className="text-[10px] hidden">搜索</span>
            <kbd className="text-[8px] bg-bg-hover px-1 py-px rounded text-text-muted border border-border-card ml-0.5 font-mono">⌘K</kbd>
          </button>

          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`w-7 h-7 flex items-center justify-center rounded-full transition-all ${showSettings ? "bg-bg-card text-accent-blue" : "text-text-muted hover:text-text-primary hover:bg-bg-hover"}`}
          >
            <IconSettings size={14} />
          </button>
          
          <div className="h-3.5 w-px bg-border-card mx-0.5" />

          <button onClick={handleMinimize} className="w-6 h-6 flex items-center justify-center rounded-full text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors">
            <IconMinimize size={13} />
          </button>
          <button onClick={handleClose} className="w-6 h-6 flex items-center justify-center rounded-full text-text-muted hover:bg-accent-red hover:text-white transition-colors">
            <IconX size={12} />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <main className="flex-1 overflow-hidden relative">
        <div className="h-full overflow-y-auto px-4 pb-24 pt-2 custom-scrollbar">
          {!notionConnected && todos.length === 0 ? (
            <div className="space-y-3 pt-4">
              {[1, 2, 3, 4].map((i) => (
                <div key={i} className="h-20 skeleton" />
              ))}
            </div>
          ) : (
            <div className="page-content-wrapper">
              {renderPage()}
            </div>
          )}
        </div>
      </main>

      {/* Bottom Navigation — Floating Pill */}
      <div className="absolute bottom-5 left-0 right-0 flex justify-center pointer-events-none z-50">
        <div className="pointer-events-auto nav-pill">
          {NAV_ITEMS.map((item) => {
            const isActive = currentPage === item.id;
            const Icon = item.Icon;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentPage(item.id)}
                className={`nav-item ${isActive ? "active" : ""}`}
              >
                <span className="nav-icon"><Icon size={15} /></span>
                <span className="nav-label">{item.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Settings Slide-over */}
      {showSettings && (
        <div className="absolute inset-0 z-[60] flex justify-end animate-fade-in" style={{ background: "var(--overlay-bg)", backdropFilter: "blur(6px)" }} onClick={() => setShowSettings(false)}>
          <div
            className="w-[300px] h-full overflow-y-auto animate-slide-in-right"
            style={{ background: "rgba(18,18,22,0.96)", backdropFilter: "blur(60px) saturate(200%)", WebkitBackdropFilter: "blur(60px) saturate(200%)", borderLeft: "0.5px solid var(--border-card)", boxShadow: "-8px 0 40px rgba(0,0,0,0.2)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-sm font-semibold text-text-primary tracking-tight">设置</h2>
                <button onClick={() => setShowSettings(false)} className="w-7 h-7 flex items-center justify-center rounded-full hover:bg-bg-hover transition-colors text-text-muted hover:text-text-primary">
                  <IconX size={13} />
                </button>
              </div>
              <Settings />
            </div>
          </div>
        </div>
      )}

      {/* Search Modal */}
      {showSearch && <SearchModal onClose={() => setShowSearch(false)} />}
    </div>
  );
}
