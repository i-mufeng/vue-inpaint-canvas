# CLAUDE.md

本文件指导 Claude Code 在本仓库工作。**设计真相源是 [DESIGN.md](DESIGN.md)——开工前先读它。**

## 项目简介

`vue-inpaint-canvas` —— 框架无关核心 + Vue 3 组件的 **inpaint 蒙版涂抹 / 裁剪 / 调色** 工作台库，专为接 AI 图像生成（gpt-image / Stable Diffusion）做局部重绘。库只吃 `source` 吐 `StudioResult { image, mask }`，**不碰网络 / 业务**。

## 工具链与命令

bun 包管理；构建走 **vite library mode**（`@vitejs/plugin-vue` + `vite-plugin-dts`），测试 Vitest，类型 vue-tsc，lint oxlint。也可用 Vite+（`vp`）跑同一套配置。

- `bun install` —— 安装依赖
- `bun run dev` —— playground（vite，根 `index.html` → `playground/`）
- `bun run build` —— 构建库 → `dist/`（`index.js` Vue 入口 + `core.js` 框架无关核心 + `style.css`）
- `bun run test` —— Vitest
- `bun run typecheck` —— `vue-tsc --noEmit`（**门禁，提交前必过**）
- `bun run lint` —— oxlint

## 架构（见 DESIGN.md §3）

两层，**严守边界**：

- `src/core/` —— 框架无关 `StudioEngine`（TS class，持有 Konva，命令式 API + 事件回调）。**禁止 import vue。**
- `src/vue/` —— `ImageStudio.vue` 组件壳，只做布局 + props→engine + engine 事件→emit + `defineExpose`。
- 唯一运行时依赖 `konva`；**不用 `vue-konva`**（命令式更顺、core 可移植）。
- `src/core/types.ts` 是全库类型契约真相源——**改 API 先改这里**。

## 红线与约定

1. **mask 语义反转（最易错）**：用户涂抹 = 要改 → 导出 PNG 里 `alpha=0`（透明）。由 `maskPolarity` 控制，实现在 `engine.ts` 的 `exportMask()`。改导出逻辑务必保持该语义并跑测试。
2. **库不碰网络 / 积分 / 鉴权 / 模型门控**——全是宿主的事。只做「图进、处理、图出」。
3. **主题不写死**：只用 `--vic-*` CSS 变量（`src/theme/default.css`），宿主注入。新样式必须走变量、明暗由宿主给值。
4. **导出尺寸 = 图像真实像素**；缩放/平移只影响显示。涂抹坐标走 `getRelativePointerPosition()`，别用裸屏幕坐标。
5. **ESM-only、SSR 友好**：core 无顶层 `window` 访问；组件在 `onMounted` 才实例化 engine。
6. **几何变换 ↔ mask 坐标联动是全程最高风险（DESIGN.md §5.4）**：动它之前先写坐标互转单测。

## 当前进度（见 DESIGN.md §8）

- ✅ L0–L3：脚手架 / 引擎骨架 / mask 涂抹+橡皮+反转 alpha 导出（PoC 验证）/ Vue 最小壳。`bun run dev` 即可涂抹并导出透明 mask。
- 🚧 TODO：矩形框选、几何（裁剪/旋转/翻转 + mask 联动）、调整实时预览、羽化、缩放/平移、笔刷光标、完整参数面板、测试补齐、构建产物对齐、发布。
- 建议顺序：**L2 补全（框选+羽化+光标）→ L4 几何（先单测）→ L6 打磨**。

## 验证

- 改 engine/组件后：`bun run typecheck` + `bun run test`；交互改动用 `bun run dev` 在 playground 实涂抹验证。
- **移动端触屏只能真机 / 微信验**（桌面无法模拟 coarse pointer）。
- **mask 导出改动**：务必有像素级断言测试（涂抹区 `alpha=0` / 保留区 `alpha=255` / mask 尺寸 = 图像尺寸 / 覆盖率符合）。
