/**
 * 白板 webview 脚本：题面 DOM 之上叠一层画布，用数位笔/鼠标批注，Ctrl+滚轮缩放、拖动平移，
 * 导出逐页 A4 PNG。
 *
 * 跑在 Chromium（webview）里，**不 import 'vscode'** —— 它被 esbuild 单独打成
 * dist/whiteboard.js（浏览器 iife），面板再把文件内容内联进 HTML 走 nonce。
 *
 * 压感：pointerType === "pen" 用 PointerEvent 的真实 pressure；鼠标恒 0.5。
 * perfect-freehand 的 simulatePressure 恒为 false，所以鼠标画等宽线、只有真笔才有粗细变化。
 * 笔宽按工具条上的档位（细/中/粗/特粗，`[`/`]` 切换）**逐笔存**在笔画里，改档位不影响已画好的笔迹。
 */

import {
  DEFAULT_PEN_COLOR,
  DEFAULT_STROKE_WIDTH,
  ERASER_RADIUS,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  MAX_PAGES,
  MIN_POINT_DISTANCE,
  MOUSE_PRESSURE,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PENS,
  PEN_WIDTHS,
  clampPageCount,
  clampPressure,
  clampZoom,
  exportScale,
  pageTop,
  pagesHeight,
  resolvePageCount,
  sanitizeStrokes,
  screenToWorld,
  strokeHitByPoint,
  strokeOutline,
  totalPageCount,
  worldToScreen,
  zoomAt,
  type Stroke,
  type View,
} from "./model";
import { FrameLoop } from "./frameLoop";

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

interface Payload {
  displayId: string;
  title: string;
  strokes: unknown;
  /** 上次手动加出来的页数（缺省 1） */
  pages?: number;
  /** 导出像素尺寸（面板按 `lgAssist.whiteboard.exportDpi` 算好传进来） */
  exportWidth?: number;
  exportHeight?: number;
}

interface ExtMessage {
  command?: string;
  css?: string;
  ok?: boolean;
}

const vscode = acquireVsCodeApi();

let viewport: HTMLDivElement;
let world: HTMLDivElement;
let sheet: HTMLDivElement;
let marksOut: HTMLDivElement;
let marks: HTMLDivElement;
let canvas: HTMLCanvasElement;
let zoomLabel: HTMLButtonElement;
let statusLabel: HTMLSpanElement;
let pagesLabel: HTMLSpanElement;
let statsLabel: HTMLSpanElement;
let eraserButton: HTMLButtonElement;
/** 题面的容器（`.oi-sheet-body`）：只用来判「这一下发生在题面区还是空白纸」，诊断日志用 */
let sheetBody: HTMLElement | null = null;

let view: View = { zoom: 1, panX: 0, panY: 0 };
let strokes: Stroke[] = [];
/** 与 strokes 一一对应的 Path2D 缓存（世界坐标，随 ctx 变换缩放，缩放时不必重建） */
let paths: (Path2D | null)[] = [];
/** 撤销栈：每次改动前压一份快照，清空/擦除也能撤回来 */
const history: Array<{ strokes: Stroke[]; paths: (Path2D | null)[] }> = [];

let live: Stroke | null = null;
let livePath: Path2D | null = null;
/**
 * 正在写的这一笔的轮廓需要重算（点在移动时只打这个标记，真正的重算交给这一帧的 draw）。
 *
 * 为什么：高回报率的数位笔一秒能送来上百个 pointermove（还带 coalesced 事件），
 * 每个事件都把**整条**笔画重跑一遍 perfect-freehand = 平方级开销，长笔画越写越卡。
 * 每帧至多算一次就够 —— 屏幕上每帧也只画一次。
 */
let liveDirty = false;
let color = DEFAULT_PEN_COLOR;
/** 当前笔宽档（PEN_WIDTHS 里的 value）：开新笔画时用它 */
let strokeWidth = DEFAULT_STROKE_WIDTH;
/** 橡皮擦工具是否选中（划过即擦掉整笔） */
let eraserMode = false;
/** 正在按住擦（一次按住 = 一次可撤销的擦除） */
let erasing = false;
let erasePointer: number | null = null;
/** 本次按住是否已经压过快照（没擦到东西就不要往撤销栈里塞空操作） */
let eraseTouched = false;
/** 指针在世界坐标里的位置（笔形指示器与橡皮擦圈都画在这里；离开视口为 null） */
let hover: [number, number] | null = null;
/**
 * 当前用的是哪类指针（"mouse" / "pen" / "touch"）。
 *
 * 数位笔一接触，系统就把鼠标光标藏起来（抬笔才回来），所以笔/触摸时我们自己画一个笔尖指示器，
 * 同时显式把系统光标藏掉（`#viewport.wb-pen-cursor`），免得出现两种指示器。
 * 鼠标照旧用系统十字光标。
 */
let pointerKind = "mouse";
/** 当前这一笔是什么时候、以什么方式开始的（诊断日志用） */
let strokeStart = 0;
let strokeRoute = "pointerdown";
/** 指针序列断流并被救回来的次数（工具栏可见；正常应为 0） */
let brokenSequences = 0;
/**
 * 被浏览器**取消**的指针序列次数（pointercancel），以及拦下的原生手势次数（选字 / 拖拽）。
 *
 * 这两个数是「笔走一小段就断、得抬笔重落」的分流依据，都显示在工具栏上：
 * - `取消 N` 涨了：浏览器终止了这一条指针序列（原生拖拽、系统手势、笔离开感应区…）。
 *   这不是我们丢事件 —— 之后同一个 pointerId 再无任何事件，只能抬笔重来；
 * - `拦手势 N` 涨了：题面 DOM 差点又被当成网页（选字 / 拖拽）。本该被 CSS 挡住，
 *   真涨了就说明有东西绕过了 `#viewport` 的 user-select / user-drag。
 */
let cancelledPointers = 0;
let nativeGestures = 0;
/** 最近一次被拦下的原生手势（dragstart / selectstart），取消发生时带进日志当上下文 */
let nativeGesture: string | null = null;

let contentHeight = 0;
/** 题面自己需要几页（由内容高度决定） */
let contentPages = 1;
/** 用户点「加页」加出来的页数（至少 1 页；落盘，重开面板还在） */
let minPages = 1;
/** 屏幕上实际铺几张 A4 = max(contentPages, minPages) */
let pages = 1;

let activePointer: number | null = null;
let panPointer: number | null = null;
let panFrom: { sx: number; sy: number; panX: number; panY: number } | null = null;
let spaceDown = false;

let exporting = false;

/** 导出像素尺寸：由面板按设置的 dpi 算好放进载荷；载荷没带就用默认档的尺寸 */
let exportW = EXPORT_WIDTH;
let exportH = EXPORT_HEIGHT;

let exportCss: string | null = null;
let exportCssOk = true;
let pendingCss: ((v: { css: string; ok: boolean }) => void) | null = null;

function must<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`白板缺少元素 #${id}`);
  return el as T;
}

/** 载荷里的正整数（导出尺寸）：不是正数就退回兜底值，免得导出画布变成 0×0 */
function positiveInt(v: unknown, fallback: number): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function reportError(e: unknown): void {
  vscode.postMessage({ command: "error", message: e instanceof Error ? e.message : String(e) });
}

