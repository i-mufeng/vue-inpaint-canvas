<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { StudioEngine } from "../core/engine";
import { adjustToCssFilter } from "../core/filters";
import { DEFAULT_CROP_RATIOS, DEFAULT_LOCALE } from "../core/types";
import type {
  AdjustValues,
  BrushOptions,
  EngineOptions,
  MaskPolarity,
  OutputType,
  SourceInput,
  StudioLocale,
  StudioResult,
  StudioStateBrief,
  StudioTheme,
  StudioTool,
  TransformState,
} from "../core/types";
import "../theme/default.css";

// Vue 3.5 reactive props destructure：默认值内联，解构变量在 watch/模板里仍保持响应式。
// brushSize prop 重命名为 brushSizeProp，避免与可变内部 ref `brushSize` 同名（防单向数据流死契约）。
const {
  source,
  tools = ["brush", "eraser"],
  maskPolarity = "paint-to-edit",
  feather = 0,
  brushSize: brushSizeProp = 40,
  cropRatios = DEFAULT_CROP_RATIOS,
  locale = {},
  theme = {},
  output = {},
} = defineProps<{
  source: SourceInput;
  /** 启用的工具。默认画笔+橡皮；rect/rotate/flip/crop 需宿主显式开启（能力已就绪）。 */
  tools?: StudioTool[];
  maskPolarity?: MaskPolarity;
  feather?: number;
  /** 画笔初始粗细（px），默认 40。运行期可经 expose.setBrush 改。 */
  brushSize?: number;
  /** 裁剪比例档位，缺省 DEFAULT_CROP_RATIOS（数字=宽高比，'free'=自由）。 */
  cropRatios?: (number | "free")[];
  /** i18n 文案覆盖，与 DEFAULT_LOCALE 浅合并（缺省键回退中文默认）。 */
  locale?: Partial<StudioLocale>;
  theme?: Partial<StudioTheme>;
  output?: { type?: OutputType; quality?: number };
}>();

const emit = defineEmits<{
  apply: [result: StudioResult];
  change: [state: StudioStateBrief];
  ready: [];
  cancel: [];
  error: [err: Error];
}>();

const canvasHost = useTemplateRef<HTMLDivElement>("canvasHost");
const brushSize = ref(brushSizeProp);
const tool = ref<StudioTool>("brush");
const cropRatio = ref<number | "free">("free");
const adjust = ref<AdjustValues>({ brightness: 0, contrast: 0, saturate: 0 });
const state = ref<StudioStateBrief | null>(null);
// 实时预览：调整非零时对画布容器套 CSS filter（GPU，§5.5）；导出由 engine 用同串 ctx.filter 烘焙进 image。
const adjustFilter = computed(() => {
  const a = adjust.value;
  return a.brightness === 0 && a.contrast === 0 && a.saturate === 0 ? "" : adjustToCssFilter(a);
});
// Konva 命令式对象刻意不进 Vue 响应式系统；只把派生的轻量快照 state 喂给模板。
let engine: StudioEngine | null = null;

// 文案：DEFAULT_LOCALE 浅合并宿主 locale（缺省键回退默认）。
const t = computed<StudioLocale>(() => ({ ...DEFAULT_LOCALE, ...locale }));
// mask 反转语义提示（红线①最易搞反点），随 maskPolarity 切换。
const maskHint = computed(() =>
  maskPolarity === "paint-to-edit" ? t.value.maskHintEdit : t.value.maskHintKeep,
);
const showTool = (n: StudioTool): boolean => tools.includes(n);
const isPaintTool = computed(() => tool.value === "brush" || tool.value === "eraser");

const themeVars = computed<Record<string, string>>(() => {
  const entries: [string, string | undefined][] = [
    ["--vic-accent", theme.accent],
    ["--vic-bg", theme.bg],
    ["--vic-surface", theme.surface],
    ["--vic-elevated", theme.elevated],
    ["--vic-text", theme.text],
    ["--vic-text-muted", theme.textMuted],
    ["--vic-border", theme.border],
    ["--vic-radius", theme.radius],
  ];
  return Object.fromEntries(entries.filter((e): e is [string, string] => e[1] != null));
});

onMounted(async () => {
  if (!canvasHost.value) return;
  engine = new StudioEngine(canvasHost.value, {
    maskPolarity,
    feather,
    output,
    tools,
    brushSize: brushSizeProp,
    locale,
  } satisfies EngineOptions);
  engine.on("ready", () => emit("ready"));
  engine.on("change", (s) => {
    state.value = s;
    emit("change", s);
  });
  engine.on("error", (e) => emit("error", e));
  await engine.loadSource(source);
  engine.setTool(tool.value);
  engine.setBrush({ size: brushSize.value });
});

