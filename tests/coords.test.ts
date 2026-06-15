import { describe, expect, test } from "vitest";
import { type CoordsContext, toDisplaySpace, toImageSpace, transformedSize } from "../src/core/coords";
import type { Point, TransformState } from "../src/core/types";

// 非正方形画幅，确保 rotate 90/270 的 W/H 互换被真正考验。
const W = 400;
const H = 200;
const IDENTITY: TransformState = { crop: null, rotate: 0, flipX: false, flipY: false };

function ctx(partial: Partial<CoordsContext> = {}): CoordsContext {
  return { transform: IDENTITY, zoom: 1, pan: { x: 0, y: 0 }, imageW: W, imageH: H, ...partial };
}

function approx(a: Point, b: Point, digits = 9): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
}

describe("identity", () => {
  test("identity 下两向均为恒等", () => {
    const c = ctx();
    const p = { x: 137, y: 42 };
    approx(toImageSpace(p, c), p);
    approx(toDisplaySpace(p, c), p);
  });
});

describe("zoom / pan（identity transform）", () => {
  const c = ctx({ zoom: 2, pan: { x: 10, y: 20 } });
  test("toDisplaySpace = p*zoom + pan", () => {
    approx(toDisplaySpace({ x: 30, y: 40 }, c), { x: 70, y: 100 });
  });
  test("toImageSpace 为其逆", () => {
    approx(toImageSpace({ x: 70, y: 100 }, c), { x: 30, y: 40 });
  });
});

describe("flip 角点映射", () => {
  test("flipX：左上→右上、右下→左下", () => {
    const c = ctx({ transform: { ...IDENTITY, flipX: true } });
    approx(toDisplaySpace({ x: 0, y: 0 }, c), { x: W, y: 0 });
    approx(toDisplaySpace({ x: W, y: H }, c), { x: 0, y: H });
  });
  test("flipY：左上→左下", () => {
    const c = ctx({ transform: { ...IDENTITY, flipY: true } });
    approx(toDisplaySpace({ x: 0, y: 0 }, c), { x: 0, y: H });
  });
});

describe("rotate 画幅与角点", () => {
  test("90：画幅 W/H 互换，左上→(H,0)", () => {
    expect(transformedSize(W, H, { ...IDENTITY, rotate: 90 })).toEqual({ width: H, height: W });
    const c = ctx({ transform: { ...IDENTITY, rotate: 90 } });
    approx(toDisplaySpace({ x: 0, y: 0 }, c), { x: H, y: 0 });
  });
  test("180：画幅不变，左上→(W,H)", () => {
    expect(transformedSize(W, H, { ...IDENTITY, rotate: 180 })).toEqual({ width: W, height: H });
    const c = ctx({ transform: { ...IDENTITY, rotate: 180 } });
    approx(toDisplaySpace({ x: 0, y: 0 }, c), { x: W, y: H });
  });
  test("270：画幅互换，左上→(0,W)", () => {
    expect(transformedSize(W, H, { ...IDENTITY, rotate: 270 })).toEqual({ width: H, height: W });
    const c = ctx({ transform: { ...IDENTITY, rotate: 270 } });
    approx(toDisplaySpace({ x: 0, y: 0 }, c), { x: 0, y: W });
  });
});

describe("crop 基准（表达在 flip+rotate 后坐标系）", () => {
  const crop = { x: 50, y: 30, width: 100, height: 80 };
  const c = ctx({ transform: { ...IDENTITY, crop } });
  test("transformedSize = crop 尺寸", () => {
    expect(transformedSize(W, H, { ...IDENTITY, crop })).toEqual({ width: 100, height: 80 });
  });
  test("crop 内一点显示坐标相对 crop 原点平移", () => {
    approx(toDisplaySpace({ x: 60, y: 40 }, c), { x: 10, y: 10 });
    approx(toImageSpace({ x: 10, y: 10 }, c), { x: 60, y: 40 });
  });
});

describe("往返一致：transform × zoom × pan 全组合", () => {
  const rotates: TransformState["rotate"][] = [0, 90, 180, 270];
  const bools = [false, true];
  const zooms = [0.5, 1, 2];
  const pans: Point[] = [
    { x: 0, y: 0 },
    { x: 13, y: -7 },
  ];
  const crops = [null, { x: 20, y: 10, width: 120, height: 90 }];
  const probes: Point[] = [
    { x: 0, y: 0 },
    { x: W, y: H },
    { x: 137, y: 42 },
    { x: 399.5, y: 0.5 },
  ];

  for (const rotate of rotates) {
    for (const flipX of bools) {
      for (const flipY of bools) {
        for (const crop of crops) {
          for (const zoom of zooms) {
            for (const pan of pans) {
              const c = ctx({ transform: { crop, rotate, flipX, flipY }, zoom, pan });
              const label = `rotate=${rotate} flipX=${flipX} flipY=${flipY} crop=${crop ? "y" : "n"} zoom=${zoom} pan=${pan.x},${pan.y}`;
              test(`toDisplaySpace∘toImageSpace ≈ id · ${label}`, () => {
                for (const p of probes) {
                  approx(toImageSpace(toDisplaySpace(p, c), c), p, 6);
                }
              });
            }
          }
        }
      }
    }
  }
});

describe("组合 flipX + rotate90 + crop 链式往返", () => {
  test("严格互逆（顺序 flip→rotate→crop 的逆 crop→rotate→flip）", () => {
    const c = ctx({
      transform: { crop: { x: 15, y: 25, width: 100, height: 120 }, rotate: 90, flipX: true, flipY: false },
      zoom: 1.5,
      pan: { x: 8, y: -4 },
    });
    for (const p of [{ x: 100, y: 50 }, { x: 0, y: 0 }, { x: 250, y: 175 }]) {
      approx(toImageSpace(toDisplaySpace(p, c), c), p, 6);
    }
  });
});
