# 桌宠稳定性修复

2026-09-14，本地 macOS 验证。

## 原因与处理

- 同时存在一个命令行调试进程和一个打包应用进程，每个进程都创建自己的桌宠窗口。退出遗留调试进程；在所有窗口和其他插件初始化之前注册 [Tauri Single Instance](https://v2.tauri.app/plugin/single-instance/)。重复打开时唤起已有主面板；自启动参数 `--minimized` 不抢焦点。
- PhysicsEngine 在异步读取屏幕与位置之后才设置 running，多次启动和启动中停止均可能留下旧循环。启动合并为一个 Promise，停止使旧请求失效；屏幕数据和原生位置写入也防止旧请求回写。
- PetBrain、SleepSequence、PhysicsEngine 各自控制睡眠或移动。现在 PetBrain 只提供任务感知，SleepSequence 管睡眠，由 pet.tsx 统一决定是否运行物理引擎。通知、悬停、锁定、拖动和减少动态效果都能暂停移动。
- 原来的普通点击也调用抛掷释放；拖动监听又在数次 IPC 之后才安装。现在监听立即安装，使用系统原生拖动，按实际窗口位移及手势状态区分点击和拖动；原生鼠标状态补足被系统消费的 mouseup。WebKit 的 mousemove.buttons=0 不再提前终止手势。
- PetBrain 对比上一轮而非当前模式，导致不变的逾期状态反复提示。已修正，同时将首次看板数据作为基线，不把历史完成任务当作刚发生的事件。
- Spine 异步加载在卸载后可能覆盖新实例，动画命令在加载完成前也会丢失。已取消旧加载回写，释放渲染资源，加载后恢复当前动画和朝向。

## 可见行为

安静工作留在原位；标准陪伴慢走、多休息；玩耍增强才启用明显跑跳。保留原猫咪素材和三种模式入口。取消常驻光圈、状态灯、自动轮播气泡及叠加在骨骼动画上的 CSS 弹跳。通知只显示一条，悬停显示操作提示。位置锁定偏好会持久保存。

## 验证

- `yarn build`
- `cargo check --manifest-path src-tauri/Cargo.toml`
- `node --test tests/*.test.mjs`，覆盖启动竞态、停止、状态优先级、睡眠唤醒、通知去重、点击与原生拖动释放。
- `yarn tauri build --debug --bundles app --config '{"build":{"beforeBuildCommand":""},"bundle":{"createUpdaterArtifacts":false}}'`；此前已完成前端构建。
- macOS 实际启动与猫咪渲染、单击打开快捷面板已检查。已有实例运行时连续启动三次，三个新进程均正常退出，主进程 PID 保持不变。
- 自动化拖动事件的 `buttons` 始终为 0，原生窗口位移为 0；已能阻止其误触发快捷面板，但该模拟输入不能证明物理鼠标拖动手感。等待用户实际鼠标验收。
- Windows/Linux 的原生鼠标状态分支尚未在对应系统上编译或运行验证；Wayland 无法读取全局鼠标状态时保留本地 mouseup 处理。

本修复随 `v2.19.0` 发布。没有更改知识库、记忆、凭据或原猫咪素材。
