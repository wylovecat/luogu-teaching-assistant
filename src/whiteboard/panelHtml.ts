/**
 * 白板面板的 HTML 组装。
 *
 * 单独拆出来是为了让 test/ 能在不登录、不开真面板的前提下断言 CSP 与载荷
 * （真面板要走「当前文件已关联题目 + 拉题面」，冒烟测试里拿不到登录态）。
 * 只用到 vscode 的类型，运行时不依赖 vscode。
 */

import type * as vscode from "vscode";
import { buildWebviewHtml } from "../ui/html";
import { PENS, PEN_WIDTHS, EXPORT_HEIGHT, EXPORT_WIDTH, SHEET_RULES, penBarHeight, type Stroke } from "./model";

export interface WhiteboardHtmlOptions {
  webview: vscode.Webview;
  title: string;
  /** 题号（批注按题号分文件落盘，webview 只把它带在载荷里） */
  displayId: string;
  /** katex.min.css 的 webview URI（asWebviewUri 的结果） */
  katexCssUri: string;
  /** renderMarkdownBody 渲染好的题面 HTML（放进 .oi-sheet-body，占纸宽 2/3，右侧留白给学生写）；知识面板传空串 */
  statementHtml: string;
  /** 已恢复的批注 */
  strokes: Stroke[];
  /** 用户上次手动加出来的页数（默认 1：一页装得下就只给一页） */
  pages: number;
  /** 导出像素尺寸（来自 `lgAssist.whiteboard.exportDpi`）；不传就用默认 150dpi 的尺寸 */
  exportWidth?: number;
  exportHeight?: number;
  /** 白板的 webview 脚本（dist/whiteboard.js 的内容） */
  script: string;
}

