import Konva from "konva";
import { toDisplaySpace, transformedSize } from "./coords";
import { adjustToCssFilter } from "./filters";
import type {
  AdjustValues,
  BrushOptions,
  EngineEvents,
  EngineOptions,
  Point,
  Rect,
  SourceInput,
  StudioResult,
  StudioStateBrief,
  StudioTool,
  TransformState,
} from "./types";

/**
 * 统一命令历史的最小单元（DESIGN §5.6）。mask 笔触与几何变换各实现为命令，
 * 单一 `history` + `redoStack` 承载两类。`kind` 用于 clearMask 时只滤除 mask 类。
 * 方案 A（矢量）下几何命令的 do/undo 只切换 layer transform 与画幅，无需恢复像素。
 */
interface Command {
  kind: "mask" | "geom" | "adjust";
  do(): void;
  undo(): void;
  /** 释放命令独占的资源（mask 命令销毁其 Konva 节点）。命令被清出历史时调用，防止已撤销节点泄漏。 */
  dispose?(): void;
}

const IDENTITY_TRANSFORM: TransformState = { crop: null, rotate: 0, flipX: false, flipY: false };

/** 涂抹高亮色（显示层）。导出时只看 alpha 是否 > 阈值，颜色本身不影响 mask。 */
const PAINT_COLOR = "rgba(124, 92, 255, 0.55)";
/** 判定"已涂抹"的 alpha 阈值，过滤抗锯齿边缘的微弱像素。 */
const PAINT_ALPHA_THRESHOLD = 10;
/** 笔刷光标圆环颜色（显示层，不导出）。 */
const CURSOR_COLOR = "rgba(124, 92, 255, 0.9)";
/** 裁剪模式框外暗化遮罩色。 */
const CROP_SHADE_COLOR = "rgba(0, 0, 0, 0.55)";
/** 裁剪框边线色。 */
const CROP_BORDER_COLOR = "rgba(124, 92, 255, 0.95)";
/** 裁剪草稿最小有效边长（px），小于此视为误点，回退默认框。 */
const CROP_MIN_SIZE = 8;
/** 默认启用工具集。须与 `ImageStudio.vue` props 默认严格同口径（防漂移）。 */
const DEFAULT_TOOLS: StudioTool[] = ["brush", "eraser"];

type EventName = keyof EngineEvents;

/**
 * 框架无关的工作台引擎。挂在一个 DOM 容器上，命令式 API + 事件回调。
 * Vue/React/Svelte 壳只需把交互转成对它的调用、把它的事件转成框架事件。
 *
 * 已实现（PoC 验证）：加载源图、分层、画笔/橡皮涂抹、反转 alpha 导出透明 mask、轻量撤销。
 * 待实现（见 DESIGN.md §5）：矩形框选、几何变换 + mask 坐标联动、调整实时预览、羽化、缩放平移。
 */
export class StudioEngine {
  private stage: Konva.Stage;
  private baseLayer: Konva.Layer;
  private maskLayer: Konva.Layer;
  private cursorLayer: Konva.Layer;
  /** 裁剪覆盖层：**stage 空间**（不套几何 transform），仅裁剪模式可见，画暗化遮罩 + 裁剪框草稿。 */
  private cropLayer: Konva.Layer;

  private options: Required<Pick<EngineOptions, "maskPolarity" | "feather">> & EngineOptions;
  private tool: StudioTool = "brush";
  private brushSize = 40;

  /** 原始源图像素宽高（变换前，loadSource 设定，几何变换不改）。flip/rotate 镜像与画幅互换以此为基准，并喂给 coords。 */
  private srcW = 0;
  private srcH = 0;
  /** 当前画幅宽高 = `transformedSize(srcW, srcH, transform)`。**导出尺寸的唯一真相源**（红线4），随 applyTransform 更新。 */
  private imageW = 0;
  private imageH = 0;
  /** File/Blob 源图创建的 object URL，延迟到下次 load 或 destroy 时统一 revoke（避免解码后立即吊销致重栅格化取空图）。 */
  private objectUrl: string | null = null;

  private transform: TransformState = { ...IDENTITY_TRANSFORM };
  private adjust: AdjustValues = { brightness: 0, contrast: 0, saturate: 0 };
  /** 上次「提交」的调整快照（commitAdjust 基准）。setAdjust 实时改 adjust，commitAdjust 把 committed→adjust 合为单条命令。 */
  private committedAdjust: AdjustValues = { brightness: 0, contrast: 0, saturate: 0 };

