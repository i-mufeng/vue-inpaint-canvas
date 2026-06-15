// Vue 包入口（默认入口）。
import ImageStudio from "./ImageStudio.vue";

export { ImageStudio };
export { adjustToCssFilter, DEFAULT_CROP_RATIOS, DEFAULT_LOCALE, StudioEngine } from "../core";
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
} from "../core/types";
