import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildWebviewHtml } from "../ui/html";
import { imageExportConfig, output, updateImageFontSize } from "../config";
import { clampCodeFontPx, codeFontRuntime, DEFAULT_CODE_FONT_PX } from "./codeFont";
import { tokenizeCpp } from "./tokenize";

const VIEW_TYPE = "lgAssist.codeImage";

/**
 * Chromium canvas 的尺寸上限（像素）。
 *
 * 代码图片是「按内容算尺寸」的位图：行数 × 行高、最长行的宽度。字号调大后两者都跟着涨，
 * 越过上限时**浏览器不抛错** —— `toDataURL()` 只给一张空图（"data:,"），写出去就是 0 字节的
 * `.png`，老师点开才发现打不开。所以画之前先判一次（见 `canvasLimitRuntime`）。
 *
 * 单边上限取小值（32767）是安全的：超过它的图在任何 Chromium 版本上都可能直接给空图。
 */
const MAX_CANVAS_SIDE = 32767;
/** 面积上限（像素²）：16384 × 16384 = 268435456。单边没超但两边都很大时也会触到这一条。 */
const MAX_CANVAS_AREA = 268435456;

interface ImagePanelState {
  panel: vscode.WebviewPanel;
  lastDataUrl: string | null;
  disposables: vscode.Disposable[];
}

export interface ExportImageOptions {
  /** 上次保存到的目录，作为本次保存框的默认目录 */
  lastDir?: string;
  /** 每次保存成功后回调（调用方用来记住目录） */
  onSaved?: (filePath: string) => void | Promise<void>;
  /**
   * 代码字号（px，来自 `lgAssist.imageExport.fontSize`）。
   * 不给就走设置项里的当前值（默认 14px，与老版本一致）。
   */
  fontPx?: number;
}

let current: ImagePanelState | undefined;

/**
 * 把代码渲染成带标题栏、行号栏的 PNG 并保存。
 *
 * 绘制放在 webview 里用 canvas 做（2x 缩放保证清晰），扩展进程负责给保存路径、
 * 写文件。分词已经在扩展进程用 highlight.js 完成，webview 只负责画。
 */
