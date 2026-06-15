// L4 几何联动护栏（DESIGN §9 P2，红线4/红线6）。
// 方案 A（矢量）：mask 节点 points 存源图坐标恒不动，几何由三层 layer transform 表达。
// 本测真实像素地实证三件事：①导出尺寸=变换后画幅；②涂抹区随变换对齐到 coords.toDisplaySpace 预测位置；
// ③image/mask/result 三者等大；并覆盖 undo/redo 还原画幅、命令同栈逆序、clearMask 分类滤除。
// 同时它是"Konva layer transform 被 toCanvas 正确渲染"这一实现前提的实证 de-risk。
import { createCanvas, loadImage } from "canvas";
import Konva from "konva";
import { afterEach, expect, test, vi } from "vitest";
import { toDisplaySpace } from "../src/core/coords";
import { StudioEngine } from "../src/core/engine";
import type { Rect, TransformState } from "../src/core/types";

const PAINT = "rgba(124, 92, 255, 0.55)"; // 与 engine PAINT_COLOR 同值，rasterize 后 alpha>阈值
const hosts: HTMLElement[] = [];

afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
});

// 非方源图（400×200）：让 rotate 90/270 的 W/H 互换与非对称坐标被真正考验。
async function setup(w = 400, h = 200): Promise<StudioEngine> {
  const src = document.createElement("canvas");
  src.width = w;
  src.height = h;
  const sctx = src.getContext("2d")!;
  sctx.fillStyle = "#888";
  sctx.fillRect(0, 0, w, h);
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const engine = new StudioEngine(host, { tools: ["brush", "eraser", "rect", "crop", "rotate", "flip"] });
  await engine.loadSource(src);
  return engine;
}

function maskLayerOf(engine: StudioEngine): Konva.Layer {
  return (engine as unknown as { maskLayer: Konva.Layer }).maskLayer;
}

/** 反射注入一个已涂矩形（源图坐标系，与画笔同语义 fill+source-over）。 */
function injectRect(engine: StudioEngine, x: number, y: number, w: number, h: number): void {
  const layer = maskLayerOf(engine);
  layer.add(new Konva.Rect({ x, y, width: w, height: h, fill: PAINT, globalCompositeOperation: "source-over" }));
  layer.draw();
}

async function decode(blob: Blob): Promise<{ alphaAt: (x: number, y: number) => number; width: number; height: number }> {
  const buf = Buffer.from(await blob.arrayBuffer());
  const img = await loadImage(buf);
  const cv = createCanvas(img.width, img.height);
  const ctx = cv.getContext("2d");
  ctx.drawImage(img, 0, 0);
  const data = ctx.getImageData(0, 0, img.width, img.height).data;
  return {
    width: img.width,
    height: img.height,
    alphaAt: (x, y) => data[(y * img.width + x) * 4 + 3]!,
  };
}

/** 源图坐标 → 导出 mask 像素坐标（zoom=1/pan=0，ctx.imageW/H 取源图尺寸——与 engine 内部口径一致）。 */
function displayOf(p: { x: number; y: number }, t: TransformState, srcW: number, srcH: number): { x: number; y: number } {
  return toDisplaySpace(p, { transform: t, zoom: 1, pan: { x: 0, y: 0 }, imageW: srcW, imageH: srcH });
}
const T = (rotate: TransformState["rotate"], flipX = false, flipY = false, crop: TransformState["crop"] = null): TransformState => ({
  crop,
  rotate,
  flipX,
  flipY,
});

// ---- 画幅 + 三者等大 --------------------------------------------------------

test("rotate cw 90：导出尺寸 H×W，image/mask/result 三者等大（红线4）", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 100, 50, 80, 60);
  engine.rotate("cw");
  const r = await engine.exportResult();
  expect(r.width).toBe(200);
  expect(r.height).toBe(400);
  const img = await decode(r.image);
  const msk = await decode(r.mask!);
  expect([img.width, img.height]).toEqual([200, 400]);
  expect([msk.width, msk.height]).toEqual([200, 400]);
  expect(img.width).toBe(msk.width); // image.width === mask.width === result.width
  expect(img.height).toBe(msk.height);
});

