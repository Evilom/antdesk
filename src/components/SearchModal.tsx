import { useEffect, useRef, useState, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
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

  const handleSelect = (result: SearchResult) => {
    setCurrentPage(result.page);
    onClose();
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
          <span className="text-text-muted text-sm">&#128269;</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索任务、项目、日报..."
            className="flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <kbd
            className="text-[10px] text-text-muted px-1.5 py-0.5 rounded"
            style={{ background: "rgba(255,255,255,0.06)" }}
          >
            Esc
          </kbd>
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
              {items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleSelect(item)}
                  className="w-full px-4 py-2.5 text-left flex items-center gap-3 transition-colors"
                  style={{ background: "transparent" }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.background = "rgba(255,255,255,0.06)")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.background = "transparent")
                  }
                >
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
              ))}
            </div>
          ))}
          {!query.trim() && (
            <div className="px-4 py-6 text-center text-text-muted text-sm">
              输入关键词开始搜索
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
