# AntDesk 助理与玻璃界面

本次改版保留 Tauri 2、React、Notion 和桌宠架构。主界面有日程、日报、目标三个入口，以及可以收起、持续通话的私人助理面板。图片使用本次生成的珠光玻璃助理，图标统一为 Lucide。

## 本地运行

```sh
yarn dev
# 另一个终端
cargo run --manifest-path src-tauri/Cargo.toml
```

浏览器可预览主界面、主题与交互。Hermes 本地检索由 Tauri 的 Rust 命令处理，需要桌面运行环境。应用未连接 Notion 时会显示连接入口，不会无限等待；同步失败保留已有数据。

macOS 本地评审包（不生成发布用更新签名）：

```sh
yarn tauri build --debug --bundles app --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

产物在 `src-tauri/target/debug/bundle/macos/AntDesk.app`。调试构建不自动下载线上更新。正式版本为 `2.19.0`，推送 `v2.19.0` 标签后由 GitHub Actions 构建各平台安装包及更新文件。

## 语音配置与边界

当前适配已有 `chatgpt-web-voice` 网关，**不是官方 OpenAI Realtime API**。两种协议的会话接口、DataChannel 参数和事件格式不同，不能只替换地址混用。

默认本机地址为 `http://127.0.0.1:6080`。在设置的「助理与知识」中输入为 AntDesk 签发的设备密钥，点击「连接语音服务」。设备密钥仅存在当前进程/页面内存中，不写入 localStorage。也可以由启动环境提供 `ANTDESK_VOICE_DEVICE_KEY`。不要向应用填管理密钥或 ChatGPT 登录令牌。

设备的创建应由网关管理员在现有服务中完成，使用独立设备、最多一个并发会话。本改动没有读取或复制语音网关的管理凭据，没有自动签发设备。

网关能力检查只验证网关和设备身份，不代表上游已接通。点击「开始语音对话」后才会请求麦克风并创建会话。macOS bundle 带有麦克风用途说明。真实验收需要用户允许麦克风，实际听见回复、验证字幕、打断、静音和结束后释放麦克风。

客户端源自同机 `chatgpt-web-voice/static/sdk/realtime-client.mjs`，在 `src/lib/vendor` 保留独立快照。本地适配包括 Rust 请求桥、重连保留静音状态、标记注入上下文的消息 ID 以排除回声检索循环。原语音项目未修改。语音通过 WebRTC 直接连接上游；文字、字幕、打断沿用网关已验证的协议。停止、重连失败与撤销会话会清理音轨和 PeerConnection。关闭整个应用结束通话；收起助理或隐藏主窗口仍可继续通话。

若 WKWebView 或目标系统不支持麦克风/WebRTC，应用会显示实际失败信息；不能将浏览器预览通过视为原生通话通过。语音声音在下一次通话生效。

## Hermes 知识

复用现有本机 QMD Knowledge Gateway。默认地址 `http://127.0.0.1:8765`，启动环境可用 `ANTDESK_KNOWLEDGE_URL` 覆盖，但必须是回环地址。凭据优先复用 `QMD_KB_TOKEN` 或 `QMD_KB_TOKEN_FILE`，否则读取 `~/.hermes/services/qmd-kb-service/.token`。不将凭据传回前端，不转发给远程主机，不跟随 HTTP 重定向。

只提供 `/health`、`/search`、`/query` 和 `/doc` 四种读取操作。没有移动、写入、重建或删除知识文件和索引。搜索结果显示 QMD 原文地址，可查看前 120 行，也可带入对话。索引状态保留上游的更新时间，历史资料不自动视为当前事实。

文字对话会按问题检索；语音里包含「知识、之前、资料、文档、项目、Hermes」等意图的用户字幕，在停顿后尝试关键词检索，返回命中来源时补充上下文。需要更完整的匹配时可手动选择深度语义检索。此协议当前没有官方工具调用，字幕检索不应描述为模型可以任意调用本地工具。只向已配置的助理服务发送当前问题相关的少量摘录，不整库上传。关闭「关联 Hermes 知识」会停止后续自动检索与资料注入。

当前接入的是原 Hermes 的 `wiki` 集合，未接入所有历史会话、第三方 agentmemory 数据库或任意磁盘目录。

## 汇报与任务操作

「听今日汇报」把当前真实日程作为上下文交给语音助理；未同步时明确告知没有数据，不生成假任务。可选的「通话中主动汇报」默认关闭：打开后每两分钟同步 Notion，在通话中检测到未完成的到期任务集合变化时提醒，同一变化不会重复播报。暂停和归档任务不进入提醒。

这不是后台定时任务系统或系统唤醒词服务；Mac 休眠、应用退出或通话结束后不会继续播报。助手当前能聊天、检索、汇报与提出行动建议，不能直接操作电脑或自动修改 Notion。已有任务编辑仍由用户在应用中完成。

## 视觉与动效

悬浮导航使用统一的玻璃层、高光边缘、连续滑动的选中态；正文采用较稳定的底色以保证可读性。主窗口支持 300–600 宽、480–960 高，按逻辑尺寸保存大小，按物理坐标保存位置，保留旧窗口记录。

这是基于 WebView CSS 的 Liquid Glass 风格实现，不是 Apple 原生 Liquid Glass 光学渲染器。深浅色主题、透明度、系统减少动态效果和应用内动效开关均有对应处理。

参考：

- [Apple：Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/)
- [OpenAI：Realtime Create call 官方接口，用于核对协议边界](https://developers.openai.com/api/reference/typescript/resources/realtime/subresources/calls/methods/create)
- 语音服务仓库：`chatgpt-web-voice/docs/INTEGRATION.md`
- 本机知识网关：`~/.hermes/services/qmd-kb-service/README.md`

## 验证

```sh
yarn build
cargo check --manifest-path src-tauri/Cargo.toml
node --test tests/*.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml assistant::
# 需要本机已有 QMD 服务，只读实测
cargo test --manifest-path src-tauri/Cargo.toml assistant::tests::live_knowledge_search -- --ignored
```

测试使用支持 TypeScript 类型剥离的 Node.js（本次为 v26.3.0）。前端测试覆盖 UTF-8 跨块流式文本、SSE 末行、服务错误、取消信号、协议封装、字幕合并、音轨/连接释放、鉴权失败不申请麦克风、迟到授权清理、原生桥错误语义、静音意图、创建中取消和上下文回声标记。Rust 测试覆盖 URL 与路径约束，真实检索测试要求返回 `qmd://wiki/` 来源。
