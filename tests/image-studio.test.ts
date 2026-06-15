// 组件桥接测试（DESIGN §9 P1，纯 jsdom 不触 canvas 像素）。
// mock StudioEngine 为 spy class：干净断言 props→engine 选项透传与 UI→engine 指令转发，
// 同时验证模板层 locale 合并 / tools 门控 / maskHint / a11y / cursor class / brushSize 接线。
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, expect, test, vi } from "vitest";
import { nextTick } from "vue";
import { DEFAULT_LOCALE } from "../src/core/types";

interface MockEngine {
  opts: Record<string, unknown>;
  loadSource: ReturnType<typeof vi.fn>;
  setTool: ReturnType<typeof vi.fn>;
  setBrush: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  redo: ReturnType<typeof vi.fn>;
  clearMask: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  applyTransform: ReturnType<typeof vi.fn>;
  rotate: ReturnType<typeof vi.fn>;
  flipHorizontal: ReturnType<typeof vi.fn>;
  flipVertical: ReturnType<typeof vi.fn>;
  setCropRatio: ReturnType<typeof vi.fn>;
  applyCrop: ReturnType<typeof vi.fn>;
  cancelCrop: ReturnType<typeof vi.fn>;
  setAdjust: ReturnType<typeof vi.fn>;
  commitAdjust: ReturnType<typeof vi.fn>;
  exportResult: ReturnType<typeof vi.fn>;
  exportMask: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}
const { instances } = vi.hoisted(() => ({ instances: [] as MockEngine[] }));

vi.mock("../src/core/engine", () => {
  class StudioEngine {
    opts: unknown;
    constructor(_el: unknown, opts: unknown) {
      this.opts = opts;
      Object.assign(this, {
        loadSource: vi.fn(async () => {}),
        setTool: vi.fn(),
        setBrush: vi.fn(),
        undo: vi.fn(),
        redo: vi.fn(),
        clearMask: vi.fn(),
        reset: vi.fn(),
        applyTransform: vi.fn(),
        rotate: vi.fn(),
        flipHorizontal: vi.fn(),
        flipVertical: vi.fn(),
        setCropRatio: vi.fn(),
        applyCrop: vi.fn(),
        cancelCrop: vi.fn(),
        setAdjust: vi.fn(),
        commitAdjust: vi.fn(),
        exportResult: vi.fn(async () => ({
          image: new Blob(),
          mask: null,
          width: 1,
          height: 1,
          hasMask: false,
          maskCoverage: 0,
        })),
        exportMask: vi.fn(async () => null),
        destroy: vi.fn(),
      });
      instances.push(this as unknown as MockEngine);
    }
    on() {
      return () => {};
    }
  }
  return { StudioEngine };
});

// 在 mock 之后导入，确保组件拿到 mock 后的 engine。
const { ImageStudio } = await import("../src/vue");

function makeSource(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 8;
  return c;
}

type StudioProps = Record<string, unknown>;

async function mountStudio(props: StudioProps = {}) {
  const wrapper = mount(ImageStudio, { props: { source: makeSource(), ...props } });
  await flushPromises();
  return wrapper;
}

function btnByText(wrapper: Awaited<ReturnType<typeof mountStudio>>, text: string) {
  return wrapper.findAll("button").find((b) => b.text() === text);
}

beforeEach(() => {
  instances.length = 0;
});

test("onMounted 实例化并透传选项 + 初始化 tool/brush", async () => {
  await mountStudio({ brushSize: 40 });
  expect(instances).toHaveLength(1);
  const eng = instances[0]!;
  const opts = eng.opts;
  expect(opts.maskPolarity).toBe("paint-to-edit");
  expect(opts.tools).toEqual(["brush", "eraser"]);
  expect(opts.brushSize).toBe(40);
  expect(opts.locale).toEqual({});
  expect(eng.loadSource).toHaveBeenCalledOnce();
  expect(eng.setTool).toHaveBeenCalledWith("brush");
  expect(eng.setBrush).toHaveBeenCalledWith({ size: 40 });
});

test("setTool 经点击转发到 engine", async () => {
  const w = await mountStudio();
  const eng = instances[0]!;
  eng.setTool.mockClear();
  await btnByText(w, DEFAULT_LOCALE.eraser)!.trigger("click");
  await nextTick();
  expect(eng.setTool).toHaveBeenCalledWith("eraser");
});

