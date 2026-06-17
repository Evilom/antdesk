import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { fetchReportContent, createReport, fetchReports } from "../lib/notion";
import { sendChatMessage } from "../lib/chat";
import { localDateString } from "../lib/date";
import { IconBrain, IconChevronLeft, IconChevronRight, IconEdit, IconReport } from "./Icons";
import KamiReport from "./KamiReport";

/* ── Markdown renderer for daily reports ── */
function ReportContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const elements: React.ReactElement[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^-{3,}$/.test(line.trim())) {
      elements.push(<hr key={`hr-${i}`} />);
      i++;
      continue;
    }

    if (line.trim().startsWith("## ")) {
      elements.push(
        <div key={`h-${i}`} className="report-content">
          <h2>{line.trim().slice(3)}</h2>
        </div>
      );
      i++;
      continue;
    }

    if (line.trim().startsWith("### ")) {
      elements.push(
        <div key={`h3-${i}`} className="report-content">
          <h3>{line.trim().slice(4)}</h3>
        </div>
      );
      i++;
      continue;
    }

    if (line.trim().startsWith("- ")) {
      const items: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("- ")) {
        items.push(lines[i].trim().slice(2));
        i++;
      }
      elements.push(
        <ul key={`ul-${i}`} style={{ margin: "4px 0", paddingLeft: 16 }}>
          {items.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    if (!line.trim()) { i++; continue; }

    elements.push(
      <p key={`p-${i}`}>{renderInline(line)}</p>
    );
    i++;
  }

  return <div className="report-content">{elements}</div>;
}

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
      if ((boldMatch.index ?? 0) < (codeMatch.index ?? 0)) { firstMatch = boldMatch; type = "bold"; }
      else { firstMatch = codeMatch; type = "code"; }
    } else if (boldMatch) { firstMatch = boldMatch; type = "bold"; }
    else if (codeMatch) { firstMatch = codeMatch; type = "code"; }

    if (!firstMatch || firstMatch.index === undefined) { parts.push(remaining); break; }
    if (firstMatch.index > 0) parts.push(remaining.slice(0, firstMatch.index));

    if (type === "bold") parts.push(<strong key={key++}>{firstMatch[1]}</strong>);
    else parts.push(<code key={key++}>{firstMatch[1]}</code>);

    remaining = remaining.slice(firstMatch.index + firstMatch[0].length);
  }

  return parts;
}

/* ═══════════════════════════════════════════
   Main Reports Component
   ═══════════════════════════════════════════ */
