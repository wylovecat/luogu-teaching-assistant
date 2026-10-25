/**
 * 白板纯逻辑：笔画结构、世界/屏幕坐标变换、A4 分页与导出尺寸、批注落盘的上限判定。
 *
 * 无 vscode 依赖，也不碰 DOM —— 扩展进程、webview 脚本与 test/ 都直接引用它
 * （同 src/util.ts、src/problems/statement.ts 的约定）。
 */

import getStroke from "perfect-freehand";
// 纯逻辑模块（没有 vscode 依赖），webview 那次浏览器打包也能带上
import { stripEventPrefix } from "../problems/uploadName";
import { BASE_STYLE } from "../ui/theme";

/** 一条批注笔画。坐标一律是「世界坐标」＝题面纸张内的 CSS px。 */
export interface Stroke {
  color: string;
  width: number;
  /** [x, y] 序列 */
  points: number[][];
  /** 与 points 一一对应的压力值（0~1），鼠标恒为 MOUSE_PRESSURE */
  pressures: number[];
}

/** 视口变换：屏幕坐标 = 世界坐标 × zoom + pan */
export interface View {
  zoom: number;
  panX: number;
  panY: number;
}

export const MM_PER_INCH = 25.4;
/** Chromium 的 CSS 逻辑像素基准固定 96dpi */
export const CSS_DPI = 96;

/** A4 纸张在屏幕上的 CSS px 尺寸（210×297mm @96dpi） */
export const PAGE_WIDTH = (210 / MM_PER_INCH) * CSS_DPI; // 793.70
export const PAGE_HEIGHT = (297 / MM_PER_INCH) * CSS_DPI; // 1122.52

/**
 * 导出 PNG 的分辨率（dpi）。默认 150（A4 → 1240×1754）：当讲义批注发群里/打草稿够用，
 * 体积只有 300dpi 的四分之一；要打精细件可以在设置里调回 300（`lgAssist.whiteboard.exportDpi`）。
 */
export const DEFAULT_EXPORT_DPI = 150;
/** 允许的 dpi 区间：下限防糊成马赛克，上限只挡住离谱脏值（真要打印清晰件 300 就够） */
export const MIN_EXPORT_DPI = 72;
export const MAX_EXPORT_DPI = 600;

/** dpi 清洗：非有限值回落默认档，其余夹到合法区间并取整（设置里手填脏值也画得出东西）。 */
export function clampExportDpi(dpi: number): number {
  if (!Number.isFinite(dpi)) return DEFAULT_EXPORT_DPI;
  return Math.min(MAX_EXPORT_DPI, Math.max(MIN_EXPORT_DPI, Math.round(dpi)));
}

/** 某档 dpi 下 A4 的导出像素尺寸（宽高分别算，免得换算取整差一丝） */
export function exportPixels(dpi: number = DEFAULT_EXPORT_DPI): { width: number; height: number } {
  const d = clampExportDpi(dpi);
  return {
    width: Math.round((210 / MM_PER_INCH) * d),
    height: Math.round((297 / MM_PER_INCH) * d),
  };
}

/** 默认档（150dpi）下的导出尺寸。webview 拿不到设置时用它兜底。 */
export const EXPORT_DPI = DEFAULT_EXPORT_DPI;
export const EXPORT_WIDTH = exportPixels(EXPORT_DPI).width; // 1240
export const EXPORT_HEIGHT = exportPixels(EXPORT_DPI).height; // 1754

export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

/** 笔迹颜色：黑、红、蓝。快捷键 1/2/3 按此顺序。 */
export const PENS: ReadonlyArray<{ id: string; label: string; value: string }> = [
  { id: "black", label: "黑色", value: "#000000" },
  { id: "red", label: "红色", value: "#d63031" },
  { id: "blue", label: "蓝色", value: "#0984e3" },
];
/** 默认笔色改成**红色**：讲义是投影给人看的，红笔写重点、黑笔抄题面，分工一眼能分。 */
export const DEFAULT_PEN_COLOR = PENS[1].value;

