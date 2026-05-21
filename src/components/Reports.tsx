import { useState, useCallback, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import { fetchReportContent, createReport, fetchReports } from "../lib/notion";

export default function Reports() {
  const reports = useAppStore((s) => s.reports);
  const todos = useAppStore((s) => s.todos);
  const token = useAppStore((s) => s.settings.notionToken);
  const setReports = useAppStore((s) => s.setReports);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedContent, setExpandedContent] = useState<string>("");
  const [loading, setLoading] = useState(false);

  // Quick write
  const [writeOpen, setWriteOpen] = useState(true);
  const [writeContent, setWriteContent] = useState("");
  const [saving, setSaving] = useState(false);

  const today = new Date().toISOString().slice(0, 10);

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

  const handleQuoteToday = useCallback(() => {
    const doneToday = todos.filter(
      (t) => t.status && t.dueDate === today
    );
    if (doneToday.length === 0) {
      const allDone = todos.filter((t) => t.status);
      if (allDone.length === 0) return;
      const bullets = allDone.map((t) => `- ${t.name}`).join("\n");
      setWriteContent((prev) => (prev ? prev + "\n" + bullets : bullets));
      return;
    }
    const bullets = doneToday.map((t) => `- ${t.name}`).join("\n");
    setWriteContent((prev) => (prev ? prev + "\n" + bullets : bullets));
  }, [todos, today]);

  const handleSave = useCallback(async () => {
    if (!writeContent.trim()) return;
    setSaving(true);
    try {
      const newReport = await createReport(token, today, writeContent);
      const fresh = await fetchReports(token);
      setReports(fresh);
      setWriteContent("");
    } catch (e) {
      console.error("Failed to save report:", e);
    } finally {
      setSaving(false);
    }
  }, [writeContent, token, today, setReports]);

  // Calendar heatmap: last 30 days
  const heatmapDays = useMemo(() => {
    const reportDates = new Set(reports.map((r) => r.date));
    const days: { date: string; hasReport: boolean; isToday: boolean }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().slice(0, 10);
      days.push({
        date: dateStr,
        hasReport: reportDates.has(dateStr),
        isToday: dateStr === today,
      });
    }
    return days;
  }, [reports, today]);

  const monthLabel = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }, []);

  return (
    <div className="space-y-3 fade-in">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">日报</h2>
        <span className="text-[10px] text-text-muted">{reports.length} 条</span>
      </div>

      {/* Quick write area */}
      <div className="bg-bg-card rounded-card overflow-hidden">
        <button
          onClick={() => setWriteOpen(!writeOpen)}
          className="w-full p-3 text-left hover:bg-bg-hover transition-colors"
        >
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-text-primary">
              写日报
            </span>
            <span className="text-[10px] text-text-muted">
              {writeOpen ? "收起" : "展开"}
            </span>
          </div>
        </button>

        {writeOpen && (
          <div className="px-3 pb-3 space-y-2 border-t border-white/5 pt-2">
            <textarea
              value={writeContent}
              onChange={(e) => setWriteContent(e.target.value)}
              placeholder="今天完成了什么？"
              className="w-full h-24 bg-white/5 rounded-lg p-2 text-xs text-text-primary placeholder:text-text-muted resize-none outline-none border border-white/10 focus:border-white/20"
            />
            <div className="flex gap-2">
              <button
                onClick={handleQuoteToday}
                className="flex-1 py-1.5 text-[10px] bg-white/5 hover:bg-white/10 rounded-lg transition-colors text-text-secondary"
              >
                引用今日任务
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !writeContent.trim()}
                className="flex-1 py-1.5 text-[10px] bg-accent/20 hover:bg-accent/30 rounded-lg transition-colors text-accent disabled:opacity-40"
              >
                {saving ? "保存中..." : "保存"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Calendar heatmap */}
      <div className="bg-bg-card rounded-card p-3">
        <div className="text-[10px] text-text-muted mb-2">{monthLabel}</div>
        <div className="grid grid-cols-6 gap-1">
          {heatmapDays.map((day) => (
            <div
              key={day.date}
              title={day.date}
              className={`aspect-square rounded-[3px] transition-colors ${
                day.hasReport
                  ? "bg-accent/70"
                  : "bg-white/5"
              } ${day.isToday ? "ring-1 ring-accent/50" : ""}`}
            />
          ))}
        </div>
      </div>

      {/* Report list */}
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
