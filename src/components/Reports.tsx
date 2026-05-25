import { useState, useCallback, useMemo } from "react";
import { useAppStore } from "../stores/appStore";
import { fetchReportContent, createReport, fetchReports } from "../lib/notion";

/* ── Markdown-ish renderer for daily reports ── */
function ReportContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- separator
    if (/^-{3,}$/.test(line.trim())) {
      elements.push(
        <hr
          key={`hr-${i}`}
          style={{
            border: "none",
            borderTop: "1px solid rgba(255,255,255,0.08)",
            margin: "8px 0",
          }}
        />
      );
      i++;
      continue;
    }

    // ## heading
    if (line.trim().startsWith("## ")) {
      elements.push(
        <div
          key={`h-${i}`}
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: "rgba(255,255,255,0.9)",
            marginTop: elements.length > 0 ? 10 : 0,
            marginBottom: 4,
          }}
        >
          {line.trim().slice(3)}
        </div>
      );
      i++;
      continue;
    }

    // ### subheading
    if (line.trim().startsWith("### ")) {
      elements.push(
        <div
          key={`h3-${i}`}
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "rgba(255,255,255,0.75)",
            marginTop: 8,
            marginBottom: 3,
          }}
        >
          {line.trim().slice(4)}
        </div>
      );
      i++;
      continue;
    }

    // - list item
    if (line.trim().startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} style={{ margin: "2px 0", paddingLeft: 14 }}>
          {items.map((item, j) => (
            <li
              key={j}
              style={{
                fontSize: 12,
                lineHeight: 1.6,
                color: "rgba(255,255,255,0.7)",
                listStyleType: "'›  '",
                marginLeft: 2,
              }}
            >
              {renderInline(item)}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Normal paragraph
    elements.push(
      <p
        key={`p-${i}`}
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          color: "rgba(255,255,255,0.65)",
          margin: "2px 0",
        }}
      >
        {renderInline(line)}
      </p>
    );
    i++;
  }

  return <>{elements}</>;
}

/** Render **bold** and `code` inline */
function renderInline(text: string): (string | React.ReactElement)[] {
  const parts: (string | React.ReactElement)[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    const boldMatch = remaining.match(/\*\*(.+?)\*\*/);
    const codeMatch = remaining.match(/`(.+?)`/);

    let firstMatch: RegExpMatchArray | null = null;
    let type = "";

    if (boldMatch && codeMatch) {
      if ((boldMatch.index ?? 0) < (codeMatch.index ?? 0)) {
        firstMatch = boldMatch;
        type = "bold";
      } else {
        firstMatch = codeMatch;
        type = "code";
      }
    } else if (boldMatch) {
      firstMatch = boldMatch;
      type = "bold";
    } else if (codeMatch) {
      firstMatch = codeMatch;
      type = "code";
    }

    if (!firstMatch || firstMatch.index === undefined) {
      parts.push(remaining);
      break;
    }

    if (firstMatch.index > 0) {
      parts.push(remaining.slice(0, firstMatch.index));
    }

    if (type === "bold") {
      parts.push(
        <strong key={key++} style={{ color: "rgba(255,255,255,0.9)", fontWeight: 600 }}>
          {firstMatch[1]}
        </strong>
      );
    } else {
      parts.push(
        <code
          key={key++}
          style={{
            fontSize: 11,
            padding: "1px 4px",
            borderRadius: 3,
            background: "rgba(255,255,255,0.08)",
            color: "#ff9f0a",
          }}
        >
          {firstMatch[1]}
        </code>
      );
    }

    remaining = remaining.slice(firstMatch.index + firstMatch[0].length);
  }

  return parts;
}

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

  const weekHeaders = ["日", "一", "二", "三", "四", "五", "六"];

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
              placeholder={"今天完成了什么？\n\n## 完成事项\n- 任务1\n- 任务2"}
              className="w-full h-24 bg-white/5 rounded-lg p-2 text-xs text-text-primary placeholder:text-text-muted resize-none outline-none border border-white/10 focus:border-white/20"
              style={{ fontFamily: "monospace" }}
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
        <div className="grid grid-cols-7 gap-0.5 mb-1">
          {weekHeaders.map((d) => (
            <div key={d} className="text-center text-[9px] text-text-muted">
              {d}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {/* Pad to start on correct weekday */}
          {(() => {
            const firstDay = new Date();
            firstDay.setDate(firstDay.getDate() - 29);
            const startWeekday = firstDay.getDay();
            const pads = Array(startWeekday).fill(null);
            return pads.map((_, i) => <div key={`pad-${i}`} />);
          })()}
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
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-text-primary">
                    {report.date}
                  </span>
                  <span className="text-[9px] text-text-muted">
                    {(() => {
                      const d = new Date(report.date + "T00:00:00");
                      return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
                    })()}
                  </span>
                </div>
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
                  <div className="max-h-64 overflow-y-auto">
                    <ReportContent content={expandedContent || "无内容"} />
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