/**
 * 「中」档的数值，历史批注都是它（老笔迹的 width 落在这里）。
 * 数值对齐 Excalidraw 的 freedraw 默认档（medium = 1）：
 * 实际线宽 = width × SIZE_FACTOR × (0.5 - THINNING × (0.5 - pressure))。
 */
const MEDIUM_STROKE_WIDTH = 1;

/**
 * 默认笔宽改成「细」档（0.6）：老师在题面上写的多是点名/强调，字要写得小而清楚，
 * 默认中档偏粗、容易把题干盖住。真笔满压时约 2.0px，压力 0.05 时约 0.6px。
 */
export const DEFAULT_STROKE_WIDTH = 0.6;

/**
 * 工具条上的笔宽档位（极细/细/中/粗/特粗）。数值就是上面公式里的 width，
 * 所以「中」画出来和老批注完全一样。
 *
 * 极细（0.35）在鼠标下约 0.7px、满压真笔约 1.2px —— 像铅笔，适合在留白处写小字；
 * 档位比 MIN_STROKE_WIDTH 宽裕，清洗不会碰到它。
 * 工具条里的条块高度按 value 等比预览（见 penBarHeight），五档高度互不相同。
 */
export const PEN_WIDTHS: ReadonlyArray<{ id: string; label: string; value: number }> = [
  { id: "hairline", label: "极细", value: 0.35 },
  { id: "thin", label: "细", value: DEFAULT_STROKE_WIDTH },
  { id: "medium", label: "中", value: MEDIUM_STROKE_WIDTH },
  { id: "thick", label: "粗", value: 2 },
  { id: "extra", label: "特粗", value: 3 },
];

/**
 * 落盘笔宽的合法区间。刻意比工具条的档位范围宽一档：这里只用来挡脏数据
 * （例如工作区状态被改坏成 width=100000 会画出个巨型色块），不跟着档位一起收窄，
 * 将来增删档位时也不会悄悄改写已有批注的粗细。
 */
export const MIN_STROKE_WIDTH = 0.3;
export const MAX_STROKE_WIDTH = 6;

/** 笔宽清洗：非有限/非正值回落到默认档，其余夹到合法区间（脏数据别画出个巨型色块）。 */
export function clampStrokeWidth(w: number): number {
  if (!Number.isFinite(w) || w <= 0) return DEFAULT_STROKE_WIDTH;
  return Math.min(MAX_STROKE_WIDTH, Math.max(MIN_STROKE_WIDTH, w));
}

/**
 * 工具条上那一小段条块的高度（px）：按笔宽等比放大，最细也留 1px 才看得见。
 *
 * 系数取 3.5（不是更大也不是更小）：五档必须给出**互不相同**的高度 —— 极细和细只差
 * 0.25，系数再小两档就一样高了；再大则「特粗」会把 26px 高的按钮撑满。
 * 当前五档 → 1 / 2 / 4 / 7 / 11px。
 */
export function penBarHeight(width: number): number {
  return Math.max(1, Math.round(width * 3.5));
}

/**
 * perfect-freehand 的变宽参数，抄自 Excalidraw（packages/element/src/shape.ts:1200-1241）。
 * 压力 0.5 时线宽恒定 —— 所以鼠标画出来是等宽线，只有真笔才有粗细变化。
 */
export const VARIABLE_WIDTH = { SIZE_FACTOR: 4.25, THINNING: 0.6, SMOOTHING: 0.5 } as const;
export const STROKE_STREAMLINE = 0.5;

/** 鼠标/触控等没有真实压力的设备用 0.5（PointerEvent 规范里按住鼠标就是 0.5） */
export const MOUSE_PRESSURE = 0.5;

/** 橡皮擦半径（世界 px）：鼠标/笔尖周围多远算「擦到」 */
export const ERASER_RADIUS = 9;

