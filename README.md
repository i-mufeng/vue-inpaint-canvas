<div align="center">

# vue-inpaint-canvas

[![npm](https://img.shields.io/npm/v/vue-inpaint-canvas.svg?color=7c5cff)](https://www.npmjs.com/package/vue-inpaint-canvas)
[![bundle](https://img.shields.io/bundlephobia/minzip/vue-inpaint-canvas?color=7c5cff&label=min%2Bgzip)](https://bundlephobia.com/package/vue-inpaint-canvas)
[![license](https://img.shields.io/npm/l/vue-inpaint-canvas.svg?color=7c5cff)](./LICENSE)
[![types](https://img.shields.io/npm/types/vue-inpaint-canvas.svg?color=7c5cff)](./dist/index.d.ts)

**Framework-agnostic core + Vue 3 component for inpaint mask painting, cropping & light adjustments** — purpose-built for AI image editing (gpt-image / Stable Diffusion inpainting).

It paints a **transparent-alpha PNG mask** following the OpenAI `images/edits` convention, ships its own Konva engine (no `vue-konva`, single runtime dependency), and leaves the theme fully host-injected.

**English** · [简体中文](#简体中文)

</div>

![image to transparent mask](docs/export-result.jpg)

> **You paint where you want the AI to repaint** → that area exports as `alpha=0` (transparent). Everything else stays `alpha=255` (opaque, kept). The mask is the same pixel size as the processed image.

## ✨ Features

- 🖌️ **Mask painting** — brush / eraser / rectangle-select / clear, inverted-alpha PNG export (both `paint-to-edit` & `paint-to-keep` polarities)
- 🔁 **Geometry** — crop (ratio presets + free) / rotate 90° / horizontal·vertical flip, with **vector mask↔geometry linkage** (no resampling, export size = transformed canvas)
- 🎚️ **Adjustments** — brightness / contrast / saturation, live CSS-filter preview, baked into export
- ↩️ **Unified undo/redo** — mask strokes, geometry and adjustments on one command history
- 🎨 **Themeable** — only `--vic-*` CSS variables; no hard-coded business theme, light/dark up to the host
- 🧩 **Two layers** — a pure-TS `StudioEngine` (portable, no Vue) + a thin `<ImageStudio>` Vue shell
- 📦 **Lean** — ESM-only, `vue` is a peer dep, `konva` the single runtime dependency, **264 tests** (real-pixel assertions)

## 📦 Install

```bash
npm install vue-inpaint-canvas konva
# pnpm add vue-inpaint-canvas konva
# yarn add vue-inpaint-canvas konva
# bun add  vue-inpaint-canvas konva
```

`vue` (^3.5) is a **peer dependency** provided by the host; `konva` is the single runtime dependency.

## 🚀 Quick start — Vue

```vue
<script setup lang="ts">
import { ImageStudio } from "vue-inpaint-canvas";
import "vue-inpaint-canvas/style.css";
import type { StudioResult } from "vue-inpaint-canvas";

function onApply(r: StudioResult) {
  // r.image : processed source image (Blob)
  // r.mask  : transparent-alpha inpaint mask (Blob | null)
  // POST both to your AI backend's images/edits endpoint
}
</script>

<template>
  <ImageStudio
    :source="file"
    :tools="['brush', 'eraser', 'rect', 'crop', 'rotate', 'flip', 'adjust']"
    @apply="onApply"
  />
</template>
```

## 🧱 Quick start — framework-agnostic core

```ts
import { StudioEngine } from "vue-inpaint-canvas/core";

const engine = new StudioEngine(containerEl);
await engine.loadSource(file);
engine.setTool("brush");
const { image, mask } = await engine.exportResult();
engine.destroy();
```

The core is a plain TS class with no Vue — mount it on a DOM container, drive it with imperative calls + event callbacks. A React/Svelte shell only needs to re-wrap this core.

## 🎭 Mask semantics (inverted on purpose)

The single most error-prone detail. Per OpenAI `images/edits`, **transparent = repaint**:

| Layer | Painted area (user wants changed) | Rest (user wants kept) |
| --- | --- | --- |
| User intent | "change here" | "leave this" |
| On-canvas | translucent accent highlight | original image |
| Exported PNG | **`alpha = 0` (transparent)** | `alpha = 255` (opaque) |
| Upstream | repainted per prompt | preserved |

Switch with `maskPolarity` (`paint-to-edit` default / `paint-to-keep`). The exported mask is **always lossless PNG** (alpha-only; RGB is black and meaningless) regardless of `output.type`.

> ⚠️ A `string` source URL is loaded with `crossOrigin="anonymous"`; the host must serve it CORS-anonymous or the canvas taints and export throws `SecurityError`. Pass a `Blob`/`File` to avoid this.

## 🎨 Theming

Override the `--vic-*` CSS variables, or pass a `:theme` object, to match your design system. The library ships a neutral dark default and never hard-codes a business theme. Consumers must `import "vue-inpaint-canvas/style.css"`.

## 🧩 API at a glance

| | |
| --- | --- |
| **Props** | `source` · `tools` · `maskPolarity` · `brushSize` · `cropRatios` · `feather`* · `locale` · `theme` · `output` |
| **Emits** | `apply(StudioResult)` · `change` · `ready` · `cancel` · `error` |
| **Expose** | `exportResult` · `exportMask` · `undo` · `redo` · `reset` · `clearMask` · `setTool` · `setBrush` · `applyTransform` · `rotate` · `flipHorizontal` · `flipVertical` · `setCropRatio` · `applyCrop` · `cancelCrop` · `setAdjust` · `commitAdjust` |
| **Result** | `{ image: Blob, mask: Blob \| null, width, height, hasMask, maskCoverage }` |

<sub>* `feather` and zoom/pan are scaffolded for 0.x — see [DESIGN.md](./DESIGN.md). Full types live in `src/core/types.ts`.</sub>

## 🛠️ Develop

```bash
bun install
bun run dev        # playground (vite)
bun run build      # build library → dist/
bun run test       # vitest (264, jsdom + node-canvas real pixels)
bun run typecheck  # vue-tsc
bun run lint       # oxlint
```

## 📄 License

[MIT](./LICENSE) © Mufeng

---

<div align="center">

## 简体中文

[English](#vue-inpaint-canvas) · **简体中文**

</div>

框架无关核心 + Vue 3 组件的 **inpaint 蒙版涂抹 / 裁剪 / 调色** 工作台，专为接 AI 图像生成（gpt-image / Stable Diffusion 局部重绘）而生。在图上**涂抹/框选**圈定要重绘的区域，按 OpenAI `images/edits` 约定导出**透明 alpha 通道的 PNG 蒙版**；自带 Konva 引擎（不依赖 `vue-konva`，唯一运行时依赖 `konva`），主题完全由宿主注入。

![image 到透明 mask](docs/export-result.jpg)

> **你涂哪里，AI 就重绘哪里** → 涂抹区导出为 `alpha=0`(透明)，其余区 `alpha=255`(不透明、保留)。mask 与处理后图像**等像素尺寸**。

### ✨ 特性

- 🖌️ **蒙版涂抹** — 画笔 / 橡皮 / 矩形框选 / 清除，反转 alpha 的 PNG 导出（`paint-to-edit` 与 `paint-to-keep` 双极性）
- 🔁 **几何** — 裁剪(比例预设+自由) / 旋转 90° / 水平·垂直翻转，**矢量蒙版↔几何联动**(无重采样，导出尺寸=变换后画幅)
- 🎚️ **调整** — 亮度 / 对比度 / 饱和度，CSS filter 实时预览，导出时烘焙进像素
- ↩️ **统一撤销/重做** — 蒙版笔触、几何、调整同一条命令历史
- 🎨 **可主题化** — 只用 `--vic-*` CSS 变量，不写死业务主题，明暗由宿主决定
- 🧩 **两层架构** — 纯 TS `StudioEngine`(可移植、不含 Vue) + 轻量 `<ImageStudio>` Vue 壳
- 📦 **轻量** — ESM-only，`vue` 为 peer 依赖，`konva` 唯一运行时依赖，**264 个测试**(像素级断言)

### 📦 安装

```bash
npm install vue-inpaint-canvas konva
# pnpm add vue-inpaint-canvas konva
# yarn add vue-inpaint-canvas konva
# bun add  vue-inpaint-canvas konva
```

`vue`（^3.5）是宿主提供的 **peer 依赖**；`konva` 是唯一运行时依赖。

### 🚀 快速开始 — Vue

```vue
<script setup lang="ts">
import { ImageStudio } from "vue-inpaint-canvas";
import "vue-inpaint-canvas/style.css";
import type { StudioResult } from "vue-inpaint-canvas";

function onApply(r: StudioResult) {
  // r.image : 处理后的原图（Blob）
  // r.mask  : 透明 alpha 的 inpaint 蒙版（Blob | null）
  // 把两者 POST 给你自己 AI 后端的 images/edits 接口
}
</script>

<template>
  <ImageStudio
    :source="file"
    :tools="['brush', 'eraser', 'rect', 'crop', 'rotate', 'flip', 'adjust']"
    @apply="onApply"
  />
</template>
```

### 🧱 快速开始 — 框架无关核心

```ts
import { StudioEngine } from "vue-inpaint-canvas/core";

const engine = new StudioEngine(containerEl);
await engine.loadSource(file);
engine.setTool("brush");
const { image, mask } = await engine.exportResult();
engine.destroy();
```

核心是不含任何 Vue 的纯 TS class——挂在 DOM 容器上、命令式 API + 事件回调。出 React/Svelte 壳只需重新包一层。

### 🎭 蒙版语义（刻意反转）

全库最易搞反的一点。按 OpenAI `images/edits`，**透明 = 重绘**：

| 层 | 涂抹区（想改） | 其余区（想保留） |
| --- | --- | --- |
| 用户心智 | 「改这里」 | 「别动」 |
| 显示层 | 半透明高亮 | 原图透出 |
| 导出 PNG | **`alpha = 0`(透明)** | `alpha = 255`(不透明) |
| 上游行为 | 按提示词重绘 | 保留 |

由 `maskPolarity` 切换(`paint-to-edit` 默认 / `paint-to-keep`)。导出 mask **恒为无损 PNG**(仅 alpha 有意义，RGB 恒黑)，不随 `output.type` 改变。

> ⚠️ 传 `string` 源图 URL 时以 `crossOrigin="anonymous"` 加载；宿主须保证 CORS 允许 anonymous，否则画布污染、导出抛 `SecurityError`。传 `Blob`/`File` 可规避。

### 🎨 主题

覆盖 `--vic-*` CSS 变量或传 `:theme` 对象即可匹配你的设计系统。库自带中性暗色默认，绝不写死业务主题。消费者需 `import "vue-inpaint-canvas/style.css"`。

### 🧩 API 速览

| | |
| --- | --- |
| **Props** | `source` · `tools` · `maskPolarity` · `brushSize` · `cropRatios` · `feather`* · `locale` · `theme` · `output` |
| **Emits** | `apply(StudioResult)` · `change` · `ready` · `cancel` · `error` |
| **Expose** | `exportResult` · `exportMask` · `undo` · `redo` · `reset` · `clearMask` · `setTool` · `setBrush` · `applyTransform` · `rotate` · `flipHorizontal` · `flipVertical` · `setCropRatio` · `applyCrop` · `cancelCrop` · `setAdjust` · `commitAdjust` |
| **产物** | `{ image: Blob, mask: Blob \| null, width, height, hasMask, maskCoverage }` |

<sub>* `feather` 羽化与 zoom/pan 缩放平移为 0.x 预留接口，详见 [DESIGN.md](./DESIGN.md)。完整类型见 `src/core/types.ts`。</sub>

### 🛠️ 本地开发

```bash
bun install
bun run dev        # playground（vite）
bun run build      # 构建库 → dist/
bun run test       # vitest（264，jsdom + node-canvas 真实像素）
bun run typecheck  # vue-tsc
bun run lint       # oxlint
```

### 📄 许可证

[MIT](./LICENSE) © Mufeng
