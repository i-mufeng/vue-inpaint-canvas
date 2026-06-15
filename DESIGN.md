# vue-inpaint-canvas · 设计文档（DESIGN）

> 状态：开发蓝图。本文是这个库的**单一设计真相源**——需求、架构、API、实现要点、路线一步到位。代码以本文为纲。
> 决策前提：① 混合自研 + **Konva 底座**；② 从一开始做成**可发布的通用依赖库**；③ 裁剪等几何**Konva 自实现**，整库仅运行时依赖 `konva`，**不使用 `vue-konva`**（高频涂抹用命令式 API 更顺，且 core 框架无关、可移植）。
> 技术基线：**mask 导出命脉（涂抹 → 反转 alpha → 透明 PNG）已手动 PoC 验证、固化进 `src/core/engine.ts`**；可重放的自动化护栏（像素断言）待补，是 0.1 必发前置（见 §9 / L3.5）。

---

## 〇、这个库解决什么

### 一句话

一个**框架无关核心 + Vue 3 组件壳**的轻量图像工作台：在图上**涂抹/框选圈定 inpaint 蒙版**（导出透明 alpha PNG）+ **裁剪/旋转/翻转** + **亮度/对比度/饱和度**，主题完全由宿主注入，专为「接 AI 图像生成（gpt-image / Stable Diffusion 等）做局部重绘」的前端场景设计。

### 目标场景

宿主应用拿到用户上传的原图 → 嵌入 `<ImageStudio>` → 用户圈定要改的区域、可选地裁剪/调色 → 库吐出 `{ image, mask }` → 宿主把它们 POST 给自己的 AI 后端（如 OpenAI 兼容的 `images/edits`）。

### 为什么造这个轮子（2026-06 调研结论）

- **整个 npm / Vue 生态没有现成的 inpaint mask 涂抹组件**：唯一活跃的 `react-canvas-masker` 是 React、输出黑白非 alpha、无触屏、单人项目。
- 一体化编辑器里只有商业付费的 **Pintura** 把 inpaint mask 做成官方功能（€169–749/年 + 绑架主题）；**Filerobot** 只有 React 且导不出透明 mask；**Toast UI** 停更 4 年。
- 结论：**inpaint mask 注定自研**，而它恰是最该自研的（触屏 Pointer + alpha 导出 + 主题融合都要完全可控）。裁剪/调整本可借力，但做**独立通用库**时收敛为 Konva 自实现 + CSS filter，保持单依赖、统一画布、统一主题。

---

## 一、上游 mask 语义与硬约束（通用知识，决定方案形态）

以 OpenAI `images/edits`（及 BananaRouter 等兼容网关）为准——这是库的"输出契约"。

### mask 语义（**最易搞反，必须钉死**）

**mask 中透明（alpha=0）的区域 = 要被重绘的区域**；不透明区域保留原样。因此「用户心智」与「文件视角」是**反的**，库做三层分离：

| 层 | 涂抹区（用户想改） | 其余区（用户想保留） |
| --- | --- | --- |
| 用户心智 | 「我要改这里」 | 「这里别动」 |
| 显示层（画布高亮） | 半透明 accent 高亮 | 原图透出 |
| 导出层（发上游的 PNG） | **alpha = 0（透明）** | alpha = 255（黑色不透明） |
| 上游行为 | 按 prompt 重绘 | 保留 |

> 由 `maskPolarity` 控制：`paint-to-edit`（默认，上述）/ `paint-to-keep`（不反转）。实现见 `src/core/engine.ts` 的 `exportMask()`。

### 硬约束 → 库的设计决策

| 约束 | 规则 | 库的应对 |
| --- | --- | --- |
| 尺寸 | mask 必须与待编辑图**尺寸一致** | 导出时 mask 画布尺寸 = 处理后原图真实像素尺寸（§5.2） |
| 格式 | mask 须与原图**格式一致** + **含 alpha 通道** | **mask 恒导出无损 PNG（带 alpha），不跟随 `output.type`/`output.quality`**——`output` 仅作用于 `image`。mask 是二值 alpha 引导图，WebP/有损会破坏 alpha 边界，故强制 PNG。原图按 `output` 规范化为 PNG/WebP。 |
| 大小 | 单文件 < 50MB | 宿主侧把关上传上限；库不限制 |
| 精度 | 上游把 mask 当**引导**，不保证逐像素贴合 | 提供**羽化**让边缘过渡自然（§5.6） |
| 作用对象 | 多图时 mask 只作用第一张 | 库聚焦**单图**；多图编排是宿主的事 |

> **mask 通道语义（面向宿主）**：导出 mask **仅 alpha 通道有意义**——涂抹区 `alpha=0`（要重绘），保留区 `alpha=255`（保留）；RGB 三通道恒为黑（`0,0,0`）且无意义。OpenAI `images/edits` 只依据 alpha 判定。**若上游是按亮度/RGB 判 mask 的自建 / SD 管线，需自行把 alpha 换算为亮度。**

> **源图 CORS（高频踩坑）**：传 `string` url 作源图时库以 `crossOrigin="anonymous"` 加载；**若该 url 的 CDN 未返回允许 anonymous 的 CORS 头，图能显示但画布会被污染，导出 `toCanvas` 必抛 `SecurityError` 而失败**。宿主须确保远程源图允许跨域，或先取成 Blob/File 再传入。

---

## 二、功能范围

### 能力模块

| 模块 | 能力 | 实现 |
| --- | --- | --- |
| **A 蒙版** | 画笔涂抹 / 矩形框选 / 橡皮 / 清除 / 羽化 → 透明 alpha PNG | Konva 分层 + 合成 |
| **B 几何** | 裁剪（比例预设 + 自由）/ 旋转 90° / 水平·垂直翻转 | Konva 自实现 |
| **C 调整** | 亮度 / 对比度 / 饱和度 | CSS `filter` 预览 + canvas 烘焙 |
| **体验** | 画布缩放/平移、撤销/重做、笔刷光标、触屏 Pointer、坐标互转 | Konva + 自管状态机 |