/** 两点靠得比这更近就丢掉，避免高采样率设备灌进来一堆重复点 */
export const MIN_POINT_DISTANCE = 0.6;

/** 批注落盘上限：超过就不再写 workspaceState（那里不适合塞大对象） */
export const MAX_PERSIST_BYTES = 2 * 1024 * 1024;

/**
 * 纸张样式（不含 BASE_STYLE）。屏幕上的题面与导出 SVG 必须用同一份，否则「看到的」和「导出的」不一样。
 * 颜色写死成浅色（白底黑字）：题面白板不跟随 VSCode 暗色主题。
 *
 * 注意：导出进 SVG 后 `--vscode-*` 变量一律不存在，BASE_STYLE 里用到变量的声明
 * （边框、代码块底色…）会整条失效 —— 所以下面凡是要保留的视觉效果，都写成完整声明而不是
 * 只覆盖某个 longhand（例如必须写 `border: 1px solid ...`，只写 border-color 是补不回边框的）。
 *
 * 同一类还有两条：BASE_STYLE 里基于 `currentColor` 的 `--oi-tint`（主题色的极淡一层）在纸面上
 * 算出来会是一层黑，所以凡是纸面可见、且 BASE_STYLE 用过 --oi-tint 的元素（目前只有 th），
 * 都要在这里显式写成固定色值。
 */
export const SHEET_RULES = `
.oi-sheet {
  box-sizing: border-box;
  width: ${PAGE_WIDTH}px;
  background: #ffffff;
  color: #1f2328;
  font-family: system-ui, "Segoe UI", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
  font-size: 16px;
  line-height: 1.35;
  /*
   * 「上 右 下 左」四值。
   * 左边 24px：题面离纸张左边界再近一点，纸就这么宽，左边省下来的都归题面。
   * 右边不跟着收（40px），右侧那 1/3 留白本来就是给学生写字的地方，
   * 由 .oi-sheet-body 的宽度保证，不靠内边距。
   * 上边 20px（原先 48px）：老师反馈题面离上边界太远，标题上方那条空白浪费了一截纸。
   * **这个方向改是安全的**：内容高按内边距一起量，缩小上边距只会让内容更矮，
   * 页数只可能变少不会变多（原先那条「别动上下」的顾虑是怕改大导致凭空多一页）。
   * 下边仍留 48px：批注常常写到纸尾，底部太贴边会在切片时被切到。
   */
  padding: 20px 40px 48px 24px;
  position: relative;
  overflow-wrap: break-word;
}
/*
 * 题面只占纸宽的 2/3，右侧那 1/3 是留给学生写的空纸 —— 讲课时笔迹落在右边，
 * 不用把字挤在题面缝里。百分比相对纸张的内容盒（页宽减左右内边距）算。
 */
.oi-sheet-body { width: 66.667%; }
/* 行距与段间距都比阅读面板紧一档：一页多塞点内容，翻页越少越好 */
.oi-sheet p { margin: .4em 0; }
.oi-sheet h1, .oi-sheet h2 { margin: .55em 0 .3em; }
.oi-sheet h1:first-child, .oi-sheet h2:first-child { margin-top: 0; }
.oi-sheet ul, .oi-sheet ol { margin: .4em 0; padding-left: 1.7em; }
.oi-sheet li { margin: .1em 0; }
.oi-sheet blockquote { margin: .4em 0; }
.oi-sheet .katex-display { margin: .4em 0; }
/*
 * 样例的代码块跟着列宽折行：列只剩 2/3 宽，而导出用的 SVG 里没有滚动条，
 * 长行（样例数据动辄几十个数）会被整段裁掉 —— 折行不好看，但至少内容都在。
 */
.oi-sheet pre { margin: .4em 0; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px 12px; }
.oi-sheet code { padding: .1em .35em; }
.oi-sheet h1, .oi-sheet h2 { border-bottom: 1px solid #d8dee4; }
.oi-sheet code, .oi-sheet pre { background: #f6f8fa; }
.oi-sheet pre code { background: transparent; }
.oi-sheet blockquote { background: #f6f8fa; border-left: 4px solid #d0d7de; color: #59636e; }
.oi-sheet table { font-size: 1em; }
.oi-sheet th, .oi-sheet td { border: 1px solid #d0d7de; padding: 4px 10px; }
/*
 * 表头底色与字重：BASE_STYLE 里 th 拿的是 --oi-tint（当前色的极淡一层），
 * 而导出环境里 currentColor 是 #1f2328，算出来是一层黑，跟「纸是白的」对不上。
 * 这里钉成与 code/pre 同一个底色。
 */
.oi-sheet th { background: #f6f8fa; font-weight: bold; }
/*
 * 字阶与行距钉死，不跟 BASE_STYLE 走。
 *
 * BASE_STYLE 是给「跟随 VS Code 主题的面板」用的，它的字阶、内边距会随界面一起改；
 * 而纸是纸 —— 字号或行距一变，内容高就变，分页页数跟着变（见 AGENTS.md 里
 * 「量内容高前先摘 min-height」那条坑的根因：整页内容高一旦越过一页，就凭空多一页）。
 * 下面每个值都是有意选定的纸面取值，不要让它继承界面样式。
 *
 * 题名（h1）与小节标题（h2）**同号**（都 1.25em）：白板是拿去投影/讲义的，
 * 题名顶着两行大字会把题面挤下去一大截，而题号在标题里已经能认出来了。
 * 行距 1.35（BASE_STYLE 是 1.7）：一页多塞点内容，翻页越少越好。
 */
.oi-sheet h1, .oi-sheet h2, .oi-sheet h3 { line-height: 1.25; }
.oi-sheet h1 { font-size: 1.25em; padding-bottom: .2em; }
.oi-sheet h2 { font-size: 1.25em; padding-bottom: .2em; }
.oi-sheet h3 { font-size: 1.1em; margin: 1em 0; }
.oi-sheet a { color: #0969da; }
.oi-sheet img { max-width: 100%; }
.oi-sheet .katex { font-size: 1.05em; }
`;