const WB_STYLE = `
body { padding: 0; margin: 0; height: 100vh; display: flex; flex-direction: column; overflow: hidden; }
/*
 * 工具栏一律不折行：分屏后白板只剩几百像素宽，中文按钮名（「橡皮擦」「导出 A4 PNG」）会被挤得
 * 在按钮**内部**折成两行，整条工具栏变成一坨（2026-10-11 用户报）。所以：
 * ① 功能键改用图标（见下面的 .wb-icon），宽度固定、不随文案变；
 * ② 剩余的文字（计数、缩放百分比）用 nowrap 挡住，放不下就让整条横向滚动，
 *    宁可滚也不要换行——横向滚动至少还能看出「左边还有东西」。
 */
.wb-bar {
  flex: 0 0 auto; display: flex; align-items: center; gap: 5px;
  padding: 6px 10px; background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border); position: relative; z-index: 2;
  white-space: nowrap; overflow-x: auto;
}
.wb-pens { display: flex; gap: 4px; }
.wb-pen {
  width: 26px; height: 26px; padding: 0; border-radius: 50%; position: relative;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 22%, transparent);
}
.wb-pen i { display: block; width: 13px; height: 13px; border-radius: 50%; }
/*
 * 选中态 = 淡底 + 底部一条下划线，和题面的短横线、评测的判定条是同一套语言。
 * 不用 focusBorder 的蓝环：蓝是 VS Code 自己的「焦点」语义，工具栏选中占着它会误导。
 */
.wb-pen.active { background: color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent); }
.wb-pen.active::after {
  content: ""; position: absolute; left: 6px; right: 6px; bottom: 3px;
  height: 2px; border-radius: 1px; background: var(--vscode-editor-foreground);
}
/* 粗细档：用小横条预览，条越粗笔画越粗（跟左边的颜色圆点区分开） */
.wb-sizes { display: flex; gap: 4px; }
.wb-width {
  width: 26px; height: 26px; padding: 0; border-radius: 4px; position: relative;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 22%, transparent);
}
.wb-width i { display: block; width: 12px; border-radius: 1px; background: var(--vscode-foreground); }
.wb-width.active { background: color-mix(in srgb, var(--vscode-editor-foreground) 10%, transparent); }
.wb-width.active::after {
  content: ""; position: absolute; left: 5px; right: 5px; bottom: 3px;
  height: 2px; border-radius: 1px; background: var(--vscode-editor-foreground);
}
#wb-eraser.active, #wb-undo.active { background: color-mix(in srgb, var(--vscode-editor-foreground) 12%, transparent); }
.wb-grow { flex: 1 1 auto; }
#wb-zoom { min-width: 58px; font-family: var(--oi-num); font-variant-numeric: tabular-nums; font-size: .86em; }
/*
 * 图标按钮（配合 .wb-bar 的 nowrap/横向滚动，见文件顶部）：
 * 固定 26px 见方，和颜色圆点、粗细档同尺寸，宽度不随文案变。
 */
.wb-icon {
  width: 26px; height: 26px; padding: 0; border-radius: 4px; flex: 0 0 auto;
  display: inline-flex; align-items: center; justify-content: center;
  background: transparent; border: 1px solid transparent;
  color: var(--vscode-button-secondaryForeground);
}
.wb-icon:hover { background: var(--vscode-button-secondaryBackground); }
.wb-icon svg { display: block; }
/* 主操作（导出）才用实心色块 —— 一排实心方块会把「导出」埋掉 */
.wb-icon:not(.secondary) {
  color: var(--vscode-button-foreground); background: var(--vscode-button-background);
}
.wb-icon:not(.secondary):hover { background: var(--vscode-button-hoverBackground); }
/*
 * 分组：书写区（笔色/粗细/擦/撤销/清空）与页面、导出区之间的分隔线。
 *
 * 刻意**不做成独立元素**：独立元素要多吃 1px 宽度加两侧 margin，而分屏后工具栏只剩几百像素，
 * 这点宽度正好够把「导出」挤出可视区（见下面诊断计数那段：导出被挤出就是真的不可用）。
 * 改成借用「加一页」按钮的左边框，宽度增量为 0，分组的意思一点没少。
 */
.wb-icon.lead {
  margin-left: 3px; border-left-color: var(--vscode-panel-border);
  border-top-left-radius: 0; border-bottom-left-radius: 0;
}
/*
 * 诊断计数（笔迹 N / 共 N 页 / 状态）是工具栏里唯一可以先让步的：窄到放不下时先让它们截断，
 * 别去挤功能键——尤其是「导出」，被挤出可视区就得先滚动工具栏才点得到，那是真正的可用性问题。
 * 配合下面的 DOM 顺序（计数排在导出之后），窄面板上先丢的总是这三个计数。
 *
 * 「笔迹 N」例外，它不参与收缩：这是排查丢笔的探针，数字被截成「笔迹…」就等于没有
 * （见 AGENTS.md 里那张「数字不涨 = 输入层 / 涨了没墨 = 重绘层」的分流表）。
 */
#wb-stats { flex: 0 0 auto; }
#wb-pages, #wb-status {
  flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis;
}
/* 计数走等宽：笔迹数、页数、状态混排时不至于跳动 */
.wb-readout {
  font-family: var(--oi-num); font-variant-numeric: tabular-nums;
  font-size: .82em; color: var(--vscode-descriptionForeground); white-space: nowrap;
}
#viewport {
  position: relative; flex: 1 1 auto; overflow: hidden;
  touch-action: none; cursor: crosshair; background: var(--vscode-editor-background);
}
/*
 * 白板是「纸」，不是网页：纸面上的题面虽然是 DOM，但不该被选中、拖拽或点击。
 *
 * 为什么必须显式关掉（2026-10-11 用户报「笔走一小段就断、得抬笔重落，题面区域高发」）：
 * 题面里的文字默认可选、图片与链接默认可拖。指针一移动，浏览器就可能把这一下判成「选字」
 * 或「拖走选中的内容」；而**原生拖拽一启动，Chromium 会终止整条指针序列**
 * （pointercancel，此后这个 pointerId 一个事件都不会再来），手里那一笔只能就地收尾 ——
 * 屏幕上就是「写了几厘米突然不落墨，必须抬笔重落」。右侧空白纸没有可选可拖的东西，
 * 所以那边几乎不出问题，这条区域差别正是「DOM 命中测试」在起作用。
 */
#viewport, #viewport * {
  -webkit-user-select: none; user-select: none;
  -webkit-user-drag: none; -webkit-touch-callout: none;
}
/* 题面整块不做命中测试：对指针来说，题面区与右边空白纸应该是同一种东西（都只是纸） */
.oi-sheet-body { pointer-events: none; }
/*
 * 数位笔：系统鼠标光标在笔尖接触时会被 Chromium 藏起来（抬笔才回来），所以笔形指示器由
 * 白板自己画（见 webview.ts 的 drawPenCursor，圆心＝笔尖＝笔迹出现的位置）。
 * 这里把系统光标显式藏掉，免得笔悬停时同时出现系统光标和我们的圈。
 * 鼠标照旧用十字光标。这条规则必须排在下面 .wb-pan / .wb-erase 之前，平移与擦除的光标才盖得住它。
 */
#viewport.wb-pen-cursor { cursor: none; }
#viewport.wb-pan { cursor: grab; }
#viewport.wb-erase { cursor: cell; }
#world { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
#sheet { box-shadow: 0 2px 14px rgba(0, 0, 0, .35); }
/*
 * 纸张外的区域压一层淡灰：让「哪块会被导出」一眼可见。
 * 用 box-shadow 的大 spread 当遮罩，元素本身（纸张大小）不画 —— 纸面仍是干净白底。
 * 这两层标记都在 #sheet 之外，导出时克隆的是 #sheet，所以不会被带进图片。
 */
#marks-out { position: absolute; left: 0; top: 0; box-shadow: 0 0 0 20000px rgba(0, 0, 0, .13); pointer-events: none; }
#marks { position: absolute; left: 0; top: 0; pointer-events: none; }
.oi-page-frame { position: absolute; left: 0; border: 1px dashed #8b95a5; }
.oi-page-tag {
  position: absolute; right: 10px; top: 6px;
  font-size: 11px; line-height: 16px; color: #7a8496;
  background: #ffffff; padding: 0 6px; border-radius: 8px;
}
/*
 * 笔迹单独提一层（will-change 让 Chromium 给它独立合成层）：每帧只重绘画布这一层，
 * 不会顺带把底下那张铺满 KaTeX 文字的题面和超大 spread 的压暗遮罩一起重画 ——
 * 这是「书写跟不跟手」的关键一层，别去掉。
 */
#ink { position: absolute; left: 0; top: 0; pointer-events: none; will-change: transform; }
`;

