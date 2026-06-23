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
import { VicIcon } from "./icons";
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
// 初始/回退工具：启用集含画笔则用画笔（最常用），否则用 'pan' 中性查看态——
// 绝不默认落到裁剪等会铺满覆盖层、改动画幅的工具（旧版对无 mask 模型默认进裁剪的根因）。
const defaultTool = computed<StudioTool>(() => (tools.includes("brush") ? "brush" : "pan"));
const tool = ref<StudioTool>(defaultTool.value);
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
// 涂抹工具（自绘光标 + 笔刷粗细）：仅画笔/橡皮。
const isPaintTool = computed(() => tool.value === "brush" || tool.value === "eraser");
// 蒙版工具（圈定要重绘区域）：画笔/橡皮/框选——决定蒙版语义提示与上下文条是否浮现。
const isMaskTool = computed(() => isPaintTool.value || tool.value === "rect");

// —— 工具栏分组可见性（驱动分段与分隔线渲染）——
const showPaint = computed(() => showTool("brush") || showTool("eraser") || showTool("rect"));
const showTransform = computed(
  () => showTool("rotate") || showTool("flip") || showTool("crop"),
);
const showAdjust = computed(() => showTool("adjust"));

// 笔刷粗细的实时预览圆点直径（随 size 放大，封顶 26px 不撑破上下文条）。
const brushDotSize = computed(() => Math.min(26, 4 + brushSize.value * 0.2));

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
  // 键盘快捷键：组件挂载期内挂 window（工作台多为全屏弹窗，独占焦点）。
  window.addEventListener("keydown", onKeydown);
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

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  engine?.destroy();
});

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
  tool.value = defaultTool.value;
}
function onCancelCrop(): void {
  engine?.cancelCrop();
  tool.value = defaultTool.value;
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

// —— 键盘快捷键 —— //
// B/E/R 切工具（仅启用时）、[ ] 调笔刷、⌘/Ctrl+Z 撤销、⌘⇧Z/⌘Y 重做、Enter 应用、Esc 取消。
function onKeydown(e: KeyboardEvent): void {
  const el = e.target as HTMLElement | null;
  const editable = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const mod = e.metaKey || e.ctrlKey;
  // 撤销/重做：焦点在滑块也允许（绘制流程中常态）。
  if (mod && (e.key === "z" || e.key === "Z")) {
    e.preventDefault();
    if (e.shiftKey) {
      if (state.value?.canRedo) onRedo();
    } else if (state.value?.canUndo) {
      onUndo();
    }
    return;
  }
  if (mod && (e.key === "y" || e.key === "Y")) {
    e.preventDefault();
    if (state.value?.canRedo) onRedo();
    return;
  }
  if (mod) return;
  if (e.key === "Escape") {
    e.preventDefault();
    emit("cancel");
    return;
  }
  if (e.key === "Enter") {
    // 焦点在按钮上时交给原生点击，避免重复触发。
    if (el?.tagName === "BUTTON") return;
    e.preventDefault();
    if (tool.value === "crop") onApplyCrop();
    else void apply();
    return;
  }
  if (editable) return; // 单键快捷键在输入态跳过
  switch (e.key.toLowerCase()) {
    case "b":
      if (showTool("brush")) {
        e.preventDefault();
        tool.value = "brush";
      }
      break;
    case "e":
      if (showTool("eraser")) {
        e.preventDefault();
        tool.value = "eraser";
      }
      break;
    case "r":
      if (showTool("rect")) {
        e.preventDefault();
        tool.value = "rect";
      }
      break;
    case "[":
      if (isPaintTool.value) {
        e.preventDefault();
        brushSize.value = Math.max(4, brushSize.value - 4);
      }
      break;
    case "]":
      if (isPaintTool.value) {
        e.preventDefault();
        brushSize.value = Math.min(120, brushSize.value + 4);
      }
      break;
  }
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
    <!-- 工具坞：分段分组（绘制 / 变换 / 调整 / 历史 / 操作），分隔线只在相邻非空组间出现 -->
    <div class="vic-toolbar" role="toolbar">
      <!-- 绘制组：画笔 / 橡皮 / 框选 / 清除蒙版 -->
      <div v-if="showPaint" class="vic-group">
        <button
          v-if="showTool('brush')"
          class="vic-tool"
          :class="{ 'is-active': tool === 'brush' }"
          :aria-label="t.brush"
          :aria-pressed="tool === 'brush'"
          :title="t.brush"
          @click="tool = 'brush'"
        >
          <VicIcon name="brush" />
        </button>
        <button
          v-if="showTool('eraser')"
          class="vic-tool"
          :class="{ 'is-active': tool === 'eraser' }"
          :aria-label="t.eraser"
          :aria-pressed="tool === 'eraser'"
          :title="t.eraser"
          @click="tool = 'eraser'"
        >
          <VicIcon name="eraser" />
        </button>
        <button
          v-if="showTool('rect')"
          class="vic-tool"
          :class="{ 'is-active': tool === 'rect' }"
          :aria-label="t.rect"
          :aria-pressed="tool === 'rect'"
          :title="t.rect"
          @click="tool = 'rect'"
        >
          <VicIcon name="rect" />
        </button>
        <button class="vic-tool" :aria-label="t.clear" :title="t.clear" @click="onClear">
          <VicIcon name="clear" />
        </button>
      </div>

      <span v-if="showPaint && showTransform" class="vic-divider" aria-hidden="true" />

      <!-- 变换组：旋转 / 水平翻转 / 垂直翻转 / 裁剪 -->
      <div v-if="showTransform" class="vic-group">
        <button
          v-if="showTool('rotate')"
          class="vic-tool"
          :aria-label="t.rotate"
          :title="t.rotate"
          @click="onRotate"
        >
          <VicIcon name="rotate" />
        </button>
        <button
          v-if="showTool('flip')"
          class="vic-tool"
          :class="{ 'is-active': state?.transform.flipX }"
          :aria-label="t.flipHorizontal"
          :aria-pressed="!!state?.transform.flipX"
          :title="t.flipHorizontal"
          @click="onFlipH"
        >
          <VicIcon name="flipH" />
        </button>
        <button
          v-if="showTool('flip')"
          class="vic-tool"
          :class="{ 'is-active': state?.transform.flipY }"
          :aria-label="t.flipVertical"
          :aria-pressed="!!state?.transform.flipY"
          :title="t.flipVertical"
          @click="onFlipV"
        >
          <VicIcon name="flipV" />
        </button>
        <button
          v-if="showTool('crop')"
          class="vic-tool"
          :class="{ 'is-active': tool === 'crop' }"
          :aria-label="t.crop"
          :aria-pressed="tool === 'crop'"
          :title="t.crop"
          @click="tool = 'crop'"
        >
          <VicIcon name="crop" />
        </button>
      </div>

      <span
        v-if="(showPaint || showTransform) && showAdjust"
        class="vic-divider"
        aria-hidden="true"
      />

      <!-- 调整组 -->
      <div v-if="showAdjust" class="vic-group">
        <button
          class="vic-tool"
          :class="{ 'is-active': tool === 'adjust' }"
          :aria-label="t.adjust"
          :aria-pressed="tool === 'adjust'"
          :title="t.adjust"
          @click="tool = 'adjust'"
        >
          <VicIcon name="adjust" />
        </button>
      </div>

      <span
        v-if="showPaint || showTransform || showAdjust"
        class="vic-divider"
        aria-hidden="true"
      />

      <!-- 历史组：撤销 / 重做 -->
      <div class="vic-group">
        <button
          class="vic-tool"
          :disabled="!state?.canUndo"
          :aria-label="t.undo"
          :title="t.undo"
          @click="onUndo"
        >
          <VicIcon name="undo" />
        </button>
        <button
          class="vic-tool"
          :disabled="!state?.canRedo"
          :aria-label="t.redo"
          :title="t.redo"
          @click="onRedo"
        >
          <VicIcon name="redo" />
        </button>
      </div>

      <span class="vic-spacer" />

      <!-- 操作组：取消（幽灵）/ 应用（强调） -->
      <div class="vic-group vic-actions">
        <button class="vic-btn vic-ghost" :aria-label="t.cancel" @click="emit('cancel')">
          <VicIcon name="cancel" :size="16" />
          <span>{{ t.cancel }}</span>
        </button>
        <button class="vic-btn vic-apply" :aria-label="t.apply" @click="apply">
          <VicIcon name="apply" :size="16" />
          <span>{{ t.apply }}</span>
        </button>
      </div>
    </div>

    <!-- 上下文子区：随当前工具切换（绘制上下文 / 裁剪档位 / 调整滑块），互斥单显。
         离场元素绝对定位 → 同高子栏交叉淡入不塌陷、画布不跳动；空态由 :empty 收起。 -->
    <div class="vic-sub-slot">
      <Transition name="vic-sub">
        <!-- 绘制上下文：笔刷粗细（仅画笔/橡皮）+ 蒙版语义提示 -->
      <div v-if="isMaskTool" key="paint" class="vic-subbar vic-context">
        <label v-if="isPaintTool" class="vic-brush">
          <span class="vic-brush-label">{{ t.brushSize }}</span>
          <input
            v-model.number="brushSize"
            type="range"
            min="4"
            max="120"
            class="vic-range"
            :aria-label="t.brushSize"
          />
          <span class="vic-brush-value">{{ brushSize }}</span>
          <span
            class="vic-brush-dot"
            :style="{ width: `${brushDotSize}px`, height: `${brushDotSize}px` }"
            aria-hidden="true"
          />
        </label>
        <span class="vic-spacer" />
        <span class="vic-mask-hint" aria-live="polite">
          <span class="vic-mask-swatch" aria-hidden="true" />
          {{ maskHint }}
        </span>
      </div>

      <!-- 裁剪子工具栏 -->
      <div v-else-if="tool === 'crop'" key="crop" class="vic-subbar vic-crop-bar">
        <span class="vic-subbar-label">{{ t.crop }}</span>
        <div class="vic-group">
          <button
            v-for="r in cropRatios"
            :key="String(r)"
            class="vic-chip"
            :class="{ 'is-active': cropRatio === r }"
            :aria-label="ratioLabel(r)"
            :aria-pressed="cropRatio === r"
            @click="onCropRatio(r)"
          >
            {{ ratioLabel(r) }}
          </button>
        </div>
        <span class="vic-spacer" />
        <button class="vic-btn vic-ghost" :aria-label="t.cancel" @click="onCancelCrop">
          <VicIcon name="cancel" :size="16" />
          <span>{{ t.cancel }}</span>
        </button>
        <button class="vic-btn vic-apply" :aria-label="t.applyCrop" @click="onApplyCrop">
          <VicIcon name="apply" :size="16" />
          <span>{{ t.applyCrop }}</span>
        </button>
      </div>

      <!-- 调整子工具栏：亮度 / 对比度 / 饱和度 -->
      <div v-else-if="tool === 'adjust'" key="adjust" class="vic-subbar vic-adjust-bar">
        <label class="vic-adjust">
          <span class="vic-adjust-label">{{ t.brightness }}</span>
          <input
            v-model.number="adjust.brightness"
            type="range"
            min="-100"
            max="100"
            class="vic-range"
            :aria-label="t.brightness"
            @input="onAdjustInput"
            @change="onAdjustCommit"
          />
          <span class="vic-adjust-value">{{ adjust.brightness }}</span>
        </label>
        <label class="vic-adjust">
          <span class="vic-adjust-label">{{ t.contrast }}</span>
          <input
            v-model.number="adjust.contrast"
            type="range"
            min="-100"
            max="100"
            class="vic-range"
            :aria-label="t.contrast"
            @input="onAdjustInput"
            @change="onAdjustCommit"
          />
          <span class="vic-adjust-value">{{ adjust.contrast }}</span>
        </label>
        <label class="vic-adjust">
          <span class="vic-adjust-label">{{ t.saturation }}</span>
          <input
            v-model.number="adjust.saturate"
            type="range"
            min="-100"
            max="100"
            class="vic-range"
            :aria-label="t.saturation"
            @input="onAdjustInput"
            @change="onAdjustCommit"
          />
          <span class="vic-adjust-value">{{ adjust.saturate }}</span>
        </label>
        <span class="vic-spacer" />
        <button class="vic-btn vic-ghost" :aria-label="t.reset" @click="onAdjustReset">
          {{ t.reset }}
        </button>
      </div>
      </Transition>
    </div>

    <div
      ref="canvasHost"
      class="vic-canvas"
      :class="{ 'vic-cursor-none': isPaintTool }"
      :style="{ filter: adjustFilter }"
    ></div>
  </div>
</template>