test("rotate 180：画幅不变（W×H）", async () => {
  const engine = await setup(400, 200);
  engine.applyTransform({ rotate: 180 });
  const r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([400, 200]);
});

// ---- 涂抹区随变换对齐（mask 坐标联动核心） ----------------------------------

test("rotate cw 90：涂抹区对齐到 toDisplaySpace 预测位置，远处保留", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 100, 50, 80, 60); // 源中心 (140,80)
  engine.rotate("cw");
  const c = displayOf({ x: 140, y: 80 }, T(90), 400, 200); // 预测 (200-80,140)=(120,140)
  const { alphaAt } = await decode((await engine.exportMask())!);
  expect(alphaAt(Math.round(c.x), Math.round(c.y))).toBe(0); // 涂抹区 → 透明=要重绘
  expect(alphaAt(5, 5)).toBe(255); // 远离涂抹区 → 保留
});

test("rotate ccw 90（=270）：画幅 H×W，角点对齐", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 0, 0, 40, 40); // 源左上，中心 (20,20)
  engine.rotate("ccw");
  const r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([200, 400]);
  const c = displayOf({ x: 20, y: 20 }, T(270), 400, 200); // rotate270:(y,w-x)=(20,380)
  const { alphaAt } = await decode(r.mask!);
  expect(alphaAt(Math.round(c.x), Math.round(c.y))).toBe(0);
});

test("flipHorizontal：尺寸不变，涂抹区水平镜像", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 20, 80, 60, 40); // 源左侧，中心 (50,100)
  engine.flipHorizontal();
  const r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([400, 200]);
  const c = displayOf({ x: 50, y: 100 }, T(0, true), 400, 200); // (400-50,100)=(350,100)
  const { alphaAt } = await decode(r.mask!);
  expect(alphaAt(Math.round(c.x), Math.round(c.y))).toBe(0);
  expect(alphaAt(50, 100)).toBe(255); // 原位置镜像后已非涂抹区
});

test("flipVertical：涂抹区垂直镜像", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 180, 20, 40, 40); // 中心 (200,40)
  engine.flipVertical();
  const c = displayOf({ x: 200, y: 40 }, T(0, false, true), 400, 200); // (200,200-40)=(200,160)
  const { alphaAt } = await decode((await engine.exportMask())!);
  expect(alphaAt(Math.round(c.x), Math.round(c.y))).toBe(0);
  expect(alphaAt(200, 40)).toBe(255);
});

// ---- 裁剪 -------------------------------------------------------------------

test("crop：导出尺寸=裁剪尺寸，区内涂抹按裁剪原点平移、区外保留", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 100, 50, 60, 40); // 源 (100,50)-(160,90)，落在裁剪区左上
  engine.applyTransform({ crop: { x: 100, y: 50, width: 120, height: 80 } });
  const r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([120, 80]);
  const { alphaAt, width, height } = await decode(r.mask!);
  expect([width, height]).toEqual([120, 80]);
  expect(alphaAt(10, 10)).toBe(0); // 裁剪后 (10,10) ← 源 (110,60) 涂抹区
  expect(alphaAt(110, 70)).toBe(255); // 裁剪区右下 ← 源未涂 → 保留
});

test("组合 flipX + rotate cw + crop：导出尺寸=裁剪尺寸且 image/mask 一致", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 0, 0, 400, 200); // 全涂，确保裁剪区内有涂抹
  engine.flipHorizontal();
  engine.rotate("cw"); // 画幅 → 200×400，裁剪在该坐标系
  engine.applyTransform({ crop: { x: 20, y: 30, width: 100, height: 150 } });
  const r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([100, 150]);
  const img = await decode(r.image);
  const msk = await decode(r.mask!);
  expect([img.width, img.height]).toEqual([100, 150]);
  expect([msk.width, msk.height]).toEqual([100, 150]);
});