function setStatus(text: string): void {
  if (statusLabel) statusLabel.textContent = text;
}

// ── 渲染 ────────────────────────────────────────────────────────────────

/**
 * 构建一笔的轮廓路径。**绝不抛异常**：抛出来会让 `strokes`/`paths` 两个数组错位，
 * 之后每一笔都会配错轮廓（表现为「新画的那一笔一直不显示」），代价远大于丢一笔。
 *
 * 传了 log 就把这一笔的统计塞进「最近几笔」环状缓冲——**平时不输出**，一旦出现异常，
 * notify 会把这几条一起打进日志当上下文（每笔都刷一行会把输出面板淹掉，反而没人看）。
 */
function buildPath(stroke: Stroke, log?: { index: number; route: string; ms: number }): Path2D | null {
  try {
    const outline = strokeOutline(stroke);
    if (log) {
      recentStrokes.push(`#${log.index} 点${stroke.points.length} 轮廓${outline.length} ${log.route} ${Math.round(log.ms)}ms`);
      if (recentStrokes.length > 8) recentStrokes.shift();
    }
    // 轮廓不够画（退化输入）：返回一个**空路径**（可缓存、填不出墨），并已经记过日志。
    // 不返回 null 是为了避免每帧都重算一遍这个不可能画出来的轮廓。
    if (outline.length < 3) return new Path2D();
    const path = new Path2D();
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) path.lineTo(outline[i][0], outline[i][1]);
    path.closePath();
    return path;
  } catch (e) {
    notify("outline-throw", `轮廓构建抛异常：${e instanceof Error ? e.message : String(e)}`, 3);
    return null;
  }
}

function rebuildPaths(): void {
  paths = strokes.map((s) => buildPath(s));
  invalidateBase();
}

/**
 * 取第 i 笔的轮廓路径：缓存缺失就按需重建。
 * 画的时候「自愈」很关键 —— 缓存里少一项（或某项为 null）时，也不能让那一笔从画面上消失。
 */
function pathOf(i: number): Path2D | null {
  const cached = paths[i];
  if (cached) return cached;
  const stroke = strokes[i];
  if (!stroke) return null;
  const built = buildPath(stroke);
  if (built) paths[i] = built;
  else notify("outline-empty", `第 ${i + 1} 笔没有可画的轮廓（点数 ${stroke.points.length}），已跳过`, 5);
  return built;
}

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, viewport.clientWidth);
  const h = Math.max(1, viewport.clientHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  settleBaseSoon(); // 尺寸变了：先按变换复用旧位图，停手后再矢量重画
}

/**
 * 「已经提交的笔迹」的离屏缓存。
 *
 * 为什么要这一层：draw() 每帧都要重填**全部**笔迹，一堂课在同一张纸上写几千笔之后，
 * 单帧光填路径就要十几毫秒 —— 手感就是「笔跟不上手」。缓存之后每帧只要 drawImage 一次
 * （独立合成层，几乎不要钱），只有「笔迹集合变了」（落笔提交 / 擦除 / 撤销 / 清空）
 * 才需要真的重画它。
 *
 * 视角变化（缩放 / 平移）与画布尺寸变化（面板尺寸 / dpr）**不立刻重画**：
 * 连续手势里每个 tick 都重画一遍全量笔迹，等于把缓存的收益在「最需要跟手的时候」全部吃掉
 * （几千笔时每帧十几毫秒，缩放和拖面板直接掉帧）。这两类变化改走 `blitBase()` ——
 * 按新旧变换的差把旧位图映射过来，一次 drawImage 搞定，手势停后再矢量重画一次让边缘清晰。
 */
let base: HTMLCanvasElement | null = null;
let baseDirty = true;
/** base 是按哪一套视角画的（device = dpr * (zoom * world + pan)），变换绘制时要用 */
let baseView: View | null = null;
let baseDpr = 1;
/** 视角/尺寸变过、还没矢量重画过 —— 与 baseDirty 分开，避免两者互相抵消 */
let baseStale = false;

function invalidateBase(): void {
  baseDirty = true;
}

/** 手势停手后再矢量重画的防抖间隔：太短会退化成每帧重画，太长会让缩放后一直是糊的 */
const BASE_SETTLE_MS = 120;
let baseSettleTimer = 0;

/**
 * 视角/尺寸变了，但**笔迹一个没动** —— 所以不必重画，让 draw() 走变换绘制即可。
 * 手势结束后再补一次矢量重画（BASE_SETTLE_MS 内没有新的变化才真的重画）。
 */
function settleBaseSoon(): void {
  baseStale = true;
  if (baseSettleTimer) clearTimeout(baseSettleTimer);
  baseSettleTimer = window.setTimeout(() => {
    baseSettleTimer = 0;
    // 这期间笔迹已经自己 invalidate 过（落笔/擦除/撤销），drawBase 顺手就画的是当前视角，不用再来一遍
    if (!baseStale || baseDirty) return;
    invalidateBase();
    schedule();
  }, BASE_SETTLE_MS);
}

function drawBase(): void {
  if (!base) base = document.createElement("canvas");
  if (base.width !== canvas.width || base.height !== canvas.height) {
    base.width = canvas.width;
    base.height = canvas.height;
  }
  const g = base.getContext("2d");
  if (!g) return;
  const dpr = window.devicePixelRatio || 1;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, base.width, base.height);
  // 世界坐标 → 设备像素（与主画布同一套变换）
  g.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
  // 以 strokes 为准遍历（paths 只是缓存），这样即使缓存缺项也不会漏画某一笔
  for (let i = 0; i < strokes.length; i++) {
    const path = pathOf(i);
    if (!path) continue;
    g.fillStyle = strokes[i].color;
    g.fill(path);
  }
  baseView = { ...view };
  baseDpr = dpr;
  baseStale = false;
}

/**
 * 把离屏那份笔迹贴到主画布上。
 *
 * 视角与画布尺寸都和当初画 base 时一致 → 原样 drawImage（最常见的一帧，几乎不要钱）。
 * 不一致（正在缩放 / 平移 / 拖面板边缘）→ 按变换差把旧位图映射过来，同样只是一次 drawImage：
 *
 *   画 base 时：device0 = dpr0 * (zoom0 * world + pan0)   ⟹   world = (device0 / dpr0 - pan0) / zoom0
 *   现在要的是：device1 = dpr1 * (zoom1 * world + pan1)
 *   代入化简：  device1 = k * device0 + t，其中 k = dpr1*zoom1 / (dpr0*zoom0)，
 *              t = dpr1*pan1 - k * dpr0 * pan0（x / y 各一份）
 *
 * 即「先按 k 缩放、再平移 t」。缩放过程中笔迹会略微发糊、平移时前沿会有一条窄带暂时是空的
 * （旧位图没覆盖到新露出来的那部分），停手后 settleBaseSoon() 补的那次矢量重画会立刻抹平。
 */