/**
 * 导出用的自包含样式：BASE_STYLE（面板在页面里已自动带上，导出进 SVG 时必须自己带）
 * + 纸张规则 + KaTeX（由面板把字体内联后拼在后面）。
 */
export const SHEET_CSS = `${BASE_STYLE}${SHEET_RULES}`;

export function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** 压力值清洗：真笔偶尔给 0（悬停/起笔），夹到一个小正数，否则那一小段会塌成 0 宽。 */
export function clampPressure(p: number): number {
  if (!Number.isFinite(p) || p <= 0) return 0.05;
  return Math.min(1, Math.max(0.05, p));
}

/**
 * 这一笔该用多少压力。
 *
 * 支持压感的数位笔**偶尔会送来一次读不出压力的事件**（板子驱动在笔仍压着纸时给出 0）。
 * 按那一次直接画就是「线条上突然凹进去一个细点」—— 而那一刻笔根本没抬起来，
 * `clampPressure` 的 0.05 恰好会把这一笔抽成一条细线。
 * 所以：读数无效 → 沿用**同一笔里**上一个有效读数；一笔开头就没有有效读数才退回 `MOUSE_PRESSURE`
 * （等宽，与鼠标一致，不猜一个偏细的值）。
 *
 * 调用方负责在开新笔画时把 `last` 清成 `MOUSE_PRESSURE`：上一笔收尾时的压力和这一笔无关
 * （中途换过笔尖粗细、换过设备，都会让它变成假数据）。
 */
export function penPressure(raw: unknown, last: number): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return clampPressure(n);
  const prev = Number(last);
  return Number.isFinite(prev) && prev > 0 ? clampPressure(prev) : MOUSE_PRESSURE;
}

export function worldToScreen(x: number, y: number, view: View): [number, number] {
  return [x * view.zoom + view.panX, y * view.zoom + view.panY];
}