test("undo/redo/reset/clearMask 经 expose 转发", async () => {
  const w = await mountStudio();
  const eng = instances[0]!;
  const vm = w.vm as unknown as {
    undo: () => void;
    redo: () => void;
    reset: () => void;
    clearMask: () => void;
  };
  vm.undo();
  vm.redo();
  vm.reset();
  vm.clearMask();
  expect(eng.undo).toHaveBeenCalledOnce();
  expect(eng.redo).toHaveBeenCalledOnce();
  expect(eng.reset).toHaveBeenCalledOnce();
  expect(eng.clearMask).toHaveBeenCalledOnce();
});

test("locale 浅合并：覆盖键生效、缺省键回退默认", async () => {
  const w = await mountStudio({ locale: { brush: "Paint" } });
  expect(btnByText(w, "Paint")).toBeTruthy(); // 覆盖
  expect(btnByText(w, DEFAULT_LOCALE.eraser)).toBeTruthy(); // 回退中文默认
});

test("maskHint 随 maskPolarity 切换", async () => {
  const edit = await mountStudio({ maskPolarity: "paint-to-edit" });
  expect(edit.get(".vic-mask-hint").text()).toBe(DEFAULT_LOCALE.maskHintEdit);
  const keep = await mountStudio({ maskPolarity: "paint-to-keep" });
  expect(keep.get(".vic-mask-hint").text()).toBe(DEFAULT_LOCALE.maskHintKeep);
});

test("tools 门控：未启用工具不渲染按钮", async () => {
  const w = await mountStudio({ tools: ["brush"] });
  expect(btnByText(w, DEFAULT_LOCALE.brush)).toBeTruthy();
  expect(btnByText(w, DEFAULT_LOCALE.eraser)).toBeFalsy();
});

test("tools 含 rect：渲染框选按钮，点击切到 rect", async () => {
  const w = await mountStudio({ tools: ["brush", "eraser", "rect"] });
  const rectBtn = btnByText(w, DEFAULT_LOCALE.rect);
  expect(rectBtn).toBeTruthy();
  const eng = instances[0]!;
  eng.setTool.mockClear();
  await rectBtn!.trigger("click");
  await nextTick();
  expect(eng.setTool).toHaveBeenCalledWith("rect");
});

test("a11y：工具按钮有 aria-label 与 aria-pressed 激活态", async () => {
  const w = await mountStudio();
  const brush = btnByText(w, DEFAULT_LOCALE.brush)!;
  expect(brush.attributes("aria-label")).toBe(DEFAULT_LOCALE.brush);
  expect(brush.attributes("aria-pressed")).toBe("true"); // 默认 tool=brush
  await btnByText(w, DEFAULT_LOCALE.eraser)!.trigger("click");
  await nextTick();
  expect(brush.attributes("aria-pressed")).toBe("false");
  expect(btnByText(w, DEFAULT_LOCALE.eraser)!.attributes("aria-pressed")).toBe("true");
});

test("setBrush 经 expose 走内部 ref（同步滑块 + 转发 engine）", async () => {
  const w = await mountStudio();
  const eng = instances[0]!;
  eng.setBrush.mockClear();
  (w.vm as unknown as { setBrush: (o: { size: number }) => void }).setBrush({ size: 80 });
  await nextTick();
  expect(eng.setBrush).toHaveBeenCalledWith({ size: 80 });
  expect((w.get('input[type="range"]').element as HTMLInputElement).value).toBe("80");
});

test("brushSize prop 接线：初值入 ref，外部更新同步", async () => {
  const w = await mountStudio({ brushSize: 64 });
  expect((w.get('input[type="range"]').element as HTMLInputElement).value).toBe("64");
  expect(instances[0]!.opts.brushSize).toBe(64);
  const eng = instances[0]!;
  eng.setBrush.mockClear();
  await w.setProps({ brushSize: 100 });
  await nextTick();
  expect((w.get('input[type="range"]').element as HTMLInputElement).value).toBe("100");
  expect(eng.setBrush).toHaveBeenCalledWith({ size: 100 });
});

test("cursor class：涂抹工具下 .vic-canvas 含 vic-cursor-none，非涂抹工具不含", async () => {
  const w = await mountStudio();
  expect(w.get(".vic-canvas").classes()).toContain("vic-cursor-none"); // 默认 brush
  (w.vm as unknown as { setTool: (t: string) => void }).setTool("rect");
  await nextTick();
  expect(w.get(".vic-canvas").classes()).not.toContain("vic-cursor-none");
});