### 处理流水线（顺序不可乱）

```
loadSource(原图)
  → [B 几何]  裁剪/旋转/翻转   改变画幅与朝向，确定最终尺寸
  → [C 调整]  亮度/对比度/饱和度  像素级，不改尺寸
  → [A 蒙版]  基于「最终画幅」涂抹/框选  导出与最终原图等大的 mask
  → exportResult() → { image（处理后原图）, mask（透明 PNG，可选） }
```

> 几何必须在蒙版**之前**：mask 尺寸要等于最终原图尺寸，先裁剪/旋转再涂抹，避免坐标错位。

### 非目标（库不做）

- ❌ 网络 / 上传 / 接口请求——库只吃 `source` 吐 `StudioResult`。
- ❌ AI 自动抠图 / 智能选区（SAM 类）——纯手动。
- ❌ 图层 / 文字 / 贴纸 / 彩色绘画——这是 mask 工具不是画图工具。
- ❌ 内置业务主题——只暴露 CSS 变量契约。
- ❌ outpaint / 多图同时编辑——单图、inpaint 语义。
- ❌ 业务门控（哪些模型支持 mask）、积分、鉴权——全是宿主的事。

---

## 三、架构

### 两层：框架无关 core + Vue 壳

```
ImageStudio.vue (Vue 壳：模板/响应式/事件/expose)
        │ 实例化、转发指令、订阅回调
        ▼
StudioEngine  (框架无关 TS class：持有 Konva、绘制、变换、导出)
        │
        ▼
   konva  (唯一运行时依赖)
```

- **core 不含任何 Vue**：纯 TS class，挂在 DOM 容器上，命令式 API + 事件回调。→ 未来出 React/Svelte 壳只需再写组件层，core 复用。
- **Vue 层只做**：布局（工具栏/画布/参数）、props→engine、engine 事件→emit、响应式桥接、`defineExpose` 命令式 API。
- **不用 vue-konva**：声明式对高频涂抹别扭且绑死 Vue。

### 目录结构（现状）

```
vue-inpaint-canvas/
├─ src/
│  ├─ core/
│  │  ├─ engine.ts     # StudioEngine：加载/画笔/橡皮/框选/几何(裁剪·旋转·翻转)/统一命令撤销/导出（已实现）；羽化·缩放平移 TODO
│  │  ├─ types.ts      # 全库公共类型契约（真相源）
│  │  └─ index.ts      # core 入口（"vue-inpaint-canvas/core"）
│  ├─ vue/
│  │  ├─ ImageStudio.vue
│  │  └─ index.ts      # Vue 入口（默认）
│  ├─ theme/
│  │  └─ default.css   # --vic-* 默认值 + 基础布局
│  └─ index.ts         # 包主入口
├─ playground/         # vite dev demo（造测试图、涂抹、看产物）
├─ tests/              # Vitest（filters/coords/export-mask/image-studio/geometry，264 用例门禁）
├─ index.html          # playground 入口（dev）
├─ vite.config.ts      # serve→playground；build→lib（dist/index.js + dist/core.js + style.css）
├─ DESIGN.md / CLAUDE.md / README.md
```

### 依赖策略

- 运行时仅 `konva`（`dependencies`）；`vue` 为 `peerDependencies`。裁剪/调整零新增依赖。
- 产物 ESM-only，`external: ["vue", "konva"]`，不打进宿主重复副本。

---

## 四、公共 API

### `<ImageStudio>` props / events / expose

```ts
// props
{
  source: File | Blob | string | HTMLImageElement | HTMLCanvasElement; // url 自动加载
  tools?: StudioTool[];              // 启用模块，默认 ['brush','eraser']。组件按 tools 门控渲染按钮，
                                     // engine 侧 `setTool` 亦做白名单二次校验（rect/rotate/flip/crop 需显式开启）。
                                     // 注：rotate/flip 经 expose 便捷方法直调，不走 setTool 门控（几何 API 始终可用）。
  maskPolarity?: 'paint-to-edit' | 'paint-to-keep'; // 默认 paint-to-edit
  feather?: number;                  // 蒙版边缘羽化像素，默认 0。⚠️ 当前为 no-op（见 §5.6）。
  brushSize?: number;                // 画笔初始粗细（px），默认 40；运行期经 expose.setBrush 改。
  locale?: Partial<StudioLocale>;    // i18n 文案覆盖，与 DEFAULT_LOCALE 浅合并（缺省键回退中文）。
  cropRatios?: (number | 'free')[];  // 裁剪档位，缺省 DEFAULT_CROP_RATIOS（✅ 裁剪子工具栏已消费）。
  theme?: Partial<StudioTheme>;      // 注入 --vic-* CSS 变量
  output?: {                         // ⚠️ 仅作用于 image；mask 恒为无损 PNG（见 §1）。
    type?: 'image/png' | 'image/webp';   // webp 不被环境支持时浏览器静默回退 png，宿主应以 result.image.type 为准。
    quality?: number;                    // [0,1]，仅 image/webp 有效；PNG 无损会忽略此值。默认 0.92。
  };
}

// emits
{
  apply:  (result: StudioResult) => void;  // 点「应用」回传产物
  change: (state: StudioStateBrief) => void;
  ready:  () => void;
  cancel: () => void;
  error:  (err: Error) => void;
}

// expose（ref 命令式调用）
{ exportResult, exportMask, undo, redo, reset, clearMask, setTool, setBrush,
  applyTransform, rotate, flipHorizontal, flipVertical,        // 几何（L4）
  setCropRatio, applyCrop, cancelCrop,                         // 交互裁剪（L4c）
  setAdjust, commitAdjust }                                    // 调整（L5b）
```