  private painting = false;
  private currentLine: Konva.Line | null = null;
  private currentRect: Konva.Rect | null = null;
  private rectStart: Point | null = null;
  private cursorRing: Konva.Circle | null = null;
  // 裁剪模式状态（DESIGN §5.4 L4c）。cropDraft 在当前显示（stage）坐标系，应用时与已有 crop 原点合成。
  private cropShade: Konva.Shape | null = null;
  private cropDraft: Rect | null = null;
  private cropDragStart: Point | null = null;
  private cropRatio: number | "free" = "free";
  /** 统一命令历史（DESIGN §5.6）：mask 笔触 + 几何变换。canUndo/canRedo 据此推导。 */
  private history: Command[] = [];
  private redoStack: Command[] = [];
  private lastCoverage = 0;
  private detachPointer: (() => void) | null = null;

  private handlers: { [K in EventName]: Set<EngineEvents[K]> } = {
    ready: new Set(),
    change: new Set(),
    error: new Set(),
  };

  constructor(container: HTMLElement, options: EngineOptions = {}) {
    this.options = { maskPolarity: "paint-to-edit", feather: 0, ...options };
    this.brushSize = options.brushSize ?? 40;

    this.stage = new Konva.Stage({
      container: container as HTMLDivElement,
      width: container.clientWidth || 1,
      height: container.clientHeight || 1,
    });
    this.baseLayer = new Konva.Layer({ listening: false });
    this.maskLayer = new Konva.Layer();
    this.cursorLayer = new Konva.Layer({ listening: false });
    // 裁剪覆盖层置顶、默认隐藏；不参与几何 transform（stage 空间），故导出 toCanvas 取 base/mask 不含它。
    this.cropLayer = new Konva.Layer({ listening: false, visible: false });
    this.stage.add(this.baseLayer, this.maskLayer, this.cursorLayer, this.cropLayer);

    this.bindPointer();
  }

  // ---- 源图加载 -------------------------------------------------------------

  async loadSource(src: SourceInput): Promise<void> {
    try {
      if (this.objectUrl) {
        URL.revokeObjectURL(this.objectUrl);
        this.objectUrl = null;
      }
      const { element, objectUrl } = await loadImage(src);
      this.objectUrl = objectUrl;
      this.srcW = "naturalWidth" in element ? element.naturalWidth : element.width;
      this.srcH = "naturalHeight" in element ? element.naturalHeight : element.height;

      // 新图复位几何/调整为初始；base 图按源图坐标系（srcW×srcH）落入，变换交由 layer transform 表达（方案 A）。
      this.transform = { ...IDENTITY_TRANSFORM };
      this.adjust = { brightness: 0, contrast: 0, saturate: 0 };
      this.committedAdjust = { brightness: 0, contrast: 0, saturate: 0 };
      this.baseLayer.destroyChildren();
      this.baseLayer.add(new Konva.Image({ image: element, width: this.srcW, height: this.srcH }));

      // 销毁旧图遗留的命令节点（含已撤销、仅存于命令闭包者）后再清空在途子节点，杜绝跨图泄漏。
      this.purgeAllCommands();
      this.maskLayer.destroyChildren();
      // setTransform 统一推导 imageW/imageH、stage.size 与三层 layer transform，并各 draw 一次。
      this.applyTransformToLayers();
      // 若在裁剪模式下换源，刷新覆盖层到新画幅。
      if (this.tool === "crop") this.enterCrop();

      this.emit("ready");
      this.emitChange();
    } catch (err) {
      // 加载失败：复位尺寸/清空底图，让导出的空 mask 守卫生效，状态自洽。
      this.srcW = 0;
      this.srcH = 0;
      this.imageW = 0;
      this.imageH = 0;
      this.baseLayer.destroyChildren();
      this.baseLayer.draw();
      const e = err instanceof Error ? err : new Error(String(err));
      // core 直接消费者可能没接 error 事件——无监听时兜底打日志，避免静默吞错。
      if (this.handlers.error.size === 0) console.error("[vue-inpaint-canvas] loadSource failed:", e);
      this.emit("error", e);
    }
  }

  // ---- 工具与画笔 -----------------------------------------------------------

  setTool(tool: StudioTool): void {
    // engine 侧白名单二次防线：非启用工具静默忽略（UI 层已门控按钮）。
    if (!this.isToolEnabled(tool)) return;
    const prev = this.tool;
    this.tool = tool;
    // 切到非涂抹工具时收起笔刷光标圆环。
    if (tool !== "brush" && tool !== "eraser") this.hideCursor();
    // 进入/退出裁剪覆盖层（裁剪是模式工具，需交互选区）。
    if (tool === "crop") this.enterCrop();
    else if (prev === "crop") this.exitCrop();
    this.emitChange();
  }

