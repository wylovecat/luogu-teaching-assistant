/**
 * 白板面板（扩展进程侧）：开/复用 webview、注入渲染好的题面（知识面板则是一张白纸）、
 * 搬运批注的持久化、把 webview 导出的 A4 PNG 落到磁盘。
 *
 * webview 里那层画布与交互在 src/whiteboard/webview.ts（单独打包成 dist/whiteboard.js，
 * 启动时读文件内容内联进 HTML 走 nonce）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { output } from "../config";
import { defaultDir } from "../imgexport/exportImage";
import type { Statement } from "../problems/statement";
import { renderMarkdownBody } from "../ui/markdown";
import { collectFontUrls, inlineFontSources } from "./fontCss";
import {
  KNOWLEDGE_BOARD_PAGES_KEY,
  KNOWLEDGE_BOARD_STATE_KEY,
  SHEET_CSS,
  clampExportDpi,
  clampPageCount,
  exportPixels,
  multiPageFileStem,
  sanitizeStrokes,
  strokesToPersist,
  whiteboardFileStem,
  whiteboardPagesKey,
  whiteboardStateKey,
  type Stroke,
} from "./model";
import { buildWhiteboardHtml } from "./panelHtml";
import { inlineRemoteImages, MAX_INLINE_IMAGES } from "./remoteImage";
import { whiteboardStatementMarkdown } from "./source";

const VIEW_TYPE = "lgAssist.whiteboard";

/**
 * 落盘防抖间隔。
 *
 * 批注逼近 2 MB 上限时，每一笔的 sanitize + JSON.stringify + workspaceState 写盘都是 O(全部点)，
 * 连着写就会在「抬笔的那一瞬」掉一下帧。webview 的消息不防抖（立刻发，数据先到扩展进程，
 * 面板被销毁也不丢），只把扩展侧的重活合并：静默一小段时间没有新笔迹了才写一次。
 * 关面板时 dispose() 会补一次 flush，不会丢最后几笔。
 */
const PERSIST_DEBOUNCE_MS = 400;

interface WebviewMessage {
  command?: string;
  strokes?: unknown;
  images?: string[];
  blank?: boolean;
  message?: string;
  /** notify 事件的类别 */
  kind?: string;
  /** savePages：用户手动加出来的纸面页数 */
  pages?: number;
  /** export：导出目标。`"banshu"` = 落进题目录并写进题解（不弹保存框） */
  target?: string;
  /** inlineImages：导出前要内联的题面图片地址 */
  urls?: unknown;
}

export interface WhiteboardOptions {
  /** 上次导出图片保存到的目录（与代码图片导出共用） */
  lastDir?: string;
  /** 每次保存成功后回调（调用方用来记住目录） */
  onSaved?: (filePath: string) => void | Promise<void>;
  /** 导出分辨率（dpi，来自 `lgAssist.whiteboard.exportDpi`）；缺省用模型的默认档 */
  exportDpi?: number;
  /**
   * 笔迹稳定器强度（来自 `lgAssist.whiteboard.stabilize`）：off / light / medium / strong。
   * 原样带进载荷，脏值由 webview 侧夹回「关」。
   */
  stabilize?: unknown;
  /**
   * 「导出并插入题解」的目标：给了才会在工具栏上多出那个按钮。
   * 走它时**不弹保存对话框**，直接按固定名写进题目录（`<base>.png` / `<base>-p2.png`），
   * 好让题解文档能按约定文件名引用。
   */
  banshu?: { dir: string; base: string };
  /** 已写进题解目录的回调（调用方据此把图写进 `题解板书.typ`）。 */
  onBanshuSaved?: (files: string[]) => void | Promise<void>;
}

/**
 * 一块白板的「内容」：题面白板装某一题的题面，知识面板装空白（整张 A4 都是白纸）。
 * 抽这一层是因为两类白板除了纸上放什么，其余（笔、导出、落盘）完全一样。
 */
