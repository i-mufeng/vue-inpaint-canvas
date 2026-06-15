// 显示坐标 ↔ 图像坐标互转（DESIGN §5.4.3）。
//
// 纯数学，不依赖 DOM / Konva / 指针 —— 可被单测往返断言，是 L4 几何的硬前置护栏（红线6）。
// 本期（L2）transform 恒为 identity、zoom=1、pan=0，函数尚不被 engine 调用，但 rotate/flip/crop
// 数学一并写齐并测透，待 L4 applyTransform 接入交互时直接复用。
//
// 变换链路（图像 → 显示）：flip → rotate → crop → zoom/pan。
// 应用顺序绝对（非增量）：rotate∈{0,90,180,270} 为绝对角度，flipX/Y 为绝对布尔，crop 表达在
// flip+rotate 之后的画布坐标系内（见 §5.4.1）。toImageSpace 是 toDisplaySpace 的严格逆。

import type { Point, TransformState } from "./types";

export interface CoordsContext {
  transform: TransformState;
  /** 显示缩放（stage scale）。 */
  zoom: number;
  /** 显示平移（stage position）。 */
  pan: Point;
  /** 原始源图像素宽高（变换前）。flip/rotate 的镜像与画幅互换都以此为基准。 */
  imageW: number;
  imageH: number;
}

/** flip 在原图坐标系内做镜像（W×H 不变）；自逆。 */
function flip(p: Point, w: number, h: number, flipX: boolean, flipY: boolean): Point {
  return { x: flipX ? w - p.x : p.x, y: flipY ? h - p.y : p.y };
}

/** 正向旋转：原图(W×H) → 旋转后画布。90/270 令画幅 W/H 互换。90° 整步用整数映射，无三角浮点噪声。 */
function rotateFwd(p: Point, rotate: number, w: number, h: number): Point {
  switch (rotate) {
    case 90:
      return { x: h - p.y, y: p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: p.y, y: w - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/** 逆向旋转：旋转后画布 → 原图(W×H)。w/h 为原图尺寸。 */
function rotateInv(p: Point, rotate: number, w: number, h: number): Point {
  switch (rotate) {
    case 90:
      return { x: p.y, y: h - p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: w - p.y, y: p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

/** 图像坐标 → 显示坐标。链路：flip → rotate → crop → zoom/pan。 */
export function toDisplaySpace(p: Point, ctx: CoordsContext): Point {
  const { transform: t, imageW: w, imageH: h, zoom, pan } = ctx;
  let q = flip(p, w, h, t.flipX, t.flipY);
  q = rotateFwd(q, t.rotate, w, h);
  if (t.crop) q = { x: q.x - t.crop.x, y: q.y - t.crop.y };
  return { x: q.x * zoom + pan.x, y: q.y * zoom + pan.y };
}

/** 显示坐标 → 图像坐标。toDisplaySpace 的严格逆：zoom/pan → crop → rotate → flip。 */
export function toImageSpace(p: Point, ctx: CoordsContext): Point {
  const { transform: t, imageW: w, imageH: h, zoom, pan } = ctx;
  let q: Point = { x: (p.x - pan.x) / zoom, y: (p.y - pan.y) / zoom };
  if (t.crop) q = { x: q.x + t.crop.x, y: q.y + t.crop.y };
  q = rotateInv(q, t.rotate, w, h);
  return flip(q, w, h, t.flipX, t.flipY);
}

/** 变换后画幅（导出尺寸真相源）：flip 不改尺寸 → rotate 90/270 令 W/H 互换 → crop 取裁剪尺寸。 */
export function transformedSize(
  w: number,
  h: number,
  t: TransformState,
): { width: number; height: number } {
  let width = w;
  let height = h;
  if (t.rotate === 90 || t.rotate === 270) {
    width = h;
    height = w;
  }
  if (t.crop) {
    width = t.crop.width;
    height = t.crop.height;
  }
  return { width, height };
}
