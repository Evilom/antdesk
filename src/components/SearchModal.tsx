import { useEffect, useRef, useState, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import { IconCalendar, IconFolder, IconReport, IconSearch, IconX } from "./Icons";
import type { Page } from "../types";

interface SearchResult {
  id: string;
  type: "todo" | "project" | "report";
  label: string;
  sublabel?: string;
  page: Page;
}

const TYPE_LABELS: Record<SearchResult["type"], string> = {
  todo: "任务",
  project: "项目",
  report: "日报",
};

export default function SearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);
  const reports = useAppStore((s) => s.reports);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo<SearchResult[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];

    const todoResults: SearchResult[] = todos
      .filter((t) => t.name.toLowerCase().includes(q))
      .map((t) => ({
        id: t.id,
        type: "todo" as const,
        label: t.name,
        sublabel: t.status ? "已完成" : "未完成",
        page: "goals" as Page,
      }));

    const projectResults: SearchResult[] = projects
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({
        id: p.id,
        type: "project" as const,
        label: p.name,
        page: "goals" as Page,
      }));

    const reportResults: SearchResult[] = reports
      .filter(
        (r) =>
          r.date.includes(q) ||
          (r.summary && r.summary.toLowerCase().includes(q))
      )
      .map((r) => ({
        id: r.id,
        type: "report" as const,
        label: r.date,
        sublabel: r.summary,
        page: "reports" as Page,
      }));

    return [...todoResults, ...projectResults, ...reportResults].slice(0, 20);
  }, [query, todos, projects, reports]);

  const grouped = useMemo(() => {
    const groups: Record<string, SearchResult[]> = {};
    for (const r of results) {
      const key = TYPE_LABELS[r.type];
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    return groups;
  }, [results]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const handleSelect = (result: SearchResult) => {
    setCurrentPage(result.page);
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && results[selectedIndex]) {
      e.preventDefault();
      handleSelect(results[selectedIndex]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  const resultIcon = (type: SearchResult["type"]) => {
    if (type === "todo") return <IconCalendar size={14} />;
    if (type === "project") return <IconFolder size={14} />;
    return <IconReport size={14} />;
  };

  return (
    <div
      className="absolute inset-0 z-50 flex items-start justify-center pt-[15vh] search-backdrop"
      onClick={onClose}
    >
      <div
        className="rounded-xl overflow-hidden flex flex-col search-modal"
        style={{
          width: 360,
          maxHeight: "60vh",
          background: "rgba(20, 20, 25, 0.92)",
          backdropFilter: "blur(40px) saturate(180%)",
          WebkitBackdropFilter: "blur(40px) saturate(180%)",
          border: "1px solid rgba(255,255,255,0.1)",
          boxShadow: "0 16px 48px rgba(0,0,0,0.5)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <IconSearch size={15} className="text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="搜索任务、项目、日报..."
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <button
            onClick={onClose}
            className="w-6 h-6 rounded-md text-text-muted hover:text-text-primary hover:bg-bg-hover flex items-center justify-center transition-colors"
          >
            <IconX size={13} />
          </button>
        </div>

        {/* Results */}
        <div className="overflow-y-auto flex-1">
          {query.trim() && Object.keys(grouped).length === 0 && (
            <div className="px-4 py-6 text-center text-text-muted text-sm">
              无结果
            </div>
          )}
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type}>
              <div
                className="px-4 py-1.5 text-[10px] font-medium text-text-muted uppercase tracking-wider"
                style={{ background: "rgba(255,255,255,0.02)" }}
              >
                {type}
              </div>
              {items.map((item) => {
                const flatIndex = results.findIndex((r) => r.id === item.id && r.type === item.type);
                const active = flatIndex === selectedIndex;
                return (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setSelectedIndex(flatIndex)}
                  className={`w-full px-4 py-2.5 text-left flex items-center gap-3 transition-colors ${active ? "bg-bg-hover" : "bg-transparent hover:bg-bg-hover"}`}
                >
                  <span className={`w-7 h-7 rounded-[9px] flex items-center justify-center ${active ? "bg-accent-blue/15 text-accent-blue" : "bg-bg-hover text-text-muted"}`}>
                    {resultIcon(item.type)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-text-primary truncate">
                      {item.label}
                    </div>
                    {item.sublabel && (
                      <div className="text-[11px] text-text-muted truncate">
                        {item.sublabel}
                      </div>
                    )}
                  </div>
                </button>
              )})}
            </div>
          ))}
          {!query.trim() && (
            <div className="px-4 py-8 text-center text-text-muted text-sm">
              <div className="mx-auto mb-2 w-9 h-9 rounded-[12px] bg-bg-hover flex items-center justify-center">
                <IconSearch size={17} />
              </div>
              输入关键词开始搜索
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