/*
 * 工具栏图标（内联 SVG，24×24 视框、描边跟随按钮文字色）。
 *
 * 为什么是图标而不是文字：分屏时面板只剩几百像素，中文按钮名会在按钮内部折行。
 * 图标按钮固定 26px 见方，和颜色圆点、粗细档同尺寸，含义写在 title 里（悬停可见，快捷键也写在里面）。
 * 这些路径只出现在工具栏上，**不进导出**（导出克隆的是 #sheet）。
 */
const ICON_ERASER = `<g transform="rotate(-45 12 12)"><rect x="5" y="8.5" width="14" height="7" rx="1.5"/><path d="M12 8.5v7"/></g><path d="M6 20.5h14"/>`;
const ICON_UNDO = `<polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>`;
const ICON_TRASH = `<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>`;
const ICON_PAGE_PLUS = `<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><path d="M12 18v-5"/><path d="M9.5 15.5h5"/>`;
const ICON_PAGE_MINUS = `<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><path d="M9.5 15.5h5"/>`;
const ICON_EXPORT = `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>`;

/**
 * 图标按钮。`tone = "primary"` 用于导出这类主操作（跟随 VSCode 主按钮配色），其余走 secondary。
 * `extra` 用来挂额外的类（如分组用的 .lead，见 WB_STYLE 里那段「为什么不做成独立元素」）。
 * title 里同时写清「是什么」和「快捷键」，因为按钮上不再有文字。
 */
