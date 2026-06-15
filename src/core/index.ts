// 框架无关核心入口。非 Vue 消费者可 `import { StudioEngine } from "vue-inpaint-canvas/core"`。
export { StudioEngine } from "./engine";
export { adjustToCssFilter } from "./filters";
export { toDisplaySpace, toImageSpace, transformedSize } from "./coords";
export type { CoordsContext } from "./coords";
export { DEFAULT_CROP_RATIOS, DEFAULT_LOCALE } from "./types";
export type {
  AdjustValues,
  BrushOptions,
  EngineEvents,
  EngineOptions,
  ImageStudioExpose,
  MaskPolarity,
  OutputType,
  Point,
  Rect,
  SourceInput,
  StudioLocale,
  StudioResult,
  StudioStateBrief,
  StudioTheme,
  StudioTool,
  TransformState,
} from "./types";