// ---- 撤销 / 重做 / 命令同栈 -------------------------------------------------

test("undo 几何：还原画幅回源图，且 mask 节点不被破坏（方案 A）", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 50, 50, 40, 40); // 源中心 (70,70)
  engine.rotate("cw");
  expect((await engine.exportResult()).width).toBe(200);
  engine.undo(); // 撤销旋转
  const r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([400, 200]);
  const { alphaAt } = await decode(r.mask!);
  expect(alphaAt(70, 70)).toBe(0); // 涂抹随变换还原，仍在源位置
});

test("redo 几何：重做恢复变换画幅", async () => {
  const engine = await setup(400, 200);
  engine.rotate("cw");
  engine.undo();
  engine.redo();
  expect((await engine.exportResult()).width).toBe(200);
});

test("几何与 mask 命令同栈：撤销按操作逆序", async () => {
  const engine = await setup(400, 200);
  const e = engine as unknown as {
    setTool: (t: string) => void;
    startRect: (p: { x: number; y: number }) => void;
    updateRect: (p: { x: number; y: number }) => void;
    onUp: () => void;
  };
  e.setTool("rect");
  e.startRect({ x: 50, y: 50 });
  e.updateRect({ x: 150, y: 150 });
  e.onUp(); // mask 命令
  engine.rotate("cw"); // geom 命令
  expect(engine.getState().canUndo).toBe(true);
  expect(engine.getState().transform.rotate).toBe(90);
  engine.undo(); // 撤销 rotate
  expect(engine.getState().transform.rotate).toBe(0);
  expect(engine.getState().hasMask).toBe(true); // mask 还在
  engine.undo(); // 撤销 mask
  expect(engine.getState().hasMask).toBe(false);
});

test("clearMask 滤除 mask 命令但保留几何命令撤销", async () => {
  const engine = await setup(400, 200);
  const e = engine as unknown as {
    setTool: (t: string) => void;
    startRect: (p: { x: number; y: number }) => void;
    updateRect: (p: { x: number; y: number }) => void;
    onUp: () => void;
  };
  e.setTool("rect");
  e.startRect({ x: 50, y: 50 });
  e.updateRect({ x: 150, y: 150 });
  e.onUp(); // mask 命令
  engine.rotate("cw"); // geom 命令
  engine.clearMask();
  expect(engine.getState().hasMask).toBe(false);
  expect(engine.getState().transform.rotate).toBe(90); // 几何未受影响
  engine.undo();
  expect(engine.getState().transform.rotate).toBe(0); // 几何可撤销
  engine.undo(); // mask 命令已被滤除 → 无操作，不抛
  expect(engine.getState().transform.rotate).toBe(0);
});

test("reset：清蒙版 + 还原几何画幅 + 清空历史", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 50, 50, 40, 40);
  engine.flipHorizontal();
  engine.rotate("cw");
  engine.reset();
  const s = engine.getState();
  expect(s.transform).toEqual(T(0));
  expect(s.canUndo).toBe(false);
  expect(s.hasMask).toBe(false);
  expect((await engine.exportResult()).width).toBe(400); // 画幅回源图
});

test("applyTransform 去抖：合并无变化不入命令栈", async () => {
  const engine = await setup(400, 200);
  engine.applyTransform({ rotate: 0 }); // 与初始一致
  expect(engine.getState().canUndo).toBe(false);
  engine.flipHorizontal();
  engine.applyTransform({ flipX: true }); // 与当前一致
  expect(engine.getState().canUndo).toBe(true); // 只有 flipHorizontal 那一次入栈
  engine.undo();
  expect(engine.getState().canUndo).toBe(false);
});

// ---- 交互式裁剪（L4c） ------------------------------------------------------