interface BoardContent {
  /** 面板标题（也是窗口标签上显示的） */
  title: string;
  /** 进 webview 载荷：题号，或知识面板的「知识面板」 */
  displayId: string;
  /** 批注落盘的 workspaceState key */
  stateKey: string;
  /** 手动加页数的 workspaceState key（与批注分开存） */
  pagesKey: string;
  /** 导出 PNG 的文件名前缀（不含页码后缀与扩展名） */
  fileStem: string;
  /** 纸张上的 HTML；知识面板为空串 = 整页白纸 */
  statementHtml: string;
  /** 纸面本来就该是空的（知识面板）：导出抽检到全白不算渲染失败，不提示「题面没渲染出来」 */
  blankSheet: boolean;
}

/** 两类白板各占一个面板实例，互相不顶替 */
type BoardSlot = "problem" | "knowledge";

function problemBoard(statement: Statement): BoardContent {
  return {
    title: `白板 · ${statement.displayId} ${statement.title}`.trim(),
    displayId: statement.displayId,
    stateKey: whiteboardStateKey(statement.displayId),
    pagesKey: whiteboardPagesKey(statement.displayId),
    // 导出文件名就是「题号 题目名」，导出的讲义一眼能认出是哪道题
    fileStem: whiteboardFileStem(statement.displayId, statement.title),
    statementHtml: renderMarkdownBody(whiteboardStatementMarkdown(statement)),
    blankSheet: false,
  };
}

/** 知识面板：一张没有题面的 A4 白纸，用来讲知识点 */
function knowledgeBoard(): BoardContent {
  return {
    title: "知识面板",
    displayId: "知识面板",
    stateKey: KNOWLEDGE_BOARD_STATE_KEY,
    pagesKey: KNOWLEDGE_BOARD_PAGES_KEY,
    fileStem: "知识面板",
    statementHtml: "",
    blankSheet: true,
  };
}

