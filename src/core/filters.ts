import type { AdjustValues } from "./types";

/**
 * 把 [-100, 100] 的调整值映射为 CSS filter 串（0 为中性）。
 * 预览阶段套到容器 style.filter；导出阶段用 ctx.filter 烘焙进像素。
 */
export function adjustToCssFilter(a: AdjustValues): string {
  return `brightness(${1 + a.brightness / 100}) contrast(${1 + a.contrast / 100}) saturate(${1 + a.saturate / 100})`;
}