> **`StudioLocale` 文案契约**：`DEFAULT_LOCALE` 提供全部 25 键中文默认（含 L4 新增 `flipHorizontal` / `flipVertical` / `applyCrop` / `cropFree`）。其中 `maskHintEdit` / `maskHintKeep` 是随 `maskPolarity` 切换的 mask 反转语义提示（红线①最易搞反点）——组件在工具栏内置渲染该提示行（`maskPolarity === 'paint-to-edit' ? locale.maskHintEdit : locale.maskHintKeep`），宿主也可读取该键自渲染。

> **expose 基线（与代码对齐）**：`{ exportResult, exportMask, undo, redo, reset, clearMask, setTool, setBrush, applyTransform, rotate, flipHorizontal, flipVertical, setCropRatio, applyCrop, cancelCrop, setAdjust, commitAdjust }`。`setBrush({ size })` 程序化改笔刷；几何/裁剪/调整命令直转 engine。**调整 UI 已落地（L5b）**：`adjust` 工具 + 滑块面板 + 实时 CSS filter 预览 + `commitAdjust` 可撤销。

### 产物 `StudioResult`

```ts
interface StudioResult {
  image: Blob;          // 处理后原图（几何+调整已烘焙）
  mask: Blob | null;    // inpaint mask（透明 alpha PNG）；无圈定为 null
  width: number;        // 处理后真实像素宽高（image 与 mask 等大）
  height: number;
  hasMask: boolean;
  maskCoverage: number; // 蒙版覆盖比例 [0,1]
}
```

### 框架无关 core `StudioEngine`

```ts
const engine = new StudioEngine(container, options);
await engine.loadSource(src);
engine.setTool('brush'); engine.setBrush({ size: 40 });
engine.on('change', (s) => { /* ... */ });
const result = await engine.exportResult();
engine.destroy();
```

完整类型见 `src/core/types.ts`（`StudioTool / MaskPolarity / EngineOptions / StudioTheme / StudioLocale / TransformState / AdjustValues / ...`）。

---

## 五、内部实现要点

### 5.1 Konva 分层

| Layer | 内容 | 导出 |
| --- | --- | --- |
| `baseLayer` | 几何+调整后的原图 | → `result.image` |
| `maskLayer` | 涂抹/框选区，画时半透明 accent 高亮（`source-over`），橡皮 `destination-out` | → 反转后成 `result.mask` |
| `cursorLayer` | 笔刷圆环光标、裁剪框手柄 | 否 |

### 5.2 mask 导出管线（**已实现，手动 PoC 验证；自动化护栏见 §9/L3.5**，代码在 `engine.ts` `exportMask()`）

```
maskLayer（高亮可见）
  → layer.toCanvas({ x:0, y:0, width=imageW, height=imageH, pixelRatio: 1 })  // 真实像素，不受缩放影响
  → 遍历像素：alpha > PAINT_ALPHA_THRESHOLD(=10) 判「已涂」，按 maskPolarity 置 alpha=0 或 255（硬二值化）
  → （feather>0，L6）离屏 blur(feather) 边缘 alpha；feather===0 走二值快路径保持像素级精确
  → canvas.toBlob('image/png')   // mask 恒 PNG，不读 output.type/quality（见 §1）
```

要点：**导出尺寸 = 图像真实像素**；缩放/平移只影响显示，靠 `getRelativePointerPosition` 拿图像坐标。

> **硬二值化取舍**：round 笔触栅格化必然产生抗锯齿半透明边缘（alpha 1~254），阈值=10 把它们全部归入涂抹区，导出为硬边（仅 {0,255} 两种 alpha），使涂抹区相对显示略外扩约 0.5px。在「上游把 mask 当引导、非逐像素」前提下可接受；真正的边缘平滑由 feather（L6）提供，届时二值快路径与羽化路径分流。护栏单测：斜线/圆头笔触导出后 alpha 仅 {0,255} 两值。

> **错误去重**：`exportMask` 抛出的错误打 `__vicEmitted` 标记；`exportResult` 复用 `exportMask` 时若错误已标记则只 `throw` 不重复 `emit('error')`，避免跨域污染时宿主弹两次错误（当前为双 emit，L3.5 修）。

### 5.3 画笔 / 橡皮 / 框选

- 画笔/橡皮：`Konva.Line` + `lineCap/lineJoin: 'round'`，`pointermove` 累加 points；橡皮用 `globalCompositeOperation: 'destination-out'`。**已实现**。
- 矩形框选（**TODO**）：`pointerdown` 记起点 → `pointermove` 更新临时 `Konva.Rect` → `pointerup` 固定并入 maskLayer（叠加非替换）。
- 笔刷光标（**TODO**）：cursorLayer 跟随指针画圆环，半径=笔刷/2。

### 5.4 几何变换 ↔ mask 联动（**✅ 已实现 0.2，方案 A 矢量；曾是全程最高风险，已用 21 像素单测 + 浏览器回归攻克**）

#### 5.4.1 变换语义规范（钉死，避免歧义）