class WhiteboardPanel {
  /** 打开着的题面白板（同一时刻一块，换题就复用） */
  static problem: WhiteboardPanel | undefined;
  /** 打开着的知识面板（空白白板）：单独一块，开它不会把题面白板顶掉 */
  static knowledge: WhiteboardPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** 「批注太大不再保存」只提示一次，不然每笔都弹 */
  private persistedWarningShown = false;
  /** 内联了字体的导出样式（KaTeX 那份不变，缓存一次） */
  private exportCss: { css: string; ok: boolean } | null = null;
  /** 待落盘的全量笔迹（最新一次 saveStrokes 收到的原始数据，尚未 sanitize） */
  private pendingStrokes: unknown = null;
  /** 防抖落盘定时器：连续落笔时合并成一次全量写盘 */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor(
    private readonly slot: BoardSlot,
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private content: BoardContent,
    private opts: WhiteboardOptions,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: WebviewMessage) => void this.onMessage(msg), null, this.disposables);
    this.render();
  }

  /** 同类面板已经开着就换内容重渲染（批注按 key 落盘，换内容不会串），否则新建。 */
  static open(
    slot: BoardSlot,
    context: vscode.ExtensionContext,
    content: BoardContent,
    opts: WhiteboardOptions,
    column: vscode.ViewColumn,
  ): void {
    const existing = slot === "knowledge" ? WhiteboardPanel.knowledge : WhiteboardPanel.problem;
    if (existing) {
      // 换内容前先把上一题的待落盘批注写掉：stateKey() 读的是 this.content，
      // 不 flush 的话防抖窗口里的旧题批注会被写到新题的 key 下（数据串题）
      void existing.flushStrokes();
      existing.content = content;
      existing.opts = opts;
      existing.persistedWarningShown = false;
      existing.panel.title = content.title;
      existing.panel.reveal(column);
      existing.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, content.title, column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    });
    const instance = new WhiteboardPanel(slot, panel, context, content, opts);
    if (slot === "knowledge") WhiteboardPanel.knowledge = instance;
    else WhiteboardPanel.problem = instance;
  }

  private stateKey(): string {
    return this.content.stateKey;
  }

  private savedStrokes(): Stroke[] {
    return sanitizeStrokes(this.context.workspaceState.get(this.stateKey()));
  }

  /** 用户手动加出来的页数（老工作区没有这个键，按 1 页算）。 */
  private savedPages(): number {
    return clampPageCount(Number(this.context.workspaceState.get(this.content.pagesKey)));
  }

  private async onMessage(msg: WebviewMessage): Promise<void> {
    try {
      await this.handleMessage(msg);
    } catch (e) {
      // 消息处理是 fire-and-forget 调的，这里不兜住就会变成静默的未处理拒绝（写文件失败尤其常见）
      void vscode.window.showErrorMessage(`白板操作失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.command) {
      case "saveStrokes": {
        // webview 每次「提交点」都把**全量**笔迹发过来（append-only 语义没法在消息里表达索引安全），
        // 但真正贵的不是这次结构化克隆，而是扩展侧的全量 sanitize + JSON.stringify + 写盘。
        // 所以消息照收（数据第一时间到扩展进程，webview 被销毁也不丢），把重活合并成一次：
        // 每来一条只更新 pendingStrokes 并重置防抖定时器，静默 PERSIST_DEBOUNCE_MS 后才真的落盘。
        this.pendingStrokes = msg.strokes;
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => void this.flushStrokes(), PERSIST_DEBOUNCE_MS);
        return;
      }
      case "savePages": {
        await this.context.workspaceState.update(this.content.pagesKey, clampPageCount(Number(msg.pages)));
        return;
      }
      case "prepareExport": {
        const css = this.buildExportCss();
        void this.panel.webview.postMessage({ command: "exportCss", css: css.css, ok: css.ok });
        return;
      }
      case "inlineImages": {
        // SVG foreignObject 当图片加载时不会取外部资源：先把题面里的网络图片下载成
        // data URI 回给 webview，替换 src 后再序列化。失败只记日志，不挡导出。
        const urls = Array.isArray(msg.urls)
          ? msg.urls.filter((u): u is string => typeof u === "string").slice(0, MAX_INLINE_IMAGES)
          : [];
        const { images, failed } = await inlineRemoteImages(urls);
        if (failed.length) {
          output.appendLine(
            `[白板] 题面图片内联失败 ${failed.length} 张：${failed.slice(0, 3).join("；")}${failed.length > 3 ? " …" : ""}`,
          );
        }
        void this.panel.webview.postMessage({ command: "inlinedImages", images });
        return;
      }
      case "export": {
        await this.saveImages(msg.images ?? [], Boolean(msg.blank), msg.target === "banshu");
        return;
      }
      case "notify": {
        // 白板自报的诊断事件（只进输出面板，不弹提示）：出现「笔迹不显示」时先看这里
        output.appendLine(`[白板] ${msg.kind ?? "事件"}：${msg.message ?? ""}`);
        return;
      }
      case "error": {
        void vscode.window.showErrorMessage(`白板渲染失败：${msg.message ?? "未知原因"}`);
        return;
      }
      default:
        return;
    }
  }

  /**
   * 把待落盘的笔迹真正写进 workspaceState（防抖合并后的那一次）。
   * 单独抽出来是因为 dispose() 也要用它 —— 面板被关掉时定时器还没到，
   * 得在这里补一次，否则最后几笔会丢（webview 已经没了，发不出补发的消息）。
   */
  private async flushStrokes(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    const pending = this.pendingStrokes;
    this.pendingStrokes = null;
    if (pending === null) return;
    const { value, bytes } = strokesToPersist(sanitizeStrokes(pending));
    if (value === null) {
      if (!this.persistedWarningShown) {
        this.persistedWarningShown = true;
        void vscode.window.showWarningMessage(
          `批注数据已约 ${Math.round(bytes / 1024)} KB，超过 2 MB 上限，这块板的批注不再保存（重开面板会丢失）。`,
        );
      }
      return;
    }
    await this.context.workspaceState.update(this.stateKey(), value);
  }

  /**
   * 组装导出用的样式：纸张样式（与屏幕同一份）+ KaTeX 的 CSS（字体换成内联 base64）。
   * 字体文件在 dist/katex/fonts 下随插件打包，扩展进程直接读盘比 webview 里 fetch 稳。
   */
  private buildExportCss(): { css: string; ok: boolean } {
    if (this.exportCss) return this.exportCss;
    const dir = path.join(this.context.extensionUri.fsPath, "dist", "katex");
    try {
      const raw = fs.readFileSync(path.join(dir, "katex.min.css"), "utf8");
      const dataUris = new Map<string, string>();
      for (const url of collectFontUrls(raw)) {
        if (!/\.woff2$/i.test(url)) continue; // 只要 woff2，Chromium 都支持，省下 ttf/woff 的体积
        if (url.includes("..")) continue;
        try {
          const file = path.join(dir, url.replace(/^\.?\//, ""));
          dataUris.set(url, `data:font/woff2;base64,${fs.readFileSync(file).toString("base64")}`);
        } catch {
          // 缺哪个字体就让它保持相对 url（那条 src 不会被替换，其余字体照常内联）
        }
      }
      this.exportCss = { css: `${SHEET_CSS}\n${inlineFontSources(raw, dataUris)}`, ok: dataUris.size > 0 };
    } catch {
      this.exportCss = { css: SHEET_CSS, ok: false };
    }
    return this.exportCss;
  }

  /** 当前这块板用的导出分辨率（脏值在 clampExportDpi 里被拉回合法区间） */
  private exportDpi(): number {
    return clampExportDpi(Number(this.opts.exportDpi));
  }

  /**
   * 逐页写盘。
   *
   * `toBanshu` 为真时走「导出并插入题解」：不弹保存对话框，直接按固定命名写进题目录
   * （`<base>.png` / `<base>-p2.png`…），随后回调让调用方把图写进题解文档 ——
   * 题解里引用的是约定好的文件名，所以这里不能让人随便改路径。
   */
  private async saveImages(images: string[], blank: boolean, toBanshu = false): Promise<void> {
    if (!images.length) return;
    const base = this.content.fileStem;
    const banshu = toBanshu ? this.opts.banshu : undefined;
    if (toBanshu && !banshu) {
      void vscode.window.showWarningMessage("这个白板没有关联题目，无法导出到题解（先按题号建题再打开白板）。");
      return;
    }
    if (images.length > 1 && !toBanshu) {
      const px = exportPixels(this.exportDpi());
      const go = await vscode.window.showWarningMessage(
        `这道题的白板共 ${images.length} 页，将导出为 ${images.length} 张 A4 图片（A4 ${this.exportDpi()}dpi，${px.width}×${px.height}）。`,
        { modal: true },
        "导出",
      );
      if (go !== "导出") return;
    }

    // 目标路径：题解走固定命名（不弹对话框），否则照旧让人选
    let targetPath: string;
    if (banshu) {
      targetPath = path.join(banshu.dir, `${banshu.base}.png`);
    } else {
      const target = await vscode.window.showSaveDialog({
        title: "导出白板图片（A4）",
        defaultUri: vscode.Uri.file(
          path.join(defaultDir(this.opts.lastDir), images.length > 1 ? `${base}-p1.png` : `${base}.png`),
        ),
        filters: { "PNG 图片": ["png"] },
      });
      if (!target) return;
      targetPath = target.fsPath;
    }

    const dir = path.dirname(targetPath);
    /*
     * 页码后缀只剥**我们自己加的那个** `-p1`（保存框的默认名就是 `<题名>-p1.png`）。
     *
     * 原来这里剥的是 `/-p\d+$/`：用户把文件命名成 `foo-p3.png` 时页码被一起剥掉，
     * 第 3 页就写回 `foo-p3.png` —— **把第 1 页覆盖了**（导出的讲义少一页）。
     */
    const stem = multiPageFileStem(path.basename(targetPath));
    const written: string[] = [];
    images.forEach((dataUrl, i) => {
      const file = i === 0 ? targetPath : path.join(dir, `${stem}-p${i + 1}.png`);
      fs.writeFileSync(file, Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"));
      written.push(file);
    });
    await this.opts.onSaved?.(targetPath);

    if (banshu) {
      // 题解那条路：交给调用方写入 `题解板书.typ`，这里只报结果
      await this.opts.onBanshuSaved?.(written);
      void vscode.window.showInformationMessage(
        `已导出 ${written.length} 张板书图到题目录，并写进题解：${path.basename(written[0])}` +
          (written.length > 1 ? ` 等 ${written.length} 个文件` : ""),
      );
      return;
    }

    // 知识面板的纸本来就没内容，抽检到全白是正常的，别拿「题面没渲染出来」吓人
    const note = blank && !this.content.blankSheet ? "\n提示：题面可能没栅格化成功（导出的图片里或许只有批注）" : "";
    const action = await vscode.window.showInformationMessage(
      `已导出 ${written.length} 张 A4 图片：${written[0]}${written.length > 1 ? ` 等 ${written.length} 个文件` : ""}${note}`,
      "在文件夹中显示",
      "复制路径",
    );
    if (action === "在文件夹中显示") void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(targetPath));
    else if (action === "复制路径") void vscode.env.clipboard.writeText(written.join("\n"));
  }

  /** 白板的 webview 脚本（esbuild 单独打的 dist/whiteboard.js），内联进 HTML 走 nonce */
  private webviewScript(): string {
    const file = path.join(this.context.extensionUri.fsPath, "dist", "whiteboard.js");
    try {
      return fs.readFileSync(file, "utf8").replace(/<\/script/gi, "<\\/script");
    } catch {
      return `acquireVsCodeApi().postMessage({command:'error',message:'缺少 dist/whiteboard.js，请重新构建插件'});`;
    }
  }

  private render(): void {
    const c = this.content;
    const katexCssUri = this.panel.webview
      .asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "katex", "katex.min.css"))
      .toString();
    // 导出分辨率是每块板算一次（设置改了、面板换题复用后都要跟着走）
    const px = exportPixels(this.exportDpi());

    this.panel.webview.html = buildWhiteboardHtml({
      webview: this.panel.webview,
      title: c.title,
      displayId: c.displayId,
      katexCssUri,
      statementHtml: c.statementHtml,
      strokes: this.savedStrokes(),
      pages: this.savedPages(),
      exportWidth: px.width,
      exportHeight: px.height,
      // 笔迹稳定器强度（脏值由 webview 侧夹回「关」，这里只原样带过去）
      stabilize: this.opts.stabilize,
      // 有题解目标才显示「导出并插入题解」按钮（知识面板没有题目，自然没有）
      banshu: Boolean(this.opts.banshu),
      script: this.webviewScript(),
    });
  }

  private dispose(): void {
    // 关面板时防抖定时器多半还没到，这里补一次 flush —— webview 已经没了，
    // 补发的消息不会再来，不 flush 就会丢掉最后几笔批注
    void this.flushStrokes();
    // 只清掉还指着自己的那个槽：面板被换成另一类时，槽里已经是新实例了
    if (WhiteboardPanel[this.slot] === this) WhiteboardPanel[this.slot] = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

/** 打开（或切到）某道题的批注白板。 */
export function showWhiteboard(
  context: vscode.ExtensionContext,
  statement: Statement,
  opts: WhiteboardOptions = {},
  column: vscode.ViewColumn = vscode.ViewColumn.Active,
): void {
  WhiteboardPanel.open("problem", context, problemBoard(statement), opts, column);
}

/**
 * 打开（或切到）知识面板：一张没有题面的空白 A4 纸，用来讲知识点（画图、推公式、写伪代码），
 * 和「题面白板」区分开。批注单独存一份，不会和任何一道题的批注混在一起。
 */
export function showKnowledgeBoard(
  context: vscode.ExtensionContext,
  opts: WhiteboardOptions = {},
  column: vscode.ViewColumn = vscode.ViewColumn.Active,
): void {
  WhiteboardPanel.open("knowledge", context, knowledgeBoard(), opts, column);
}
