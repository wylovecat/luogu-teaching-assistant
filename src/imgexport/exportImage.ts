import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { buildWebviewHtml } from "../ui/html";
import { tokenizeCpp } from "./tokenize";

const VIEW_TYPE = "lgAssist.codeImage";

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

  const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `代码图片 · ${path.basename(displayName)}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });

  const disposables: vscode.Disposable[] = [];
  current?.panel.dispose();
  current = { panel, lastDataUrl: null, disposables };

  const defaultName = path.basename(displayName).replace(/\.[^.]+$/, "") + ".png";

  const save = async (dataUrl: string): Promise<void> => {
    if (current) current.lastDataUrl = dataUrl;
    const target = await vscode.window.showSaveDialog({
      title: "保存代码图片",
      defaultUri: vscode.Uri.file(path.join(defaultDir(opts.lastDir), defaultName)),
      filters: { "PNG 图片": ["png"] },
    });
    if (!target) return;
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    fs.writeFileSync(target.fsPath, Buffer.from(base64, "base64"));
    await opts.onSaved?.(target.fsPath);
    const action = await vscode.window.showInformationMessage(`已保存图片：${target.fsPath}`, "在文件夹中显示", "复制路径");
    if (action === "在文件夹中显示") void vscode.commands.executeCommand("revealFileInOS", target);
    else if (action === "复制路径") void vscode.env.clipboard.writeText(target.fsPath);
  };

  panel.webview.onDidReceiveMessage(
    async (msg: { command?: string; dataUrl?: string; error?: string }) => {
      if (msg.command === "rendered" && msg.dataUrl) {
        if (current) current.lastDataUrl = msg.dataUrl;
        await save(msg.dataUrl);
      } else if (msg.command === "save" && msg.dataUrl) {
        await save(msg.dataUrl);
      } else if (msg.command === "error") {
        void vscode.window.showErrorMessage(`生成图片失败：${msg.error ?? "未知原因"}`);
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

  const statusText = "图片已生成。若已取消保存，可点下方按钮再次保存。";

  const payload = JSON.stringify({ fileName: displayName, lines });
  const script = `
const vscode = acquireVsCodeApi();
const DATA = JSON.parse(document.getElementById('payload').textContent);
const PAD = 28, LINE_H = 21, SCALE = 2, NUM_GAP = 18, TITLE_H = 40;
const FONT = "14px 'JetBrains Mono','Cascadia Code','Noto Sans Mono CJK SC',Consolas,monospace";

function draw() {
  const lines = DATA.lines;
  const text = lines.map((runs) => runs.map((r) => r.text).join(''));
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = FONT;
  let maxWidth = 0;
  for (const line of text) maxWidth = Math.max(maxWidth, probe.measureText(line).width);
  const numW = probe.measureText('0'.repeat(String(lines.length).length)).width;

  const codeX = PAD + numW + NUM_GAP;
  const gutterEdge = PAD + numW + NUM_GAP / 2;
  const w = Math.ceil(maxWidth) + codeX + PAD + 8;
  const h = lines.length * LINE_H + PAD * 2 + TITLE_H;

  const canvas = document.getElementById('canvas');
  canvas.width = w * SCALE; canvas.height = h * SCALE;
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

  c.font = FONT; c.textBaseline = 'top';
  c.textAlign = 'right'; c.fillStyle = '#858585';
  lines.forEach((_, i) => c.fillText(String(i + 1), PAD + numW, PAD + TITLE_H + i * LINE_H));
  c.textAlign = 'left';

  lines.forEach((runs, i) => {
    const y = PAD + TITLE_H + i * LINE_H;
    let x = codeX;
    for (const run of runs) { c.fillStyle = run.color; c.fillText(run.text, x, y); x += probe.measureText(run.text).width; }
  });
  return canvas.toDataURL('image/png');
}

try {
  const url = draw();
  document.getElementById('status').textContent = ${JSON.stringify(statusText)};
  document.getElementById('save').style.display = 'inline-block';
  document.getElementById('save').addEventListener('click', () => vscode.postMessage({ command:'save', dataUrl: draw() }));
  vscode.postMessage({ command:'rendered', dataUrl: url });
} catch (e) {
  vscode.postMessage({ command:'error', error: String(e && e.message || e) });
}`;

  panel.webview.html = buildWebviewHtml({
    webview: panel.webview,
    title: "代码图片",
    style: `
body { background: var(--vscode-editor-background); }
#wrap { display:flex; flex-direction:column; align-items:flex-start; gap:12px; }
#actions { display:flex; gap:8px; }
#save { display:none; }
#canvas { max-width:100%; height:auto; border-radius:6px; box-shadow: 0 4px 18px rgba(0,0,0,.35); }
`,
    body: `<div id="wrap">
  <div class="muted" id="status">正在渲染图片…</div>
  <div id="actions">
    <button id="save" class="secondary">保存为 PNG</button>
  </div>
  <canvas id="canvas"></canvas>
</div>
<script type="application/json" id="payload">${payload.replace(/</g, "\\u003c")}</script>`,
    script,
  });
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
