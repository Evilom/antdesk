import { useMemo } from "react";
import type { Todo, Report, Project } from "../types";

/* ────────────────────────────────────────────
   Kami 日报渲染器
   暖色羊皮纸 + 墨蓝点缀 + 衬线体
   ──────────────────────────────────────────── */

interface KamiReportProps {
  /** 选中日期的原始 markdown 内容 */
  content: string;
  /** 日期字符串 YYYY-MM-DD */
  date: string;
  /** 所有 todos，用于统计 */
  todos: Todo[];
  /** 所有 reports，用于统计连续天数 */
  reports: Report[];
  /** 项目列表，用于解析 projectId → 名称 */
  projects: Project[];
}

/* ── 统计数据 ── */
function useStats(todos: Todo[], reports: Report[], projects: Project[], date: string) {
  return useMemo(() => {
    const projMap = new Map(projects.map((p) => [p.id, p.name]));
    const todayDone = todos.filter((t) => t.status && t.dueDate === date);
    const allDone = todos.filter((t) => t.status);
    const pending = todos.filter((t) => !t.status);
    const high = pending.filter((t) => t.priority === "High");

    // 连续日报天数
    const dates = new Set(reports.map((r) => r.date));
    let streak = 0;
    const d = new Date(date);
    while (dates.has(d.toISOString().slice(0, 10))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }

    // 按项目分组完成数
    const byProject = new Map<string, { done: number; total: number }>();
    for (const t of todos) {
      const proj = t.projectId ? projMap.get(t.projectId) || "未命名" : "收件箱";
      const entry = byProject.get(proj) || { done: 0, total: 0 };
      entry.total++;
      if (t.status) entry.done++;
      byProject.set(proj, entry);
    }

    return {
      todayDone: todayDone.length,
      allDone: allDone.length,
      pending: pending.length,
      high: high.length,
      streak,
      totalReports: reports.length,
      byProject,
    };
  }, [todos, reports, date]);
}

/* ── 解析 markdown → 结构化 sections ── */
function parseSections(md: string): { title: string; items: string[] }[] {
  const sections: { title: string; items: string[] }[] = [];
  let current: { title: string; items: string[] } | null = null;

  for (const line of md.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("## ")) {
      if (current) sections.push(current);
      current = { title: trimmed.slice(3), items: [] };
    } else if (trimmed.startsWith("- ")) {
      if (!current) current = { title: "其他", items: [] };
      current.items.push(trimmed.slice(2));
    } else if (trimmed.startsWith("### ")) {
      if (!current) current = { title: "其他", items: [] };
      current.items.push(`**${trimmed.slice(4)}**`);
    }
  }
  if (current) sections.push(current);
  return sections;
}