- **单一状态快照**：`TransformState { crop, rotate∈{0,90,180,270}, flipX, flipY }`。`applyTransform(Partial<TransformState>)` 是对该 state 的 **merge 覆盖**（非增量）；`rotate` 为**绝对角度**（不是 +90 增量），`flipX/flipY` 为绝对布尔。
- **固定应用顺序 `flip → rotate → crop`**：先在原图坐标系做水平/垂直翻转 → 再做 90° 整步旋转 → 最后在**旋转后坐标系**内按 `crop` 矩形截取。
  - ⚠️ **坐标系一致性**：`crop` 字段表达在 **flip+rotate 之后的画布坐标系**内。这与 `types.ts` 现有注释「裁剪在图像像素坐标系内表达」冲突，**实现时须同步把 `TransformState.crop` 注释改为「裁剪矩形在 flip+rotate 之后的画布坐标系内表达」**。merge 语义下 `crop` 始终相对当次合并后的 `rotate` 结果，宿主传 `crop` 前应已知目标 `rotate`；「坐标系基准」列为 L4 坐标互转单测的断言项。
- **画幅推导**（导出尺寸断言基准）：

  | 输入 (W,H) | rotate | crop | 输出画幅 (W',H') |
  | --- | --- | --- | --- |
  | (W,H) | 0/180 | null | (W,H) |
  | (W,H) | 90/270 | null | (H,W) |
  | (W,H) | 任意 | {w,h} | (crop.w, crop.h) |

#### 5.4.2 实现方案 A（矢量保真，**已落地**）

几何变换**不烘焙像素**：在 `baseLayer`/`maskLayer`/`cursorLayer` 三层上设**同一组** `rotation` + `scaleX/Y(-1 翻转)` + `position`，mask 的 `Konva.Line`/`Rect` 节点 `points` **保持源图坐标不动**（无插值损失、不破坏逐笔撤销栈，对齐 §5.6）。导出时各自 `toCanvas({0,0,imageW,imageH})` 出处理后画幅。

> **实现支点（已实证）**：Konva layer 的 `world(p)=position+R(rotation)·S(scale)·p` 恰等于 `coords.toDisplaySpace(p)`，故实现里 **`layer.position = toDisplaySpace(源图原点(0,0))`**、`rotation/scaleX/scaleY` 直取 transform——`coords.ts` 纯函数（红线6 护栏）**同时就是几何实现的数学基础**，无需手推仿射矩阵（见 `engine.applyTransformToLayers()`）。`tests/geometry.test.ts` 用 node-canvas 真实像素断言涂抹区对齐到 `toDisplaySpace` 预测位置，已证 Konva layer transform 被 `toCanvas` 正确渲染。
>
> **裁剪交互**：裁剪框在 `cropLayer`（**stage 空间、不套几何 transform**）上以暗化遮罩抠洞 + 拖拽选区表达；`applyCrop` 把草稿（当前显示空间）与已有 `transform.crop` 原点**相加**合成到 flip+rotate-after 全空间再 `applyTransform({crop})`，故二次裁剪可正确叠加（zoom=1/pan=0 下精确；L6 接缩放后改走 coords 逆变换）。

- **`imageW/imageH` 不变式**：`applyTransform` 完成后必须把 `imageW/imageH` 更新为推导出的处理后画幅 (W',H')。**`imageW/imageH` 恒等于当前画幅，是导出尺寸的唯一真相源**。
- **导出取数规则**：`exportMask`/`exportResult` 的 `toCanvas` 取数原点/尺寸走处理后坐标系（`0,0,imageW,imageH`，因变换已套在 layer 上、画幅已更新）。**`image` 与 `mask` 必须同源于 `imageW/imageH`**——L4 后须断言 `image.width === mask.width === result.width`，三者等大（红线4 与 `StudioResult{width,height}` 契约）。
- **与 §5.7 zoom/pan 正交**：几何变换**只改** layer transform 与画幅（`imageW/imageH`、`stage.size`），**绝不写** `stage.scale/position`；显示缩放平移（§5.7）**只改** `stage.scale/position`，**绝不改** layer transform。几何变换后触发一次 fit 重算刷新 zoom 基准。

#### 5.4.3 坐标互转（可单测纯函数，先于交互）

抽出一对**不依赖真实 DOM/指针**的纯函数（建议 `src/core/coords.ts`）：

```ts
// flip 镜像需原图画幅基准，故 ctx 含 imageW/imageH（实现见 src/core/coords.ts）。
export interface CoordsContext { transform: TransformState; zoom: number; pan: Point; imageW: number; imageH: number }
export function toImageSpace(p: Point, ctx: CoordsContext): Point;
export function toDisplaySpace(p: Point, ctx: CoordsContext): Point;
export function transformedSize(w: number, h: number, t: TransformState): { width: number; height: number };
```

`getRelativePointerPosition()` 仍是交互期取图像坐标的快路径，但**坐标互转单测针对这对纯函数**，断言 `toDisplaySpace(toImageSpace(p)) ≈ p`（亚像素容差）与各 transform 序列下角点映射到预期位置。**红线6：此单测必须先于 L4 任何 `applyTransform` 实现合入**。

#### 5.4.4 能力边界（非目标）

几何仅支持 **90° 整步旋转 + 轴对齐矩形裁剪 + 水平/垂直翻转**；**不做**任意角度旋转 / 拉直(straighten) / 透视校正 / 非矩形（圆形·多边形）选区。整步旋转保证 mask 无插值损失，与 inpaint 单图局部重绘场景匹配。

### 5.5 调整 pipeline（**✅ 已接线 L5a+L5b**）