function blitBase(g: CanvasRenderingContext2D, dpr: number): void {
  if (!base) return;
  const from = baseView;
  if (!from || (from.panX === view.panX && from.panY === view.panY && from.zoom === view.zoom
    && baseDpr === dpr && base.width === canvas.width && base.height === canvas.height)) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(base, 0, 0);
    return;
  }
  const k = (dpr * view.zoom) / (baseDpr * from.zoom);
  g.setTransform(k, 0, 0, k, dpr * view.panX - k * baseDpr * from.panX, dpr * view.panY - k * baseDpr * from.panY);
  g.drawImage(base, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
}

function draw(): void {
  const g = canvas.getContext("2d");
  if (!g) return;
  if (canvas.width <= 1 || canvas.height <= 1) {
    notify("canvas-zero", `画布尺寸异常（${canvas.width}×${canvas.height}），这一段不会显示`, 2);
    return;
  }
  if (paths.length !== strokes.length) {
    notify("cache-desync", `轮廓缓存与笔画数不一致（${paths.length} vs ${strokes.length}），已按笔画重建`, 3);
  }
  const dpr = window.devicePixelRatio || 1;

  // 笔迹集合变了才真的重画全量；只看视角/尺寸变化时由 blitBase 按变换复用（见 base 那段注释）
  if (baseDirty || !base || !baseView) {
    drawBase();
    baseDirty = false;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  blitBase(g, dpr);

  // 世界坐标 → 设备像素：屏幕坐标 = 世界 × zoom + pan
  g.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);
  if (live) {
    // 正在写的这一笔：轮廓每帧至多重算一次（pointermove 里只打 liveDirty）
    if (liveDirty || !livePath) {
      livePath = buildPath(live);
      liveDirty = false;
    }
    if (livePath) {
      g.fillStyle = live.color;
      g.fill(livePath);
    }
  }
  if (eraserMode && hover) {
    // 擦除半径的圈：让「擦到哪」看得见。线宽除以 zoom 是为了屏幕上始终约 1.5px
    g.beginPath();
    g.arc(hover[0], hover[1], ERASER_RADIUS, 0, Math.PI * 2);
    g.strokeStyle = "#7a8496";
    g.lineWidth = 1.5 / view.zoom;
    g.stroke();
  }
  if (penCursorVisible()) {
    // 指示器按屏幕像素画（不随缩放变大变小），所以要先把变换还原成设备像素
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawPenCursor(g);
  }
  updateStats();
}

/**
 * 笔形指示器该不该画：只有**非鼠标**指针（数位笔/触摸）才自己画。
 *
 * 数位笔一接触，系统就把鼠标光标藏起来 —— 这正是「写字时指示光标消失、抬笔才出现」的原因；
 * 鼠标的系统十字光标一直都在，再画一个只会变成两个指示器。
 */
function penCursorVisible(): boolean {
  return pointerKind !== "mouse" && hover !== null && panPointer === null && !eraserMode && !erasing;
}

/** 悬停（没接触）时移动也要让指示器跟手 —— 这条路径原本完全不重绘 */
function scheduleIfPenCursor(): void {
  if (penCursorVisible()) schedule();
}

/**
 * 笔形指示器：一个空心圈 + 斜着伸出的笔杆，**圈的圆心就是笔尖**，
 * 与笔迹出现的位置重合（正在画的笔迹 livePath 也画在这个点上）。
 *
 * 空心是刻意的：实心图标会盖住刚写下的那一笔，空心只有 1.5px 的圈线压在上面。
 * 笔杆朝**右上方**伸 —— 和右手握笔的姿势一致（笔尖在左下、笔杆斜向右上），
 * 而且这条方向落在「还没写到」的上方，不会压住刚写下的这一笔。
 * 尺寸用屏幕像素（调用前已把变换还原成设备像素），缩放时手上的感觉才一致。
 */
function drawPenCursor(g: CanvasRenderingContext2D): void {
  if (!hover) return;
  const [sx, sy] = worldToScreen(hover[0], hover[1], view);
  const dx = Math.SQRT1_2; // 45°：右上方（与握笔姿势一致）
  const dy = -Math.SQRT1_2;
  g.save();
  g.strokeStyle = "rgba(122, 132, 150, .9)";
  g.lineWidth = 1.5;
  g.beginPath();
  g.arc(sx, sy, 4.5, 0, Math.PI * 2);
  g.stroke();
  g.beginPath();
  g.moveTo(sx + dx * 7, sy + dy * 7);
  g.lineTo(sx + dx * 18, sy + dy * 18);
  g.stroke();
  g.restore();
}

/**
 * 工具栏上的「笔迹 N」与「断流 M」。
 *
 * 出问题时它们就是分流依据：**笔迹不涨** = 这一笔根本没提交（输入层），
 * **笔迹涨了却没墨** = 重绘层；而**断流** 记的是「指针序列断过但被救回来」的次数 ——
 * 它就是当初「只画出开头一段」的成因，正常应为 0。
 */
function updateStats(): void {
  const parts = [`笔迹 ${strokes.length}`];
  if (brokenSequences > 0) parts.push(`断流 ${brokenSequences}`);
  if (cancelledPointers > 0) parts.push(`取消 ${cancelledPointers}`);
  if (nativeGestures > 0) parts.push(`拦手势 ${nativeGestures}`);
  const text = parts.join(" · ");
  if (statsLabel.textContent !== text) statsLabel.textContent = text;
}

/**
 * 重绘节流：拖动中合并成每帧一次；丢帧时由 FrameLoop 的兜底超时补画（见 frameLoop.ts 的说明）。
 * 提交点（一笔画完/撤销/清空）走 flush 直接画，不受动画帧影响。
 */
const frames = new FrameLoop(
  () => draw(),
  {
    request: (cb) => window.requestAnimationFrame(cb),
    cancel: (id) => window.cancelAnimationFrame(id),
    timeout: (cb, ms) => window.setTimeout(cb, ms),
    clear: (id) => window.clearTimeout(id),
  },
  () => notify("raf-stall", "重绘用的动画帧回调被丢弃过（webview 挂起/冻结），已兜底补画"),
);

function schedule(): void {
  frames.schedule();
}

/** 立刻重画一次：笔一落完就调用，这样「提交」这条路不依赖动画帧还活着 */
function drawNow(): void {
  frames.flush();
}

function applyView(): void {
  world.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  zoomLabel.textContent = `${Math.round(view.zoom * 100)}%`;
  // 视角变了但笔迹没动：这一帧由 blitBase 按变换复用，离屏那份留给手势停后再矢量重画
  settleBaseSoon();
}

/** 适应页宽：整页宽度塞进视口（不放大超过 100%），水平居中、顶部留白 */
function fitWidth(): void {
  const pad = 24;
  const avail = Math.max(120, viewport.clientWidth - pad * 2);
  const zoom = clampZoom(Math.min(1, avail / PAGE_WIDTH));
  view = { zoom, panX: Math.max(pad, (viewport.clientWidth - PAGE_WIDTH * zoom) / 2), panY: pad };
  applyView();
  schedule();
}

