import * as vscode from "vscode";
import type { Statement } from "../problems/statement";
import { clampFontScale, DEFAULT_FONT_SCALE, FONT_SCALE_KEY, FONT_SCALE_MAX, FONT_SCALE_MIN, FONT_SCALE_STEP } from "./fontScale";
import { buildWebviewHtml, BASE_STYLE } from "./html";
import { escapeHtml, renderMarkdownBody } from "./markdown";

const VIEW_TYPE = "lgAssist.statement";

/** 把题面组装成一段 Markdown（优先站点给的完整 markdown）。 */
export function statementToSource(s: Statement): string {
  if (s.rawMarkdown.trim()) {
    const head = `# ${s.displayId} ${s.title}`.trim();
    return s.rawMarkdown.includes(s.displayId) || !s.displayId ? s.rawMarkdown : `${head}\n\n${s.rawMarkdown}`;
  }
  const parts: string[] = [`# ${s.displayId} ${s.title}`.trim()];
  const limits: string[] = [];
  if (s.timeLimitMs !== null) limits.push(`时间限制 ${s.timeLimitMs} ms`);
  if (s.memoryLimitMb !== null) limits.push(`内存限制 ${s.memoryLimitMb} MB`);
  if (limits.length) parts.push(`> ${limits.join(" · ")}`);
  const block = (t: string, body: string) => {
    if (body.trim()) parts.push(`## ${t}`, "", body.trim());
  };
  block("题目描述", s.description);
  block("输入格式", s.inputDescription);
  block("输出格式", s.outputDescription);
  if (s.samples.length) {
    parts.push("## 样例");
    s.samples.forEach((sample, i) => {
      parts.push(`### 样例 ${i + 1}`, "", "**输入**", "", "```", sample.input.replace(/\s+$/, ""), "```", "", "**输出**", "", "```", sample.output.replace(/\s+$/, ""), "```");
    });
  }
  block("提示", s.prompt);
  block("说明", s.hint);
  return parts.join("\n");
}

