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
- Databases: Todos, Projects, Reports, Chat History, Think Tank

## Version Bumping
- `src-tauri/tauri.conf.json` → `version` field
- `src-tauri/Cargo.toml` → `version` field (if present)
- Git tag: `v{version}` (e.g., `v2.0.5`)

## Release
- GitHub Actions triggers on `AntDesk-v*` or `v*` tags
- Builds: macOS (arm64 + x64), Windows (x64), Linux (x64)
- Auto-update via tauri-plugin-updater

## Common Pitfalls
- Don't mix up Notion tokens — the correct one starts with `ntn_A742...`
- Windows needs `transparent: true` + `decorations: false` in tauri.conf.json
- `backdrop-filter` only works when the element's ancestors have transparent backgrounds