  setBrush(opts: BrushOptions): void {
    if (opts.size != null) {
      this.brushSize = opts.size;
      if (this.cursorRing) {
        this.cursorRing.radius(this.brushSize / 2);
        this.cursorLayer.batchDraw();
      }
    }
  }

  /** 工具是否在启用集内（默认 `['brush','eraser']`）。 */
  private isToolEnabled(tool: StudioTool): boolean {
    return (this.options.tools ?? DEFAULT_TOOLS).includes(tool);
  }

  private bindPointer(): void {
    const down = () => this.onDown();
    const move = () => {
      this.onMove();
      this.updateCursor();
    };
    const up = () => this.onUp();
    const leave = () => {
      this.onUp();
      this.hideCursor();
    };
    this.stage.on("pointerdown", down);
    this.stage.on("pointermove", move);
    this.stage.on("pointerup", up);
    this.stage.on("pointerleave", leave);
    this.detachPointer = () => this.stage.off("pointerdown pointermove pointerup pointerleave");
  }

  private onDown(): void {
    if (this.tool === "crop") {
      this.startCropDraft();
      return;
    }
    if (!this.isToolEnabled(this.tool)) return;
    const pos = this.maskLayer.getRelativePointerPosition();
    if (!pos) return;
    if (this.tool === "brush" || this.tool === "eraser") this.startLine(pos);
    else if (this.tool === "rect") this.startRect(pos);
    // pan：不在 maskLayer 绘制。
  }

  private onMove(): void {
    if (this.tool === "crop") {
      if (this.painting) this.updateCropDraft();
      return;
    }
    if (!this.painting) return;
    const pos = this.maskLayer.getRelativePointerPosition();
    if (!pos) return;
    if (this.currentLine) {
      this.currentLine.points([...this.currentLine.points(), pos.x, pos.y]);
      this.maskLayer.batchDraw();
    } else if (this.currentRect) {
      this.updateRect(pos);
    }
  }

  private onUp(): void {
    if (this.tool === "crop") {
      this.commitCropDraft();
      return;
    }
    if (!this.painting) return;
    this.painting = false;
    // 笔触/框选完成 → 包装成 mask 命令入统一历史（节点已实时绘制，入栈不重复 do）。
    if (this.currentRect) {
      if (this.commitRect()) this.commitMaskNode(this.currentRect);
      this.currentRect = null;
      this.rectStart = null;
    } else if (this.currentLine) {
      this.commitMaskNode(this.currentLine);
      this.currentLine = null;
    }
    this.emitChange();
  }

  private startLine(pos: Point): void {
    this.painting = true;
    this.currentLine = new Konva.Line({
      points: [pos.x, pos.y, pos.x, pos.y],
      stroke: PAINT_COLOR,
      strokeWidth: this.brushSize,
      lineCap: "round",
      lineJoin: "round",
      // 画笔叠加；橡皮挖掉已涂区域——这正是 inpaint mask 的天然实现。
      globalCompositeOperation: this.tool === "eraser" ? "destination-out" : "source-over",
    });
    this.maskLayer.add(this.currentLine);
    this.maskLayer.batchDraw();
  }

  // 矩形框选（DESIGN §5.3）：起点 → 临时 Rect → pointerup 固定，叠加进 maskLayer。
  // 用 fill + source-over，与画笔同语义，天然计入 exportMask 覆盖率/二值化、纳入轻量撤销栈。
  private startRect(pos: Point): void {
    this.painting = true;
    this.rectStart = { x: pos.x, y: pos.y };
    this.currentRect = new Konva.Rect({
      x: pos.x,
      y: pos.y,
      width: 0,
      height: 0,
      fill: PAINT_COLOR,
      globalCompositeOperation: "source-over",
    });
    this.maskLayer.add(this.currentRect);
    this.maskLayer.batchDraw();
  }

  private updateRect(pos: Point): void {
    if (!this.currentRect || !this.rectStart) return;
    // 支持任意方向拖拽：取左上角 + 绝对宽高。
    this.currentRect.setAttrs({
      x: Math.min(this.rectStart.x, pos.x),
      y: Math.min(this.rectStart.y, pos.y),
      width: Math.abs(pos.x - this.rectStart.x),
      height: Math.abs(pos.y - this.rectStart.y),
    });
    this.maskLayer.batchDraw();
  }