watch(
  () => source,
  (s) => void engine?.loadSource(s),
);
// 外部 brushSize prop 更新 → 内部 ref（单向，绝不 ref→prop 反写）。
watch(
  () => brushSizeProp,
  (v) => {
    brushSize.value = v;
  },
);
watch(brushSize, (v) => engine?.setBrush({ size: v }));
watch(tool, (v) => engine?.setTool(v));
// 引擎侧调整变化（撤销/重做/重置/expose）回填滑块；组件自身拖拽产生的同值变化被守卫跳过。
watch(
  () => state.value?.adjust,
  (a) => {
    if (
      a &&
      (a.brightness !== adjust.value.brightness ||
        a.contrast !== adjust.value.contrast ||
        a.saturate !== adjust.value.saturate)
    ) {
      adjust.value = { ...a };
    }
  },
);

onBeforeUnmount(() => engine?.destroy());

async function apply(): Promise<void> {
  if (engine) emit("apply", await engine.exportResult());
}
function onClear(): void {
  engine?.clearMask();
}
function onUndo(): void {
  engine?.undo();
}
function onRedo(): void {
  engine?.redo();
}
// 几何动作按钮（旋转/翻转为即时命令，不切换当前绘制工具）。
function onRotate(): void {
  engine?.rotate("cw");
}
function onFlipH(): void {
  engine?.flipHorizontal();
}
function onFlipV(): void {
  engine?.flipVertical();
}
// 裁剪（L4c）：比例档位 + 应用/取消。应用/取消后回到画笔工具（退出裁剪覆盖层）。
function ratioLabel(r: number | "free"): string {
  if (r === "free") return t.value.cropFree;
  const known: [number, string][] = [
    [1, "1:1"],
    [4 / 3, "4:3"],
    [3 / 4, "3:4"],
    [16 / 9, "16:9"],
    [9 / 16, "9:16"],
  ];
  const hit = known.find(([v]) => Math.abs(v - r) < 1e-6);
  return hit ? hit[1] : String(r);
}
function onCropRatio(r: number | "free"): void {
  cropRatio.value = r;
  engine?.setCropRatio(r);
}
function onApplyCrop(): void {
  engine?.applyCrop();
  tool.value = "brush";
}
function onCancelCrop(): void {
  engine?.cancelCrop();
  tool.value = "brush";
}
// 调整（L5b）：@input 实时（CSS filter 预览 + engine 存值供导出烘焙），@change 释放时提交为可撤销命令。
function onAdjustInput(): void {
  engine?.setAdjust(adjust.value);
}
function onAdjustCommit(): void {
  engine?.commitAdjust();
}
function onAdjustReset(): void {
  adjust.value = { brightness: 0, contrast: 0, saturate: 0 };
  engine?.setAdjust(adjust.value);
  engine?.commitAdjust();
}

// 未就绪时 reject（而非静默返回 undefined），让宿主拿到干净的 Promise 契约。
const notReady = (): Promise<never> => Promise.reject(new Error("ImageStudio 尚未就绪"));
defineExpose({
  exportResult: () => (engine ? engine.exportResult() : notReady()),
  exportMask: () => (engine ? engine.exportMask() : notReady()),
  undo: onUndo,
  redo: onRedo,
  reset: () => engine?.reset(),
  clearMask: onClear,
  setTool: (next: StudioTool) => {
    tool.value = next;
  },
  // 走内部 ref 复用既有 watch→engine.setBrush，与滑块/prop 同源（不直呼 engine）。
  setBrush: (opts: BrushOptions) => {
    if (opts.size != null) brushSize.value = opts.size;
  },
  // 几何（L4）：直转 engine（engine 内部走统一命令历史，组件不维护 transform 镜像，以 state.transform 为准）。
  applyTransform: (patch: Partial<TransformState>) => engine?.applyTransform(patch),
  rotate: (dir?: "cw" | "ccw") => engine?.rotate(dir),
  flipHorizontal: () => engine?.flipHorizontal(),
  flipVertical: () => engine?.flipVertical(),
  // 裁剪：经组件 handler，与子工具栏同源（同步 cropRatio ref / 应用后回画笔）。
  setCropRatio: (r: number | "free") => onCropRatio(r),
  applyCrop: () => onApplyCrop(),
  cancelCrop: () => onCancelCrop(),
  // 调整：更新滑块 ref 并转发 engine（与面板同源）。
  setAdjust: (a: Partial<AdjustValues>) => {
    adjust.value = { ...adjust.value, ...a };
    engine?.setAdjust(adjust.value);
  },
  commitAdjust: () => engine?.commitAdjust(),
});
</script>