export function screenToWorld(x: number, y: number, view: View): [number, number] {
  return [(x - view.panX) / view.zoom, (y - view.panY) / view.zoom];
}

/** 以屏幕上的 (sx, sy) 为锚点缩放：锚点下的世界坐标保持不动。 */
export function zoomAt(view: View, sx: number, sy: number, factor: number): View {
  const zoom = clampZoom(view.zoom * factor);
  const [wx, wy] = screenToWorld(sx, sy, view);
  return { zoom, panX: sx - wx * zoom, panY: sy - wy * zoom };
}

/** 每 1 个世界 px 对应多少导出 px（宽高分开算，避免 A4 换算的取整误差） */
export function exportScale(
  width: number = EXPORT_WIDTH,
  height: number = EXPORT_HEIGHT,
): { x: number; y: number } {
  return { x: width / PAGE_WIDTH, y: height / PAGE_HEIGHT };
}

/** 内容总高对应多少张 A4（空内容也算 1 页） */
export function totalPageCount(contentHeight: number): number {
  if (!Number.isFinite(contentHeight) || contentHeight <= 0) return 1;
  return Math.max(1, Math.ceil(contentHeight / PAGE_HEIGHT));
}

/**
 * 手动加页的上限。目的是挡住脏数据（落盘值被改成 1e9 会把 DOM 与导出一起撑爆），
 * 30 页 A4 已经远超讲课所需。
 */
export const MAX_PAGES = 30;

/** 页数清洗：非有限值、0、负数、小数都归到 1..MAX_PAGES 的整数。 */
export function clampPageCount(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_PAGES, Math.max(1, Math.floor(n)));
}

/**
 * 实际页数 = max(内容需要的页数, 用户手动加出来的页数)。
 *
 * 白板默认只给一页：装得下就是一页，题面长到装不下才按内容自动加。
 * 学生写到纸尾还不够时由「加页」手动再加一张 A4（见 minPages 的落盘）。
 */
export function resolvePageCount(contentHeight: number, minPages: number): number {
  return Math.max(totalPageCount(contentHeight), clampPageCount(minPages));
}

/** 纸张高度：按整页的整数倍撑开（至少要有一页，白纸不会停在半页处）。 */
export function pagesHeight(pages: number): number {
  return clampPageCount(pages) * PAGE_HEIGHT;
}

/** 纸张显示高度：按内容需要的页数撑开（内容不足一页也撑满一页）。 */
export function sheetContentHeight(contentHeight: number): number {
  return pagesHeight(totalPageCount(contentHeight));
}

/** 第 index 页（0 起）在纸张内的顶端偏移 */
export function pageTop(index: number): number {
  return index * PAGE_HEIGHT;
}

/**
 * 把一笔转成 perfect-freehand 的轮廓多边形（世界坐标）。
 * simulatePressure 恒为 false：压力只用真实值，鼠标等宽线不做速度模拟。
 *
 * 注意：perfect-freehand 在退化输入（例如坐标本身非有限）下会返回**全是 NaN 的轮廓**，
 * 而 canvas 对非有限坐标的处理是「静默不画」—— 那一笔就凭空消失了，所以这里先把非有限点滤掉，
 * 滤完不足 3 个点就当作空轮廓（宁可退化成什么都不画并上报，也不要画出不可预期的东西）。
 */
export function strokeOutline(stroke: Stroke): number[][] {
  if (!stroke.points.length) return [];
  const points = stroke.points.map<number[]>(([x, y], i) => [x, y, clampPressure(stroke.pressures[i] ?? MOUSE_PRESSURE)]);
  const outline = getStroke(points, {
    size: stroke.width * VARIABLE_WIDTH.SIZE_FACTOR,
    thinning: VARIABLE_WIDTH.THINNING,
    smoothing: VARIABLE_WIDTH.SMOOTHING,
    streamline: STROKE_STREAMLINE,
    simulatePressure: false,
    last: true,
  }) as number[][];
  const clean = outline.filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  return clean.length >= 3 ? clean : [];
}