  /** 固定框选：零面积（仅点击未拖动）丢弃返回 false；有效则保留返回 true（由 onUp 入命令栈）。 */
  private commitRect(): boolean {
    if (!this.currentRect) return false;
    if (this.currentRect.width() < 1 || this.currentRect.height() < 1) {
      this.currentRect.destroy();
      this.maskLayer.batchDraw();
      return false;
    }
    return true;
  }

  // 笔刷光标（DESIGN §5.3）：cursorLayer 跟随指针画圆环，半径=brushSize/2（图像像素）。
  private updateCursor(): void {
    if (this.tool !== "brush" && this.tool !== "eraser") {
      this.hideCursor();
      return;
    }
    const pos = this.maskLayer.getRelativePointerPosition();
    if (!pos) return;
    if (!this.cursorRing) {
      this.cursorRing = new Konva.Circle({
        radius: this.brushSize / 2,
        stroke: CURSOR_COLOR,
        strokeWidth: 1,
        listening: false,
      });
      this.cursorLayer.add(this.cursorRing);
    }
    this.cursorRing.position(pos);
    this.cursorRing.radius(this.brushSize / 2);
    this.cursorRing.visible(true);
    this.cursorLayer.batchDraw();
  }

  private hideCursor(): void {
    if (this.cursorRing?.visible()) {
      this.cursorRing.visible(false);
      this.cursorLayer.batchDraw();
    }
  }

  clearMask(): void {
    // 滤除并销毁 mask 命令（含已撤销节点，防泄漏）；几何命令（方案 A 不依赖 mask 节点）保留其撤销能力。
    this.purgeMaskCommands();
    // 兜底销毁未提交的在途节点（极少：clearMask 撞上进行中的笔触）。
    this.maskLayer.destroyChildren();
    this.lastCoverage = 0;
    this.maskLayer.draw();
    this.emitChange();
  }

  // 统一命令撤销/重做（DESIGN §5.6）：mask 笔触与几何变换同栈，几何 undo 只逆变换、无需恢复像素。
  undo(): void {
    const cmd = this.history.pop();
    if (!cmd) return;
    cmd.undo();
    this.redoStack.push(cmd);
    this.emitChange();
  }

  redo(): void {
    const cmd = this.redoStack.pop();
    if (!cmd) return;
    cmd.do();
    this.history.push(cmd);
    this.emitChange();
  }

  /** 记一次已完成的操作入历史并切断 redo 分支。节点/变换已实时应用，入栈不重复 do。 */
  private pushCommand(cmd: Command): void {
    this.history.push(cmd);
    this.redoStack = [];
  }

  /** mask 笔触/框选命令：do=挂回 maskLayer，undo=摘除（节点保活，可被 redo 复用），dispose=销毁节点。 */
  private commitMaskNode(node: Konva.Node): void {
    this.pushCommand({
      kind: "mask",
      do: () => {
        this.maskLayer.add(node as Konva.Shape);
        this.maskLayer.batchDraw();
      },
      undo: () => {
        node.remove();
        this.maskLayer.batchDraw();
      },
      dispose: () => node.destroy(),
    });
  }

  /** 清出 mask 类命令并销毁其节点（含已撤销、仅存于命令闭包的节点），geom 命令保留。 */
  private purgeMaskCommands(): void {
    for (const c of [...this.history, ...this.redoStack]) {
      if (c.kind === "mask") c.dispose?.();
    }
    this.history = this.history.filter((c) => c.kind !== "mask");
    this.redoStack = this.redoStack.filter((c) => c.kind !== "mask");
  }

  /** 清空全部命令并销毁所有命令独占资源（loadSource/reset 用）。 */
  private purgeAllCommands(): void {
    for (const c of [...this.history, ...this.redoStack]) c.dispose?.();
    this.history = [];
    this.redoStack = [];
  }

  // ---- 几何变换（DESIGN §5.4，方案 A 矢量：只改 layer transform 与画幅，不烘焙像素） --------

  /**
   * 合并几何变换（对 `TransformState` 做 merge 覆盖，**非增量**）并记入命令历史。
   * `crop` 表达在 flip+rotate **之后**的画布坐标系内（§5.4.1）；`rotate` 为绝对角度（内部归一化）。
   * ⚠️ 已有 crop 时再改 rotate/flip 为纯 merge，crop 坐标仍按"当次 rotate 结果"解释（§5.4 已知边界，常见 UX 是 crop 最后做）。
   */
  applyTransform(patch: Partial<TransformState>): void {
    if (this.srcW === 0) return; // 未加载源图，几何无意义
    const prev = this.transform;
    const next = normalizeTransform({ ...this.transform, ...patch });
    if (sameTransform(prev, next)) return; // 无实际变化不入栈
    const cmd: Command = {
      kind: "geom",
      do: () => {
        this.transform = next;
        this.applyTransformToLayers();
      },
      undo: () => {
        this.transform = prev;
        this.applyTransformToLayers();
      },
    };
    cmd.do();
    this.pushCommand(cmd);
    this.emitChange();
  }