interface CropInternals {
  cropDraft: Rect | null;
  setCropRatio: (r: number | "free") => void;
  applyCrop: () => void;
  cancelCrop: () => void;
}
const cropOf = (engine: StudioEngine): CropInternals => engine as unknown as CropInternals;

test("crop 模式：默认草稿 = 全画幅（自由比例）", async () => {
  const engine = await setup(400, 200);
  engine.setTool("crop");
  expect(cropOf(engine).cropDraft).toEqual({ x: 0, y: 0, width: 400, height: 200 });
});

test("setCropRatio 1:1 → 居中最大内接方框（非方画幅取短边）", async () => {
  const engine = await setup(400, 200);
  engine.setTool("crop");
  cropOf(engine).setCropRatio(1);
  expect(cropOf(engine).cropDraft).toEqual({ x: 100, y: 0, width: 200, height: 200 });
});

test("applyCrop：草稿应用为 transform.crop，导出尺寸=草稿，撤销还原", async () => {
  const engine = await setup(400, 200);
  engine.setTool("crop");
  const e = cropOf(engine);
  e.cropDraft = { x: 50, y: 30, width: 120, height: 80 };
  e.applyCrop();
  let r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([120, 80]);
  expect(engine.getState().transform.crop).toEqual({ x: 50, y: 30, width: 120, height: 80 });
  engine.undo();
  r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([400, 200]);
  expect(engine.getState().transform.crop).toBeNull();
});

test("二次裁剪：与已有 crop 原点合成（非替换）", async () => {
  const engine = await setup(400, 200);
  engine.setTool("crop");
  const e = cropOf(engine);
  e.cropDraft = { x: 50, y: 30, width: 200, height: 120 };
  e.applyCrop(); // crop1，画幅 → 200×120
  engine.setTool("crop");
  e.cropDraft = { x: 10, y: 10, width: 80, height: 60 }; // 裁剪后空间内再选
  e.applyCrop();
  expect(engine.getState().transform.crop).toEqual({ x: 60, y: 40, width: 80, height: 60 }); // (50+10,30+10)
  const r = await engine.exportResult();
  expect([r.width, r.height]).toEqual([80, 60]);
});

test("cancelCrop：不改变 transform，退出覆盖层", async () => {
  const engine = await setup(400, 200);
  engine.setTool("crop");
  const e = cropOf(engine);
  e.cropDraft = { x: 50, y: 30, width: 120, height: 80 };
  e.cancelCrop();
  expect(engine.getState().transform.crop).toBeNull();
  expect(e.cropDraft).toBeNull();
});

test("applyCrop 与 mask 联动：裁剪后涂抹区按裁剪原点平移", async () => {
  const engine = await setup(400, 200);
  injectRect(engine, 60, 40, 40, 40); // 源 (60,40)-(100,80)，中心 (80,60)
  engine.setTool("crop");
  const e = cropOf(engine);
  e.cropDraft = { x: 50, y: 30, width: 120, height: 80 };
  e.applyCrop();
  const { alphaAt } = await decode((await engine.exportMask())!);
  expect(alphaAt(30, 30)).toBe(0); // 源(80,60) → 裁剪后 (30,30) 仍是涂抹区
});

test("applyCrop 误操作守卫：草稿过小不应用", async () => {
  const engine = await setup(400, 200);
  engine.setTool("crop");
  const e = cropOf(engine);
  e.cropDraft = { x: 10, y: 10, width: 4, height: 4 }; // < CROP_MIN_SIZE
  e.applyCrop();
  expect(engine.getState().transform.crop).toBeNull(); // 未应用
});