/* ── 生成 Kami HTML ── */
function generateKamiHTML(
  date: string,
  content: string,
  stats: ReturnType<typeof useStats>,
  sections: { title: string; items: string[] }[]
): string {
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const d = new Date(date + "T00:00:00");
  const dateLabel = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
  const weekday = weekdays[d.getDay()];

  // 项目表行
  const projectRows = Array.from(stats.byProject.entries())
    .sort((a, b) => b[1].done - a[1].done)
    .slice(0, 6)
    .map(
      ([name, { done, total }]) => `
      <tr>
        <td>${name}</td>
        <td style="text-align:center">${done}/${total}</td>
        <td><div style="background:var(--border);height:4pt;border-radius:2pt;overflow:hidden"><div style="background:var(--brand);height:100%;width:${total > 0 ? Math.round((done / total) * 100) : 0}%;border-radius:2pt"></div></div></td>
      </tr>`
    )
    .join("");

  // 内容 sections
  const sectionHTML = sections.length > 0
    ? sections
        .map(
          (s) => `
      <section style="margin-bottom:14pt;break-inside:avoid">
        <h2 style="font-family:var(--serif);font-size:14pt;font-weight:500;color:var(--near-black);margin-bottom:5pt">${s.title}</h2>
        ${s.items.length > 0
          ? `<ul style="list-style:none;margin:0;padding:0">${s.items
              .map(
                (item) => `<li style="position:relative;padding-left:14pt;margin-bottom:3pt;line-height:1.45;font-size:10pt;color:var(--dark-warm)"><span style="position:absolute;left:0;color:var(--brand)">–</span>${item
                  .replace(/\*\*(.+?)\*\*/g, '<strong style="color:var(--near-black)">$1</strong>')
                  .replace(/`(.+?)`/g, '<code style="font-size:9pt;background:var(--sand);padding:1pt 3pt;border-radius:2pt">$1</code>')
                }</li>`
              )
              .join("")}</ul>`
          : '<p style="font-size:10pt;color:var(--stone);font-style:italic">暂无记录</p>'
        }
      </section>`
        )
        .join("")
    : '<section style="margin-bottom:14pt"><p style="font-size:10pt;color:var(--stone);font-style:italic;text-align:center;padding:20pt 0">这天还没有日报记录</p></section>';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>日报 · ${dateLabel} ${weekday}</title>
<meta name="generator" content="Kami × AntDesk">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@400;500;600&display=swap');

  @page { size: A4; margin: 12mm 16mm; background: #f5f4ed; }
  * { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --parchment: #f5f4ed; --ivory: #faf9f5; --sand: #e8e6dc;
    --near-black: #141413; --dark-warm: #3d3d3a; --olive: #504e49;
    --stone: #6b6a64; --brand: #1B365D; --border: #e8e6dc;
    --border-soft: #e5e3d8; --tag-bg: #E4ECF5;
    --serif: "Noto Serif SC", "Source Han Serif SC", "Songti SC", Georgia, serif;
  }

  html, body { background: var(--parchment); margin: 0; padding: 0; }
  body {
    color: var(--near-black); font-family: var(--serif); font-size: 10pt;
    line-height: 1.45; letter-spacing: 0.3pt;
    padding: 12mm 16mm;
  }

  .header {
    border-left: 2.5pt solid var(--brand); border-radius: 1.5pt;
    padding-left: 8pt; margin-bottom: 12pt;
    display: flex; align-items: flex-end; justify-content: space-between; gap: 16pt;
  }
  .title-block { flex: 1; }
  .eyebrow { font-size: 8pt; color: var(--brand); letter-spacing: 1pt; text-transform: uppercase; margin-bottom: 3pt; }
  h1 { font-family: var(--serif); font-size: 20pt; font-weight: 500; color: var(--near-black); line-height: 1.15; margin-bottom: 4pt; }
  .subtitle { font-size: 10pt; color: var(--olive); line-height: 1.4; }
  .meta { font-size: 8pt; color: var(--stone); text-align: right; line-height: 1.45; white-space: nowrap; }

  .metrics { display: flex; gap: 12pt; margin-bottom: 14pt; padding: 3pt 0 5pt 0; border-bottom: 0.3pt dotted var(--border); }
  .metric { flex: 1; display: flex; align-items: baseline; gap: 3pt; }
  .metric-value { font-family: var(--serif); font-size: 18pt; font-weight: 500; color: var(--brand); line-height: 1; font-variant-numeric: tabular-nums; }
  .metric-label { font-size: 8pt; color: var(--olive); line-height: 1.3; }

  .lead { font-size: 10pt; line-height: 1.5; color: var(--dark-warm); margin-bottom: 12pt; }
  .hl { color: var(--brand); font-weight: 500; }

  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 14pt; }

  table { width: 100%; border-collapse: collapse; font-size: 8pt; margin: 6pt 0; }
  th { text-align: left; font-weight: 500; color: var(--dark-warm); padding: 3pt 5pt; border-bottom: 1pt solid var(--border); }
  td { padding: 2pt 5pt; border-bottom: 0.3pt solid var(--border-soft); vertical-align: middle; }

  .callout { border-left: 1.8pt solid var(--brand); padding: 3pt 0 3pt 12pt; margin: 8pt 0; font-size: 9pt; line-height: 1.5; color: var(--olive); }

  .footer { margin-top: 14pt; padding-top: 5pt; border-top: 0.3pt dotted var(--border); font-size: 8pt; color: var(--stone); display: flex; justify-content: space-between; }

  @media print { body { padding: 0; } }
</style>
</head>
<body>

<div class="header">
  <div class="title-block">
    <div class="eyebrow">每日活动摘要 · AntDesk</div>
    <h1>${dateLabel} ${weekday}</h1>
    <div class="subtitle">飞书 + Notion + AgentMemory 自动汇总</div>
  </div>
  <div class="meta">
    Evilom<br>${dateLabel}<br>Kami × AntDesk
  </div>
</div>

<div class="metrics">
  <div class="metric"><div class="metric-value">${stats.todayDone}</div><div class="metric-label">今日完成</div></div>
  <div class="metric"><div class="metric-value">${stats.pending}</div><div class="metric-label">待办任务</div></div>
  <div class="metric"><div class="metric-value">${stats.high}</div><div class="metric-label">高优先级</div></div>
  <div class="metric"><div class="metric-value">${stats.streak}</div><div class="metric-label">连续日报</div></div>
</div>

<p class="lead">
  ${sections.length > 0
    ? `今日核心产出：<span class="hl">${sections[0].items.length > 0 ? sections[0].items[0].replace(/\*\*/g, "").slice(0, 40) : "见详情"}</span>${sections[0].items.length > 1 ? "等" : ""}。共 <span class="hl">${sections.reduce((a, s) => a + s.items.length, 0)}</span> 条记录，覆盖 <span class="hl">${sections.length}</span> 个维度。`
    : '<span class="hl">暂无日报内容</span>，点击「写日报」开始记录今天的工作。'
  }
</p>

<div class="two-col">
  <div>
    ${sectionHTML}
  </div>
  <div>
    <section style="margin-bottom:14pt">
      <h2 style="font-family:var(--serif);font-size:14pt;font-weight:500;color:var(--near-black);margin-bottom:5pt">项目进度</h2>
      <table>
        <tr><th>项目</th><th style="text-align:center">进度</th><th>完成率</th></tr>
        ${projectRows}
      </table>
    </section>

    <section style="margin-bottom:14pt">
      <h2 style="font-family:var(--serif);font-size:14pt;font-weight:500;color:var(--near-black);margin-bottom:5pt">任务概览</h2>
      <table>
        <tr><td style="color:var(--olive)">已完成总计</td><td style="text-align:right;color:var(--brand);font-weight:500">${stats.allDone}</td></tr>
        <tr><td style="color:var(--olive)">待办总计</td><td style="text-align:right;color:var(--near-black);font-weight:500">${stats.pending}</td></tr>
        <tr><td style="color:var(--olive)">日报总条数</td><td style="text-align:right">${stats.totalReports}</td></tr>
        <tr><td style="color:var(--olive)">连续天数</td><td style="text-align:right;color:var(--brand);font-weight:500">${stats.streak} 天</td></tr>
      </table>
    </section>
  </div>
</div>

${stats.high > 0 ? `<div class="callout"><span class="hl">⚠ ${stats.high} 个高优先级任务待处理</span>，建议优先安排。</div>` : ''}

<div class="footer">
  <span>内部 · Evilom Daily</span>
  <span>Generated by Kami × AntDesk · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span>
</div>

</body>
</html>`;
}

/* ═══════════════════════════════════════════
   主组件
   ═══════════════════════════════════════════ */
export default function KamiReport({ content, date, todos, reports, projects }: KamiReportProps) {
  const stats = useStats(todos, reports, projects, date);
  const sections = useMemo(() => parseSections(content), [content]);
  const html = useMemo(
    () => generateKamiHTML(date, content, stats, sections),
    [date, content, stats, sections]
  );

  return (
    <div className="rounded-lg overflow-hidden border border-white/5" style={{ height: 420 }}>
      <iframe
        srcDoc={html}
        title="Kami 日报"
        sandbox="allow-same-origin"
        style={{
          width: "100%",
          height: "100%",
          border: "none",
          borderRadius: 8,
        }}
      />
    </div>
  );
}
