import { useState, useCallback, useMemo, useEffect } from "react";
import { useAppStore } from "../stores/appStore";
import { fetchReportContent, createReport, fetchReports } from "../lib/notion";
import KamiReport from "./KamiReport";

/* ── Markdown renderer for daily reports ── */
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
            borderTop: "1px solid rgba(255,255,255,0.06)",
            margin: "10px 0",
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
            marginTop: elements.length > 0 ? 12 : 0,
            marginBottom: 6,
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{
            width: 3,
            height: 12,
            borderRadius: 2,
            background: "rgba(0, 122, 255, 0.6)",
            flexShrink: 0,
          }} />
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
            color: "rgba(255,255,255,0.7)",
            marginTop: 8,
            marginBottom: 4,
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
        <ul key={`ul-${i}`} style={{ margin: "4px 0", paddingLeft: 16 }}>
          {items.map((item, j) => (
            <li
              key={j}
              style={{
                fontSize: 12,
                lineHeight: 1.7,
                color: "rgba(255,255,255,0.7)",
                listStyleType: "none",
                position: "relative",
                paddingLeft: 10,
              }}
            >
              <span style={{
                position: "absolute",
                left: 0,
                top: 0,
                color: "rgba(0, 122, 255, 0.5)",
                fontSize: 10,
              }}>›</span>
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
          lineHeight: 1.7,
          color: "rgba(255,255,255,0.6)",
          margin: "3px 0",
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

// ── Get calendar days for a month ──
function getMonthDays(year: number, month: number) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startPad = firstDay.getDay(); // 0=Sun
  const totalDays = lastDay.getDate();
  const days: (number | null)[] = [];
  for (let p = 0; p < startPad; p++) days.push(null);
  for (let d = 1; d <= totalDays; d++) days.push(d);
  return days;
}

export default function Reports() {
  const reports = useAppStore((s) => s.reports);
  const todos = useAppStore((s) => s.todos);
  const projects = useAppStore((s) => s.projects);
  const token = useAppStore((s) => s.settings.notionToken);
  const setReports = useAppStore((s) => s.setReports);

  const today = new Date();
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-indexed
  const [selectedDate, setSelectedDate] = useState<string | null>(
    today.toISOString().slice(0, 10)
  );
  const [selectedContent, setSelectedContent] = useState<string>("");
  const [contentLoading, setContentLoading] = useState(false);

  // Quick write
  const [writeOpen, setWriteOpen] = useState(false);
  const [writeContent, setWriteContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Kami view toggle
  const [kamiView, setKamiView] = useState(false);

  // Build date → report map
  const reportMap = useMemo(() => {
    const map = new Map<string, { id: string; summary?: string }>();
    for (const r of reports) {
      map.set(r.date, { id: r.id, summary: r.summary });
    }
    return map;
  }, [reports]);

  // Calendar days for current view month
  const calendarDays = useMemo(() => getMonthDays(viewYear, viewMonth), [viewYear, viewMonth]);

  const monthLabel = `${viewYear}年${viewMonth + 1}月`;
  const weekHeaders = ["日", "一", "二", "三", "四", "五", "六"];

  // Navigate months
  const prevMonth = useCallback(() => {
    if (viewMonth === 0) {
      setViewYear(viewYear - 1);
      setViewMonth(11);
    } else {
      setViewMonth(viewMonth - 1);
    }
  }, [viewYear, viewMonth]);

  const nextMonth = useCallback(() => {
    if (viewMonth === 11) {
      setViewYear(viewYear + 1);
      setViewMonth(0);
    } else {
      setViewMonth(viewMonth + 1);
    }
  }, [viewYear, viewMonth]);

  // Load content when selected date changes
  useEffect(() => {
    if (!selectedDate) {
      setSelectedContent("");
      return;
    }
    const report = reportMap.get(selectedDate);
    if (!report) {
      setSelectedContent("");
      return;
    }
    setContentLoading(true);
    fetchReportContent(token, report.id)
      .then((c) => setSelectedContent(c))
      .catch(() => setSelectedContent("加载失败"))
      .finally(() => setContentLoading(false));
  }, [selectedDate, reportMap, token]);

  const handleQuoteToday = useCallback(() => {
    const todayStr = today.toISOString().slice(0, 10);
    const doneToday = todos.filter(
      (t) => t.status && t.dueDate === todayStr
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
      const todayStr = today.toISOString().slice(0, 10);
      await createReport(token, todayStr, writeContent);
      const fresh = await fetchReports(token);
      setReports(fresh);
      setWriteContent("");
      setWriteOpen(false);
      setSelectedDate(todayStr);
    } catch (e) {
      console.error("Failed to save report:", e);
    } finally {
      setSaving(false);
    }
  }, [writeContent, token, today, setReports]);

  const todayStr = today.toISOString().slice(0, 10);

  return (
    <div className="space-y-3 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">日报</h2>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted">{reports.length} 条</span>
          <button
            onClick={() => setKamiView(!kamiView)}
            className={`text-[10px] px-2 py-0.5 rounded-md transition-colors ${
              kamiView
                ? "bg-[#1B365D]/30 text-[#8BA4C9] border border-[#1B365D]/40"
                : "bg-white/5 text-text-muted hover:bg-white/10"
            }`}
            title="Kami 排版视图"
          >
            {kamiView ? "标准" : "Kami"}
          </button>
          <button
            onClick={() => setWriteOpen(!writeOpen)}
            className="text-[10px] px-2 py-0.5 rounded-md bg-accent/20 text-accent hover:bg-accent/30 transition-colors"
          >
            {writeOpen ? "收起" : "写日报"}
          </button>
        </div>
      </div>

      {/* Quick write area */}
      {writeOpen && (
        <div className="bg-bg-card rounded-card p-3 space-y-2 fade-in">
          <textarea
            value={writeContent}
            onChange={(e) => setWriteContent(e.target.value)}
            placeholder={"## 完成事项\n- 任务1\n- 任务2\n\n## 进行中\n- 任务3\n\n## 明日计划\n- 任务4"}
            className="w-full h-28 bg-white/5 rounded-lg p-2 text-xs text-text-primary placeholder:text-text-muted resize-none outline-none border border-white/10 focus:border-white/20"
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

      {/* Calendar with integrated content */}
      <div className="bg-bg-card rounded-card overflow-hidden">
        {/* Month navigation */}
        <div className="flex items-center justify-between px-3 pt-3 pb-2">
          <button
            onClick={prevMonth}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors text-text-muted text-xs"
          >
            ‹
          </button>
          <span className="text-xs font-medium text-text-primary">{monthLabel}</span>
          <button
            onClick={nextMonth}
            className="w-6 h-6 flex items-center justify-center rounded-md hover:bg-white/10 transition-colors text-text-muted text-xs"
          >
            ›
          </button>
        </div>

        {/* Week headers */}
        <div className="grid grid-cols-7 gap-0.5 px-3 mb-1">
          {weekHeaders.map((d) => (
            <div key={d} className="text-center text-[9px] text-text-muted py-0.5">
              {d}
            </div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-0.5 px-3 pb-2">
          {calendarDays.map((day, idx) => {
            if (day === null) return <div key={`pad-${idx}`} />;
            const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
            const hasReport = reportMap.has(dateStr);
            const isToday = dateStr === todayStr;
            const isSelected = dateStr === selectedDate;

            return (
              <button
                key={dateStr}
                onClick={() => setSelectedDate(dateStr === selectedDate ? null : dateStr)}
                className={`
                  relative aspect-square rounded-lg flex flex-col items-center justify-center gap-0.5
                  transition-all duration-150 text-xs
                  ${isSelected
                    ? "bg-accent/25 border border-accent/40"
                    : hasReport
                      ? "bg-white/8 hover:bg-white/12 border border-transparent"
                      : "hover:bg-white/5 border border-transparent"
                  }
                  ${isToday ? "ring-1 ring-accent/30" : ""}
                `}
              >
                <span className={`text-[11px] ${isSelected ? "text-accent font-medium" : isToday ? "text-text-primary font-medium" : "text-text-secondary"}`}>
                  {day}
                </span>
                {hasReport && (
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{
                      background: isSelected ? "rgba(0, 122, 255, 0.8)" : "rgba(0, 122, 255, 0.4)",
                    }}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Selected date content */}
        {selectedDate && (
          <div className="border-t border-white/5">
            <div className="px-3 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-text-primary">{selectedDate}</span>
                <span className="text-[9px] text-text-muted">
                  {["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(selectedDate + "T00:00:00").getDay()]}
                </span>
              </div>
              {reportMap.has(selectedDate) && (
                <span className="text-[9px] text-accent/60">已记录</span>
              )}
              {!reportMap.has(selectedDate) && selectedDate <= todayStr && (
                <span className="text-[9px] text-text-muted">未记录</span>
              )}
            </div>

            <div className="px-3 pb-3 max-h-72 overflow-y-auto">
              {contentLoading ? (
                <div className="text-center text-text-muted text-xs py-6">加载中...</div>
              ) : reportMap.has(selectedDate) ? (
                selectedContent ? (
                  kamiView ? (
                    <KamiReport
                      content={selectedContent}
                      date={selectedDate}
                      todos={todos}
                      reports={reports}
                      projects={projects}
                    />
                  ) : (
                    <ReportContent content={selectedContent} />
                  )
                ) : (
                  <div className="text-center text-text-muted text-xs py-4">无内容</div>
                )
              ) : (
                <div className="text-center text-text-muted text-xs py-6">
                  {selectedDate > todayStr ? "未来日期" : "这一天没有记录"}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