/**
 * 量题面高度、铺够页数，并标出每张 A4 的页框与页码 —— 虚线框内就是将来会导出的区域，
 * 批注写到框外（或越过分页线）就会丢/被切开，所以这个标界要一眼可见。
 * 标界画在 #sheet 之外的独立层里，导出克隆的是 #sheet，因此不会被带进图片。
 *
 * **量高度前必须先把 min-height 摘掉**：纸张平时被 min-height 撑到整页高，而
 * scrollHeight 是取整过的整数，1122.52px 会量成 1123 → 超过一页 → 每块白板都凭空多出第二页。
 * 摘掉再量才是题面真正需要的高度（不足一页就是一页），量完立刻恢复，中间不会有绘制。
 */
function layoutSheet(): void {
  const prevMin = sheet.style.minHeight;
  sheet.style.minHeight = "0px";
  contentHeight = sheet.scrollHeight;
  sheet.style.minHeight = prevMin;

  contentPages = totalPageCount(contentHeight);
  pages = resolvePageCount(contentHeight, minPages);
  const paperHeight = pagesHeight(pages);
  sheet.style.minHeight = `${paperHeight}px`;

  marksOut.style.width = `${PAGE_WIDTH}px`;
  marksOut.style.height = `${paperHeight}px`;

  marks.textContent = "";
  for (let i = 0; i < pages; i++) {
    const frame = document.createElement("div");
    frame.className = "oi-page-frame";
    frame.style.top = `${pageTop(i)}px`;
    frame.style.width = `${PAGE_WIDTH}px`;
    frame.style.height = `${PAGE_HEIGHT}px`;
    const tag = document.createElement("div");
    tag.className = "oi-page-tag";
    tag.textContent = pages > 1 ? `第 ${i + 1} / ${pages} 页` : "导出范围";
    frame.appendChild(tag);
    marks.appendChild(frame);
  }
  pagesLabel.textContent = pages > 1 ? `共 ${pages} 页 · 虚线框内会导出` : "虚线框内会导出";
}

/** 视口上边距，与 fitWidth 的留白保持一致 */
const VIEW_PAD = 24;

/**
 * 加一页 A4：把新加的那一页滚到视口顶端，正好接着往下写。
 * 页数是「加出来的页数」与「题面需要的页数」取大，所以这里直接钉 pages+1 —— 无论题面多长，
 * 点一下必然多出一页，不会出现「点了没反应」。
 */
function addPage(): void {
  if (pages >= MAX_PAGES) {
    setStatus(`最多 ${MAX_PAGES} 页`);
    return;
  }
  minPages = pages + 1;
  layoutSheet();
  persistPages();
  view = { ...view, panY: -pageTop(pages - 1) * view.zoom + VIEW_PAD };
  applyView();
  schedule();
  setStatus(`已加到 ${pages} 页`);
}

/** 末尾那一页上有没有笔迹（笔画只要有一点落在这一页里就算写了字） */
function inkOnLastPage(): boolean {
  const top = pageTop(pages - 1);
  return strokes.some((s) => s.points.some((p) => p[1] >= top));
}

/**
 * 减掉末尾那张 A4。只减「自己加出来的空白页」：
 * 题面占用的页减不掉，写了字的页要求先擦干净（免得把批注留在纸外面）。
 */
function removePage(): void {
  if (pages <= 1) {
    setStatus("只剩一页了");
    return;
  }
  if (pages <= contentPages) {
    setStatus("这几页是题面占用的，减不掉");
    return;
  }
  if (inkOnLastPage()) {
    setStatus("最后一页还有笔迹，先擦掉再减页");
    return;
  }
  minPages = pages - 1;
  layoutSheet();
  persistPages();
  schedule();
  setStatus(`已减到 ${pages} 页`);
}

// ── 批注 ────────────────────────────────────────────────────────────────

function pressureOf(e: PointerEvent): number {
  return e.pointerType === "pen" ? clampPressure(e.pressure) : MOUSE_PRESSURE;
}

function localPoint(e: { clientX: number; clientY: number }): [number, number] {
  const rect = viewport.getBoundingClientRect();
  return [e.clientX - rect.left, e.clientY - rect.top];
}

