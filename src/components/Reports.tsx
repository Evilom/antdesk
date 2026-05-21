import { useState, useCallback } from "react";
import { useAppStore } from "../stores/appStore";
import { fetchReportContent } from "../lib/notion";

export default function Reports() {
  const reports = useAppStore((s) => s.reports);
  const token = useAppStore((s) => s.settings.notionToken);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<string>("");
  const [loading, setLoading] = useState(false);

  const handleExpand = useCallback(
    async (id: string) => {
      if (expandedId === id) {
        setExpandedId(null);
        return;
      }
      setExpandedId(id);
      setLoading(true);
      try {
        const content = await fetchReportContent(token, id);
        setExpandedContent(content);
      } catch {
        setExpandedContent("加载失败");
      } finally {
        setLoading(false);
      }
    },
    [expandedId, token]
  );

  return (
    <div className="space-y-3 fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">日报</h2>
        <span className="text-[10px] text-text-muted">{reports.length} 条</span>
      </div>

      {reports.length === 0 && (
        <div className="text-center text-text-muted text-xs py-8">
          暂无日报
        </div>
      )}

      <div className="space-y-2">
        {reports.map((report) => (
          <div
            key={report.id}
            className="bg-bg-card rounded-card overflow-hidden"
          >
            <button
              onClick={() => handleExpand(report.id)}
              className="w-full p-3 text-left hover:bg-bg-hover transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-primary">
                  {report.date}
                </span>
                <span className="text-[10px] text-text-muted">
                  {expandedId === report.id ? "收起" : "展开"}
                </span>
              </div>
              {report.summary && (
                <p className="text-[11px] text-text-secondary mt-1 line-clamp-2">
                  {report.summary}
                </p>
              )}
            </button>

            {expandedId === report.id && (
              <div className="px-3 pb-3 border-t border-white/5 pt-2">
                {loading ? (
                  <div className="text-center text-text-muted text-xs py-4">
                    加载中...
                  </div>
                ) : (
                  <div className="text-xs text-text-secondary whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                    {expandedContent || "无内容"}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