class StatementPanel {
  static current: StatementPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  /**
   * 正文字号缩放（1 = 原样）。**会话内权威**：点击后同步更新，globalState 只是持久副本。
   * 换题复用面板时字段不重置 → 字号保留；关面板重开则由构造函数从 globalState 恢复。
   */
  private fontScale: number;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private statement: Statement,
    /** 换题时会整体换掉：面板是复用的，回调若跟着第一道题不放，按钮会作用到上一道题上 */
    private actions: StatementActions,
    /** 旁注标记（洛谷传难度标签，如「普及-」），只是「这道题什么档」的注脚；留空则不显示 */
    private badge: string,
  ) {
    // 从 globalState 恢复字号（脏值在 clampFontScale 里被拉回合法档）
    this.fontScale = clampFontScale(Number(this.context.globalState.get(FONT_SCALE_KEY, DEFAULT_FONT_SCALE)));
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: { command?: string; scale?: number }) => this.onMessage(msg),
      null,
      this.disposables,
    );
    this.render();
  }

  static show(
    context: vscode.ExtensionContext,
    statement: Statement,
    actions: StatementActions,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
    badge = "",
  ): void {
    if (StatementPanel.current) {
      // 面板复用：题面、回调、来源标记必须一起换，只换其中一部分会让按钮作用到上一道题上
      StatementPanel.current.statement = statement;
      StatementPanel.current.actions = actions;
      StatementPanel.current.badge = badge;
      StatementPanel.current.panel.title = `${statement.displayId} ${statement.title}`.trim();
      StatementPanel.current.panel.reveal(column);
      StatementPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, `${statement.displayId} ${statement.title}`.trim(), column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    });
    StatementPanel.current = new StatementPanel(panel, context, statement, actions, badge);
  }

  private onMessage(msg: { command?: string; scale?: number }): void {
    switch (msg.command) {
      case "create":
        void this.actions.onCreate();
        break;
      case "openMd":
        void this.actions.onOpenMarkdown();
        break;
      case "copySamples":
        void this.actions.onCopySamples();
        break;
      case "whiteboard":
        void this.actions.onOpenWhiteboard();
        break;
      case "fontScale":
        /*
         * 字号：前端点一下就地改 CSS 变量生效了（不重渲染），这里只负责「记住」。
         * 权威拉一次夹紧（防脏值/缺失 → 回落默认），同步更新 this.fontScale（会话内立即一致），
         * globalState 异步落盘 —— 与同方法里 void this.actions.* 一样是 fire-and-forget。
         */
        this.fontScale = clampFontScale(Number(msg.scale));
        void this.context.globalState.update(FONT_SCALE_KEY, this.fontScale);
        break;
    }
  }

  private render(): void {
    const s = this.statement;
    const katexCss = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "dist", "katex", "katex.min.css"),
    );
    const rendered = renderMarkdownBody(statementToSource(s));
    /*
     * 题号 + 题名提到头部做成名牌，正文里 markdown 生成的那个 <h1> 就摘掉，别重复两遍。
     * 只摘「位于开头」的 <h1>：站点给的 rawMarkdown 可能自带标题且不是 <h1>，那种一个字都不动。
     *
     * 注意别去改 statementToSource —— 白板那张纸还在用它，纸上的标题要留着
     * （test/whiteboard.test.ts 盯着纸面上有 <h1>）。
     */
    const lead = /^\s*<h1>[\s\S]*?<\/h1>/.exec(rendered);
    const bodyHtml = lead ? rendered.slice(lead[0].length).replace(/^\s+/, "") : rendered;

    const limits: string[] = [];
    if (s.timeLimitMs !== null) limits.push(`${s.timeLimitMs} ms`);
    if (s.memoryLimitMb !== null) limits.push(`${s.memoryLimitMb} MB`);
    // 时限/内存是赛制参数，按「数据铭牌」处理：等宽 + 小标签，不跟正文叙事混在一起
    const limitChip = limits.length
      ? `<span class="oi-chip"><em>限制</em>${limits
          .map((v, i) => `${i ? "<i>·</i>" : ""}${escapeHtml(v)}`)
          .join("")}</span>`
      : "";

    /*
     * 字号控件：A− / 读数 / A+ 的步进组，放工具栏左侧（视图控件），与右侧动作按钮用 oi-grow 隔开。
     * 静态就把读数与禁用态按当前字号注入，免得脚本跑之前闪一下错误状态。
     */
    const fontPct = Math.round(this.fontScale * 100);
    const fontCtl = `<span class="font-ctl" role="group" aria-label="正文字号">
  <button id="fontDown" class="secondary" title="减小正文字号" aria-label="减小正文字号"${this.fontScale <= FONT_SCALE_MIN ? " disabled" : ""}>A−</button>
  <span id="fontScale" class="mono font-readout">${fontPct}%</span>
  <button id="fontUp" class="secondary" title="增大正文字号" aria-label="增大正文字号"${this.fontScale >= FONT_SCALE_MAX ? " disabled" : ""}>A+</button>
</span>`;

    const body = `<div class="toolbar">
  ${this.badge ? `<span class="badge">${escapeHtml(this.badge)}</span>` : ""}
  ${fontCtl}
  <span class="oi-grow"></span>
  <button id="create" title="在题目目录里创建 .cpp、样例与题面 md">创建题目文件</button>
  <button id="whiteboard" class="secondary">打开白板</button>
  <button id="openMd" class="secondary">打开 Markdown</button>
  <button id="copySamples" class="secondary">复制全部样例</button>
</div>
<header class="oi-doc-head">
  <div class="oi-doc-id">${escapeHtml(s.displayId)}</div>
  <div class="oi-doc-titles"><h1>${escapeHtml(s.title)}</h1></div>
  ${limitChip}
</header>
<div class="oi-rule"></div>
${bodyHtml}`;

    const script = `
const vscode = acquireVsCodeApi();
for (const [id, command] of [['create','create'],['whiteboard','whiteboard'],['openMd','openMd'],['copySamples','copySamples']]) {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', () => vscode.postMessage({ command }));
}

/*
 * 正文字号：点一下就地改 --oi-font-scale（body font-size 乘它；标题/代码都是 em 会一起缩放），
 * 不重渲染面板（重渲染会跳回顶部、重跑 KaTeX）。改完把目标值发给扩展去持久化（globalState）。
 * 常量由扩展注入，扩展侧 src/ui/fontScale.ts 是唯一出处。
 */
const FONT_MIN = ${FONT_SCALE_MIN}, FONT_MAX = ${FONT_SCALE_MAX}, FONT_STEP = ${FONT_SCALE_STEP};
let fontScale = ${this.fontScale};
const fontDown = document.getElementById('fontDown');
const fontUp = document.getElementById('fontUp');
const fontReadout = document.getElementById('fontScale');
const round1 = (n) => Math.round(n * 10) / 10;
const clampFont = (n) => Math.min(FONT_MAX, Math.max(FONT_MIN, round1(n)));
function renderFont(n) {
  fontScale = clampFont(n);
  document.documentElement.style.setProperty('--oi-font-scale', fontScale);
  if (fontReadout) fontReadout.textContent = Math.round(fontScale * 100) + '%';
  if (fontDown) fontDown.disabled = fontScale <= FONT_MIN;
  if (fontUp) fontUp.disabled = fontScale >= FONT_MAX;
}
renderFont(fontScale);
if (fontDown) fontDown.addEventListener('click', () => { renderFont(fontScale - FONT_STEP); vscode.postMessage({ command: 'fontScale', scale: fontScale }); });
if (fontUp) fontUp.addEventListener('click', () => { renderFont(fontScale + FONT_STEP); vscode.postMessage({ command: 'fontScale', scale: fontScale }); });`;

    this.panel.webview.html = buildWebviewHtml({
      webview: this.panel.webview,
      title: `${s.displayId} ${s.title}`,
      stylesheets: [katexCss.toString()],
      style: `${BASE_STYLE}
/*
 * 正文字号缩放：--oi-font-scale 由扩展注入当前值（脚本跑之前就是对的，无闪烁），点击时脚本就地改它。
 * 只覆盖 body 的 font-size，其余属性仍走 BASE_STYLE；标题/代码/表格都是 em 相对正文，会一起等比缩放。
 * ⚠️ 这段是题面面板专属：别挪进共享的 BASE_STYLE，否则会改到白板纸面的字号。
 */
:root { --oi-font-scale: ${this.fontScale}; }
body { font-size: calc(var(--vscode-font-size) * var(--oi-font-scale)); }
.font-ctl { display: inline-flex; align-items: center; gap: 3px; }
.font-readout { font-size: .84em; min-width: 40px; text-align: center; color: var(--vscode-descriptionForeground); }
/* 题号是这道题的身份：等宽、加粗、带一圈淡边，题名退为叙事层 */
.oi-doc-head { display: flex; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin: 4px 0 0; }
.oi-doc-id {
  font-family: var(--oi-num); font-variant-numeric: tabular-nums;
  font-size: 1.5em; font-weight: 700; letter-spacing: -.01em; line-height: 1.15;
  padding: 1px 9px; border-radius: 4px;
  background: var(--oi-tint);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-editor-foreground) 18%, transparent);
}
.oi-doc-titles { flex: 1 1 220px; }
.oi-doc-titles h1 { margin: 0; font-size: 1.35em; }
/* 难度标记描边小标签：它是「这道题什么档」的旁注，不该跟创建按钮一样抢眼 */
.badge {
  display: inline-flex; align-items: center;
  font-size: .84em; letter-spacing: .03em; padding: 1px 9px; border-radius: 3px;
  background: transparent; color: var(--vscode-editor-foreground);
  border: 1px solid color-mix(in srgb, var(--vscode-editor-foreground) 30%, transparent);
}
.katex-display { overflow-x: auto; overflow-y: hidden; padding: 4px 0; }`,
      body,
      script,
    });
  }

  private dispose(): void {
    StatementPanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

export interface StatementActions {
  onCreate(): Promise<void> | void;
  onOpenMarkdown(): Promise<void> | void;
  onCopySamples(): Promise<void> | void;
  /** 把这道题的题面带进批注白板 */
  onOpenWhiteboard(): Promise<void> | void;
}

/** column 默认 Beside，建题流程会显式传 ViewColumn.One 把题面放到左栏。 */
export function showStatement(
  context: vscode.ExtensionContext,
  statement: Statement,
  actions: StatementActions,
  column: vscode.ViewColumn = vscode.ViewColumn.Beside,
  /** 旁注标记（洛谷传难度标签，如「普及-」）：面板上会显示成一个小标签 */
  badge = "",
): void {
  StatementPanel.show(context, statement, actions, column, badge);
}