test("tools 含 rotate/flip：渲染几何按钮，点击转发 engine 命令", async () => {
  const w = await mountStudio({ tools: ["brush", "rotate", "flip"] });
  const eng = instances[0]!;
  await btnByText(w, DEFAULT_LOCALE.rotate)!.trigger("click");
  expect(eng.rotate).toHaveBeenCalledWith("cw");
  await btnByText(w, DEFAULT_LOCALE.flipHorizontal)!.trigger("click");
  expect(eng.flipHorizontal).toHaveBeenCalledOnce();
  await btnByText(w, DEFAULT_LOCALE.flipVertical)!.trigger("click");
  expect(eng.flipVertical).toHaveBeenCalledOnce();
});

test("tools 门控：未启用 rotate/flip 不渲染几何按钮", async () => {
  const w = await mountStudio({ tools: ["brush", "eraser"] });
  expect(btnByText(w, DEFAULT_LOCALE.rotate)).toBeFalsy();
  expect(btnByText(w, DEFAULT_LOCALE.flipHorizontal)).toBeFalsy();
  expect(btnByText(w, DEFAULT_LOCALE.flipVertical)).toBeFalsy();
});

test("几何动作不切换当前绘制工具（rotate/flip 为即时命令）", async () => {
  const w = await mountStudio({ tools: ["brush", "rotate", "flip"] });
  await btnByText(w, DEFAULT_LOCALE.rotate)!.trigger("click");
  await nextTick();
  // 绘制工具仍是 brush（aria-pressed 保持），rotate 不抢占工具态
  expect(btnByText(w, DEFAULT_LOCALE.brush)!.attributes("aria-pressed")).toBe("true");
});

test("applyTransform/rotate/flip 经 expose 转发到 engine", async () => {
  const w = await mountStudio();
  const eng = instances[0]!;
  const vm = w.vm as unknown as {
    applyTransform: (p: unknown) => void;
    rotate: (d?: string) => void;
    flipHorizontal: () => void;
    flipVertical: () => void;
  };
  vm.applyTransform({ rotate: 90 });
  vm.rotate("ccw");
  vm.flipHorizontal();
  vm.flipVertical();
  expect(eng.applyTransform).toHaveBeenCalledWith({ rotate: 90 });
  expect(eng.rotate).toHaveBeenCalledWith("ccw");
  expect(eng.flipHorizontal).toHaveBeenCalledOnce();
  expect(eng.flipVertical).toHaveBeenCalledOnce();
});

test("crop 工具：点击进入裁剪模式，渲染比例子工具栏并转发 setCropRatio", async () => {
  const w = await mountStudio({ tools: ["brush", "crop"], cropRatios: [1, "free"] });
  const eng = instances[0]!;
  // 默认无裁剪子工具栏
  expect(w.find(".vic-crop-bar").exists()).toBe(false);
  await btnByText(w, DEFAULT_LOCALE.crop)!.trigger("click");
  await nextTick();
  expect(eng.setTool).toHaveBeenCalledWith("crop"); // 进入裁剪模式
  expect(w.find(".vic-crop-bar").exists()).toBe(true);
  // 比例档位按钮：1:1 与 自由
  const r11 = btnByText(w, "1:1");
  expect(r11).toBeTruthy();
  expect(btnByText(w, DEFAULT_LOCALE.cropFree)).toBeTruthy();
  await r11!.trigger("click");
  expect(eng.setCropRatio).toHaveBeenCalledWith(1);
});

test("crop 子工具栏：应用/取消转发 engine 并退出裁剪模式回画笔", async () => {
  const w = await mountStudio({ tools: ["brush", "crop"] });
  const eng = instances[0]!;
  await btnByText(w, DEFAULT_LOCALE.crop)!.trigger("click");
  await nextTick();
  await btnByText(w, DEFAULT_LOCALE.applyCrop)!.trigger("click");
  await nextTick();
  expect(eng.applyCrop).toHaveBeenCalledOnce();
  expect(w.find(".vic-crop-bar").exists()).toBe(false); // 回到画笔，子工具栏消失
  // 再进裁剪 → 取消（"取消"在主栏与裁剪子栏都有，需 scope 到子栏避免命中主栏 emit('cancel')）
  await btnByText(w, DEFAULT_LOCALE.crop)!.trigger("click");
  await nextTick();
  const cropBarCancel = w.find(".vic-crop-bar").findAll("button").find((b) => b.text() === DEFAULT_LOCALE.cancel);
  await cropBarCancel!.trigger("click");
  await nextTick();
  expect(eng.cancelCrop).toHaveBeenCalledOnce();
  expect(w.find(".vic-crop-bar").exists()).toBe(false);
});