/** 事件落在什么元素上（诊断日志用）：标签名 + id/class，一眼看出是题面里的哪一块 */
function describeTarget(t: EventTarget | null): string {
  const el = t as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return "?";
  const id = el.id ? `#${el.id}` : "";
  // SVG 元素的 className 是对象而不是字符串，别直接拿它拼
  const cls = typeof el.className === "string" && el.className ? `.${el.className.split(/\s+/)[0]}` : "";
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

/**
 * 这个点落在题面区还是右侧空白纸（诊断日志用）。
 *
 * 按几何位置判，**不用 `elementFromPoint`** —— 题面整块设了 `pointer-events: none`，
 * 命中测试根本拿不到它；而「题面区 / 空白纸」正是判断这类断笔最要紧的一条线索。
 */
function areaOf(e: { clientX: number; clientY: number }): string {
  if (!sheetBody) return "未知区域";
  const r = sheetBody.getBoundingClientRect();
  const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  return inside ? "题面区" : "空白纸";
}

/**
 * 压一份快照。**连轮廓缓存一起存** —— 撤销时直接把当初那份 paths 恢复回去，
 * 不必对所有笔迹重跑一遍 perfect-freehand（几千笔时那是一整帧级别的开销，
 * 而其中绝大多数笔迹根本没变）。两个数组都是浅拷贝，存的是同一批对象引用，成本只是两个数组。
 */
function snapshot(): void {
  history.push({ strokes: strokes.slice(), paths: paths.slice() });
  if (history.length > 60) history.shift();
}

function appendPoint(ev: PointerEvent): void {
  if (!live) return;
  const [sx, sy] = localPoint(ev);
  const [x, y] = screenToWorld(sx, sy, view);
  const last = live.points[live.points.length - 1];
  if (last && Math.hypot(x - last[0], y - last[1]) < MIN_POINT_DISTANCE) return;
  live.points.push([x, y]);
  live.pressures.push(pressureOf(ev));
}

/** 指针捕获失败（pointerId 已失效等）不该让整支笔跟着失效，包一层即可 */
function capture(id: number): void {
  try {
    viewport.setPointerCapture(id);
  } catch {
    // 没有捕获只是「拖到视口外会丢事件」，画出界外就出界，不影响继续写
  }
}

/**
 * 接触中？（笔尖压在板子上 / 按键按着）
 *
 * **以接触状态驱动，而不是只认 pointerId**：数位笔中途掉序列时（驱动送来一次假的
 * pointerup / pointercancel，或者重新接触后 pointerId 变了），只认 id 的写法会把后半截事件
 * 全部吞掉 —— 屏幕上就是「只画出开头一段」。接触状态不会骗人，所以拿它当依据。
 */
function inContact(e: PointerEvent): boolean {
  return (e.buttons & 1) === 1;
}

/** 开一笔新笔画。除了 pointerdown，还会在「接触中却没在画」时由 pointermove 用来续笔 */
function startStroke(e: PointerEvent, route: string): void {
  const [sx, sy] = localPoint(e);
  const [x, y] = screenToWorld(sx, sy, view);
  activePointer = e.pointerId;
  strokeStart = performance.now();
  strokeRoute = route;
  live = { color, width: strokeWidth, points: [[x, y]], pressures: [pressureOf(e)] };
  livePath = null;
  liveDirty = true; // 轮廓交给这一帧的 draw 算（起笔也一样，反正马上要画）
  capture(e.pointerId);
}

/** 收尾当前笔画：把已经画出来的点提交成正式笔画。pointerup / 失去捕获 / 失焦都走这里，重复调用安全 */
function finishStroke(route = strokeRoute): void {
  const finished = live;
  activePointer = null;
  live = null;
  livePath = null;
  liveDirty = false;
  if (finished && finished.points.length) {
    snapshot();
    strokes.push(finished);
    paths.push(buildPath(finished, { index: strokes.length, route, ms: performance.now() - strokeStart }));
    invalidateBase(); // 笔迹集合变了
  }
  persist();
  drawNow();
}

function endErase(): void {
  if (!erasing) return;
  erasing = false;
  erasePointer = null;
  persist();
  drawNow();
}

/** 假按下（同一笔中途又收到一次 pointerdown）时，新起点离笔尾这么近（屏幕像素）就当成续笔 */
const CONTINUE_SCREEN_DISTANCE = 12;

/**
 * 记下这次用的是笔还是鼠标，并据此显隐系统光标：
 * 笔/触摸时系统光标会被 Chromium 藏起来（写字时看不见指到哪），所以我们自己画的指示器接手，
 * 同时把系统光标显式藏掉 —— 不然笔悬停时会同时看到系统光标和我们的圈，两个指示器互相打架。
 */
function notePointerKind(e: PointerEvent): void {
  if (e.pointerType === pointerKind) return;
  pointerKind = e.pointerType;
  viewport.classList.toggle("wb-pen-cursor", pointerKind !== "mouse");
}

function onPointerDown(e: PointerEvent): void {
  notePointerKind(e);
  if (e.button === 1 || (e.button === 0 && spaceDown)) {
    panPointer = e.pointerId;
    const [sx, sy] = localPoint(e);
    panFrom = { sx, sy, panX: view.panX, panY: view.panY };
    capture(e.pointerId);
    e.preventDefault();
    return;
  }
  if (e.button !== 0 || !e.isPrimary) {
    // 这一下没被当成笔画：如果设备（数位板驱动、系统手势）送来的按钮/指针类型和预期不同，
    // 这里会留下证据——「某一笔没出来」十有八九能在这一行里看出来
    if (e.button !== 0) {
      notify("pointer-ignored", `忽略了一次按键：button=${e.button} type=${e.pointerType} isPrimary=${e.isPrimary}`, 5);
    }
    return;
  }

  const [sx, sy] = localPoint(e);
  const [x, y] = screenToWorld(sx, sy, view);
  // 落笔就把指示器放到笔尖上：第一段笔迹出来之前也不该「看不见指到哪」
  hover = [x, y];

  // 还压着却又来一次 pointerdown：多半是驱动/系统合成的假按下，不该把一笔切成两截。
  // 起点挨着笔尾就当作同一笔继续画（否则会把当前这一笔提前收尾，后半截变成另一笔或直接丢）。
  if (live && inContact(e)) {
    const last = live.points[live.points.length - 1];
    if (last && Math.hypot(x - last[0], y - last[1]) * view.zoom <= CONTINUE_SCREEN_DISTANCE) {
      activePointer = e.pointerId;
      capture(e.pointerId);
      appendPoint(e);
      liveDirty = true;
      schedule();
      e.preventDefault();
      return;
    }
  }

  // 上一次的 pointerup 丢了（切窗口、笔离开感应区、被系统手势劫持…）时，会留着一个「正在画」的状态。
  // 新的主指针按下来就说明上一笔无论如何已经结束，先收尾，免得它跟新的一笔粘在一起。
  if (activePointer !== null) {
    markBroken("上一次没收到 pointerup，新按压时补收尾");
    finishStroke("上一次没收到 pointerup");
  }
  if (erasing) endErase();

  if (eraserMode) {
    erasing = true;
    erasePointer = e.pointerId;
    eraseTouched = false;
    capture(e.pointerId);
    eraseAt(x, y);
    schedule();
    e.preventDefault();
    return;
  }

  startStroke(e, "pointerdown");
  schedule();
  e.preventDefault();
}

function onPointerMove(e: PointerEvent): void {
  notePointerKind(e);
  if (panPointer === e.pointerId && panFrom) {
    const [sx, sy] = localPoint(e);
    view = { ...view, panX: panFrom.panX + (sx - panFrom.sx), panY: panFrom.panY + (sy - panFrom.sy) };
    applyView();
    schedule();
    e.preventDefault();
    return;
  }

  // 高回报率的数位笔一帧里会攒好几个点，只取主事件会画出折线
  const coalesced = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
  const events = coalesced.length ? coalesced : [e];
  const [sx, sy] = localPoint(e);
  hover = screenToWorld(sx, sy, view);

  if (erasing) {
    // 擦除同样按接触状态认：pointerId 变了也接着擦，松手了就收尾
    if (e.pointerId === erasePointer && !inContact(e)) {
      endErase();
      return;
    }
    // 与画笔同理：正在擦的这个指针就算被报成非主指针也接着擦（其他指针如手掌仍照旧忽略）
    if (!e.isPrimary && e.pointerId !== erasePointer) return;
    erasePointer = e.pointerId;
    for (const ev of events) {
      const [px, py] = localPoint(ev);
      const [wx, wy] = screenToWorld(px, py, view);
      hover = [wx, wy];
      eraseAt(wx, wy);
    }
    schedule();
    e.preventDefault();
    return;
  }

  if (eraserMode) {
    schedule(); // 只跟着指针重画橡皮圈
    return;
  }

  if (!inContact(e)) {
    // 已经离纸/松手：这一下结束当前笔画（常见于 pointerup 那一帧的事件丢了）
    if (live) {
      markBroken("pointerup 那一帧丢了，靠「接触结束」补收尾");
      finishStroke("接触结束");
    }
    // 笔悬在纸面上移动（没接触）时也要让笔形指示器跟手：这条路径只重绘指示器，不动笔迹
    scheduleIfPenCursor();
    return;
  }
  // 已经在画的那个指针，就算设备把它报成「非主指针」也照画：数位笔在规范上永远是主指针，
  // 报成非主指针是驱动的事；照旧一律丢弃就会**静默停笔**（同样得抬笔重落才恢复），而且不留下任何线索。
  if (!e.isPrimary && e.pointerId !== activePointer) return;
  if (!live) {
    markBroken("接触中却没有进行中的笔画，就地续笔");
    startStroke(e, "接触中续笔"); // 中途断过序列，直接续上，别丢后半截
  } else if (e.pointerId !== activePointer) {
    activePointer = e.pointerId; // 换了 pointerId 也续同一笔
  }
  const current = live;
  if (!current) return;
  for (const ev of events) appendPoint(ev);
  liveDirty = true;
  schedule();
  e.preventDefault();
}

function onPointerUp(e: PointerEvent): void {
  if (panPointer === e.pointerId) {
    panPointer = null;
    panFrom = null;
    schedule(); // 平移结束：笔形指示器该按当前指针位置重新画出来
    return;
  }
  if (erasing) {
    if (e.pointerId === erasePointer) endErase();
    return;
  }
  if (!live) return;
  if (e.pointerId !== activePointer && !e.isPrimary) return;
  // 「松手了但事件里还带着接触」= 假的 pointerup（驱动/系统合成），收尾会把这一笔提前掐断
  if (inContact(e)) {
    markBroken("收到仍带接触的 pointerup（假松手），已忽略");
    return;
  }
  finishStroke("pointerup");
}

/**
 * 指针序列被浏览器**终止**（pointercancel）—— 与「松手了」不是一回事，所以单独处理。
 *
 * Chromium 判定这个指针不会再产生事件时才会发它（起手原生拖拽、系统手势、笔离开感应区…），
 * **此后同一个 pointerId 一个事件都不会再来**，所以屏幕上就是「笔走一小段突然不落墨」，
 * 而且只能抬笔重落才能继续写。已经画出来的点照常提交（别吞掉用户写了一半的内容），
 * 但原因必须记下来 —— 这条路径原先混在 pointerup 里静默收尾，等于丢掉了最要紧的一条线索。
 */
function onPointerCancel(e: PointerEvent): void {
  cancelledPointers++;
  const drawn = live?.points.length ?? 0;
  notify(
    "pointer-cancel",
    `指针序列被浏览器取消：${areaOf(e)} ${describeTarget(e.target)} type=${e.pointerType} buttons=${e.buttons}` +
      `${nativeGesture ? `（前一步是原生手势 ${nativeGesture}）` : ""}，这一笔只写到 ${drawn} 个点`,
    20,
  );
  nativeGesture = null;
  updateStats();

  if (panPointer === e.pointerId) {
    panPointer = null;
    panFrom = null;
    schedule();
    return;
  }
  if (erasing) {
    if (e.pointerId === erasePointer) endErase();
    return;
  }
  if (live && (e.pointerId === activePointer || e.isPrimary)) finishStroke("指针被取消");
}

/** 捕获被释放时兜底：还压着就继续画（把捕获再要回来），已经松手才收尾 */
function onLostCapture(e: PointerEvent): void {
  if (erasing) {
    if (e.pointerId === erasePointer && !inContact(e)) endErase();
    return;
  }
  if (e.pointerId !== activePointer) return;
  if (inContact(e)) {
    markBroken("指针捕获被释放但仍在接触，继续画");
    capture(e.pointerId); // 还压着，只是捕获没了 —— 别把后半截笔画掐掉
    return;
  }
  // 不接触却丢掉捕获：这一笔就此收尾。原来这里是静默的，同样把线索丢了（收尾原因必须留痕）
  notify("capture-lost", `指针捕获丢失且已不接触，收尾这一笔（type=${e.pointerType} buttons=${e.buttons}）`, 20);
  finishStroke("捕获丢失");
}

/**
 * 拦下原生拖拽。
 *
 * HTML5 拖拽（题面里的图片、链接、以及被选中的文字默认都可拖）一启动，Chromium 就会把正在
 * 写的那一笔的指针序列**取消**（见 WB_STYLE 里那段注释），所以它在白板上必须被拦住。
 * 这里同时也是一条探针：`拦手势 N` 涨了，就说明 CSS 那道防线被绕过了（真拦到时一并记下是谁）。
 */
function onNativeDrag(e: Event): void {
  nativeGestures++;
  nativeGesture = `dragstart(${describeTarget(e.target)})`;
  notify("native-drag", `拦下原生拖拽：${describeTarget(e.target)}（拖拽起手会取消指针序列、把正在写的这一笔掐断）`, 20);
  updateStats();
  e.preventDefault();
}

/** 拦下选字：在纸上写字不该选中题面文字（选中之后再拖就是从选区拖拽了，一样会掐断笔画） */
function onNativeSelectStart(e: Event): void {
  nativeGestures++;
  nativeGesture = "selectstart";
  notify("native-select", `拦下选字：${describeTarget(e.target)}`, 5);
  updateStats();
  e.preventDefault();
}

function onWheel(e: WheelEvent): void {
  e.preventDefault();
  if (e.ctrlKey) {
    const [sx, sy] = localPoint(e);
    view = zoomAt(view, sx, sy, Math.exp(-e.deltaY * 0.0015));
  } else {
    view = { ...view, panX: view.panX - e.deltaX, panY: view.panY - e.deltaY };
  }
  applyView();
  schedule();
}

function undo(): void {
  const prev = history.pop();
  if (!prev) return;
  // 轮廓跟着快照一起回来（见 snapshot）：不必 rebuildPaths 全量重算
  strokes = prev.strokes;
  paths = prev.paths;
  invalidateBase(); // 笔迹集合变了（少了那一笔），整片要重画
  persist();
  drawNow();
}

function clearAll(): void {
  if (!strokes.length) return;
  snapshot();
  strokes = [];
  paths = [];
  invalidateBase();
  persist();
  drawNow();
}

/** 擦掉 (x, y) 处的整笔（从最上面一笔往下找，一次可能擦到多笔重叠处）。返回是否擦掉了东西 */
function eraseAt(x: number, y: number): boolean {
  let removed = false;
  for (let i = strokes.length - 1; i >= 0; i--) {
    if (strokes[i].points.length && strokeHitByPoint(strokes[i], x, y, ERASER_RADIUS)) {
      if (!eraseTouched) {
        snapshot(); // 一次按住只压一份快照，且要在第一次真正改动之前
        eraseTouched = true;
      }
      strokes.splice(i, 1);
      paths.splice(i, 1);
      removed = true;
    }
  }
  if (removed) {
    invalidateBase();
    schedule();
  }
  return removed;
}

function setEraser(on: boolean): void {
  eraserMode = on;
  eraserButton.classList.toggle("active", on);
  viewport.classList.toggle("wb-erase", on);
  if (on) {
    // 切到橡皮擦时收掉进行中的笔画（别把已经画出来的丢了），也别留着橡皮拖动状态
    if (activePointer !== null) finishStroke();
    endErase();
  }
  drawNow();
}

function setColor(next: string): void {
  color = next;
  if (eraserMode) setEraser(false);
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".wb-pen"))) {
    btn.classList.toggle("active", btn.dataset.color === next);
  }
}

