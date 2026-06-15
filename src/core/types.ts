// 全库公共类型契约（真相源）。core 与 vue 层都从这里取类型。

/** 工具枚举。pan=选择/平移，brush=画笔，rect=矩形框选，eraser=橡皮，其余为几何/调整。 */
export type StudioTool =
  | "pan"
  | "brush"
  | "rect"
  | "eraser"
  | "crop"
  | "rotate"
  | "flip"
  | "adjust";

/**
 * mask 极性。
 * - `paint-to-edit`（默认）：涂抹区 = 要重绘 → 导出 PNG 中涂抹区 alpha=0（透明），对齐 OpenAI images/edits 约定。
 * - `paint-to-keep`：涂抹区 = 要保留（反过来）。
 */
export type MaskPolarity = "paint-to-edit" | "paint-to-keep";

export type OutputType = "image/png" | "image/webp";

/** 任意可作为源图的输入。url 字符串会被异步加载。 */
export type SourceInput = File | Blob | string | HTMLImageElement | HTMLCanvasElement;

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 二维坐标点。core 内部坐标互转（coords.ts）与笔触/光标共用同一类型。 */
export interface Point {
  x: number;
  y: number;
}

/** 画笔参数。当前仅 size；软笔刷（硬度/不透明度渐变）为未决项（DESIGN §10.4），届时在此扩展。 */
export interface BrushOptions {
  /** 画笔粗细（图像像素）。 */
  size?: number;
}

/** 像素级调色，取值区间 [-100, 100]，0 为原值。 */
export interface AdjustValues {
  brightness: number;
  contrast: number;
  saturate: number;
}

/** 几何变换状态。`crop` 矩形在 flip+rotate **之后**的画布坐标系内表达（见 DESIGN §5.4.1）。 */
export interface TransformState {
  crop: Rect | null;
  rotate: 0 | 90 | 180 | 270;
  flipX: boolean;
  flipY: boolean;
}

/** 主题契约：宿主用这些键覆盖 `--vic-*` CSS 变量即可融入自身设计系统。 */
export interface StudioTheme {
  accent: string;
  bg: string;
  surface: string;
  elevated: string;
  text: string;
  textMuted: string;
  border: string;
  radius: string;
}

/** i18n 文案契约。宿主可整体或部分覆盖。 */
export interface StudioLocale {
  brush: string;
  rect: string;
  eraser: string;
  clear: string;
  crop: string;
  rotate: string;
  flip: string;
  flipHorizontal: string;
  flipVertical: string;
  applyCrop: string;
  cropFree: string;
  adjust: string;
  apply: string;
  cancel: string;
  reset: string;
  undo: string;
  redo: string;
  fit: string;
  brushSize: string;
  feather: string;
  brightness: string;
  contrast: string;
  saturation: string;
  maskHintEdit: string;
  maskHintKeep: string;
}

export interface EngineOptions {
  maskPolarity?: MaskPolarity;
  /** 蒙版边缘羽化像素，默认 0。⚠️ 当前为 no-op（导出未消费，见 DESIGN §5.6/L6）。 */
  feather?: number;
  /** ⚠️ 仅作用于 image；mask 恒导出无损 PNG（见 DESIGN §1）。quality 仅对 image/webp 有效。 */
  output?: { type?: OutputType; quality?: number };
  maxZoom?: number;
  minZoom?: number;
  /** 启用的工具集，决定哪些能力可用。默认 `['brush','eraser']`（与组件 props 默认同口径）。 */
  tools?: StudioTool[];
  /** 画笔初始粗细（图像像素），默认 40。仅作构造初值，运行期改用 `setBrush`。 */
  brushSize?: number;
  /** i18n 文案覆盖。当前由组件层 computed 浅合并 `DEFAULT_LOCALE` 消费，engine 透传备用。 */
  locale?: Partial<StudioLocale>;
}