test("adjust 工具：进入调整模式渲染滑块面板，拖动转发 setAdjust，释放转发 commitAdjust", async () => {
  const w = await mountStudio({ tools: ["brush", "adjust"] });
  const eng = instances[0]!;
  expect(w.find(".vic-adjust-bar").exists()).toBe(false);
  await btnByText(w, DEFAULT_LOCALE.adjust)!.trigger("click");
  await nextTick();
  expect(eng.setTool).toHaveBeenCalledWith("adjust");
  expect(w.find(".vic-adjust-bar").exists()).toBe(true);
  const ranges = w.findAll(".vic-adjust-bar input[type='range']");
  expect(ranges).toHaveLength(3); // 亮度/对比度/饱和度
  // 直接置值 + trigger('input')，避免 setValue 在 range 上附带的 change 副作用干扰提交计数。
  (ranges[0]!.element as HTMLInputElement).value = "50"; // 亮度
  await ranges[0]!.trigger("input");
  expect(eng.setAdjust).toHaveBeenCalled();
  expect(eng.setAdjust.mock.calls.at(-1)![0]).toMatchObject({ brightness: 50 });
  eng.commitAdjust.mockClear();
  await ranges[0]!.trigger("change"); // 释放 → 提交一次
  expect(eng.commitAdjust).toHaveBeenCalledOnce();
});

test("adjust 实时预览：非零调整给画布套 CSS filter，归零清除", async () => {
  const w = await mountStudio({ tools: ["brush", "adjust"] });
  await btnByText(w, DEFAULT_LOCALE.adjust)!.trigger("click");
  await nextTick();
  const canvas = w.get(".vic-canvas");
  expect(canvas.attributes("style") ?? "").not.toContain("brightness"); // 初始无 filter
  const range = w.findAll(".vic-adjust-bar input[type='range']")[0]!;
  await range.setValue(40);
  await range.trigger("input");
  await nextTick();
  expect(canvas.attributes("style")).toContain("brightness(1.4)"); // 1 + 40/100
});

test("adjust 重置：归零滑块 + 转发 setAdjust/commitAdjust", async () => {
  const w = await mountStudio({ tools: ["brush", "adjust"] });
  const eng = instances[0]!;
  await btnByText(w, DEFAULT_LOCALE.adjust)!.trigger("click");
  await nextTick();
  const range = w.findAll(".vic-adjust-bar input[type='range']")[1]!; // 对比度
  await range.setValue(30);
  await range.trigger("input");
  eng.setAdjust.mockClear();
  eng.commitAdjust.mockClear();
  // 子工具栏内的「重置」按钮（scope 到 adjust-bar，避开主栏可能的同名）
  const resetBtn = w.find(".vic-adjust-bar").findAll("button").find((b) => b.text() === DEFAULT_LOCALE.reset);
  await resetBtn!.trigger("click");
  await nextTick();
  expect(eng.setAdjust).toHaveBeenCalledWith({ brightness: 0, contrast: 0, saturate: 0 });
  expect(eng.commitAdjust).toHaveBeenCalledOnce();
  expect((range.element as HTMLInputElement).value).toBe("0");
});

test("setAdjust/commitAdjust 经 expose 转发并同步滑块面板", async () => {
  const w = await mountStudio({ tools: ["brush", "adjust"] });
  const eng = instances[0]!;
  const vm = w.vm as unknown as { setAdjust: (a: unknown) => void; commitAdjust: () => void };
  vm.setAdjust({ saturate: -20 });
  vm.commitAdjust();
  expect(eng.setAdjust).toHaveBeenCalled();
  expect(eng.setAdjust.mock.calls.at(-1)![0]).toMatchObject({ saturate: -20 });
  expect(eng.commitAdjust).toHaveBeenCalledOnce();
  await btnByText(w, DEFAULT_LOCALE.adjust)!.trigger("click");
  await nextTick();
  const range = w.findAll(".vic-adjust-bar input[type='range']")[2]!; // 饱和度
  expect((range.element as HTMLInputElement).value).toBe("-20"); // expose 已同步滑块
});

test("ready 态 exportResult 转发到 engine 并 resolve", async () => {
  const w = await mountStudio();
  const r = await (w.vm as unknown as { exportResult: () => Promise<{ hasMask: boolean }> }).exportResult();
  expect(instances[0]!.exportResult).toHaveBeenCalledOnce();
  expect(r.hasMask).toBe(false);
});
