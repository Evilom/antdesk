# AntDesk v2 — 重建设计文档

## 项目定位

**AntDesk** 是一个浮窗式 PM 桌面助手，定位为 **AI + Notion 之间的快捷交互层**。

核心场景：
- 一键呼出，快速查看/添加任务
- 快速写日报、查看最近日报
- 与 AI 对话（通过 Chat2API）
- 浮窗常驻桌面，不打断工作流

## 技术栈

- **框架**: Tauri 2.0 (Rust 后端 + Web 前端)
- **前端**: React 19 + TypeScript + Vite
- **样式**: Tailwind CSS 3.4（深色主题）
- **状态管理**: Zustand
- **包管理**: yarn

## 架构：双窗口模式

### FAB 窗口（悬浮按钮）
- 64×64px，透明背景
- 始终置顶，不在任务栏显示
- 显示 🐜 图标 + 连接状态指示灯
- 点击 → 展开主面板

### 主面板
- 380×560px，无边框，圆角，阴影
- 可拖动（标题栏区域）
- 关闭按钮 → 收起到 FAB（不退出）
- 深色主题

## 页面设计

### 1. 仪表盘 (Dashboard)
- 连接状态指示
- 今日统计：紧急任务数 / 待办数 / 已完成数
- 紧急待办列表（红色高亮）
- 最近日报摘要（3条）
- 快捷入口：新建任务、写日报

### 2. 任务 (Tasks)
- 三栏过滤：待办 / 已完成 / 全部
- 任务卡片：名称 + 优先级标签 + 项目关联
- 快速添加：输入框 + 优先级选择
- 点击切换完成状态
- 支持拖拽排序（可选）

### 3. 日报 (Reports)
- 最近日报列表（日期 + 摘要预览）
- 点击展开查看完整内容
- 快速写日报入口

### 4. AI 对话 (Chat)
- 接入用户在设置中配置的 OpenAI 兼容 API
- 流式响应，打字机效果
- 支持上下文（最近10条消息）
- 快捷指令：/todo（添加任务）、/report（生成日报）、/help

### 5. 设置 (Settings)
- Notion 连接状态 + Token 管理
- AI API 配置（端点、模型选择）
- 主题设置（深色/浅色）
- 快捷键配置

## Notion 集成

### 数据库 ID（已验证）
```
DestopAnt Todos:     2d51ba51-3457-815e-8850-000b6ebaa003
DestopAnt Projects:  2d51ba51-3457-813a-9eeb-000b6715eed1
DestopAnt Reports:   2d51ba51-3457-8158-84e1-c5cbc66ed8b2
```

### Notion Token
- 读取顺序：用户设置 → 环境变量 NOTION_TOKEN → Rust 缓存
- 不要在源码、文档或 release artifact 中提交真实 token
- API 版本: 2022-06-28
- 直连 api.notion.com（无需代理）

### Rust 后端命令（Tauri Commands）
```rust
get_notion_token() -> String        // 获取 token（带缓存）
clear_token_cache()                 // 清除缓存
fetch_notion(path, method, body, token) -> String  // 代理 Notion API
window_minimize()                   // 最小化
window_maximize()                   // 最大化/还原
window_close()                      // 收起到 FAB
is_maximized() -> bool
expand_panel()                      // 展开主面板
collapse_panel()                    // 收起主面板
fab_click()                         // FAB 点击
```

### 数据模型
```typescript
interface Todo {
  id: string
  name: string
  status: boolean        // true=已完成
  priority: 'High' | 'Medium' | 'Low'
  tags: string[]
  projectId?: string
  createdTime?: string
}

interface Project {
  id: string
  name: string
  status: string
}

interface Report {
  id: string
  date: string
  summary?: string
}
```

## AI 对话集成

### Chat2API 端点
- 本地: http://127.0.0.1:6033/v1/chat/completions
- 外网端点由用户在设置中自行配置
- 格式: OpenAI 兼容
- 推荐模型: DeepSeek-V3.2（稳定）、deepseek-v4-flash-think（快速）

### 请求格式
```json
{
  "model": "DeepSeek-V3.2",
  "messages": [
    {"role": "system", "content": "你是 AntDesk AI 助手..."},
    {"role": "user", "content": "用户消息"}
  ],
  "max_tokens": 2000,
  "stream": true
}
```

## 设计风格

- **主题**: 深色（#0f0f17 背景，#1a1a2e 卡片）
- **强调色**: #6366f1（紫色）、#22c55e（绿色）、#ef4444（红色）
- **字体**: system-ui，12-14px
- **圆角**: 12px（卡片）、8px（按钮）
- **阴影**: 0 4px 24px rgba(0,0,0,0.3)
- **动画**: 平滑过渡 200ms

## 项目目录结构

```
antdesk/
├── src/
│   ├── main.tsx              # 主面板入口
│   ├── App.tsx               # 主面板应用
│   ├── App.css               # 全局样式
│   ├── fab-main.tsx          # FAB 入口
│   ├── fab.tsx               # FAB 组件
│   ├── fab.css               # FAB 样式
│   ├── components/
│   │   ├── Dashboard.tsx
│   │   ├── TaskList.tsx
│   │   ├── Reports.tsx
│   │   ├── Chat.tsx
│   │   └── Settings.tsx
│   ├── lib/
│   │   ├── notion.ts         # Notion API 封装
│   │   └── chat.ts           # Chat2API 封装
│   ├── stores/
│   │   └── appStore.ts       # Zustand 全局状态
│   └── types/
│       └── index.ts          # 类型定义
├── src-tauri/
│   ├── src/
│   │   ├── main.rs
│   │   └── lib.rs            # Tauri Commands
│   ├── Cargo.toml
│   └── tauri.conf.json
├── public/
├── index.html
├── fab.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── postcss.config.js
```

## 注意事项

1. **不要用 Auth Gateway** — 直连 Notion API
2. **FAB 窗口透明** — 背景色由 CSS 控制，不是 Tauri 窗口背景
3. **主面板无边框** — decorations: false，自定义标题栏
4. **关闭不退出** — 关闭按钮只隐藏主面板，FAB 仍在
5. **macOS 特殊处理** — 窗口层级、透明度需要特殊配置
6. **Notion API 版本** — 用 2022-06-28（稳定）
