import { useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./stores/appStore";
import { getNotionToken, fetchTodos, fetchReports } from "./lib/notion";
import Dashboard from "./components/Dashboard";
import TaskList from "./components/TaskList";
import Reports from "./components/Reports";
import Chat from "./components/Chat";
import Settings from "./components/Settings";
import type { Page } from "./types";

const NAV_ITEMS: { id: Page; label: string; icon: string }[] = [
  { id: "dashboard", label: "仪表盘", icon: " " },
  { id: "tasks", label: "任务", icon: " " },
  { id: "reports", label: "日报", icon: " " },
  { id: "chat", label: "AI", icon: " " },
  { id: "settings", label: "设置", icon: " " },
];

export default function App() {
  const currentPage = useAppStore((s) => s.currentPage);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);
  const setTodos = useAppStore((s) => s.setTodos);
  const setReports = useAppStore((s) => s.setReports);
  const setNotionConnected = useAppStore((s) => s.setNotionConnected);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const notionConnected = useAppStore((s) => s.notionConnected);

  const loadData = useCallback(async () => {
    try {
      const token = await getNotionToken();
      updateSettings({ notionToken: token });
      setNotionConnected(true);

      const [todos, reports] = await Promise.all([
        fetchTodos(token).catch(() => []),
        fetchReports(token).catch(() => []),
      ]);
      setTodos(todos);
      setReports(reports);
    } catch {
      setNotionConnected(false);
    }
  }, [setTodos, setReports, setNotionConnected, updateSettings]);

  useEffect(() => {
    loadData();
  }, [loadData]);

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
      case "dashboard":
        return <Dashboard onRefresh={loadData} />;
      case "tasks":
        return <TaskList />;
      case "reports":
        return <Reports />;
      case "chat":
        return <Chat />;
      case "settings":
        return <Settings />;
    }
  };

  return (
    <div className="h-screen flex flex-col bg-bg-primary text-text-primary">
      {/* Title Bar */}
      <div className="titlebar flex items-center justify-between px-3 bg-bg-card border-b border-white/5">
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
            onClick={handleMinimize}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-bg-hover text-text-muted hover:text-text-primary transition-colors"
          >
            &#x2013;
          </button>
          <button
            onClick={handleClose}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-accent-red/80 text-text-muted hover:text-white transition-colors"
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">{renderPage()}</div>

      {/* Bottom Nav */}
      <div className="flex items-center justify-around bg-bg-card border-t border-white/5 py-1.5">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => setCurrentPage(item.id)}
            className={`flex flex-col items-center gap-0.5 px-2 py-1 rounded-lg transition-colors ${
              currentPage === item.id
                ? "text-accent-purple"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            <span className="text-base leading-none">{item.icon}</span>
            <span className="text-[10px]">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