<template>
  <div class="vic-studio" :style="themeVars">
    <div class="vic-toolbar">
      <button
        v-if="showTool('brush')"
        :class="{ 'is-active': tool === 'brush' }"
        :aria-label="t.brush"
        :aria-pressed="tool === 'brush'"
        @click="tool = 'brush'"
      >
        {{ t.brush }}
      </button>
      <button
        v-if="showTool('eraser')"
        :class="{ 'is-active': tool === 'eraser' }"
        :aria-label="t.eraser"
        :aria-pressed="tool === 'eraser'"
        @click="tool = 'eraser'"
      >
        {{ t.eraser }}
      </button>
      <button
        v-if="showTool('rect')"
        :class="{ 'is-active': tool === 'rect' }"
        :aria-label="t.rect"
        :aria-pressed="tool === 'rect'"
        @click="tool = 'rect'"
      >
        {{ t.rect }}
      </button>
      <button v-if="showTool('rotate')" :aria-label="t.rotate" @click="onRotate">{{ t.rotate }}</button>
      <button
        v-if="showTool('flip')"
        :class="{ 'is-active': state?.transform.flipX }"
        :aria-label="t.flipHorizontal"
        :aria-pressed="!!state?.transform.flipX"
        @click="onFlipH"
      >
        {{ t.flipHorizontal }}
      </button>
      <button
        v-if="showTool('flip')"
        :class="{ 'is-active': state?.transform.flipY }"
        :aria-label="t.flipVertical"
        :aria-pressed="!!state?.transform.flipY"
        @click="onFlipV"
      >
        {{ t.flipVertical }}
      </button>
      <button
        v-if="showTool('crop')"
        :class="{ 'is-active': tool === 'crop' }"
        :aria-label="t.crop"
        :aria-pressed="tool === 'crop'"
        @click="tool = 'crop'"
      >
        {{ t.crop }}
      </button>
      <button
        v-if="showTool('adjust')"
        :class="{ 'is-active': tool === 'adjust' }"
        :aria-label="t.adjust"
        :aria-pressed="tool === 'adjust'"
        @click="tool = 'adjust'"
      >
        {{ t.adjust }}
      </button>
      <button :aria-label="t.clear" @click="onClear">{{ t.clear }}</button>
      <button :disabled="!state?.canUndo" :aria-label="t.undo" @click="onUndo">{{ t.undo }}</button>
      <button :disabled="!state?.canRedo" :aria-label="t.redo" @click="onRedo">{{ t.redo }}</button>
      <label class="vic-brush">
        {{ t.brushSize }} {{ brushSize }}
        <input v-model.number="brushSize" type="range" min="4" max="120" :aria-label="t.brushSize" />
      </label>
      <span class="vic-mask-hint" aria-live="polite">{{ maskHint }}</span>
      <span class="vic-spacer" />
      <button class="vic-ghost" :aria-label="t.cancel" @click="emit('cancel')">{{ t.cancel }}</button>
      <button class="vic-apply" :aria-label="t.apply" @click="apply">{{ t.apply }}</button>
    </div>
    <div v-if="tool === 'crop'" class="vic-crop-bar">
      <button
        v-for="r in cropRatios"
        :key="String(r)"
        :class="{ 'is-active': cropRatio === r }"
        :aria-label="ratioLabel(r)"
        :aria-pressed="cropRatio === r"
        @click="onCropRatio(r)"
      >
        {{ ratioLabel(r) }}
      </button>
      <span class="vic-spacer" />
      <button class="vic-ghost" :aria-label="t.cancel" @click="onCancelCrop">{{ t.cancel }}</button>
      <button class="vic-apply" :aria-label="t.applyCrop" @click="onApplyCrop">{{ t.applyCrop }}</button>
    </div>
    <div v-if="tool === 'adjust'" class="vic-adjust-bar">
      <label class="vic-adjust">
        {{ t.brightness }} {{ adjust.brightness }}
        <input
          v-model.number="adjust.brightness"
          type="range"
          min="-100"
          max="100"
          :aria-label="t.brightness"
          @input="onAdjustInput"
          @change="onAdjustCommit"
        />
      </label>
      <label class="vic-adjust">
        {{ t.contrast }} {{ adjust.contrast }}
        <input
          v-model.number="adjust.contrast"
          type="range"
          min="-100"
          max="100"
          :aria-label="t.contrast"
          @input="onAdjustInput"
          @change="onAdjustCommit"
        />
      </label>
      <label class="vic-adjust">
        {{ t.saturation }} {{ adjust.saturate }}
        <input
          v-model.number="adjust.saturate"
          type="range"
          min="-100"
          max="100"
          :aria-label="t.saturation"
          @input="onAdjustInput"
          @change="onAdjustCommit"
        />
      </label>
      <span class="vic-spacer" />
      <button class="vic-ghost" :aria-label="t.reset" @click="onAdjustReset">{{ t.reset }}</button>
    </div>
    <div
      ref="canvasHost"
      class="vic-canvas"
      :class="{ 'vic-cursor-none': isPaintTool }"
      :style="{ filter: adjustFilter }"
    ></div>
  </div>
</template>
