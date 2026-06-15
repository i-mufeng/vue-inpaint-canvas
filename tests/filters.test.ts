import { expect, test } from "vitest";
import { adjustToCssFilter } from "../src/core/filters";

test("0 调整 = 中性 filter", () => {
  expect(adjustToCssFilter({ brightness: 0, contrast: 0, saturate: 0 })).toBe(
    "brightness(1) contrast(1) saturate(1)",
  );
});

test("满值映射正确（亮度 +100 / 对比 -100 / 饱和 +50）", () => {
  expect(adjustToCssFilter({ brightness: 100, contrast: -100, saturate: 50 })).toBe(
    "brightness(2) contrast(0) saturate(1.5)",
  );
});