/** 切换笔宽档。只影响之后新起的笔画，已经画好的笔画粗细不变（粗细是逐笔存的）。 */
function setWidth(next: number): void {
  strokeWidth = next;
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".wb-width"))) {
    btn.classList.toggle("active", Number(btn.dataset.width) === next);
  }
}

/** `[` / `]` 在档位表里前后挪一格（到头/到底就不动），档位表以外的当前值从默认档起算。 */
function stepWidth(dir: number): void {
  const current = PEN_WIDTHS.findIndex((w) => w.value === strokeWidth);
  const from = current >= 0 ? current : PEN_WIDTHS.findIndex((w) => w.value === DEFAULT_STROKE_WIDTH);
  const next = Math.max(0, Math.min(PEN_WIDTHS.length - 1, (from < 0 ? 0 : from) + dir));
  setWidth(PEN_WIDTHS[next].value);
}

// ── 落盘 ────────────────────────────────────────────────────────────────

/**
 * 把批注交给扩展进程存起来。
 * 只在「提交点」（一笔画完 / 擦完 / 撤销 / 清空）调用，所以不必防抖；立即发的好处是
 * 面板被重载或重开时不会丢掉最后一笔。
 */
function persist(): void {
  vscode.postMessage({ command: "saveStrokes", strokes });
}