/** 点到线段的最短距离。 */
export function distanceToSegment(px: number, py: number, a: number[], b: number[]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - a[0], py - a[1]);
  let t = ((px - a[0]) * dx + (py - a[1]) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}

/**
 * 笔迹的包围盒缓存（按对象身份存）。
 *
 * 橡皮擦每划一下要对**所有**笔迹逐点算距离，密集板面上这是 O(总点数)/事件，
 * 一秒上百个事件就会掉帧。绝大多数笔迹离橡皮很远，先用包围盒一次性排除掉，
 * 只有盒子附近的才逐点算 —— 常见情形（笔没画几笔、板面很空）下这一条几乎等于 O(笔数)。
 *
 * 用 WeakMap 按对象身份缓存：笔迹一旦提交就不再被改动（改的是数组本身，不是笔迹对象），
 * 撤销恢复的也是同一批对象引用，所以盒子不会失效。**只对已提交的笔迹调这个函数** ——
 * 正在写的那一笔边画边加点，缓存会算错。
 */
const strokeBoundsCache = new WeakMap<Stroke, readonly [number, number, number, number]>();

function boundsOf(stroke: Stroke): readonly [number, number, number, number] {
  const cached = strokeBoundsCache.get(stroke);
  if (cached) return cached;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of stroke.points) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  const b = [minX, minY, maxX, maxY] as const;
  strokeBoundsCache.set(stroke, b);
  return b;
}

/**
 * 橡皮擦判定：点 (x, y) 是否落在这一笔的墨迹里 —— 落到就整笔擦掉。
 *
 * 容差取「这一笔最粗处的半径 + 橡皮半径」：宁可擦得比看起来多一点，也不要
 * 「明明划过去了却没反应」。用折线距离近似墨迹（笔迹是围绕折线加粗出来的）。
 *
 * 先用包围盒排除掉远处的笔迹（见 boundsOf）：密板面上这一步省掉绝大部分逐点计算。
 */
