# vue-inpaint-canvas

[![npm](https://img.shields.io/npm/v/vue-inpaint-canvas.svg)](https://www.npmjs.com/package/vue-inpaint-canvas)
[![license](https://img.shields.io/npm/l/vue-inpaint-canvas.svg)](./LICENSE)
[![types](https://img.shields.io/npm/types/vue-inpaint-canvas.svg)](./dist/index.d.ts)

[English](./README.md) · **简体中文**

> 框架无关核心 + Vue 3 组件的 **inpaint 蒙版涂抹 / 裁剪 / 调色** 工作台，专为接 AI 图像生成（gpt-image / Stable Diffusion 局部重绘）而生。

在图上**涂抹 / 框选**圈定要重绘的区域，按 OpenAI `images/edits` 约定导出**透明 alpha 通道的 PNG 蒙版**（涂抹区 → `alpha=0` = 重绘）。自带基于 Konva 的引擎，**不依赖 `vue-konva`，唯一运行时依赖是 `konva`**，主题完全由宿主注入。库只吃 `source` 吐 `StudioResult`，**不碰网络 / 业务**。

## 蒙版语义（最易搞反，务必先读）

**蒙版里透明（`alpha=0`）的区域 = 要被重绘的区域**；不透明区域保留原样。所以「用户心智」与「文件视角」是**相反**的：

| 层 | 涂抹区（用户想改） | 其余区（用户想保留） |
| --- | --- | --- |
| 用户心智 | 「我要改这里」 | 「这里别动」 |
| 显示层（画布高亮） | 半透明高亮 | 原图透出 |
| 导出层（发给上游的 PNG） | **`alpha=0`（透明）** | `alpha=255`（不透明） |

由 `maskPolarity` 控制：`paint-to-edit`（默认，上表语义）/ `paint-to-keep`（不反转）。导出 mask **仅 alpha 通道有意义**，RGB 恒为黑。若你的上游是按亮度/RGB 判 mask 的自建 / SD 管线，需自行把 alpha 换算为亮度。

## 当前状态

早期但已测试。**蒙版管线**——画笔 / 橡皮 / **矩形框选**（经 `tools` 显式开启）/ 清除 / 反转 alpha 的 PNG 导出——已实现并有**像素级自动化测试**（两种极性的 alpha 反转、尺寸、覆盖率、二值化稳定性）。**几何（裁剪 / 旋转 90° / 水平·垂直翻转）已实现**，并带完整的 **蒙版↔几何坐标联动**（矢量「方案 A」：图像与蒙版共享同一组 layer transform，蒙版节点保持源图坐标，故导出尺寸 = 变换后画幅、且 `image.width === mask.width === result.width`）、**统一的命令式撤销/重做栈**（蒙版笔触 + 几何同栈）以及**交互式裁剪框**（`cropRatios` 比例预设、暗化遮罩、拖拽选区、可与已有裁剪叠加）——共 **264 个测试**（jsdom + node-canvas 真实像素）加浏览器回归验证。i18n（`locale`）、笔刷光标、工具门控、可访问性（`aria-label` / `aria-pressed` / 减少动效）均已接线。亮度 / 对比度 / 饱和度调整已落地（核心烘焙 + 滑块 UI + CSS filter 实时预览 + 可撤销）。

**仍是脚手架的部分**：羽化（`feather` 当前为 **no-op**）与缩放/平移（zoom/pan）计划在 0.3；裁剪缩放手柄、移动端双指手势为后续打磨项。完整设计与路线见 [DESIGN.md](./DESIGN.md)。

> **提示：** 传 `string` 源图 URL 时库以 `crossOrigin="anonymous"` 加载；宿主须保证该 URL 的 CORS 允许 anonymous，否则画布被污染、导出会抛 `SecurityError`。传 `Blob`/`File` 可规避。

## 安装

```bash
npm install vue-inpaint-canvas konva
# pnpm add vue-inpaint-canvas konva
# yarn add vue-inpaint-canvas konva
# bun add vue-inpaint-canvas konva
```

`vue`（^3.5）是 peer 依赖，由宿主应用提供；`konva` 是唯一运行时依赖。

## 用法 — Vue

```vue
<script setup lang="ts">
import { ImageStudio } from "vue-inpaint-canvas";
import "vue-inpaint-canvas/style.css";
import type { StudioResult } from "vue-inpaint-canvas";

function onApply(r: StudioResult) {
  // r.image : 处理后的原图（Blob）
  // r.mask  : 透明 alpha 的 inpaint 蒙版（Blob | null，未圈定时为 null）
  // 把两者上传到你自己 AI 后端的 images/edits 接口
}
</script>

<template>
  <ImageStudio :source="file" @apply="onApply" />
</template>
```

## 用法 — 框架无关核心

```ts
import { StudioEngine } from "vue-inpaint-canvas/core";

const engine = new StudioEngine(containerEl);
await engine.loadSource(file);
engine.setTool("brush");
const { image, mask } = await engine.exportResult();
engine.destroy();
```

核心是纯 TS class（不含任何 Vue），挂在 DOM 容器上、命令式 API + 事件回调，可移植到 React/Svelte 等其他框架壳。

## 主题

覆盖 `--vic-*` CSS 变量，或传入 `:theme` 对象来匹配你的设计系统。库自带中性暗色默认值，**绝不写死任何业务主题**；明暗由宿主按需给值。消费者需 `import "vue-inpaint-canvas/style.css"`。

## 本地开发

```bash
bun install
bun run dev        # playground（vite）
bun run build      # 构建库 → dist/
bun run test       # vitest
bun run typecheck  # vue-tsc
bun run lint       # oxlint
```

## 设计要点

- **`mask` 语义是刻意反转的。** 用户涂抹的（意图：「改这里」）在导出 PNG 里变成 `alpha=0`（透明），对齐 OpenAI/BananaRouter 的 `images/edits`。详见 [DESIGN.md](./DESIGN.md) §1。
- **库不做任何网络 / 业务逻辑。** 它只吃一个 `source`、吐一个 `StudioResult`。模型门控（哪些模型支持蒙版）、积分、上传都是宿主应用的事。
- **几何在蒙版之前。** 处理顺序为 几何（裁剪/旋转/翻转）→ 调整（亮度/对比度/饱和度）→ 蒙版，保证蒙版尺寸等于最终画幅、坐标不错位。

## 许可证

MIT