/** 加页/减页后立刻把页数交给扩展进程存起来（重开面板要能接着写在那张纸上）。 */
function persistPages(): void {
  vscode.postMessage({ command: "savePages", pages: minPages });
}

// ── 自定义事件上报（面板里能看见 + 输出面板留档，供排查用） ──────────────

const notified = new Map<string, number>();
/** 最近几笔的统计，出现异常时随日志一起打出去当上下文 */
const recentStrokes: string[] = [];

/**
 * 记录一次诊断事件：
 * - 写进「OI教学助手」输出面板（点开 `查看 → 输出`，右上角选这个通道）；
 * - 非例行事件同时显示在工具栏状态区 —— 输出面板用户不一定找得到，面板里的才一定看得见。
 * limit 是同一类事件的最大条数，免得刷屏。
 */
function notify(kind: string, message: string, limit = 1, show = true): void {
  const n = (notified.get(kind) ?? 0) + 1;
  notified.set(kind, n);
  if (n > limit) return;
  const suffix = n > 1 ? `（第 ${n} 次）` : "";
  const context = recentStrokes.length ? ` ｜ 最近几笔：${recentStrokes.join(" / ")}` : "";
  vscode.postMessage({ command: "notify", kind, message: `${message}${suffix}${context}` });
  if (show) setStatus(`${message}${suffix}`);
}

/**
 * 指针序列断了一次但被救回来（接触中续笔、忽略假松手、丢了 pointerup…）。
 * 这个计数直接显示在工具栏上：**它就是当初「只画出开头一段」的成因**，
 * 显示 0 说明整段会话都干干净净；涨了说明驱动仍在制造断流，只是现在能接住。
 */
function markBroken(reason: string): void {
  brokenSequences++;
  notify("sequence-break", `指针序列断流：${reason}`, 20);
  updateStats();
}

// ── 导出 A4 PNG ─────────────────────────────────────────────────────────

/** 向扩展进程要「内联了 KaTeX 字体的样式」（字体在磁盘上，扩展侧读比 webview 里 fetch 稳） */
function prepareExportCss(): Promise<{ css: string; ok: boolean }> {
  if (exportCss !== null) return Promise.resolve({ css: exportCss, ok: exportCssOk });
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingCss = null;
      reject(new Error("导出样式准备超时（扩展进程未响应）"));
    }, 15000);
    pendingCss = (v) => {
      window.clearTimeout(timer);
      resolve(v);
    };
    vscode.postMessage({ command: "prepareExport" });
  });
}

/** XML 文本节点只需转义 & 与 <（> 在 XML 文本里合法） */
function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

/**
 * 把整张纸序列化进 SVG，用 foreignObject + 负偏移裁出第 pageIndex 页。
 * SVG 以 img 加载时不能引外部资源，所以样式（含 base64 字体）全部内联；
 * width/height 给导出像素、viewBox 给 CSS px，让浏览器按目标 dpi 光栅化矢量文字
 * （导出分辨率来自设置，见 exportW/exportH）。
 *
 * **序列化只做一次**（prepareSheetSvg）：各页的题面内容完全相同，差的只是那个 top 偏移，
 * 没必要每页都克隆 + XMLSerializer 一遍整张纸 —— 页数一多这才是导出的主要开销。
 * 转义过的 css 也一并共享（内联的 base64 字体有几十万字符，重复 escape 更贵）。
 */
function prepareSheetSvg(css: string): { inner: string; cssXml: string } {
  const clone = sheet.cloneNode(true) as HTMLElement;
  clone.style.boxShadow = "none";
  clone.style.margin = "0";
  return { inner: new XMLSerializer().serializeToString(clone), cssXml: escapeXml(css) };
}