export async function exportCodeImage(
  code: string,
  fileName: string,
  opts: ExportImageOptions = {},
): Promise<void> {
  const lines = tokenizeCpp(code);
  const displayName = fileName || "code.cpp";
  /** 字号：调用方没给就取设置项里的当前档（面板里的 A−/A＋ 改的也是那一项） */
  const fontPx = clampCodeFontPx(opts.fontPx ?? imageExportConfig().fontSize);

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `代码图片 · ${path.basename(displayName)}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const disposables: vscode.Disposable[] = [];
  current?.panel.dispose();
  current = { panel, lastDataUrl: null, disposables };

  const defaultName = path.basename(displayName).replace(/\.[^.]+$/, "") + ".png";

  const save = async (dataUrl: string): Promise<void> => {
    const bytes = pngBytes(dataUrl);
    if (!bytes) {
      // canvas 超限时 toDataURL() 给的是 "data:," —— 直接写盘就是一个 0 字节的 .png，
      // 老师点开才发现打不开（而面板上明明显示「已保存图片」）。
      void vscode.window.showErrorMessage(
        "没有生成有效的图片（代码太长或单行太宽，超出了浏览器的画布上限），请把代码字号调小或拆短后再导出。",
      );
      return;
    }
    if (current) current.lastDataUrl = dataUrl;
    const target = await vscode.window.showSaveDialog({
      title: "保存代码图片",
      defaultUri: vscode.Uri.file(path.join(defaultDir(opts.lastDir), defaultName)),
      filters: { "PNG 图片": ["png"] },
    });
    if (!target) return;
    fs.writeFileSync(target.fsPath, bytes);
    await opts.onSaved?.(target.fsPath);
    const action = await vscode.window.showInformationMessage(`已保存图片：${target.fsPath}`, "在文件夹中显示", "复制路径");
    if (action === "在文件夹中显示") void vscode.commands.executeCommand("revealFileInOS", target);
    else if (action === "复制路径") void vscode.env.clipboard.writeText(target.fsPath);
  };

  panel.webview.onDidReceiveMessage(
    async (msg: { command?: string; dataUrl?: string; error?: string; fontPx?: number }) => {
      try {
        if (msg.command === "rendered" && msg.dataUrl) {
          if (current) current.lastDataUrl = msg.dataUrl;
          await save(msg.dataUrl);
        } else if (msg.command === "save" && msg.dataUrl) {
          await save(msg.dataUrl);
        } else if (msg.command === "fontSize") {
          // 面板里改完字号就落盘（写设置项；写哪一层见 config.updateImageFontSize）
          // 面板把新图也带回来了：顺手换掉 lastDataUrl，别再拿着旧字号的图去存。
          if (current && msg.dataUrl) current.lastDataUrl = msg.dataUrl;
          if (msg.fontPx !== undefined) {
            await updateImageFontSize(clampCodeFontPx(Number(msg.fontPx)));
          }
        } else if (msg.command === "error") {
          void vscode.window.showErrorMessage(`生成图片失败：${msg.error ?? "未知原因"}`);
        }
      } catch (e) {
        // 保存写盘失败（只读目录、磁盘满）也要说出来，不能静默
        output.appendLine(`[图片] 保存代码图片失败：${e instanceof Error ? e.message : String(e)}`);
        void vscode.window.showErrorMessage(`图片操作失败：${e instanceof Error ? e.message : String(e)}`);
      }
    },
    null,
    disposables,
  );

  panel.onDidDispose(
    () => {
      while (disposables.length) disposables.pop()?.dispose();
      if (current?.panel === panel) current = undefined;
    },
    null,
    disposables,
  );

  panel.webview.html = buildCodeImageHtml({
    webview: panel.webview,
    fileName: displayName,
    lines,
    fontPx,
  });
}

export interface CodeImageHtmlOptions {
  /** 面板 webview（CSP 用） */
  webview: vscode.Webview;
  /** 标题栏里显示的文件名 */
  fileName: string;
  /** 已分词的行（tokenizeCpp 的结果），脚本按它逐行画 */
  lines: ReturnType<typeof tokenizeCpp>;
  /** 代码字号（px，来自 `lgAssist.imageExport.fontSize`）；未给就走默认档 */
  fontPx?: number;
}

/**
 * 代码图片面板的整份 HTML。
 *
 * 从 `exportCodeImage` 里拆出来是为了让 test/codeFont.test.ts 能直接断言
 * 「字号控件在、载荷里带的是清洗过的字号、脚本里的档位与 codeFont.ts 一致」——
 * 面板逻辑全在这一个字符串里，真跑起来要 vscode 的 WebviewPanel，单元测试里拿不到。
 */
export function buildCodeImageHtml(opts: CodeImageHtmlOptions): string {
  const statusText = "图片已生成。若已取消保存，可点下方按钮再次保存。";

  const fontPx = clampCodeFontPx(Number(opts.fontPx ?? DEFAULT_CODE_FONT_PX));
  const payload = JSON.stringify({ fileName: opts.fileName, lines: opts.lines, fontPx });
  const script = `
const vscode = acquireVsCodeApi();
const DATA = JSON.parse(document.getElementById('payload').textContent);
const PAD = 28, SCALE = 2, NUM_GAP = 18, TITLE_H = 40;
${codeFontRuntime()}
${canvasLimitRuntime()}
let fontPx = clampFontPx(DATA.fontPx);

function draw() {
  const lines = DATA.lines;
  const text = lines.map((runs) => runs.map((r) => r.text).join(''));
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = fontSpec(fontPx);
  let maxWidth = 0;
  for (const line of text) maxWidth = Math.max(maxWidth, probe.measureText(line).width);
  const numW = probe.measureText('0'.repeat(String(lines.length).length)).width;

  const codeX = PAD + numW + NUM_GAP;
  const gutterEdge = PAD + numW + NUM_GAP / 2;
  const w = Math.ceil(maxWidth) + codeX + PAD + 8;
  const lineH = lineHeight(fontPx);
  const h = lines.length * lineH + PAD * 2 + TITLE_H;

  // 先问尺寸：超限时 Chromium 不抛错，toDataURL() 只会给一张空图（"data:,"），
  // 于是写盘变成 0 字节 PNG、还弹「已保存图片」。这里提前把话说清楚。
  const pxW = Math.ceil(w * SCALE), pxH = Math.ceil(h * SCALE);
  if (canvasTooLarge(pxW, pxH)) throw new Error(canvasLimitMessage(pxW, pxH));

  const canvas = document.getElementById('canvas');
  canvas.width = pxW; canvas.height = pxH;
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
  const c = canvas.getContext('2d');
  c.scale(SCALE, SCALE);

  c.fillStyle = '#1e1e1e'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#252526'; c.fillRect(0, TITLE_H, gutterEdge, h - TITLE_H);
  c.fillStyle = '#3a3a3a'; c.fillRect(gutterEdge, TITLE_H, 1, h - TITLE_H);
  c.fillStyle = '#2d2d2d'; c.fillRect(0, 0, w, TITLE_H);
  const dots = ['#ff5f57', '#febc2e', '#28c840'];
  for (let i = 0; i < 3; i++) { c.beginPath(); c.arc(PAD + i * 18, TITLE_H / 2, 5, 0, Math.PI * 2); c.fillStyle = dots[i]; c.fill(); }
  c.fillStyle = '#9d9d9d'; c.font = '13px system-ui,sans-serif'; c.textBaseline = 'middle';
  c.fillText(DATA.fileName, PAD + 70, TITLE_H / 2 + 1);

  c.font = fontSpec(fontPx); c.textBaseline = 'top';
  c.textAlign = 'right'; c.fillStyle = '#858585';
  lines.forEach((_, i) => c.fillText(String(i + 1), PAD + numW, PAD + TITLE_H + i * lineH));
  c.textAlign = 'left';

  lines.forEach((runs, i) => {
    const y = PAD + TITLE_H + i * lineH;
    let x = codeX;
    for (const run of runs) { c.fillStyle = run.color; c.fillText(run.text, x, y); x += probe.measureText(run.text).width; }
  });
  const url = canvas.toDataURL('image/png');
  // 尺寸判过了仍可能拿到空串（内存不足 / 区域上限按设备算）：别把 "data:," 当成功报出去
  if (!url || url.indexOf('data:image/png') !== 0) {
    throw new Error('浏览器没能把画布导出成 PNG（尺寸 ' + pxW + '×' + pxH + '），请把代码字号调小或把文件拆短后再试。');
  }
  return url;
}

function showFont() { document.getElementById('fontsize').textContent = fontPx + 'px'; }

/* 画图可能因为「代码太长/太宽」而抛错：事件回调里的异常不会有人接，必须自己报给扩展进程
   （否则点「保存」就是彻底没反应，老师只会以为按钮坏了）。 */
function drawSafe() {
  try { return draw(); } catch (e) { vscode.postMessage({ command:'error', error: String(e && e.message || e) }); return null; }
}

/* 改字号后立刻重画：图的宽高、行号栏宽度都跟着字号走，画完顺手把新图报给扩展进程 */
function stepFont(dir) {
  const next = clampFontPx(fontPx + dir * FONT_STEP);
  if (next === fontPx) return;
  const prev = fontPx;
  fontPx = next;
  const url = drawSafe();
  if (!url) { fontPx = prev; showFont(); return; } // 调大后超限：退回原档，别让读数与实际图对不上
  showFont();
  vscode.postMessage({ command:'fontSize', fontPx, dataUrl: url });
}

try {
  const url = draw();
  showFont();
  document.getElementById('status').textContent = ${JSON.stringify(statusText)};
  document.getElementById('save').style.display = 'inline-block';
  document.getElementById('save').addEventListener('click', () => {
    const url = drawSafe();
    if (url) vscode.postMessage({ command:'save', dataUrl: url });
  });
  document.getElementById('font-minus').addEventListener('click', () => stepFont(-1));
  document.getElementById('font-plus').addEventListener('click', () => stepFont(1));
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '-' || e.key === '_') { stepFont(-1); e.preventDefault(); }
    else if (e.key === '=' || e.key === '+') { stepFont(1); e.preventDefault(); }
  });
  vscode.postMessage({ command:'rendered', dataUrl: url });
} catch (e) {
  vscode.postMessage({ command:'error', error: String(e && e.message || e) });
}`;

  return buildWebviewHtml({
    webview: opts.webview,
    title: "代码图片",
    style: `