  /** 整步旋转 90°（增量便捷方法）：cw 顺时针 / ccw 逆时针。 */
  rotate(dir: "cw" | "ccw" = "cw"): void {
    const delta = dir === "cw" ? 90 : 270;
    this.applyTransform({ rotate: ((this.transform.rotate + delta) % 360) as TransformState["rotate"] });
  }

  /** 水平翻转（切换 flipX）。 */
  flipHorizontal(): void {
    this.applyTransform({ flipX: !this.transform.flipX });
  }

  /** 垂直翻转（切换 flipY）。 */
  flipVertical(): void {
    this.applyTransform({ flipY: !this.transform.flipY });
  }

  /**
   * 把当前 transform 套到 base/mask/cursor 三层 layer，并更新画幅真相源 `imageW/imageH`、`stage.size`。
   * 数学复用 `coords.toDisplaySpace`（已 203 单测护栏，红线6）：因 Konva layer 的
   * `world(p)=position+R(rotation)·S(scale)·p` 恰等于 `toDisplaySpace(p)`，故
   * `position = toDisplaySpace(原图原点(0,0))`、`rotation/scaleX/scaleY` 直取 transform，三层共用同一变换 → mask 与底图天然对齐。
   * 仅改 layer transform，**绝不动** `stage.scale/position`（几何与显示缩放正交 §5.4.2）。
   */
  private applyTransformToLayers(): void {
    const t = this.transform;
    const size = transformedSize(this.srcW, this.srcH, t);
    this.imageW = size.width;
    this.imageH = size.height;
    this.stage.size({ width: this.imageW, height: this.imageH });

    const pos = toDisplaySpace(
      { x: 0, y: 0 },
      { transform: t, zoom: 1, pan: { x: 0, y: 0 }, imageW: this.srcW, imageH: this.srcH },
    );
    for (const layer of [this.baseLayer, this.maskLayer, this.cursorLayer]) {
      layer.rotation(t.rotate);
      layer.scaleX(t.flipX ? -1 : 1);
      layer.scaleY(t.flipY ? -1 : 1);
      layer.position(pos);
      layer.batchDraw();
    }
  }

  // ---- 交互式裁剪（DESIGN §5.4 L4c） -----------------------------------------
  // 裁剪框在当前显示（stage）坐标系拖拽选取；应用时与已有 crop 原点合成到 flip+rotate-after 全空间。

  /** 设置裁剪比例档位（数字=宽高比，'free'=自由）。裁剪模式下立即按比例重置默认框。 */
  setCropRatio(ratio: number | "free"): void {
    this.cropRatio = ratio;
    if (this.tool === "crop") {
      this.cropDraft = this.defaultCropDraft();
      this.cropLayer.batchDraw();
      this.emitChange();
    }
  }

  /** 应用当前裁剪草稿：合成进 transform.crop 并走命令历史；随后退出覆盖层（工具切换由宿主决定）。 */
  applyCrop(): void {
    const d = this.cropDraft;
    if (!d || d.width < CROP_MIN_SIZE || d.height < CROP_MIN_SIZE) return;
    // 草稿在当前显示空间；与已有 crop 原点相加得 flip+rotate-after 全空间坐标（zoom=1/pan=0，L6 接入缩放后改走 coords）。
    const base = this.transform.crop;
    // 裁剪表达空间边界 = 旋转后未裁剪全画幅。clamp 杜绝合成/编程式草稿越界产生空白边（红线4：画幅须落在源图内）。
    const bounds = transformedSize(this.srcW, this.srcH, { ...this.transform, crop: null });
    const x = clamp(Math.round((base?.x ?? 0) + d.x), 0, Math.max(0, bounds.width - CROP_MIN_SIZE));
    const y = clamp(Math.round((base?.y ?? 0) + d.y), 0, Math.max(0, bounds.height - CROP_MIN_SIZE));
    const crop: Rect = {
      x,
      y,
      width: clamp(Math.round(d.width), CROP_MIN_SIZE, bounds.width - x),
      height: clamp(Math.round(d.height), CROP_MIN_SIZE, bounds.height - y),
    };
    this.exitCrop();
    this.applyTransform({ crop });
  }