export default function Reports() {
  const todos = useAppStore((s) => s.todos);
  const reports = useAppStore((s) => s.reports);
  const projects = useAppStore((s) => s.projects);
  const token = useAppStore((s) => s.settings.notionToken);
  const setReports = useAppStore((s) => s.setReports);

  const [showWrite, setShowWrite] = useState(false);
  const [writeContent, setWriteContent] = useState("");
  const [saving, setSaving] = useState(false);

  // Calendar state
  const today = new Date();
  const todayStr = localDateString(today);
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth());
  const [selectedDate, setSelectedDate] = useState<string | null>(todayStr);
  const [selectedContent, setSelectedContent] = useState<string | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [kamiView, setKamiView] = useState(false);
  const reportDate = selectedDate && selectedDate <= todayStr ? selectedDate : todayStr;

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Report date set
  const reportMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reports) {
      if (r.date) map.set(r.date, r.id);
    }
    return map;
  }, [reports]);

  // Calendar days
  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewYear, viewMonth, 1).getDay();
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const days: (number | null)[] = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let d = 1; d <= daysInMonth; d++) days.push(d);
    return days;
  }, [viewYear, viewMonth]);

  const monthLabel = `${viewYear}年${viewMonth + 1}月`;
  const weekHeaders = ["日", "一", "二", "三", "四", "五", "六"];
  const monthReportCount = useMemo(() => {
    const prefix = `${viewYear}-${String(viewMonth + 1).padStart(2, "0")}`;
    return reports.filter((r) => r.date.startsWith(prefix)).length;
  }, [reports, viewMonth, viewYear]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1); }
    else setViewMonth(viewMonth - 1);
  };

  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1); }
    else setViewMonth(viewMonth + 1);
  };

  // Fetch content for selected date
  useEffect(() => {
    if (!selectedDate || !reportMap.has(selectedDate)) { setSelectedContent(null); return; }
    const reportId = reportMap.get(selectedDate)!;
    setContentLoading(true);
    fetchReportContent(token, reportId)
      .then((c) => setSelectedContent(c))
      .catch(() => setSelectedContent(null))
      .finally(() => setContentLoading(false));
  }, [selectedDate, reportMap, token]);

  // Save report
  const handleSave = useCallback(async () => {
    if (!writeContent.trim() || saving) return;
    setSaving(true);
    try {
      await createReport(token, reportDate, writeContent);
      const updated = await fetchReports(token);
      setReports(updated);
      setWriteContent("");
      setShowWrite(false);
      setSelectedDate(reportDate);
    } catch (e) {
      console.error("Save report failed:", e);
    } finally {
      setSaving(false);
    }
  }, [writeContent, saving, token, reportDate, setReports]);

  // AI Draft
  const [draftLoading, setDraftLoading] = useState(false);
  const handleAIDraft = useCallback(async () => {
    if (draftLoading) return;
    setDraftLoading(true);
    const completedToday = todos.filter((t) => t.status && t.dueDate === todayStr);
    const pending = todos.filter((t) => !t.status);
    const taskList = completedToday.map((t) => `- ${t.name}`).join("\n") || "- （暂无完成任务）";
    const pendingList = pending.slice(0, 5).map((t) => `- ${t.name}（${t.priority}）`).join("\n");

    const prompt = `请根据以下信息生成一份简洁的中文日报草稿，包含"今日完成"、"进行中"和"明日计划"三个部分：\n\n今日完成：\n${taskList}\n\n待办任务：\n${pendingList}`;

    let result = "";
    try {
      const ac = new AbortController();
      await sendChatMessage(
        useAppStore.getState().settings.aiEndpoint,
        useAppStore.getState().settings.aiModel,
        [{ role: "user", content: prompt }],
        (chunk) => { result += chunk; },
        ac.signal
      );
      if (result) {
        setWriteContent(result);
        setShowWrite(true);
      }
    } catch (e) {
      console.error("AI draft failed:", e);
    } finally {
      setDraftLoading(false);
    }
  }, [todos, todayStr, draftLoading]);

  const completedToday = useMemo(() => todos.filter((t) => t.status && t.dueDate === todayStr), [todos, todayStr]);

  return (
    <div className="space-y-3 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between px-1 pt-1 pb-1">
        <div>
          <h1 className="text-display text-text-primary">日报</h1>
          <p className="text-[10px] text-text-muted mt-0.5">{monthReportCount} 篇本月记录</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button onClick={handleAIDraft} disabled={draftLoading} className="btn-ghost text-[10px] px-2.5 py-1 disabled:opacity-40 inline-flex items-center gap-1.5">
            <IconBrain size={12} />
            {draftLoading ? "生成中..." : "AI 草稿"}
          </button>
          <button onClick={() => setShowWrite(!showWrite)} className="btn-primary text-[11px] px-3 py-1.5 inline-flex items-center gap-1.5">
            <IconEdit size={12} />
            {showWrite ? "收起" : "写日报"}
          </button>
        </div>
      </div>

      {/* Quick Write Area */}
      {showWrite && (
        <div className="card p-3.5 anim-card">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium text-text-primary">写入 {reportDate}</span>
            <span className="text-[9px] text-text-muted">{writeContent.length} 字</span>
          </div>
          <textarea
            ref={textareaRef}
            value={writeContent}
            onChange={(e) => setWriteContent(e.target.value)}
            placeholder="今天完成了什么..."
            className="input-field min-h-[100px] resize-none text-[12px] leading-relaxed"
            style={{ background: "var(--bg-input)" }}
          />
          <div className="flex items-center justify-between mt-2.5">
            <button
              onClick={() => {
                const bullets = completedToday.map((t) => `- ${t.name}`).join("\n");
                setWriteContent((prev) => prev + (prev ? "\n" : "") + bullets);
              }}
              className="btn-ghost text-[10px] px-2 py-1"
              disabled={completedToday.length === 0}
            >
              引用今日任务 ({completedToday.length})
            </button>
            <button onClick={handleSave} disabled={saving || !writeContent.trim()} className="btn-primary text-[11px] px-4 py-1.5 disabled:opacity-40">
              {saving ? "保存中..." : "保存"}
            </button>
          </div>
        </div>
      )}

      {/* Calendar */}
      <div className="card overflow-hidden">
        {/* Month navigation */}
        <div className="flex items-center justify-between px-3.5 pt-3 pb-2">
          <button onClick={prevMonth} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg-hover transition-colors text-text-muted text-xs"><IconChevronLeft size={14} /></button>
          <span className="text-[12px] font-semibold text-text-primary tracking-tight">{monthLabel}</span>
          <button onClick={nextMonth} className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-bg-hover transition-colors text-text-muted text-xs"><IconChevronRight size={14} /></button>
        </div>

        {/* Week headers */}
        <div className="grid grid-cols-7 gap-0.5 px-3.5 mb-1">
          {weekHeaders.map((d) => (
            <div key={d} className="text-center text-[9px] text-text-muted py-0.5 font-medium">{d}</div>
          ))}
        </div>

        {/* Day grid */}
        <div className="grid grid-cols-7 gap-0.5 px-3.5 pb-2.5">
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
                className={`calendar-day ${hasReport ? "has-report" : ""} ${isSelected ? "selected" : ""} ${isToday ? "today" : ""}`}
              >
                <span className={`text-[11px] ${isSelected ? "text-accent-blue font-semibold" : isToday ? "text-text-primary font-semibold" : "text-text-secondary"}`}>
                  {day}
                </span>
                {hasReport && (
                  <span className="w-[4px] h-[4px] rounded-full" style={{ background: isSelected ? "var(--accent-primary)" : "rgba(10,132,255,0.35)" }} />
                )}
              </button>
            );
          })}
        </div>

        {/* Selected date content */}
        {selectedDate && (
          <div className="border-t" style={{ borderColor: "var(--border-separator)" }}>
            <div className="px-3.5 py-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-text-primary">{selectedDate}</span>
                <span className="text-[9px] text-text-muted">
                  {["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(selectedDate + "T00:00:00").getDay()]}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {reportMap.has(selectedDate) && (
                  <button onClick={() => setKamiView(!kamiView)} className="text-[9px] text-accent-blue/60 hover:text-accent-blue transition-colors">
                    {kamiView ? "普通视图" : "Kami 视图"}
                  </button>
                )}
                {reportMap.has(selectedDate) && <span className="text-[9px] text-accent-green/60">已记录</span>}
                {!reportMap.has(selectedDate) && selectedDate <= todayStr && <span className="text-[9px] text-text-muted">未记录</span>}
              </div>
            </div>

            <div className="px-3.5 pb-3 max-h-72 overflow-y-auto">
              {contentLoading ? (
                <div className="text-center text-text-muted text-[11px] py-6">加载中...</div>
              ) : reportMap.has(selectedDate) ? (
                selectedContent ? (
                  kamiView ? (
                    <KamiReport content={selectedContent} date={selectedDate} todos={todos} reports={reports} projects={projects} />
                  ) : (
                    <ReportContent content={selectedContent} />
                  )
                ) : (
                  <div className="text-center text-text-muted text-[11px] py-4">无内容</div>
                )
              ) : (
                <div className="text-center text-text-muted text-[11px] py-6">
                  <div className="mx-auto mb-2 w-8 h-8 rounded-[10px] bg-bg-hover text-text-muted flex items-center justify-center">
                    <IconReport size={15} />
                  </div>
                  <div>{selectedDate > todayStr ? "未来日期" : "这一天没有记录"}</div>
                  {selectedDate <= todayStr && (
                    <button
                      onClick={() => {
                        setShowWrite(true);
                        setWriteContent((prev) => prev || `## 今日完成\n\n## 进行中\n\n## 明日计划\n`);
                      }}
                      className="mt-2 text-[10px] text-accent-blue hover:text-accent-blue transition-colors"
                    >
                      写一篇
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