body { background: var(--vscode-editor-background); }
#wrap { display:flex; flex-direction:column; align-items:flex-start; gap:12px; }
#actions { display:flex; gap:8px; align-items:center; }
#save { display:none; }
/*
 * 字号控件与「保存」同一行、靠右留出 12px：这条是**动作行**，改字号会重画图，
 * 和「保存为 PNG」是一类操作（改完立刻能存），所以放一起而不是另起一行。
 */
#fontgroup { display:inline-flex; align-items:center; gap:6px; margin-left:12px; }
#fontsize { font-family: var(--oi-num); font-variant-numeric: tabular-nums; min-width:38px; text-align:center; }
#canvas { max-width:100%; height:auto; border-radius:6px; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
`,
    body: `<div id="wrap">
  <div class="muted" id="status">正在渲染图片…</div>
  <div id="actions">
    <button id="save" class="secondary">保存为 PNG</button>
    <span id="fontgroup" title="代码字号（8–32px，每次 2px）：投影上看不清就调大，图会跟着变高变宽；也可以按 - / = 调整">
      <button id="font-minus" class="secondary" aria-label="代码字号调小一档">A−</button>
      <span id="fontsize" class="muted">${fontPx}px</span>
      <button id="font-plus" class="secondary" aria-label="代码字号调大一档">A＋</button>
    </span>
  </div>
  <canvas id="canvas"></canvas>