  /** 取消裁剪：丢弃草稿、退出覆盖层，不改变 transform。 */
  cancelCrop(): void {
    this.exitCrop();
    this.emitChange();
  }

  private enterCrop(): void {
    if (this.srcW === 0) return;
    this.cropLayer.destroyChildren();
    // 自绘 Shape：填满暗化遮罩 → clearRect 抠出裁剪框 → 描边。草稿变化时 batchDraw 重跑 sceneFunc。
    this.cropShade = new Konva.Shape({
      listening: false,
      sceneFunc: (ctx) => {
        ctx.fillStyle = CROP_SHADE_COLOR;
        ctx.fillRect(0, 0, this.imageW, this.imageH);
        const d = this.cropDraft;
        if (!d) return;
        ctx.clearRect(d.x, d.y, d.width, d.height);
        ctx.strokeStyle = CROP_BORDER_COLOR;
        ctx.lineWidth = 2;
        ctx.strokeRect(d.x, d.y, d.width, d.height);
      },
    });
    this.cropLayer.add(this.cropShade);
    this.cropDraft = this.defaultCropDraft();
    this.cropLayer.visible(true);
    this.cropLayer.batchDraw();
  }

  private exitCrop(): void {
    this.cropLayer.visible(false);
    this.cropLayer.destroyChildren();
    this.cropShade = null;
    this.cropDraft = null;
    this.cropDragStart = null;
    this.painting = false;
  }

  /** stage 指针位置（clamp 进当前画幅）。裁剪在 stage 空间，故不用 maskLayer 的本地坐标。 */
  private cropPointer(): Point | null {
    const p = this.stage.getPointerPosition();
    if (!p) return null;
    return { x: clamp(p.x, 0, this.imageW), y: clamp(p.y, 0, this.imageH) };
  }

  private startCropDraft(): void {
    const p = this.cropPointer();
    if (!p) return;
    this.painting = true;
    this.cropDragStart = p;
    this.cropDraft = { x: p.x, y: p.y, width: 0, height: 0 };
    this.cropLayer.batchDraw();
  }

  private updateCropDraft(): void {
    const p = this.cropPointer();
    if (!p || !this.cropDragStart) return;
    this.cropDraft = this.fitRatioRect(this.cropDragStart.x, this.cropDragStart.y, p.x, p.y);
    this.cropLayer.batchDraw();
  }

  private commitCropDraft(): void {
    this.painting = false;
    this.cropDragStart = null;
    // 误点（未拖出有效面积）回退默认框，避免应用到极小区域。
    if (this.cropDraft && (this.cropDraft.width < CROP_MIN_SIZE || this.cropDraft.height < CROP_MIN_SIZE)) {
      this.cropDraft = this.defaultCropDraft();
      this.cropLayer.batchDraw();
    }
    this.emitChange();
  }

  /** 默认裁剪框：自由比例=全画幅；定比例=居中最大内接框。 */
  private defaultCropDraft(): Rect {
    const r = this.cropRatio;
    if (typeof r !== "number" || r <= 0) {
      return { x: 0, y: 0, width: this.imageW, height: this.imageH };
    }
    let w = this.imageW;
    let h = w / r;
    if (h > this.imageH) {
      h = this.imageH;
      w = h * r;
    }
    return { x: (this.imageW - w) / 2, y: (this.imageH - h) / 2, width: w, height: h };
  }

  /** 由拖拽两点得裁剪框：定比例时以宽定高、超界再反推，最后 clamp 进画幅。 */
  private fitRatioRect(x0: number, y0: number, x1: number, y1: number): Rect {
    const x = Math.min(x0, x1);
    const y = Math.min(y0, y1);
    let w = Math.abs(x1 - x0);
    let h = Math.abs(y1 - y0);
    const r = this.cropRatio;
    if (typeof r === "number" && r > 0) {
      h = w / r;
      if (y + h > this.imageH) {
        h = this.imageH - y;
        w = h * r;
      }
      if (x + w > this.imageW) {
        w = this.imageW - x;
        h = w / r;
      }
    }
    return { x, y, width: Math.min(w, this.imageW - x), height: Math.min(h, this.imageH - y) };
  }

  // ---- 调整（DESIGN §5.5） ----------------------------------------------------

  setAdjust(a: Partial<AdjustValues>): void {
    this.adjust = { ...this.adjust, ...a };
    // 实时预览由组件对画布容器套 CSS filter（GPU，§5.5）；导出时 exportResult 用 ctx.filter 把同串烘焙进 image 像素。
    // 实时改不入历史（滑块拖拽会刷屏），由 commitAdjust 在释放时合为单条命令。
    this.emitChange();
  }

