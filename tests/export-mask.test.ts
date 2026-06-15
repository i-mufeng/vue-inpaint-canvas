// mask 导出命脉护栏（DESIGN §9 P0，红线①）。
// 制造涂抹用「反射注入 maskLayer 节点」为首选（导出断言只看 maskLayer 像素，与制造方式无关，
// 绕开 jsdom 指针不确定性）；rect 工具单独用私有方法驱动以验证 T6 真实代码路径。
// 读回像素用 node-canvas 直接解码导出的 PNG Blob（T8 已冒烟验证链路通）。
import { createCanvas, loadImage } from "canvas";
import Konva from "konva";
import { afterEach, expect, test } from "vitest";
import { StudioEngine } from "../src/core/engine";
import type { EngineOptions } from "../src/core/types";

const PAINT = "rgba(124, 92, 255, 0.55)"; // 与 engine PAINT_COLOR 同值，rasterize 后 alpha≈140>阈值
const SIZE = 512;

const hosts: HTMLElement[] = [];

afterEach(() => {
  for (const h of hosts) h.remove();
  hosts.length = 0;
});

async function setup(opts?: EngineOptions): Promise<StudioEngine> {
  const src = document.createElement("canvas");
  src.width = SIZE;
  src.height = SIZE;
  const sctx = src.getContext("2d")!;
  sctx.fillStyle = "#888";
  sctx.fillRect(0, 0, SIZE, SIZE);
  const host = document.createElement("div");
  document.body.appendChild(host);
  hosts.push(host);
  const engine = new StudioEngine(host, opts);
  await engine.loadSource(src);
  return engine;
}

function maskLayerOf(engine: StudioEngine): Konva.Layer {
  return (engine as unknown as { maskLayer: Konva.Layer }).maskLayer;
}

/** 反射注入一个已涂矩形（与画笔同语义：fill + source-over）。 */
function injectRect(engine: StudioEngine, x: number, y: number, w: number, h: number, fill = PAINT): void {
  const layer = maskLayerOf(engine);
  layer.add(new Konva.Rect({ x, y, width: w, height: h, fill, globalCompositeOperation: "source-over" }));
  layer.draw();
}

/** 解码 PNG Blob 为像素（node-canvas），返回读 alpha 的取值器与尺寸。 */
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

test("paint-to-edit（默认）：涂抹区中心 alpha=0，保留区角落 alpha=255", async () => {
  const engine = await setup();
  injectRect(engine, 156, 156, 200, 200); // 居中 200×200
  const mask = await engine.exportMask();
  expect(mask).not.toBeNull();
  const { alphaAt } = await decode(mask!);
  expect(alphaAt(256, 256)).toBe(0); // 涂抹区中心 → 透明 = 要重绘
  expect(alphaAt(4, 4)).toBe(255); // 保留区角落 → 不透明 = 保留
});

test("paint-to-keep：极性反转，涂抹区中心 alpha=255、角落 alpha=0", async () => {
  const engine = await setup({ maskPolarity: "paint-to-keep" });
  injectRect(engine, 156, 156, 200, 200);
  const { alphaAt } = await decode((await engine.exportMask())!);
  expect(alphaAt(256, 256)).toBe(255);
  expect(alphaAt(4, 4)).toBe(0);
});

test("mask 尺寸 = 图像尺寸（非显示尺寸）", async () => {
  const engine = await setup();
  injectRect(engine, 100, 100, 50, 50);
  const { width, height } = await decode((await engine.exportMask())!);
  expect(width).toBe(SIZE);
  expect(height).toBe(SIZE);
});

test("空 mask → null，且 exportResult 反映 hasMask=false / coverage=0", async () => {
  const engine = await setup();
  expect(await engine.exportMask()).toBeNull();
  const r = await engine.exportResult();
  expect(r.mask).toBeNull();
  expect(r.hasMask).toBe(false);
  expect(r.maskCoverage).toBe(0);
});

test("覆盖率 ≈ 涂抹面积比例（带容差）", async () => {
  const engine = await setup();
  injectRect(engine, 100, 100, 200, 200); // 40000 / 262144 ≈ 0.1526
  const r = await engine.exportResult();
  expect(r.maskCoverage).toBeCloseTo(40000 / (SIZE * SIZE), 2);
});

test("阈值边界：alpha≤10 的弱涂抹不计入涂抹区", async () => {
  const engine = await setup();
  injectRect(engine, 156, 156, 200, 200, "rgba(124,92,255,0.02)"); // alpha≈5 ≤ 10
  const { alphaAt } = await decode((await engine.exportMask())!);
  expect(alphaAt(256, 256)).toBe(255); // 弱涂抹被滤除 → 视为保留
  expect((await engine.exportResult()).maskCoverage).toBe(0);
});

test("二值化稳定：圆头笔触导出后 alpha 仅 {0,255}", async () => {
  const engine = await setup();
  // 斜线 + 圆头，边缘必有抗锯齿
  maskLayerOf(engine).add(
    new Konva.Line({
      points: [80, 80, 420, 300],
      stroke: PAINT,
      strokeWidth: 50,
      lineCap: "round",
      lineJoin: "round",
      globalCompositeOperation: "source-over",
    }),
  );
  maskLayerOf(engine).draw();
  const buf = Buffer.from(await (await engine.exportMask())!.arrayBuffer());
  const img = await loadImage(buf);
  const cv = createCanvas(img.width, img.height);
  cv.getContext("2d").drawImage(img, 0, 0);
  const data = cv.getContext("2d").getImageData(0, 0, img.width, img.height).data;
  const alphas = new Set<number>();
  for (let i = 3; i < data.length; i += 4) alphas.add(data[i]!);
  expect([...alphas].sort((a, b) => a - b)).toEqual([0, 255]);
});

test("output.type=webp 不污染 mask：mask 恒 image/png", async () => {
  const engine = await setup({ output: { type: "image/webp", quality: 0.5 } });
  injectRect(engine, 100, 100, 100, 100);
  const mask = await engine.exportMask();
  expect(mask!.type).toBe("image/png");
});

test("rect 框选工具：框选区计入覆盖率并纳入撤销栈", async () => {
  const engine = await setup({ tools: ["brush", "eraser", "rect"] });
  const e = engine as unknown as {
    setTool: (t: string) => void;
    startRect: (p: { x: number; y: number }) => void;
    updateRect: (p: { x: number; y: number }) => void;
    onUp: () => void;
  };
  e.setTool("rect");
  e.startRect({ x: 150, y: 150 });
  e.updateRect({ x: 350, y: 350 }); // 200×200
  e.onUp(); // commit
  const r = await engine.exportResult();
  expect(r.hasMask).toBe(true);
  expect(r.maskCoverage).toBeCloseTo(40000 / (SIZE * SIZE), 2);
  const { alphaAt } = await decode(r.mask!);
  expect(alphaAt(250, 250)).toBe(0); // 框选区中心 → 要重绘
  engine.undo();
  expect((await engine.exportMask())).toBeNull(); // 撤销后清空
});

test("跨域污染导出：error 事件只 emit 一次（exportResult 单路径）", async () => {
  const engine = await setup();
  injectRect(engine, 100, 100, 100, 100);
  // 强制 maskLayer.toCanvas 抛错，模拟跨域污染 SecurityError。
  maskLayerOf(engine).toCanvas = () => {
    throw new Error("tainted canvas");
  };
  let count = 0;
  engine.on("error", () => count++);
  await expect(engine.exportResult()).rejects.toThrow("tainted");
  expect(count).toBe(1);
});
