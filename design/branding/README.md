# AntDesk 应用图标

2026-09-14

使用内置 image_gen 生成「玻璃对话环」图标：深蓝圆角底板、珠光玻璃对话环和单颗光点。用于替换原蚂蚁应用图标。原始输出保存在 `antdesk-conversation-glass.png`，图标尺寸与 ICO/ICNS 使用 Tauri CLI 从此母版导出。菜单栏使用同一轮廓的简化单色模板，适配明暗背景。

## 导出与接入

- 母版：`antdesk-conversation-glass.png`，保留原始透明 PNG。
- 桌面导出：`yarn tauri icon design/branding/antdesk-conversation-glass.png --output src-tauri/target/icon-export`，将桌面 PNG、ICO、ICNS 复制到 `src-tauri/icons/`。
- 网页及标题栏：`public/assets/brand/app-icon.png`，来自 256px 导出。
- 菜单栏：`tray-mark.svg` 为同一标志的单色简化轮廓，使用 `yarn tauri icon design/branding/tray-mark.svg --output src-tauri/target/tray-export --png 48` 导出到 `src-tauri/icons/tray-template.png`；macOS 启用 template 渲染。
- 本地设计预览：运行 `yarn dev` 后访问 `/design/branding/preview.html`。

已检查透明通道、ICO 的 16/24/32/48/64/256 像素层、ICNS 的标准与 Retina 层，及 16–64px、明暗背景、主界面的实际渲染。`yarn build`、`cargo check --manifest-path src-tauri/Cargo.toml` 与本地 macOS 应用打包通过。新图标随 `v2.19.0` 发布。

## 生成提示词

```text
Use case: logo-brand
Asset type: production macOS / Windows desktop application icon, one square 1024x1024 PNG with true transparent pixels outside the tile.
Primary request: Design a beautiful, distinctive new app icon for AntDesk, a calm personal voice assistant and knowledge companion. The brand symbol is a single sculptural glass conversation loop, no insect motif.
Composition: straight-on orthographic view, perfectly centered large rounded-square app tile occupying about 86% of the canvas (7% clear margin on each edge). Outside the tile must be genuinely transparent, NOT a checkerboard illustration. Rounded tile with smooth Apple-style continuous corners. No extra scene, no mockup, no perspective rotation.
Tile: deep midnight ink blue, nearly black at its lower edge, softly illuminated rich blue toward the upper area, subtle smooth premium glass finish. Clean silhouette and minimal soft shadow contained within the icon margin.
Central emblem: a thick, elegantly rounded open conversation bubble ring, with a gently tapered short speech-tail at lower left. The ring is made of smooth dimensional opalescent frosted glass, mainly ice blue and pearl white with a restrained lavender edge refraction. It should read immediately as ONE bold speech-loop silhouette even at 32 pixels. Large empty central opening, containing ONE small softly glowing pearl-white circular core, placed slightly right of center. Overall emblem fills about 65% of the tile. Tasteful material depth, not a thin outline. The tail is integrated naturally into the lower-left ring, not an extra floating shape. Distinctive gently asymmetric geometry, calm and human.
Lighting: soft studio light from upper left, luminous rim along the loop, controlled highlights, very subtle pale blue reflection on the tile. Rich deep blue versus high-value pearl contrast; no overexposed broad glow.
Constraints: one icon only, no sheet, no multiple variants, no title, no letters, no typography, no watermark, no ant, no insect, no character face, no robot, no headphones, no microphone drawing, no tiny sparkles, no decorative stars, no multicolored rainbow, no intricate background texture, no border around the whole image. Preserve a clean premium iOS liquid-glass aesthetic without copying another app logo.
```