function buildPageSvg(pageIndex: number, prepared: { inner: string; cssXml: string }): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${exportW}" height="${exportH}" viewBox="0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}">
<foreignObject x="0" y="0" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}">
<div xmlns="http://www.w3.org/1999/xhtml" style="position:relative;width:${PAGE_WIDTH}px;height:${PAGE_HEIGHT}px;overflow:hidden;background:#ffffff">
<style>${prepared.cssXml}</style>
<div style="position:absolute;left:0;top:${-pageTop(pageIndex)}px;width:${PAGE_WIDTH}px">${prepared.inner}</div>
</div>
</foreignObject>
</svg>`;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("题面栅格化失败：SVG foreignObject 无法渲染"));
    img.src = src;
  });
}

/** 让出一帧好让「正在导出 N/M 页」能画出来；万一动画帧被冻结，兜底用超时继续，别把导出卡死 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(), 200);
    window.requestAnimationFrame(() => {
      window.clearTimeout(timer);
      resolve();
    });
  });
}

async function renderPage(pageIndex: number, prepared: { inner: string; cssXml: string }): Promise<{ dataUrl: string; blank: boolean }> {
  const svg = buildPageSvg(pageIndex, prepared);
  const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);

  const out = document.createElement("canvas");
  out.width = exportW;
  out.height = exportH;
  const g = out.getContext("2d");
  if (!g) throw new Error("拿不到导出画布上下文");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, exportW, exportH);
  g.drawImage(img, 0, 0, exportW, exportH);

  // 抽查题面有没有真画上去：缩到 1/4 数非白像素（全白说明 foreignObject 没渲染出来）
  let blank = false;
  const probe = document.createElement("canvas");
  probe.width = Math.round(exportW / 4);
  probe.height = Math.round(exportH / 4);
  const pg = probe.getContext("2d");
  if (pg) {
    pg.drawImage(img, 0, 0, probe.width, probe.height);
    const data = pg.getImageData(0, 0, probe.width, probe.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) dark++;
    }
    blank = dark < 40;
  }

  // 笔迹：同一套 perfect-freehand 管线，世界坐标按导出比例放大、按页偏移裁剪
  const s = exportScale(exportW, exportH);
  g.setTransform(s.x, 0, 0, s.y, 0, -pageTop(pageIndex) * s.y);
  for (let i = 0; i < strokes.length; i++) {
    const path = paths[i] ?? buildPath(strokes[i]);
    if (!path) continue;
    g.fillStyle = strokes[i].color;
    g.fill(path);
  }
  g.setTransform(1, 0, 0, 1, 0, 0);

  return { dataUrl: out.toDataURL("image/png"), blank };
}

async function exportPages(): Promise<void> {
  if (exporting) return;
  exporting = true;
  setStatus("正在准备导出…");
  try {
    const { css, ok } = await prepareExportCss();
    if (!ok) setStatus("未取到公式字体，公式可能显示为占位字形");
    // 整纸只序列化一次，各页复用（每页只有 top 偏移不同）
    const prepared = prepareSheetSvg(css);
    const images: string[] = [];
    let blank = false;
    for (let i = 0; i < pages; i++) {
      setStatus(`正在导出 ${i + 1}/${pages} 页…`);
      await nextFrame();
      const page = await renderPage(i, prepared);
      // 只有「题面占用的那几页」才算进抽检：用户自己加出来的空白页本来就该是白的，
      // 把它们算进去会误报「题面没栅格化成功」。
      if (page.blank && i < contentPages) blank = true;
      images.push(page.dataUrl);
    }
    setStatus("");
    vscode.postMessage({ command: "export", images, blank });
  } catch (e) {
    setStatus("");
    reportError(e);
  } finally {
    exporting = false;
  }
}

// ── 事件绑定 ────────────────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === " ") {
    if (!spaceDown) {
      spaceDown = true;
      viewport.classList.add("wb-pan");
    }
    e.preventDefault();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    undo();
    e.preventDefault();
    return;
  }
  if (!e.ctrlKey && !e.metaKey && !e.altKey) {
    if (e.key === "e" || e.key === "E") {
      setEraser(!eraserMode);
      return;
    }
    // 方括号调笔宽：手不离开笔也能换粗细（中文输入法下也可能是这两个字符，认不到就点工具条）
    if (e.key === "[") {
      stepWidth(-1);
      e.preventDefault();
      return;
    }
    if (e.key === "]") {
      stepWidth(1);
      e.preventDefault();
      return;
    }
    const idx = "123".indexOf(e.key);
    if (idx >= 0 && idx < PENS.length) setColor(PENS[idx].value);
  }
}

function onKeyUp(e: KeyboardEvent): void {
  if (e.key === " ") {
    spaceDown = false;
    viewport.classList.remove("wb-pan");
  }
}

function onMessage(ev: MessageEvent<ExtMessage>): void {
  const msg = ev.data;
  if (!msg || msg.command !== "exportCss") return;
  exportCss = msg.css ?? "";
  exportCssOk = msg.ok !== false;
  const resolve = pendingCss;
  pendingCss = null;
  resolve?.({ css: exportCss, ok: exportCssOk });
}

function start(): void {
  viewport = must<HTMLDivElement>("viewport");
  world = must<HTMLDivElement>("world");
  sheet = must<HTMLDivElement>("sheet");
  marksOut = must<HTMLDivElement>("marks-out");
  marks = must<HTMLDivElement>("marks");
  canvas = must<HTMLCanvasElement>("ink");
  // 题面容器：只用于诊断（这个点在题面区还是空白纸）
  sheetBody = document.querySelector<HTMLElement>(".oi-sheet-body");
  zoomLabel = must<HTMLButtonElement>("wb-zoom");
  statusLabel = must<HTMLSpanElement>("wb-status");
  pagesLabel = must<HTMLSpanElement>("wb-pages");
  statsLabel = must<HTMLSpanElement>("wb-stats");
  eraserButton = must<HTMLButtonElement>("wb-eraser");

  const payload = JSON.parse(document.getElementById("wb-payload")?.textContent ?? "{}") as Payload;
  strokes = sanitizeStrokes(payload.strokes);
  minPages = clampPageCount(Number(payload.pages));
  exportW = positiveInt(payload.exportWidth, EXPORT_WIDTH);
  exportH = positiveInt(payload.exportHeight, EXPORT_HEIGHT);

  rebuildPaths();
  resizeCanvas();
  layoutSheet();
  applyView();
  fitWidth();
  setEraser(false);
  setColor(DEFAULT_PEN_COLOR);
  setWidth(DEFAULT_STROKE_WIDTH);
  setStatus("");
  updateStats();
  // 自检：这行一定会写进「OI教学助手」输出面板。看不到它 = 输出面板选错了通道，
  // 而不是白板没上报（省得下次又因为「日志里什么都没有」白跑一轮）。
  notify("panel-open", "白板已打开（自检行；诊断信息都写在本通道，前缀 [白板]）", 1, false);

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointermove", onPointerMove);
  viewport.addEventListener("pointerup", onPointerUp);
  // pointercancel 与 pointerup 分开处理：前者是「浏览器终止了这条指针序列」，不是松手（见 onPointerCancel）
  viewport.addEventListener("pointercancel", onPointerCancel);
  viewport.addEventListener("lostpointercapture", onLostCapture);
  /*
   * 原生选字 / 拖拽的兜底拦截。
   *
   * CSS（WB_STYLE 里的 user-select / -webkit-user-drag / pointer-events）是第一道防线，这里兜第二道：
   * 万一以后有人给题面加了可拖元素、或把 pointer-events 改回去，也不会变成「写几厘米就断笔」。
   * 挂 window 且走捕获阶段：确保在任何元素自己的处理之前拦住。
   */
  window.addEventListener("dragstart", onNativeDrag, true);
  window.addEventListener("selectstart", onNativeSelectStart, true);
  viewport.addEventListener("pointerleave", (e) => {
    hover = null;
    // 指针无接触地离开视口（还按着拖动是另一个分支，不能收尾）——顺手兜住可能卡住的进行中笔画
    if (live && !inContact(e)) {
      markBroken("指针无接触地离开视口，兜底收尾");
      finishStroke("指针离开");
    }
    schedule();
  });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("message", onMessage);
  // 失焦时不可能还在写：把进行中的笔画收掉，避免 pointerup 丢了之后整支笔卡死
  window.addEventListener("blur", () => {
    if (activePointer !== null) finishStroke("窗口失焦");
    if (erasing) endErase();
  });
  window.addEventListener("resize", () => {
    resizeCanvas();
    schedule();
  });
  // 从后台切回来时补一次：布局（字体/图片）可能变了，画布也可能被清过
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    resizeCanvas();
    layoutSheet();
    applyView();
    drawNow();
  });
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => {
      resizeCanvas();
      schedule();
    }).observe(viewport);
  }
  document.getElementById("wb-undo")?.addEventListener("click", undo);
  document.getElementById("wb-clear")?.addEventListener("click", clearAll);
  document.getElementById("wb-add-page")?.addEventListener("click", addPage);
  document.getElementById("wb-del-page")?.addEventListener("click", removePage);
  document.getElementById("wb-export")?.addEventListener("click", () => void exportPages());
  eraserButton.addEventListener("click", () => setEraser(!eraserMode));
  zoomLabel.addEventListener("click", fitWidth);
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".wb-pen"))) {
    btn.addEventListener("click", () => setColor(btn.dataset.color ?? DEFAULT_PEN_COLOR));
  }
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>(".wb-width"))) {
    btn.addEventListener("click", () => {
      const w = Number(btn.dataset.width);
      setWidth(Number.isFinite(w) && w > 0 ? w : DEFAULT_STROKE_WIDTH);
    });
  }

  draw();

  // 公式字体与题面里的图片是异步到的，尺寸会变 —— 到齐后重量一次页高，否则分页位置与导出裁剪会偏
  void document.fonts?.ready.then(() => {
    layoutSheet();
    schedule();
  });
  window.addEventListener("load", () => {
    layoutSheet();
    schedule();
  });
}

try {
  start();
} catch (e) {
  reportError(e);
}