/** 工作台产物：处理后原图 + 可选 mask（两者等大）。 */
export interface StudioResult {
  /** 处理后原图（几何 + 调整已烘焙）。 */
  image: Blob;
  /** inpaint mask（透明 alpha PNG）；无圈定时为 null。 */
  mask: Blob | null;
  /** 处理后真实像素宽高。image 与 mask 尺寸一致。 */
  width: number;
  height: number;
  hasMask: boolean;
  /** 蒙版覆盖比例 [0,1]。 */
  maskCoverage: number;
}

/** 轻量状态快照，随 `change` 事件下发，驱动宿主 UI（按钮禁用态等）。 */
export interface StudioStateBrief {
  tool: StudioTool;
  dirty: boolean;
  hasMask: boolean;
  maskCoverage: number;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  /** 当前几何变换快照（只读）。UI 据此显示旋转角度 / 翻转激活态。 */
  transform: TransformState;
  /** 当前调整值快照（只读）。UI 据此同步滑块（撤销/重做/重置后回填）。 */
  adjust: AdjustValues;
}

export interface EngineEvents {
  ready: () => void;
  change: (state: StudioStateBrief) => void;
  error: (err: Error) => void;
}

/** `<ImageStudio>` 通过 ref 暴露的命令式 API。宿主可 `useTemplateRef<ImageStudioExpose>(...)` 取得类型。 */
export interface ImageStudioExpose {
  exportResult(): Promise<StudioResult>;
  exportMask(): Promise<Blob | null>;
  undo(): void;
  redo(): void;
  reset(): void;
  clearMask(): void;
  setTool(tool: StudioTool): void;
  setBrush(opts: BrushOptions): void;
  /** 几何变换（L4）：对 `TransformState` 做 merge 覆盖（非增量）。crop 表达在 flip+rotate 后坐标系。 */
  applyTransform(patch: Partial<TransformState>): void;
  /** 顺时针/逆时针整步旋转 90°（增量，内部归一化到 {0,90,180,270}）。 */
  rotate(dir?: "cw" | "ccw"): void;
  /** 水平翻转（切换 flipX）。 */
  flipHorizontal(): void;
  /** 垂直翻转（切换 flipY）。 */
  flipVertical(): void;
  /** 设置裁剪比例档位（数字=宽高比，'free'=自由）。仅裁剪模式下即时重置默认框。 */
  setCropRatio(ratio: number | "free"): void;
  /** 应用当前裁剪草稿（合成进 transform.crop，走命令历史）。 */
  applyCrop(): void;
  /** 取消裁剪，丢弃草稿不改变 transform。 */
  cancelCrop(): void;
  /** 实时调整（亮度/对比度/饱和度，[-100,100]）。导出时烘焙进 image 像素；预览由组件 CSS filter 实现。 */
  setAdjust(a: Partial<AdjustValues>): void;
  /** 提交一次调整为可撤销命令（滑块释放时调，把上次提交→当前合为单步入历史）。 */
  commitAdjust(): void;
}

export const DEFAULT_CROP_RATIOS: (number | "free")[] = [1, 4 / 3, 3 / 4, 16 / 9, 9 / 16, "free"];

export const DEFAULT_LOCALE: StudioLocale = {
  brush: "画笔",
  rect: "框选",
  eraser: "橡皮",
  clear: "清除蒙版",
  crop: "裁剪",
  rotate: "旋转",
  flip: "翻转",
  flipHorizontal: "水平翻转",
  flipVertical: "垂直翻转",
  applyCrop: "应用裁剪",
  cropFree: "自由",
  adjust: "调整",
  apply: "应用",
  cancel: "取消",
  reset: "重置",
  undo: "撤销",
  redo: "重做",
  fit: "适应屏幕",
  brushSize: "画笔粗细",
  feather: "边缘羽化",
  brightness: "亮度",
  contrast: "对比度",
  saturation: "饱和度",
  maskHintEdit: "紫色：按提示词重绘",
  maskHintKeep: "紫色：保留区域",
};