  /** 把自上次提交以来的调整合为一条可撤销命令（滑块 change/释放时调）。无变化则跳过。 */
  commitAdjust(): void {
    if (sameAdjust(this.committedAdjust, this.adjust)) return;
    const prev = { ...this.committedAdjust };
    const next = { ...this.adjust };
    const apply = (v: AdjustValues): void => {
      this.adjust = { ...v };
      this.committedAdjust = { ...v };
      this.emitChange();
    };
    this.committedAdjust = next;
    this.pushCommand({ kind: "adjust", do: () => apply(next), undo: () => apply(prev) });
    this.emitChange();
  }

  // ---- 导出（命脉，PoC 已验证） --------------------------------------------

  /** 蒙版层 → 反转 alpha 的透明 PNG。涂抹区 alpha=0（要重绘），其余黑色不透明（保留）。 */
  async exportMask(): Promise<Blob | null> {
    if (this.imageW === 0 || this.maskLayer.getChildren().length === 0) {
      this.lastCoverage = 0;
      return null;
    }
    try {
      const src = this.maskLayer.toCanvas({ x: 0, y: 0, width: this.imageW, height: this.imageH, pixelRatio: 1 });
      const sdata = src.getContext("2d")!.getImageData(0, 0, this.imageW, this.imageH).data;

      const out = document.createElement("canvas");
      out.width = this.imageW;
      out.height = this.imageH;
      const octx = out.getContext("2d")!;
      const odata = octx.createImageData(this.imageW, this.imageH);

      const invert = this.options.maskPolarity === "paint-to-edit";
      let painted = 0;
      for (let i = 0; i < sdata.length; i += 4) {
        const isPainted = sdata[i + 3]! > PAINT_ALPHA_THRESHOLD;
        if (isPainted) painted++;
        // paint-to-edit：涂抹→透明；paint-to-keep：涂抹→不透明。
        const transparent = invert ? isPainted : !isPainted;
        odata.data[i + 3] = transparent ? 0 : 255; // RGB 留 0（黑）
      }
      octx.putImageData(odata, 0, 0);
      this.lastCoverage = painted / (this.imageW * this.imageH);

      // TODO(L6): feather>0 时对 alpha 边缘 blur。注意与上面的硬二值化耦合——加羽化时这段要改成保留中间 alpha。
      // TODO(perf): 4096² 逐像素循环会卡主线程，可改 GPU 合成 / OffscreenCanvas + Worker。

      // mask 恒导出无损 PNG，不跟随 output.type/quality（DESIGN §1：webp/有损会破坏 alpha 边界）。
      return await canvasToBlob(out, "image/png");
    } catch (err) {
      // 跨域源图会污染 canvas，toCanvas/toBlob 抛 SecurityError——转成 error 事件而非裸抛。
      const e = err instanceof Error ? err : new Error(String(err));
      markEmitted(e);
      this.emit("error", e);
      throw e;
    }
  }