export function strokeHitByPoint(stroke: Stroke, x: number, y: number, radius: number): boolean {
  const pts = stroke.points;
  if (!pts.length) return false;
  const tolerance = (stroke.width * VARIABLE_WIDTH.SIZE_FACTOR) / 2 + Math.max(0, radius);
  const [minX, minY, maxX, maxY] = boundsOf(stroke);
  if (x < minX - tolerance || x > maxX + tolerance || y < minY - tolerance || y > maxY + tolerance) {
    return false;
  }
  if (pts.length === 1) return Math.hypot(pts[0][0] - x, pts[0][1] - y) <= tolerance;
  for (let i = 0; i < pts.length - 1; i++) {
    if (distanceToSegment(x, y, pts[i], pts[i + 1]) <= tolerance) return true;
  }
  return false;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 反序列化/清洗批注：坐标压到 2 位小数（落盘的 JSON 小一个量级），脏数据直接丢。 */
export function sanitizeStrokes(input: unknown): Stroke[] {
  if (!Array.isArray(input)) return [];
  const out: Stroke[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const s = raw as Partial<Stroke>;
    if (!Array.isArray(s.points)) continue;
    const pressures = Array.isArray(s.pressures) ? s.pressures : [];
    const points: number[][] = [];
    const press: number[] = [];
    for (let i = 0; i < s.points.length; i++) {
      const p = s.points[i];
      if (!Array.isArray(p) || p.length < 2) continue;
      const x = Number(p[0]);
      const y = Number(p[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      points.push([round2(x), round2(y)]);
      press.push(clampPressure(Number(pressures[i])));
    }
    if (!points.length) continue;
    const w = Number(s.width);
    out.push({
      color: typeof s.color === "string" && /^#[0-9a-fA-F]{3,8}$/.test(s.color) ? s.color : DEFAULT_PEN_COLOR,
      width: clampStrokeWidth(w),
      points,
      pressures: press,
    });
  }
  return out;
}

/**
 * 决定这一笔批注要不要落盘。
 * value 为 null 表示「太大了，放弃保存」，调用方据此提示一次。
 */
export function strokesToPersist(strokes: Stroke[]): { value: Stroke[] | null; bytes: number } {
  if (!strokes.length) return { value: [], bytes: 2 };
  const json = JSON.stringify(strokes);
  if (json.length > MAX_PERSIST_BYTES) return { value: null, bytes: json.length };
  return { value: strokes, bytes: json.length };
}

/**
 * 导出 PNG 的文件名前缀：`题号 题目名`（例如 `A1131 公路`）。
 *
 * 以前是「题号-白板」，导出几张图堆在文件夹里分不清是哪道题；直接用题号加题名，
 * 老师在文件管理器/群里一眼能认出来。题号或题名缺一个就用另一个，都缺退回「题目」。
 * 多页导出时后面还会接 `-p2`、`-p3`…（见 panel.ts 的 saveImages）。
 *
 * 清洗只做「文件名不能有的东西」：`\ / : * ? " < > |` 与控制字符换成下划线、
 * 空白压成一个空格、去掉结尾的点与空格（Windows 会静默吃掉结尾的点，留着会让
 * 实际文件名和这里算的对不上）。
 *
 * 题名开头的赛事/时间括号（`【2024年CSP-J第一轮】`）**剥掉**：文件名里那一长串
 * 比赛信息既占地方又让真正认题的那个词被推到末尾，题号已经够定位了。
 * 复用上传班级文件那条路的 `stripEventPrefix`，两条路对「什么叫赛事前缀」保持一致；
 * 剥完只剩空白（题名整个就是括号）时退回原题名，避免导出文件叫「A1131」。
 */
export function whiteboardFileStem(displayId: string, title: string): string {
  const name = fileStemPart(stripEventPrefix(title ?? "")) || fileStemPart(title);
  const stem = `${fileStemPart(displayId)} ${name}`.trim();
  return stem || "题目";
}

function fileStemPart(text: string): string {
  return (text ?? "")
    // 换行/制表这类空白先并成空格（文件名本身是单行的），其余控制字符与非法字符才换下划线
    .replace(/[\t\n\r\f\v]+/g, " ")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
}

/**
 * 多页导出时，第 2 页往后的文件名主干。
 *
 * 输入是用户在保存框里定的那个文件名（去掉 `.png`）。**只剥结尾那一个 `-p1`** ——
 * 那是保存框默认名 `<题名>-p1.png` 里我们自己加的页码。
 *
 * ⚠️ 早先这里剥的是 `/-p\d+$/`：用户把文件命名成 `foo-p3.png` 时页码被一起剥掉，
 * 第 3 页就写回 `foo-p3.png` —— **把第 1 页覆盖了**，导出的讲义凭空少一页。
 */
export function multiPageFileStem(fileName: string): string {
  return (fileName ?? "").replace(/\.png$/i, "").replace(/-p1$/i, "");
}

/** 每个题号一份批注，存 workspaceState */
export function whiteboardStateKey(displayId: string): string {
  const id = (displayId || "").trim() || "untitled";
  return `lgAssist.whiteboard.${id}`;
}

/**
 * 知识面板（不绑题目的空白白板）的批注 key：整块板共一份，和题目白板分开存，
 * 所以「讲知识点」写的东西不会串到任何一道题上。
 */
export const KNOWLEDGE_BOARD_STATE_KEY = "lgAssist.knowledgeBoard";

/** 手动加页数：和批注分开存（旧版本没有这个键，读到就当 1 页）。 */
export function whiteboardPagesKey(displayId: string): string {
  return `${whiteboardStateKey(displayId)}.pages`;
}

/** 知识面板的手动加页数（和它的批注一样单独一份）。 */
export const KNOWLEDGE_BOARD_PAGES_KEY = `${KNOWLEDGE_BOARD_STATE_KEY}.pages`;