- 导出（**L5a**）：`engine.setAdjust()` 写入 `this.adjust`，`exportResult()` 用 `ctx.filter` 把同串 filter 烘焙进 image 像素（见 `adjustToCssFilter`）。**浏览器实测烘焙生效**（源 `[55,137,220]` → brightness80 导出 `[199,255,255]`）。
- 预览（**L5b**）：组件对画布容器 `.vic-canvas` 套响应式 CSS `filter: brightness() contrast() saturate()`（GPU、实时），与导出同串、所见即所得。⚠️ **node-canvas 不支持 `ctx.filter`**，故烘焙正确性走浏览器回归而非单测（单测仅覆盖命令/状态/撤销语义）。
- 撤销（**L5b**）：`setAdjust` 实时改值不入栈（滑块拖拽会刷屏）；`commitAdjust`（滑块释放 `@change`）把"上次提交→当前"合为单条 `kind:'adjust'` 命令入统一历史，可撤销/重做且回填滑块。`clearMask` 不影响 adjust 命令（kind 分类），`reset` 清空。
- 组件 UI（**L5b**）：`adjust` 工具进入调整模式 → 亮度/对比度/饱和度滑块面板（[-100,100]）+ 重置；expose `setAdjust`/`commitAdjust`；`StudioStateBrief.adjust` 快照驱动滑块在撤销/重做/重置后同步。

### 5.6 撤销/重做 + 羽化

- **撤销/重做（统一命令历史，✅ L4 已落地）**：`interface Command { kind: "mask" | "geom"; do(); undo() }`；mask 笔触/框选与 crop/rotate/flip 各实现为命令，单一 `history: Command[]` + `redoStack: Command[]` 承载（`redoStack` 类型已从 `Konva.Node[]` 改为 `Command[]`）。配合 §5.4 方案 A（矢量）：几何命令 `undo` 只需逆变换 + 还原 `imageW/imageH`/`stage.size`，**无需恢复像素**。`getState().canUndo` 已从 `=hasMask` 改为 `=history.length>0`；`StudioStateBrief` 新增 `transform` 快照供 UI 显示旋转/翻转激活态。`clearMask` 按 `kind!=='mask'` **滤除** mask 命令、保留几何撤销；`reset` 清空整个历史。⚠️ **`adjust` 暂未入命令栈**（`setAdjust` 仅 core API、无 UI，归 L5b；届时补 adjust 命令）。
- **羽化（feather）**：⚠️ **当前为 no-op——`feather` 选项被透传存储但 `exportMask` 尚未消费（仅 TODO 注释），设任何值都不生效**。实现（L6）：二值 alpha 写完后，`feather>0` 时对 mask 做离屏 `ctx.filter='blur(${feather}px)'` 重绘 alpha 通道；`feather===0` 走二值快路径保持像素级精确。**验收**：`feather>0` 时涂抹边缘 alpha 呈 `0<alpha<255` 单调渐变（非纯 0/255），覆盖率测试改用阈值带容差断言。

### 5.7 坐标互转 + 缩放平移（**TODO**）

- Stage `scale`/`position` 做 zoom/pan；`getRelativePointerPosition()` 直接拿图像真实像素坐标。
- 导出与涂抹坐标全程走图像坐标系，显示变换不污染产物。

---

## 六、主题契约

不绑死任何业务主题，暴露 `--vic-*`，宿主用 `:theme` prop 或外层 CSS 覆盖：

```css
.vic-studio {
  --vic-accent: #7c5cff;  /* 涂抹高亮 / 主按钮 */
  --vic-bg; --vic-surface; --vic-elevated;
  --vic-text; --vic-text-muted; --vic-border; --vic-radius;
}
```

- 库自带中性暗色默认（`src/theme/default.css`）。
- 明暗由宿主按需给值（库不自带 colorMode）。
- 消费者需 `import "vue-inpaint-canvas/style.css"`。

---

## 七、工程与发布

| 项 | 选型 |
| --- | --- |
| 包管理 | bun |
| 构建 | **vite library mode**（`@vitejs/plugin-vue`）打包 + **`vue-tsc -p tsconfig.build.json`** 生成 `.d.ts`（`rootDir: src` 去掉 `src/` 前缀，但**保留 `core/`/`vue/`/`theme/` 子目录层级**，产出 `dist/core/index.d.ts`、`dist/vue/index.d.ts`，非全部平铺到根）→ `dist/index.js`（Vue）+ `dist/core.js`（core）+ `dist/style.css`。**不用 `vite-plugin-dts`**（已被作者软弃用，迁 `unplugin-dts`；这里用官方 `vue-tsc` 更省依赖） |
| 类型 | `vue-tsc --noEmit` 把关；dts 由 build 第二步 `vue-tsc -p tsconfig.build.json` 生成。**注：`typecheck` 通过 ≠ dts 能产出**（declaration emit 仅在 build 触发，`.vue` 的 `defineExpose`/`defineProps` 推断失败只在 build 暴露），靠 CI build 步兜底。 |
| 测试 | Vitest（jsdom + devDep `node-canvas` 出真实像素，见 §9 方案 B）。纯函数(filters/coords)与 canvas 像素断言(mask 导出/几何联动)同跑 jsdom，**264 用例**成门禁（5 文件：filters/coords/export-mask/image-studio/geometry）。 |
| Lint/格式 | oxlint（可选 oxfmt / `vp check`，对齐 Vite+ 生态） |
| 导出 | `.`→Vue、`./core`→框架无关核心、`./style.css`；ESM-only、`external: vue/konva` |
| SSR | 无顶层 `window` 访问；组件在 `onMounted` 实例化 engine；宿主 Nuxt 用 `<ClientOnly>` |
| 发布 | npm（先 `0.x`，首发打 `beta`/`next` dist-tag，几何稳定后升 `latest`）；语义化版本；MIT。`package.json` 已声明 `provenance:true`，但**发布前需在 `ci.yml` 增 release job（`permissions.id-token: write`）并在 npm 侧配置 trusted publisher (OIDC)**；当前 `ci.yml` 仅含校验步骤、无 publish job。 |
| CI | **已落地**：GitHub Actions（`install → lint → typecheck → test → build`，`--frozen-lockfile`），见 `.github/workflows/ci.yml`。L3.5 测试护栏落地后像素/坐标断言随 `test` 步成为门禁。 |
| engines | `node >=18.12`（已收紧，node-canvas v3 prebuild 下限）。`canvas` 仅 devDep，**不影响宿主运行时**（运行时仍单依赖 `konva`）。 |