</div>
<script type="application/json" id="payload">${payload.replace(/</g, "\\u003c")}</script>`,
    script,
  });
}

/**
 * 注入代码图片面板脚本的画布上限判据（与上面的常量同源，别在面板里另写一套）。
 */
export function canvasLimitRuntime(): string {
  return `const MAX_CANVAS_SIDE = ${MAX_CANVAS_SIDE}, MAX_CANVAS_AREA = ${MAX_CANVAS_AREA};
function canvasTooLarge(w, h) {
  if (!isFinite(w) || !isFinite(h) || w <= 0 || h <= 0) return true;
  return w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE || w * h > MAX_CANVAS_AREA;
}
function canvasLimitMessage(w, h) {
  return '代码图片尺寸 ' + Math.round(w) + '×' + Math.round(h) + ' 像素，超过浏览器画布上限' +
    '（单边 ' + MAX_CANVAS_SIDE + 'px、总面积 ' + MAX_CANVAS_AREA + 'px²）。请把代码字号调小，' +
    '或把文件拆短后再导出 —— 超限时浏览器只会给出一张空图。';
}`;
}

/**
 * `data:image/png;base64,…` → PNG 字节；不是一张**真的** PNG 就返回 null。
 *
 * 两道判据缺一不可：前缀/载荷形状（canvas 超限时给的是 `"data:,"`，解出来是 0 字节）
 * 与 PNG 签名（89 50 4E 47 0D 0A 1A 0A）—— 否则写盘成功，老师打开却是一张打不开的图。
 */
export function pngBytes(dataUrl: string): Buffer | null {
  if (typeof dataUrl !== "string") return null;
  const prefix = "data:image/png;base64,";
  if (!dataUrl.startsWith(prefix)) return null;
  const base64 = dataUrl.slice(prefix.length);
  if (!base64) return null;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (bytes.length < 8) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i++) {
    if (bytes[i] !== signature[i]) return null;
  }
  return bytes;
}

/**
 * 保存框的默认目录：优先用上次保存的位置（目录被删掉了就忽略），
 * 否则落到工作区根目录，再不行用家目录。
 * 白板的 A4 导出也用这套（同一个「上次导出目录」）。
 */
export function defaultDir(lastDir?: string): string {
  if (lastDir && fs.existsSync(lastDir)) return lastDir;
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length) return folders[0].uri.fsPath;
  return os.homedir();
}
