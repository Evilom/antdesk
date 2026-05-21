# AntDesk — Tauri 2 Desktop App

## Architecture
- **Frontend**: React + TypeScript + Tailwind CSS + Vite
- **Backend**: Rust (Tauri 2)
- **Data**: Notion API direct (no backend DB)
- **Pages**: index.html (main panel), fab.html (floating action button)

## Key Commands
- `yarn build` — build frontend
- `cargo check` — check Rust compilation
- `yarn dev` — dev server (port 1420)

## Design Principles
- iOS 26 frosted glass aesthetic
- Transparent window with CSS `backdrop-filter: blur()`
- html/body MUST be `background: transparent` for Windows WebView2
- Dark theme: `rgba(10, 10, 15, 0.70)` backgrounds

## FAB (Floating Action Button)
- Separate window (`fab.html`), 64x64, always-on-top, transparent
- Drag: use `getCurrentWindow().startDragging()` from `@tauri-apps/api/window`
- NEVER use IPC `invoke("set_fab_position")` per mousemove — causes lag
- Right-click: invoke `show_fab_context_menu` via Rust

## Notion Integration
- Token: hardcoded default in `src-tauri/src/lib.rs` as `DEFAULT_NOTION_TOKEN`
- API calls go through Rust `fetch_notion` command (proxies to api.notion.com)
- Databases:
  - Todos: 2d51ba51-3457-8125-9d4c-f28ffa2fff14 (Name, Status/checkbox, Priority/select, Tags/multi_select, Project/relation, Due Date/date)
  - Projects: 2d51ba51-3457-8127-840e-d8b43c0e5e21 (Name/title)
  - Reports: 2d51ba51-3457-8158-84e1-c5cbc66ed8b2 (Name/title, Date/date, Content/rich_text)

## Version Bumping
- `src-tauri/tauri.conf.json` → `version` field
- Git tag: `v{version}` (e.g., `v2.0.5`)

## Release
- GitHub Actions triggers on `v*` tags
- Builds: macOS (arm64 + x64), Windows (x64), Linux (x64)
- Auto-update via tauri-plugin-updater

---

# UI/UX Design Spec (v2.1)

## Navigation: 4 Tabs (bottom bar)
```
 今日  |  项目  |  日报  |  助理
```
- Settings moved to title bar gear icon (top-right)
- Each tab icon + 10px label text

## Page 1: 今日 (Today — replaces Dashboard)
Action-oriented "what to do today" view:
```
┌─────────────────────────┐
│  今日 · 5月21日 周三      │
├─────────────────────────┤
│  逾期任务 (红色卡片)      │
│  🔴 task name            │
│                          │
│  今日截止 (黄色卡片)      │
│  🟡 task name            │
│                          │
│  高优先级 (橙色卡片)      │
│  🟠 task name            │
├─────────────────────────┤
│  项目快览                 │
│  AntDesk  ██████░░ 3/5   │
│  数字人    ████░░░░ 2/5   │
├─────────────────────────┤
│  [➕ 快速新增]  [📝 写日报] │
└─────────────────────────┘
```
- Filter todos: overdue (Due Date < today && !status), due today (Due Date == today && !status), high priority (Priority == "High" && !status)
- Project overview: group todos by Project relation, show done/total per project
- Quick actions at bottom

## Page 2: 项目 (Projects — replaces Tasks)
Tasks grouped by project:
```
┌─────────────────────────┐
│  项目    [筛选▾]  [搜索]  │
├─────────────────────────┤
│  ▼ AntDesk 桌面客户端     │
│    ☐ FAB拖拽优化   🔴高   │
│    ☐ 磨砂玻璃效果  🟡中   │
│    ☑ Notion数据连接       │
│    ── 已完成(1) ──────    │
│                          │
│  ▼ 跨境数字人直播         │
│    ☐ 韩语pipeline  🔴高   │
│    ☐ 直播间UI优化  🟡中   │
│                          │
│  ▼ 收件箱（无项目）       │
│    ☐ 随机任务             │
├─────────────────────────┤
│  [➕ 新增任务]            │
└─────────────────────────┘
```
- Group by Project relation (todos with no project → "收件箱")
- Each project section collapsible
- Show priority tag (colored)
- Filter dropdown: by priority, by project, show done toggle
- Add task: name input + priority select + project select

## Page 3: 日报 (Reports — enhanced)
```
┌─────────────────────────┐
│  日报           [写日报]  │
├─────────────────────────┤
│  ┌─ 快速写日报 ─────────┐ │
│  │ 今天完成了什么？      │ │
│  │ [编辑区]             │ │
│  │ [引用今日任务] [保存]  │ │
│  └─────────────────────┘ │
├─────────────────────────┤
│  5月  ░░▓▓░░▓▓░░▓▓░░▓   │  ← calendar heatmap
├─────────────────────────┤
│  日报 2026-05-20         │
│  日报 2026-05-19         │
│  ...                     │
└─────────────────────────┘
```
- Quick write area at top (collapsible)
- "引用今日任务" button: inserts today's completed tasks as bullet points
- Calendar heatmap: 30-day grid, color by report existence
- Report list below with expandable content

## Page 4: 助理 (Assistant — enhanced Chat)
```
┌─────────────────────────┐
│  AI 助理    [清空] [模型] │
├─────────────────────────┤
│  快捷指令:               │
│  [规划今日] [总结项目]    │
│  [生成日报] [整理任务]    │
├─────────────────────────┤
│  聊天消息区...            │
│                          │
├─────────────────────────┤
│  [输入框]           [发送]│
└─────────────────────────┘
```
- Quick command buttons at top that inject prompts with Notion context
- "规划今日": sends "根据以下未完成任务，帮我规划今天的优先级: {todos}"
- "总结项目": sends "总结以下项目的进展: {projects}"
- "生成日报": sends "根据今日完成的任务生成日报: {completed_today}"
- Chat history preserved in store

## Title Bar (enhanced)
```
[  AntDesk  🟢]              [🔍] [⚙️] [—] [✕]
```
- Connection status dot
- 🔍 search icon → global search modal (Ctrl+K)
- ⚙️ settings icon → settings slide-over panel
- Settings panel: Notion Token, AI Endpoint, AI Model, theme

## Keyboard Shortcuts
- `Ctrl+Shift+A`: Toggle main panel show/hide (Rust command)
- `Ctrl+K`: Open global search
- `Esc`: Close panel / close modal

## FAB Enhancements
- Show todo count badge (number of pending todos)
- Double-click: open quick-add task input overlay

## Global Search (Ctrl+K)
- Search across todos, projects, reports
- Modal overlay with search input + results list
- Click result → navigate to relevant page

## Window Behavior
- Main panel: resizable (280-600px width), remember last size/position
- Save window state to localStorage on close, restore on open

## Common Pitfalls
- Don't mix up Notion tokens — the correct one starts with `ntn_A742...`
- Windows needs `transparent: true` + `decorations: false` in tauri.conf.json
- `backdrop-filter` only works when the element's ancestors have transparent backgrounds
- Todo sort must use `{ timestamp: "created_time" }` not `{ property: "Created time" }`
- Always import and call `fetchProjects` alongside `fetchTodos` and `fetchReports`