> **dist 实测产物**（`bun run build` 已实核）：双入口共享 `engine/coords/filters/types`，Rollup 析出一个共享 chunk `core2.js`，`core.js` 仅作 `./core` 入口的 re-export 壳——功能正常（ESM 解析到 chunk），但产物多一文件，**L7 可评估 `manualChunks`/内联消除该 `core2.js`**：
>
> ```
> dist/
> ├─ index.js              # Vue 入口（~8.2 kB，含几何/裁剪 UI）
> ├─ core.js               # ./core 入口 re-export 壳（~0.2 kB）
> ├─ core2.js              # 共享核心实现 chunk（~17.6 kB：engine/coords/filters/types）
> ├─ style.css             # 仅由 index 入口（ImageStudio.vue 的 CSS import）产出（~1.9 kB）
> └─ index.d.ts · core/index.d.ts · vue/index.d.ts   # dts 保留子目录层级
> ```

---

## 八、开发路线与当前进度

| 阶段 | 内容 | 目标版本 | 状态 | 验收标准（DoD，交叉引用 §9） |
| --- | --- | --- | --- | --- |
| **L0–L1** | 脚手架 / 引擎骨架 / 三层 / 加载 / 事件 | 0.1 | ✅ | typecheck+test+lint 绿 |
| **L2 蒙版** | 画笔/橡皮/清除/反转 alpha 导出/轻量撤销 | 0.1 | ✅ 命脉 | 见 L2 收尾行 |
| **L2 收尾** | 框选(rect 并入 maskLayer) + 笔刷光标(cursorLayer 圆环) + locale 接线 + maskHint 提示行 + tools UI 门控 + brushSize prop 接线 + a11y 底线(aria-label/aria-pressed/reduce-motion) + output.type=webp 解耦 mask + 文档准确性(quality/RGB黑/feather no-op) | 0.1 | ✅ | 模板零硬编码文案、locale 浅合并生效；传 `tools:['brush']` 不渲染橡皮；框选区计入覆盖率；光标半径=brushSize/2 可视；maskHint 随 maskPolarity 切换；按钮 aria-label/aria-pressed 全覆盖；`output={type:'webp'}` 时 `result.mask` 仍 PNG（均有单测） |
| **L3 Vue 壳** | ImageStudio + 工具栏 + 主题注入 + 事件/命令 API | 0.1 | ✅ | 挂载/expose/事件桥接组件测试（`image-studio.test.ts`，jsdom，不依赖 canvas 像素） |
| **L3.5 测试护栏** | 测试栈方案 B(node-canvas) + mask 导出断言 + 坐标互转往返 + 组件桥接 | 0.1 | ✅ | §9 的 4 条 mask 断言全绿 + `toDisplaySpace(toImageSpace(p))≈p`(203 用例) + 二值化稳定 + 双 emit 去重；`bun run test` 227 绿成门禁 |
| **L4 几何** | 裁剪/旋转/翻转 + mask 坐标联动（方案 A 矢量）+ 统一命令撤销 + 交互裁剪框（比例预设/暗化遮罩/拖拽选区） | 0.2 | ✅ | 变换后对应点像素对齐 + 导出尺寸=变换后画幅（旋转 90° W/H 互换、crop 后=裁剪框）+ `image.width===mask.width===result.width` + 撤销可回退几何（含 imageW/imageH）；`geometry.test.ts` 27 用例（node-canvas 真实像素，含鲁棒性 + adjust 命令回归）+ 组件桥接，浏览器实操回归（rotate/flip/crop 全验） |
| **L5a 调整(core)** | setAdjust + exportResult 烘焙 | 0.1 | ✅ | filters 单测（已有） |
| **L5b 调整(Vue)** | expose setAdjust/commitAdjust + 滑块面板 + CSS filter 实时预览 + adjust 命令撤销 | 0.3 | ✅ | 预览/导出像素一致（浏览器实测烘焙生效）+ commitAdjust 可撤销回填滑块 + clearMask 不误清；组件桥接 4 用例 + 引擎命令 3 用例 |
| **L6 打磨** | 缩放/平移 + 羽化 + 移动端双指手势 + 性能 + 真机回归 | 0.3 | 🚧 | zoom/pan 下坐标往返一致（复用 L3.5）；feather>0 边缘渐变；移动端**真机/微信回归后方可标完成** |
| **L7 文档/发布** | README / 测试补齐 / 发 npm | 0.1+ | 🚧 README ✅、CI ✅ | `npm publish --dry-run` 核对 dist 产物齐全 |

> **0.1 MVP 边界**：L0–L3 + **L2 收尾**（框选+光标+locale+maskHint+brushSize+a11y）+ **L3.5 测试护栏** + L5a。把蒙版闭环做扎实先发，尽早拿真实宿主反馈。**几何（L4）单独成 0.2**——最高风险，绑进首发会让 bug 绑架整个发布。缩放平移/羽化/实时预览归 0.3。
>
> **critical path**：框选 → 笔刷光标 → a11y 底线，三项互相独立可并行；羽化依赖 `exportMask` 重构故排框选之后；几何/缩放平移明确移出首发关键路径。
>
> **目标顺序**：~~L2 收尾 → L3.5 测试护栏 → L4 几何~~（✅ 全部完成）→ **L5b 调整 UI / L6 缩放平移+羽化+移动端（0.3）**。当前 `bun run dev` 即可在 playground 涂抹/框选/橡皮 + 旋转/翻转/裁剪 并导出透明 mask（几何与 mask 联动）。
>
> **L4 几何已落地（0.2）**：`applyTransform`（flip→rotate→crop merge，方案 A 矢量，三层 layer transform 复用 `toDisplaySpace` 定位）+ `rotate/flipHorizontal/flipVertical` 便捷命令 + 统一 `Command[]` 历史（mask 笔触与几何同栈）+ 交互裁剪框（cropLayer stage 空间覆盖层、暗化抠洞、比例预设、拖拽选区、与已有 crop 原点合成）。**已知边界（resize 手柄）**：裁剪当前为「拖拽重绘选区」，无 Konva.Transformer 缩放手柄——可用但 UX 可再打磨，列入 L6 polish。