function iconButton(
  id: string,
  title: string,
  body: string,
  tone: "secondary" | "primary" = "secondary",
  extra = "",
): string {
  const cls = (tone === "primary" ? "wb-icon" : "wb-icon secondary") + (extra ? ` ${extra}` : "");
  return (
    `<button id="${id}" class="${cls}" title="${title}" aria-label="${title}">` +
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"` +
    ` stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg></button>`
  );
}

/** 组装白板面板的完整 HTML。 */
export function buildWhiteboardHtml(opts: WhiteboardHtmlOptions): string {
  const pens = PENS.map(
    (p) => `<button class="wb-pen" data-color="${p.value}" title="${p.label}"><i style="background:${p.value}"></i></button>`,
  ).join("\n  ");

  const widths = PEN_WIDTHS.map(
    (w) =>
      `<button class="wb-width" data-width="${w.value}" title="笔画粗细：${w.label}（] 加粗 / [ 变细）"><i style="height:${penBarHeight(w.value)}px"></i></button>`,
  ).join("\n  ");

  const payload = JSON.stringify({
    displayId: opts.displayId,
    title: opts.title,
    strokes: opts.strokes,
    pages: opts.pages,
    exportWidth: opts.exportWidth ?? EXPORT_WIDTH,
    exportHeight: opts.exportHeight ?? EXPORT_HEIGHT,
  });

  const body = `<div class="wb-bar">
  <span class="wb-pens">
  ${pens}
  </span>
  <span class="wb-sizes" title="笔画粗细（] 加粗 / [ 变细）">
  ${widths}
  </span>
  ${iconButton("wb-eraser", "橡皮擦（E）：划过即擦掉整笔", ICON_ERASER)}
  ${iconButton("wb-undo", "撤销上一步（Ctrl+Z）", ICON_UNDO)}
  ${iconButton("wb-clear", "清空全部批注（清空也能用 Ctrl+Z 撤销回来）", ICON_TRASH)}
  ${iconButton("wb-add-page", "在末尾加一张 A4：写到纸尾不够用时点，加出来的页会跟着批注一起保存", ICON_PAGE_PLUS, "secondary", "lead")}
  ${iconButton("wb-del-page", "减掉末尾那张 A4：只减空白页，题面占用的页减不掉，写了字的页要先擦掉", ICON_PAGE_MINUS)}
  <span class="wb-grow"></span>
  <button id="wb-zoom" class="secondary" title="点击恢复「适应页宽」">100%</button>
  ${iconButton("wb-export", "导出为 A4 大小的 PNG（分辨率见设置 lgAssist.whiteboard.exportDpi，默认 150dpi）", ICON_EXPORT, "primary")}
  <span id="wb-stats" class="wb-readout"></span>
  <span id="wb-pages" class="wb-readout"></span>
  <span id="wb-status" class="wb-readout"></span>
</div>
<div id="viewport">
  <div id="world"><div id="marks-out"></div><div id="sheet" class="oi-sheet"><div class="oi-sheet-body">${opts.statementHtml}</div></div><div id="marks"></div></div>
  <canvas id="ink"></canvas>
</div>
<script type="application/json" id="wb-payload">${payload.replace(/</g, "\\u003c")}</script>`;

  return buildWebviewHtml({
    webview: opts.webview,
    title: opts.title,
    stylesheets: [opts.katexCssUri],
    // BASE_STYLE 由 buildWebviewHtml 自动带上；纸张规则必须一起进页面，否则暗色主题下题面不是白底
    style: `${SHEET_RULES}\n${WB_STYLE}`,
    body,
    script: opts.script,
  });
}