test("applyCrop 越界守卫：合成草稿超出源画幅被 clamp 回界内", async () => {
  const engine = await setup(400, 200);
  engine.setTool("crop");
  const e = cropOf(engine);
  e.cropDraft = { x: 350, y: 150, width: 300, height: 300 }; // 远超 400×200
  e.applyCrop();
  const crop = engine.getState().transform.crop!;
  expect(crop.x).toBeGreaterThanOrEqual(0);
  expect(crop.y).toBeGreaterThanOrEqual(0);
  expect(crop.x + crop.width).toBeLessThanOrEqual(400);
  expect(crop.y + crop.height).toBeLessThanOrEqual(200);
  const r = await engine.exportResult();
  expect(r.width).toBeLessThanOrEqual(400);
  expect(r.height).toBeLessThanOrEqual(200);
});

// ---- 鲁棒性回归（对抗审查 M1/m7） ------------------------------------------

test("clearMask 销毁已撤销的 mask 节点（防泄漏，M1）", async () => {
  const engine = await setup(400, 200);
  const e = engine as unknown as {
    setTool: (t: string) => void;
    startRect: (p: { x: number; y: number }) => void;
    updateRect: (p: { x: number; y: number }) => void;
    onUp: () => void;
    currentRect: Konva.Rect | null;
  };
  e.setTool("rect");
  e.startRect({ x: 50, y: 50 });
  e.updateRect({ x: 150, y: 150 });
  const node = e.currentRect!; // 提交前捕获节点
  const spy = vi.spyOn(node, "destroy");
  e.onUp(); // 提交为 mask 命令
  engine.undo(); // 节点摘除，仅存于 redoStack 命令闭包
  engine.clearMask(); // 应 dispose → 销毁该已撤销节点
  expect(spy).toHaveBeenCalled();
  expect(engine.getState().canRedo).toBe(false); // mask 命令已清出
});

test("destroy 后调用几何/导出安全 no-op（不触碰已销毁 stage，m7）", async () => {
  const engine = await setup(400, 200);
  engine.destroy();
  expect(() => engine.rotate("cw")).not.toThrow();
  expect(() => engine.flipHorizontal()).not.toThrow();
  expect(() => engine.applyTransform({ rotate: 90 })).not.toThrow();
  await expect(engine.exportMask()).resolves.toBeNull();
});

// ---- 调整命令（L5b） --------------------------------------------------------
// 注：亮度/对比度/饱和度的「像素烘焙」用 `ctx.filter`，node-canvas 不支持该属性（静默忽略），
// 故烘焙正确性走浏览器实操回归（见会话记录），此处仅测命令/状态/撤销语义（不依赖 filter 渲染）。

test("commitAdjust：作为命令可撤销/重做，getState().adjust 反映", async () => {
  const engine = await setup(64, 64);
  engine.setAdjust({ brightness: 50 });
  engine.commitAdjust();
  expect(engine.getState().adjust.brightness).toBe(50);
  expect(engine.getState().canUndo).toBe(true);
  engine.undo();
  expect(engine.getState().adjust.brightness).toBe(0);
  engine.redo();
  expect(engine.getState().adjust.brightness).toBe(50);
});

test("commitAdjust 去抖 + clearMask 不影响调整命令", async () => {
  const engine = await setup(64, 64);
  engine.commitAdjust(); // 与初始一致 → 不入栈
  expect(engine.getState().canUndo).toBe(false);
  engine.setAdjust({ contrast: 30 });
  engine.commitAdjust();
  injectRect(engine, 10, 10, 20, 20); // 直接入 maskLayer
  engine.clearMask(); // 仅清 mask 命令，adjust（kind!=='mask'）保留
  expect(engine.getState().adjust.contrast).toBe(30);
  expect(engine.getState().canUndo).toBe(true);
});

test("reset 清空调整：adjust 归零且不可撤销", async () => {
  const engine = await setup(64, 64);
  engine.setAdjust({ brightness: 60, saturate: -30 });
  engine.commitAdjust();
  engine.reset();
  expect(engine.getState().adjust).toEqual({ brightness: 0, contrast: 0, saturate: 0 });
  expect(engine.getState().canUndo).toBe(false);
});