### 已实现 vs TODO 速查（按文件）

- `src/core/engine.ts`：✅ `loadSource`(srcW/srcH↔imageW/imageH 分离) / `setTool`(白名单门控+裁剪进出) / `setBrush` / 画笔+橡皮+**rect 框选** / **笔刷光标圆环** / **`applyTransform`+`rotate`+`flipHorizontal`+`flipVertical`(几何方案 A 矢量)** / **交互裁剪(`setCropRatio`/`applyCrop`/`cancelCrop`+cropLayer)** / **统一 `Command[]` 撤销/重做(mask+几何+adjust 同栈)** / `exportMask`(反转 alpha，**恒 PNG**) / `exportResult`(adjust 烘焙) / `clearMask`(按 kind 滤除) / **`setAdjust`+`commitAdjust`(adjust 命令)** / **error 去重(`__vicEmitted`)** / 事件；🚧 羽化(no-op，L6) / 缩放平移(L6)。
- `src/core/coords.ts`：✅ `toImageSpace`/`toDisplaySpace`/`transformedSize` 纯函数（203 单测）——**L4 已接线**：`toDisplaySpace(原点)` 即三层 layer 的 `position`，coords 既是护栏也是几何实现数学基础（见 §5.4.2）。
- `src/vue/ImageStudio.vue`：✅ 实例化/接线/工具栏/主题注入/apply/**locale 浅合并**/**maskHint**/**tools UI 门控**/**brushSize prop**/**a11y**/**setBrush expose**/cursor class/**旋转·翻转·裁剪按钮 + 裁剪子工具栏 + cropRatios prop + 几何 expose + 调整滑块面板(亮度/对比度/饱和度) + CSS filter 实时预览 + adjust/commitAdjust expose**。
- `src/core/types.ts`：契约真相源已含 `Point`/`BrushOptions`/`StudioLocale`/`DEFAULT_LOCALE`/`TransformState`/`AdjustValues`；`EngineOptions` 含 `locale`/`brushSize`；`StudioStateBrief` 已加 `transform` 快照；`ImageStudioExpose` 已加 `setBrush`/`applyTransform`/`rotate`/`flipHorizontal`/`flipVertical`/`setCropRatio`/`applyCrop`/`cancelCrop`。

---

## 九、质量基线

### PoC 验证结论（**手动 PoC，自动化护栏待补**）

下表 4 条断言经 **playground 手动涂抹 + 程序化自检脚本**验证通过，但**该脚本尚未作为可重放单测提交仓库**（仅 `tests/filters.test.ts` 已落地）。自动化护栏依赖下方测试栈选型，落地后这 4 条即成 mask 命脉回归门禁。

| 断言 | 期望 |
| --- | --- |
| 涂抹区中心 alpha | 0（透明=要重绘） |
| 保留区角落 alpha | 255（不透明=保留） |
| mask 尺寸 = 图像尺寸 | 512×512 |
| 覆盖率 | ≈15.3%（带容差） |

### ⚠️ 测试栈可行性（决定性前提，先选型再写护栏）

**实测**：当前 `environment: 'jsdom'` + devDependencies 未装 `canvas` 包下，`canvas.getContext('2d')` 抛 `Not implemented: HTMLCanvasElement's getContext()` 并返回 `null`（`engine.ts` 的 `getContext('2d')!` 会在 null 上崩），Konva 的 `toCanvas()/getImageData()` 也取不到真实像素——**§9 全部像素断言在现有栈上一行都跑不了**。落地前**必须二选一**并写定：

- **方案 B（L3.5 **已采用**）`node-canvas`**：`bun add -D canvas` 让 jsdom 后端出真实像素、零浏览器、CI 快。代价：`engines.node` 收紧为 `>=18.12`、Konva 文本/滤镜与浏览器有细微差异。**L3.5 的 4 条 mask 断言 + 坐标往返本就不依赖浏览器渲染差异**（纯几何/alpha 阈值），方案 B 足够且最省 CI。canvas v3 自带多平台 prebuilt binary，CI 免编译。
- **方案 A（L4 像素对齐再评估）Vitest browser mode**：`bun add -D @vitest/browser playwright`，`vite.config` 用 `test.projects` 把 canvas 像素测试放 `browser`(chromium headless)、`filters/coords` 纯函数留 jsdom。真实浏览器像素最可靠、最贴生产。代价：playwright 需下载 chromium（~150MB）、headless 启动比 jsdom 慢一个数量级、CI 时长上升，须严格隔离 project 避免拖慢纯函数测试。

> 结论（**已落地**）：**L3.5 采用方案 B（node-canvas）**。`tests/{export-mask,coords,image-studio,geometry}.test.ts` 已覆盖 mask 命脉 4 断言 + 坐标往返 + 组件桥接 + **L4 几何/裁剪联动**，随 `bun run test` 成门禁（264 用例绿）；冒烟已验证 `StudioEngine → 注入笔触 → exportMask` 出可解码 PNG 的 Konva+node-canvas 链路。**L4 几何像素对齐实测 node-canvas 已足够**（layer transform + flip 负 scale 渲染正确），未动用 browser mode，省 CI；browser mode 留给将来真彩/滤镜差异敏感的测试再评估。

### 测试重点与优先级（写入路线，与 §8 阶段绑定）

- **P0 mask 导出（命脉 + 红线①，L3.5）**：两种 `maskPolarity` 涂抹区/保留区 alpha 反转正确；尺寸=图像；空 mask→null 且 `exportResult().mask===null`、`hasMask===false`；`maskCoverage≈0.153`（容差）；阈值边界（alpha≤10 不计入）；二值化稳定（边缘仅 {0,255}）；污染源导出 error 只 emit 一次。
- **P0 坐标互转往返（L4 前置护栏，红线6，L3.5）**：对一组 `(scale, offset, rotate∈{0,90,180,270}, flipX/Y)` 断言 `toDisplaySpace(toImageSpace(p))≈p`（亚像素容差）+ 角点映射到预期位置 + crop 坐标系基准。**必须先于任何 applyTransform 实现合入**。
- **P1 组件桥接（纯 jsdom，不依赖 canvas）**：`@vue/test-utils` 已装，验证 onMounted 实例化、setTool/undo/redo 转发、locale 浅合并、tools 门控、未就绪时 expose reject。
- **P2 几何联动（✅ L4 已落地，`geometry.test.ts` 27 用例）**：变换后涂抹区对齐到 `toDisplaySpace` 预测像素（rotate 90/180/270、flipX/Y、crop、组合）+ 导出尺寸=变换后画幅（旋转 W/H 互换、crop=裁剪框）+ `image.width===mask.width===result.width` + undo/redo 还原画幅 + 命令同栈逆序 + clearMask 按 kind 滤除 + 裁剪默认框/比例/合成/守卫。

### 性能 / 移动端 / 可访问性

- **性能**：`exportMask` 4096² 逐像素 JS 循环（1677 万像素）同步阻塞主线程。L6 前可接受，重构方向：改离屏 `globalCompositeOperation` 一次性合成消除 JS 循环（零依赖、收益最大），或迁 OffscreenCanvas+Worker（core 无 DOM 依赖、契合框架无关定位）。⚠️ **合成算子必须等价于现「按 maskPolarity 反转 alpha」语义**（红线①最易错点）——重构时复用 L3.5 的 4 条 mask 断言做不变量护栏，防止把 alpha 反转方向搞反。大图导出宿主应显 loading。
- **移动端**：全程 Pointer；单指涂抹**已通**，**双指捏合缩放/平移尚未实现**（仅 `touch-action:none` 兜底，L6）。**真机/微信回归后方可标 L6 完成**（桌面无法模拟 coarse pointer）。
- **可访问性（验收项，非泛目标）**：① 工具按钮 `:aria-label`（取自 locale）；② 工具按钮 `:aria-pressed="tool==='brush'"` 表达激活态；③ `default.css` 加 `@media (prefers-reduced-motion: reduce){ .vic-toolbar button{ transition:none } }`。三条均为 0.1 打磨子项。**已知边界**：涂抹画布是鼠标/触屏 only，canvas 无键盘涂抹替代——键盘不可达是 inpaint 工具的固有边界，文档据实标注，不列入可达性验收。

---

## 十、关键决策（原未决项定调）

1. **包名/发布 → 直接以 `vue-inpaint-canvas` 公开 MIT 发布，不走私有 `@scope`**。首发 `0.1.0` 打 `beta`/`next` dist-tag，几何（0.2）稳定后升 `latest`。理由：§0 定位是填补生态空白的通用库，私有化与立项冲突；`package.json` 已是无 scope + `access:public` + `provenance:true`；`@scope→无 scope` 改名会破坏已安装宿主。⚠️ **provenance 不是「已配齐」**——当前 `ci.yml` 只有校验步骤，发布前需增 release job（`permissions.id-token: write`）+ npm trusted publisher (OIDC)，列入 L7 前置 todo。
2. **裁剪比例字典 → 支持宿主自定义档位（✅ L4c 已落地）**。组件 props 增 `cropRatios?: (number|'free')[]`，缺省回退 `DEFAULT_CROP_RATIOS`，裁剪子工具栏只渲染该集合并经 `setCropRatio` 驱动引擎。成本近零（默认常量已有），裁剪比例高度业务相关（社媒尺寸各异），不开放会逼宿主 fork。不阻塞 0.1，随 L4/0.2 落。验收：传自定义档位时工具栏只渲染该集合。
3. **文档站 → 0.1/0.2 维持 playground + README，文档站延后**。待 API(props/events/expose) 在 0.3 连续两版无破坏性变更后再选 **VitePress**（比 Histoire 轻、对单组件库够用、§7 已是 vite 生态零学习成本）。当前每迭代都在改 props，过早上 story 维护成本 > 收益。归 L7/1.0 前收尾。
4. **多 mask 笔刷形态 → 0.1 仅硬边笔刷 + 导出羽化（feather）；软笔刷（硬度/不透明度渐变）延后 0.3+ 并列为 feather 重构的依赖项**——前置必须先在 L6 把 `exportMask` 从硬二值重构为「阈值判定 + 保留/生成边缘渐变 alpha」。理由：上游把 mask 当引导（§1 精度行），导出羽化已足够让边缘自然，性价比远高于交互式软笔刷；软笔刷产生的中间 alpha 与现有硬二值导出直接冲突，且会放大 §5.4 几何重采样复杂度。类型侧先加 `export interface BrushOptions { size?: number; /* 预留 hardness?/opacity? 待本项定案 */ }` 让 `setBrush` 用它，把未决点显式编码进类型而非内联匿名对象。