  async exportResult(): Promise<StudioResult> {
    try {
      const imageCanvas = document.createElement("canvas");
      imageCanvas.width = this.imageW;
      imageCanvas.height = this.imageH;
      const ictx = imageCanvas.getContext("2d")!;
      // 调整非零时烘焙进像素（实时预览另由 Vue 层套容器 CSS filter，见 DESIGN.md §5.5）。
      ictx.filter = adjustToCssFilter(this.adjust);
      ictx.drawImage(
        this.baseLayer.toCanvas({ x: 0, y: 0, width: this.imageW, height: this.imageH, pixelRatio: 1 }),
        0,
        0,
      );

      const image = await canvasToBlob(imageCanvas, this.options.output?.type ?? "image/png", this.options.output?.quality);
      const mask = await this.exportMask();

      return {
        image,
        mask,
        width: this.imageW,
        height: this.imageH,
        hasMask: mask != null,
        maskCoverage: this.lastCoverage,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      // exportMask 已 emit 过的错误（复用路径）不二次 emit；image 阶段新错误仍 emit 一次。
      if (!isEmitted(e)) this.emit("error", e);
      throw e;
    }
  }

  reset(): void {
    // 全量复位：清蒙版（销毁含已撤销节点）+ 还原几何（套回三层 layer）+ 清调整 + 清空整个命令历史。
    this.purgeAllCommands();
    this.maskLayer.destroyChildren();
    this.lastCoverage = 0;
    this.transform = { ...IDENTITY_TRANSFORM };
    this.adjust = { brightness: 0, contrast: 0, saturate: 0 };
    this.committedAdjust = { brightness: 0, contrast: 0, saturate: 0 };
    this.applyTransformToLayers();
    // 若 reset 时正处裁剪模式，刷新覆盖层到还原后的画幅（否则草稿引用旧画幅）。
    if (this.tool === "crop") this.enterCrop();
    this.emitChange();
  }

  // ---- 事件 -----------------------------------------------------------------

  on<E extends EventName>(event: E, cb: EngineEvents[E]): () => void {
    const set = this.handlers[event] as Set<EngineEvents[E]>;
    set.add(cb);
    return () => void set.delete(cb);
  }

  private emit<E extends EventName>(event: E, ...args: Parameters<EngineEvents[E]>): void {
    // 一处 cast 收口联合分发的固有限制（不再是 unknown[]）；listener 抛错不中断其余。
    const set = this.handlers[event] as Set<(...a: Parameters<EngineEvents[E]>) => void>;
    set.forEach((cb) => {
      try {
        cb(...args);
      } catch (err) {
        console.error("[vue-inpaint-canvas] event listener error:", err);
      }
    });
  }

  private emitChange(): void {
    this.emit("change", this.getState());
  }

  getState(): StudioStateBrief {
    const hasMask = this.maskLayer.getChildren().length > 0;
    const t = this.transform;
    const a = this.adjust;
    const transformed = t.rotate !== 0 || t.flipX || t.flipY || t.crop != null;
    const adjusted = a.brightness !== 0 || a.contrast !== 0 || a.saturate !== 0;
    return {
      tool: this.tool,
      dirty: hasMask || transformed || adjusted,
      hasMask,
      maskCoverage: this.lastCoverage,
      canUndo: this.history.length > 0,
      canRedo: this.redoStack.length > 0,
      zoom: this.stage.scaleX(),
      transform: { ...t, crop: t.crop ? { ...t.crop } : null },
      adjust: { ...a },
    };
  }

  destroy(): void {
    this.detachPointer?.();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.stage.destroy();
    // 复位尺寸真相源：destroy 后再调 applyTransform/export 等会因 srcW/imageW===0 安全 no-op，不触碰已销毁的 stage。
    this.srcW = 0;
    this.srcH = 0;
    this.imageW = 0;
    this.imageH = 0;
    this.history = [];
    this.redoStack = [];
    this.currentLine = null;
    this.currentRect = null;
    this.rectStart = null;
    this.cursorRing = null;
    this.cropShade = null;
    this.cropDraft = null;
    this.cropDragStart = null;
    this.painting = false;
    this.objectUrl = null;
    this.handlers = { ready: new Set(), change: new Set(), error: new Set() };
  }
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 把 rotate 归一化到 {0,90,180,270}（容忍增量/负值）。 */
function normalizeTransform(t: TransformState): TransformState {
  return { ...t, rotate: ((((t.rotate % 360) + 360) % 360) as TransformState["rotate"]) };
}

/** 两个 transform 是否等价（用于 applyTransform 去抖，无变化不入命令栈）。 */
function sameTransform(a: TransformState, b: TransformState): boolean {
  return a.rotate === b.rotate && a.flipX === b.flipX && a.flipY === b.flipY && sameCrop(a.crop, b.crop);
}
function sameCrop(a: Rect | null, b: Rect | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameAdjust(a: AdjustValues, b: AdjustValues): boolean {
  return a.brightness === b.brightness && a.contrast === b.contrast && a.saturate === b.saturate;
}

/** 给错误打"已 emit"标记，避免 exportResult 复用 exportMask 抛错时二次 emit。 */
function markEmitted(e: Error): void {
  (e as { __vicEmitted?: boolean }).__vicEmitted = true;
}
function isEmitted(e: Error): boolean {
  return (e as { __vicEmitted?: boolean }).__vicEmitted === true;
}

// ---- 辅助 -------------------------------------------------------------------

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob 返回空"))), type, quality);
  });
}

/** 把任意源输入解码为可绘制元素；File/Blob 创建的 object URL 一并返回，由调用方择机 revoke。 */
async function loadImage(
  src: SourceInput,
): Promise<{ element: HTMLImageElement | HTMLCanvasElement; objectUrl: string | null }> {
  if (src instanceof HTMLCanvasElement) return { element: src, objectUrl: null };
  if (src instanceof HTMLImageElement) {
    if (!src.complete) await src.decode();
    return { element: src, objectUrl: null };
  }
  const objectUrl = typeof src === "string" ? null : URL.createObjectURL(src);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = objectUrl ?? (src as string);
  await img.decode();
  return { element: img, objectUrl };
}
