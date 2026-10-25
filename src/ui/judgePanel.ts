import * as vscode from "vscode";
import * as path from "node:path";
import type { CaseResult, JudgeReport, CaseStatus } from "../judge/judge";
import { parseCompileDiagnostics, type CompileDiagnostic } from "../judge/diagnostics";
import { sameFilePath } from "../util";
import { buildWebviewHtml, BASE_STYLE } from "./html";
import { escapeHtml } from "./markdown";

const VIEW_TYPE = "lgAssist.judge";

/** 编译问题列表里的级别标签。 */
const PROBLEM_LABEL: Record<CompileDiagnostic["severity"], string> = {
  error: "错误",
  warning: "告警",
  note: "提示",
};

/**
 * 样例判定的中文全称，用于结论区的统计与判定条的悬停提示。
 * 判定码（AC/WA/TLE…）不在这里定义：它只出现在 webview 脚本生成的样例行里，
 * 那边有自己的一份（STATUS_CODE），别在扩展侧留一份没人用的。
 */
const VERDICT_LABEL: Record<CaseStatus, string> = {
  AC: "通过",
  WA: "答案错误",
  TLE: "超时",
  RE: "运行错误",
  NO_EXPECTED: "仅运行",
  NO_OUT: "缺少输出",
};
/** 结论区统计的排列顺序：按「错了有多严重」排，不按字母序。 */
const VERDICT_ORDER: CaseStatus[] = ["WA", "TLE", "RE", "NO_OUT", "NO_EXPECTED"];

export interface JudgePanelCallbacks {
  onRerun(): void;
  /** 用某个样例作为输入在终端运行（读 .in 文件） */
  onRunInTerminal(inputFile: string | null): void;
  onOpenSource(): void;
  /** 跳到编译报错所在行（1 起） */
  onGotoLocation(line: number, column: number | null): void;
  /** 把当前代码提交到题目；完成（或失败）后按钮恢复可点 */
  onSubmit(): Promise<void>;
  /** 打开洛谷评测记录页（提交结果卡片上的「到洛谷查看记录」） */
  onOpenRecord(rid: number): void;
}

/**
 * 提交到洛谷的结果，直接嵌在评测面板里。
 *
 * 为什么不用通知：判定的信息量不止一句结论 —— 分数、耗时、内存、编译报错都得看，
 * 通知（右下角弹一下就没了）装不下这些，而且用户要的是「就在这里看完」，
 * 不必点按钮跳到浏览器。通知仍然保留（切到别的窗口时是个提醒），但这里才是主场。
 */
export interface SubmitOutcome {
  /** 提交的是哪个源文件（绝对路径）。面板据此判断「这份结果是不是我现在显示的那份代码」。 */
  sourcePath: string;
  /** 提交是否成功走到「拿到结果」这一步 */
  ok: boolean;
  /** 洛谷评测记录号；提交失败时为 0 */
  rid: number;
  /** 判定码（AC / WA / TLE…）；拿不到结果时为空串 */
  verdict: string;
  /** 一行摘要：`通过（AC） · 100 分 · 12 ms · 1.2 MB` */
  summary: string;
  /** 评测记录的补充说明（CE 的编译报错就走这里） */
  feedback: string;
  /** 分数 / 耗时 / 内存（未知为 null） */
  score: number | null;
  timeMs: number | null;
  memoryMb: number | null;
  /** 失败时的原因（登录过期、网络、超时……） */
  error: string;
  /** 提交时间（`HH:MM:SS`），调用方生成 */
  at: string;
}

/** 面板里的编译问题：列号可能是「编译器没给」，跳转时按第 1 列处理。 */
interface PanelProblem {
  severity: CompileDiagnostic["severity"];
  text: string;
  line: number | null;
  column: number | null;
  /** 是否是当前源文件里的位置（只有这种才给「跳到该行」） */
  inSource: boolean;
}

interface SerializedCase {
  index: number;
  status: CaseStatus;
  inputFile: string;
  inputName: string;
  outputFile: string | null;
  outputName: string | null;
  input: string;
  expected: string | null;
  actual: string;
  stderr: string;
  durationMs: number;
  exitCode: number | null;
  truncated: boolean;
  /** 因为太长、只在面板里截掉显示的字段（中文名），空数组表示都完整显示 */
  displayClipped: string[];
}

/**
 * 面板里每段文本的显示上限（字符数）。
 *
 * **判定一直用全量数据** —— AC/WA 的结论、差异行标记都来自 judge.ts 里的全量比较，
 * 这里截的只是「送进 webview 的那一份显示副本」。不截的话：一个死循环刷屏的程序能把
 * actual 顶到 maxOutputBytes（默认 16MB），期望输出文件更是没有上限，
 * 面板要解析几十 MB 的 JSON、再把输出逐行包成 <span>，webview 直接卡死。
 * 64KB 对单个样例的输出来说远远够看，真要看全量可以打开源文件。
 */
const DISPLAY_CHARS = 64 * 1024;

/** 截一段显示用的文本，返回文本与是否截掉过 */
function clipForDisplay(s: string): { text: string; clipped: boolean } {
  if (s.length <= DISPLAY_CHARS) return { text: s, clipped: false };
  return { text: s.slice(0, DISPLAY_CHARS), clipped: true };
}

function serialize(report: JudgeReport): {
  cases: SerializedCase[];
  compileOk: boolean;
  compileMessage: string;
  problems: PanelProblem[];
  errorCount: number;
  warningCount: number;
  exeName: string;
} {
  const cases: SerializedCase[] = report.cases.map((c: CaseResult) => {
    const input = clipForDisplay(c.input);
    const expected = c.expected === null ? null : clipForDisplay(c.expected);
    const actual = clipForDisplay(c.actual);
    const stderr = clipForDisplay(c.stderr);
    const displayClipped: string[] = [];
    if (input.clipped) displayClipped.push("输入");
    if (expected?.clipped) displayClipped.push("期望输出");
    if (actual.clipped) displayClipped.push("实际输出");
    if (stderr.clipped) displayClipped.push("标准错误");
    return {
      index: c.index,
      status: c.status,
      inputFile: c.inputFile,
      inputName: path.basename(c.inputFile),
      outputFile: c.outputFile,
      outputName: c.outputFile ? path.basename(c.outputFile) : null,
      input: input.text,
      expected: expected ? expected.text : null,
      actual: actual.text,
      stderr: stderr.text,
      durationMs: c.durationMs,
      exitCode: c.exitCode,
      truncated: c.truncated,
      displayClipped,
    };
  });
  // 编译输出解析成「文件:行:列 + 正文」，面板里就能逐条列出来并点着跳过去
  const diags = parseCompileDiagnostics(report.compile.message, {
    cwd: path.dirname(report.sourcePath),
    fallbackFile: report.sourcePath,
  });
  const problems: PanelProblem[] = diags.map((d) => ({
    severity: d.severity,
    text: `${d.line === null ? "" : `${path.basename(d.file)}:${d.line}${d.column === null ? "" : `:${d.column}`}: `}${d.message}`,
    line: d.line,
    column: d.column,
    inSource: d.line !== null && path.resolve(d.file) === path.resolve(report.sourcePath),
  }));
  return {
    cases,
    compileOk: report.compile.ok,
    compileMessage: report.compile.message,
    problems,
    errorCount: problems.filter((p) => p.severity === "error").length,
    warningCount: problems.filter((p) => p.severity === "warning").length,
    exeName: path.basename(report.sourcePath),
  };
}

class JudgePanel {
  static current: JudgePanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private closed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private report: JudgeReport,
    private readonly callbacks: JudgePanelCallbacks,
  ) {
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      async (msg: {
        command?: string;
        inputFile?: string;
        line?: number;
        column?: number | null;
        /** `openRecord`：要打开的洛谷评测记录号 */
        rid?: number;
      }) => {
        if (msg.command === "rerun") this.callbacks.onRerun();
        else if (msg.command === "runTerminal") this.callbacks.onRunInTerminal(msg.inputFile ?? null);
        else if (msg.command === "openSource") this.callbacks.onOpenSource();
        else if (msg.command === "goto" && typeof msg.line === "number") {
          this.callbacks.onGotoLocation(msg.line, msg.column ?? null);
        } else if (msg.command === "submit") {
          // 提交要走网络/轮询，期间把按钮置灰，完成后（成功或失败）再放行
          try {
            await this.callbacks.onSubmit();
          } finally {
            if (!this.closed) void this.panel.webview.postMessage({ command: "submitDone" });
          }
        } else if (msg.command === "openRecord" && typeof msg.rid === "number") {
          this.callbacks.onOpenRecord(msg.rid);
        }
      },
      null,
      this.disposables,
    );
    this.render();
  }

  static show(
    _context: vscode.ExtensionContext,
    report: JudgeReport,
    callbacks: JudgePanelCallbacks,
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): void {
    if (JudgePanel.current) {
      JudgePanel.current.report = report;
      JudgePanel.current.panel.reveal(column);
      JudgePanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "样例评测结果", column, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    JudgePanel.current = new JudgePanel(panel, report, callbacks);
  }

  /**
   * 把一次提交的结果推给面板。
   *
   * 面板没开时**不强开**：提交入口在编辑器命令与快捷键里都有，
   * 用户没在看评测面板时弹一个面板出来会打断他手头的事 —— 那种情况通知就够了。
   * 面板开着时就地刷新，不需要重新评测。
   *
   * ⚠️ **面板显示的是另一份代码时不能把结果挂上去**。面板是单例复用的：
   * A 题评测开着面板 → 切去 B 题提交 → 结果直接贴上来就成了
   * 「A 题的样例下面挂着 B 题的提交结果」，比不显示更难解释。
   * 这时返回 false，让调用方退回通知。
   */
  static publishSubmit(outcome: SubmitOutcome): boolean {
    const panel = JudgePanel.current;
    if (!panel || panel.closed) return false;
    if (!sameFilePath(panel.report.sourcePath, outcome.sourcePath)) return false;
    void panel.panel.webview.postMessage({ command: "submitResult", outcome });
    return true;
  }

  private render(): void {
    const data = serialize(this.report);
    const name = escapeHtml(path.basename(this.report.sourcePath));
    const total = data.cases.length;
    const passed = data.cases.filter((c) => c.status === "AC" || c.status === "NO_EXPECTED").length;
    const allAc = total > 0 && data.cases.every((c) => c.status === "AC");

    /*
     * 结论区：一眼说清「过了几个、挂在哪几类」。
     *
     * 判定条按样例顺序一格一个 —— 格子的先后就是样例的先后（挂掉的是第几个），
     * 所以它不是装饰，是下面那张表的图形摘要，不是通过就随便排一下。
     * 判定色只出现在这几格和卡片左侧的竖条上，不做整片填充：投影时大面积红绿很刺眼。
     */
    const tally = new Map<CaseStatus, number>();
    for (const c of data.cases) tally.set(c.status, (tally.get(c.status) ?? 0) + 1);
    const tallyText = VERDICT_ORDER.filter((s) => (tally.get(s) ?? 0) > 0)
      .map((s) => `${VERDICT_LABEL[s]} ${tally.get(s)}`)
      .join(" · ");
    const strip = data.cases.length
      ? `<span class="oi-strip" title="${data.cases
          .map((c) => `样例 ${c.index} ${VERDICT_LABEL[c.status]}`)
          .join("；")}">${data.cases
          .map((c) => {
            // NO_OUT 也要红（没输出就是没过），别让它掉到默认的绿色格子上
            const cls =
              c.status === "AC" ? "" : c.status === "NO_EXPECTED" ? "noexp" : c.status === "NO_OUT" ? "wa" : c.status.toLowerCase();
            return `<i class="${cls}"></i>`;
          })
          .join("")}</span>`
      : "";
    const totalMs = data.cases.reduce((acc, c) => acc + c.durationMs, 0);

    let tone: "ac" | "wa" | "tle" | "re" | "ce" | "none";
    let state: string;
    let sub: string;
    if (!data.compileOk) {
      tone = "ce";
      state = "编译错误";
      sub = "本地编译未通过";
    } else if (this.report.noSamples) {
      tone = "none";
      state = "无样例";
      sub = "题目目录下没有 <code>*_N.in</code> 样例文件";
    } else if (allAc) {
      tone = "ac";
      state = "全部通过";
      sub = "可以提交了";
    } else {
      // 整体取「第一个失败样例」的判定色：TLE 和 WA 是要区别对待的两件事，不该都显示红
      const firstBad = data.cases.find((c) => c.status !== "AC" && c.status !== "NO_EXPECTED");
      tone = firstBad?.status === "TLE" ? "tle" : firstBad?.status === "RE" ? "re" : "wa";
      state = "存在未通过";
      sub = tallyText;
    }
    const score = data.cases.length
      ? `<div class="oi-score"><b>${passed}</b><span>/${total}</span></div>`
      : "";
    const verdict = `<div class="oi-verdict is-${tone}">${strip}${score}
  <div class="oi-verdict-meta">
    <span class="oi-state is-${tone}">${state}</span>
    ${sub ? `<span class="oi-tally">${sub}</span>` : ""}
  </div>
  <span class="oi-grow"></span>
  ${totalMs ? `<span class="oi-chip"><em>总耗时</em>${totalMs} ms</span>` : ""}
</div>`;

    /*
     * 提交结果区：一开始是空的（只有一行说明），点了「提交到洛谷」之后由扩展把结果
     * postMessage 进来再填。放在结论区下面、编译问题上面 —— 提交是这里最重的事，
     * 不该埋在样例列表后面，但也不必占掉第一位（样例结果才是这个面板的日常用途）。
     */
    const submitBlock = `<section id="submit-result" class="oi-submit" hidden>
  <h2>提交结果<small class="muted" id="submit-at"></small></h2>
  <div id="submit-body"></div>
</section>`;

    // 编译问题：逐条列出（能点着跳到出错行），原始输出收在下面的 details 里
    const problemList = data.problems.length
      ? `<h2>编译问题<small class="muted"> ${data.errorCount} 错误 · ${data.warningCount} 警告</small></h2>` +
        '<ul class="problems">' +
        data.problems
          .map((p) => {
            const attrs = p.inSource && p.line !== null ? ` class="goto" data-line="${p.line}" data-col="${p.column ?? 1}"` : "";
            return (
              `<li class="p-${p.severity}"${attrs}><span class="p-sev">${PROBLEM_LABEL[p.severity]}</span>` +
              `<span class="p-text">${escapeHtml(p.text)}</span>` +
              (p.inSource && p.line !== null ? '<span class="p-go">跳到该行</span>' : "") +
              "</li>"
            );
          })
          .join("") +
        "</ul>"
      : "";
    const compileOutput = data.compileMessage.trim()
      ? `<details class="raw"${data.compileOk ? "" : " open"}><summary>编译器原始输出</summary><pre class="err">${escapeHtml(data.compileMessage)}</pre></details>`
      : "";

    const body = `<div class="toolbar">
  <span class="mono">${name}</span>
  <span class="oi-grow"></span>
  <button id="rerun" class="secondary">重新评测</button>
  <button id="submit" title="把这份代码提交到洛谷该题目（评测刚编译过，不再重复编译）">提交到洛谷</button>
  <button id="runTerminal" class="secondary">用样例在终端运行</button>
  <button id="openSource" class="secondary">回到源文件</button>
</div>
${verdict}
${submitBlock}
${problemList}
${compileOutput}
${this.report.noSamples && data.compileOk ? `<p class="muted">已编译成功。当前题目没有可用样例，建议在终端里手工输入数据运行。</p>` : ""}
${data.cases.length ? `<h2>样例</h2>` : ""}
<div id="cases"></div>`;

    const script = `
const vscode = acquireVsCodeApi();
const DATA = JSON.parse(document.getElementById('data').textContent);
const STATUS_TEXT = { AC:'通过', WA:'答案错误', TLE:'超时', RE:'运行错误', NO_EXPECTED:'仅运行（无期望输出）', NO_OUT:'缺少输出' };
/* 样例行里显示判定码而不是中文：AC/WA/TLE 是竞赛通用语，字母在等宽字体里占位固定，
   多行样例的判定列才能竖着对齐。中文全称放 title 里（STATUS_TEXT）。 */
const STATUS_CODE = { AC:'AC', WA:'WA', TLE:'TLE', RE:'RE', NO_EXPECTED:'—', NO_OUT:'NO' };
/* NO_OUT 用 wa 的样式（红）：没输出就是没过 */
const STATUS_CLASS = { AC:'ac', WA:'wa', TLE:'tle', RE:'re', NO_EXPECTED:'noexp', NO_OUT:'wa' };

function lines(s) { return s === null ? [] : s.replace(/\\r\\n?/g, '\\n').split('\\n'); }
function esc(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

/** 按行做位置比对，标出不一致的行——样例对比不需要完整的 LCS diff。 */
function compare(expected, actual) {
  if (expected === null) return null;
  const e = lines(expected), a = lines(actual);
  const n = Math.max(e.length, a.length);
  const marks = [];
  for (let i = 0; i < n; i++) marks.push((e[i] ?? '') !== (a[i] ?? ''));
  return { e, a, marks };
}

/**
 * 逐行渲染：每一行包一个 <span> 用来标红不一致的行。
 * 但行数必须有上限 —— 一个「每行只有一个换行」的输出能有几十万行，逐行包 span 一样会把 DOM 撑爆，
 * 这时退回「整段纯文本、不标差异行」，面板一定能打开（下面的提示里会说明差异行没标）。
 */
const MAX_DIFF_LINES = 4000;
function renderLines(arr, marks) {
  if (arr.length > MAX_DIFF_LINES) return esc(arr.join('\\n'));
  return arr.map((l, i) => '<span class="' + (marks[i] ? 'bad' : '') + '">' + (esc(l) || ' ') + '</span>').join('\\n');
}

function renderCase(c) {
  const cmp = compare(c.expected, c.actual);
  const eb = cmp ? renderLines(cmp.e, cmp.marks) : '';
  const ab = cmp ? renderLines(cmp.a, cmp.marks) : esc(c.actual) || '<span class="muted">（无输出）</span>';
  const stderr = c.stderr && c.stderr.trim() ? '<h4>标准错误</h4><pre class="err">' + esc(c.stderr) + '</pre>' : '';
  const bits = [];
  if (c.exitCode !== null && c.exitCode !== 0) bits.push('退出码 ' + c.exitCode);
  if (c.truncated) bits.push('输出已截断');
  if (c.displayClipped && c.displayClipped.length) bits.push('显示已截断：' + c.displayClipped.join('、'));
  if (cmp && (cmp.e.length > MAX_DIFF_LINES || cmp.a.length > MAX_DIFF_LINES)) bits.push('行数过多，未标差异行');
  const notes = bits.length ? '<span class="case-notes">' + esc(bits.join(' · ')) + '</span>' : '';
  const cmpBlock = cmp
    ? '<div class="cols"><div><h4>期望输出 · ' + esc(c.outputName || '') + '</h4><pre class="out">' + eb + '</pre></div>' +
      '<div><h4>实际输出</h4><pre class="out">' + ab + '</pre></div></div>'
    : '<h4>实际输出</h4><pre class="out">' + ab + '</pre>';
  return '<details class="case ' + STATUS_CLASS[c.status] + '"' + (c.status === 'AC' ? '' : ' open') + '>' +
    '<summary>' +
    '<span class="case-no mono">' + String(c.index).padStart(2, '0') + '</span>' +
    '<span class="case-file mono">' + esc(c.inputName) + '</span>' +
    notes +
    '<span class="oi-grow"></span>' +
    '<span class="case-verdict mono" title="' + STATUS_TEXT[c.status] + '">' + STATUS_CODE[c.status] + '</span>' +
    '<span class="case-time mono">' + (c.durationMs ? c.durationMs + ' ms' : '') + '</span>' +
    '</summary>' +
    '<h4>输入</h4><pre class="out">' + (esc(c.input) || '<span class="muted">（空）</span>') + '</pre>' +
    cmpBlock + stderr +
    '<div class="case-actions"><button class="secondary tiny" data-run="' + esc(c.inputFile) + '">用这个样例在终端运行</button></div>' +
    '</details>';
}

document.getElementById('cases').innerHTML = DATA.cases.map(renderCase).join('') ||
  '<p class="muted">' + (DATA.compileOk ? '没有可运行的样例。' : '编译未通过，没有样例结果。') + '</p>';
document.getElementById('cases').addEventListener('click', (ev) => {
  const t = ev.target;
  if (t && t.dataset && t.dataset.run) { vscode.postMessage({ command:'runTerminal', inputFile: t.dataset.run }); }
});
document.body.addEventListener('click', (ev) => {
  const row = ev.target && ev.target.closest ? ev.target.closest('li.goto') : null;
  if (!row) return;
  vscode.postMessage({ command:'goto', line: parseInt(row.dataset.line, 10), column: row.dataset.col ? parseInt(row.dataset.col, 10) : null });
});
document.getElementById('rerun').addEventListener('click', () => vscode.postMessage({ command:'rerun' }));
document.getElementById('openSource').addEventListener('click', () => vscode.postMessage({ command:'openSource' }));
document.getElementById('runTerminal').addEventListener('click', () => {
  const first = DATA.cases.find((c) => c.inputFile);
  vscode.postMessage({ command:'runTerminal', inputFile: first ? first.inputFile : null });
});
const submitBtn = document.getElementById('submit');
submitBtn.addEventListener('click', () => {
  submitBtn.disabled = true;
  submitBtn.textContent = '提交中…';
  vscode.postMessage({ command:'submit' });
});

/*
 * 提交结果渲染。判定色只落在左侧竖条与判定文字上 —— 与面板其它地方一致，
 * 不做大面积填充。分数/耗时/内存用小 chip 排一行，和结论区的视觉语言对齐。
 */
const SUBMIT_VERDICT_CLASS = {
  AC:'ac', WA:'wa', TLE:'tle', RE:'re', CE:'wa', MLE:'wa', OLE:'wa', UKE:'none', NAC:'none'
};
function renderSubmit(o) {
  const box = document.getElementById('submit-result');
  const body = document.getElementById('submit-body');
  document.getElementById('submit-at').textContent = o.at ? ' · ' + o.at : '';
  if (!o.ok) {
    body.innerHTML = '<div class="oi-submit-card is-err">' +
      '<div class="oi-submit-line"><span class="oi-submit-state is-err">提交失败</span></div>' +
      '<p class="muted">' + esc(o.error || '未知原因') + '</p></div>';
    box.hidden = false;
    return;
  }
  const cls = SUBMIT_VERDICT_CLASS[o.verdict] || 'none';
  const chips = [];
  if (o.score !== null) chips.push('<span class="oi-chip"><em>分数</em>' + o.score + '</span>');
  if (o.timeMs !== null) chips.push('<span class="oi-chip"><em>耗时</em>' + o.timeMs + ' ms</span>');
  if (o.memoryMb !== null) chips.push('<span class="oi-chip"><em>内存</em>' + o.memoryMb.toFixed(1) + ' MB</span>');
  if (o.rid) chips.push('<span class="oi-chip"><em>记录</em>#' + o.rid + '</span>');
  const fb = o.feedback && o.feedback.trim()
    ? '<pre class="err">' + esc(o.feedback) + '</pre>'
    : '';
  const link = o.rid
    ? '<div class="oi-submit-actions"><button class="secondary tiny" id="openRecord">到洛谷查看记录</button></div>'
    : '';
  body.innerHTML = '<div class="oi-submit-card is-' + cls + '">' +
    '<div class="oi-submit-line">' +
      '<span class="oi-submit-verdict mono is-' + cls + '" title="' + esc(o.verdict) + '">' + esc(o.verdict || '?') + '</span>' +
      '<span class="oi-submit-summary">' + esc(o.summary || '') + '</span>' +
      '<span class="oi-grow"></span>' +
      chips.join('') +
    '</div>' + fb + link + '</div>';
  const btn = document.getElementById('openRecord');
  if (btn) btn.addEventListener('click', () => vscode.postMessage({ command:'openRecord', rid: o.rid }));
  box.hidden = false;
}
window.addEventListener('message', (ev) => {
  if (ev.data && ev.data.command === 'submitDone') {
    submitBtn.disabled = false;
    submitBtn.textContent = '提交到洛谷';
  } else if (ev.data && ev.data.command === 'submitResult') {
    renderSubmit(ev.data.outcome);
  }
});`;

    const style = `${BASE_STYLE}
/*
 * 结论区：左边一道判定色的竖条标出「整体是什么结果」，右边是图形化的样例判定摘要。
 * 判定色只出现在竖条和格子上，绝不做整片填充 —— 投影时大面积红绿很刺眼。
 */
.oi-verdict {
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 14px 16px; margin: 0 0 20px;
  border: 1px solid var(--vscode-panel-border); border-radius: 5px;
  border-left: 3px solid var(--vscode-editor-foreground);
}
.oi-verdict.is-ac { border-left-color: var(--oi-ac); }
.oi-verdict.is-wa { border-left-color: var(--oi-wa); }
.oi-verdict.is-tle { border-left-color: var(--oi-tle); }
.oi-verdict.is-re { border-left-color: var(--oi-re); }
.oi-verdict.is-ce { border-left-color: var(--oi-wa); }
.oi-verdict.is-none { border-left-color: var(--vscode-descriptionForeground); }

/* 判定条：一格一个样例，格子的先后就是样例的先后 */
.oi-strip { display: inline-flex; gap: 3px; align-items: center; }
.oi-strip i {
  display: block; width: 20px; height: 11px; border-radius: 2px;
  background: var(--oi-ac); font-style: normal;
  transition: height .12s ease;
}
.oi-strip i:hover { height: 15px; }
.oi-strip i.wa { background: var(--oi-wa); }
.oi-strip i.tle { background: var(--oi-tle); }
.oi-strip i.re { background: var(--oi-re); }
/* 没有期望输出的样例算「跑了但没结论」，用空心格，跟实心的失败区分开 */
.oi-strip i.noexp { background: transparent; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--vscode-editor-foreground) 35%, transparent); }

.oi-score { font-family: var(--oi-num); font-variant-numeric: tabular-nums; line-height: 1; letter-spacing: -.02em; }
.oi-score b { font-size: 1.9em; font-weight: 600; }
.oi-score span { font-size: 1.05em; opacity: .5; }
.oi-verdict-meta { display: flex; flex-direction: column; gap: 1px; line-height: 1.45; }
.oi-state { font-weight: 600; }
.oi-state.is-ac { color: var(--oi-ac); }
.oi-state.is-wa, .oi-state.is-ce { color: var(--oi-wa); }
.oi-state.is-tle { color: var(--oi-tle); }
.oi-state.is-re { color: var(--oi-re); }
.oi-tally { font-size: .88em; color: var(--vscode-descriptionForeground); }

/*
 * 提交结果卡片：与结论区同一套语言 —— 左侧一道判定色竖条，判定码等宽大号，
 * 分数/耗时/内存是小 chip。整片底色不铺，只有失败时的错误文案块给一点点淡底。
 */
.oi-submit-card {
  border: 1px solid var(--vscode-panel-border); border-radius: 5px;
  border-left: 3px solid var(--vscode-editor-foreground);
  padding: 12px 14px; margin: 0 0 20px;
}
.oi-submit-card.is-ac { border-left-color: var(--oi-ac); }
.oi-submit-card.is-wa { border-left-color: var(--oi-wa); }
.oi-submit-card.is-tle { border-left-color: var(--oi-tle); }
.oi-submit-card.is-re { border-left-color: var(--oi-re); }
.oi-submit-card.is-none { border-left-color: var(--vscode-descriptionForeground); }
.oi-submit-card.is-err { border-left-color: var(--oi-wa); }
.oi-submit-line { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.oi-submit-verdict { font-size: 1.5em; font-weight: 700; letter-spacing: -.02em; }
.oi-submit-verdict.is-ac { color: var(--oi-ac); }
.oi-submit-verdict.is-wa { color: var(--oi-wa); }
.oi-submit-verdict.is-tle { color: var(--oi-tle); }
.oi-submit-verdict.is-re { color: var(--oi-re); }
.oi-submit-verdict.is-none { color: var(--vscode-descriptionForeground); }
.oi-submit-summary { font-size: .95em; }
.oi-submit-state { font-weight: 600; }
.oi-submit-state.is-err { color: var(--oi-wa); }
.oi-submit-card pre.err { margin-top: 10px; }
.oi-submit-actions { margin-top: 10px; }

h2 small { font-size: .8em; font-weight: 400; margin-left: .5em; }

/*
 * 样例行：序号 / 输入文件 / 判定码 / 耗时 全部等宽，多行之间竖着对齐。
 * 默认收起，保持原来的渐进披露 —— 老师多数时候只看结论那一行。
 */
.case {
  border: 1px solid var(--vscode-panel-border); border-left-width: 3px; border-left-color: transparent;
  border-radius: 4px; margin: 0 0 6px; padding: 0;
}
.case.ac { border-left-color: var(--oi-ac); }
.case.wa { border-left-color: var(--oi-wa); }
.case.tle { border-left-color: var(--oi-tle); }
.case.re { border-left-color: var(--oi-re); }
.case.noexp { border-left-color: color-mix(in srgb, var(--vscode-editor-foreground) 30%, transparent); }
.case summary {
  cursor: pointer; display: flex; align-items: center; gap: 12px;
  padding: 7px 12px; list-style: none;
}
.case summary::-webkit-details-marker { display: none; }
/* 收起/展开的小箭头，自绘以免和等宽数字抢排版 */
.case summary::after {
  content: ""; width: 6px; height: 6px; flex: 0 0 auto;
  border-right: 1.5px solid var(--vscode-descriptionForeground);
  border-bottom: 1.5px solid var(--vscode-descriptionForeground);
  transform: rotate(-45deg); transition: transform .12s ease; margin-left: 2px;
}
.case[open] summary::after { transform: rotate(45deg); }
.case-no { color: var(--vscode-descriptionForeground); font-size: .86em; flex: 0 0 auto; }
.case-file { font-size: .9em; }
.case-notes { font-size: .82em; color: var(--vscode-descriptionForeground); }
.case-verdict { margin-left: auto; font-size: .86em; font-weight: 600; letter-spacing: .04em; }
.case.ac .case-verdict { color: var(--oi-ac); }
.case.wa .case-verdict { color: var(--oi-wa); }
.case.tle .case-verdict { color: var(--oi-tle); }
.case.re .case-verdict { color: var(--oi-re); }
.case-time { font-size: .86em; color: var(--vscode-descriptionForeground); min-width: 56px; text-align: right; }
.case > :not(summary) { padding: 0 12px 12px 16px; }
.case[open] > summary { border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 10px; }

h4 {
  margin: 12px 0 5px; font-size: .82em; letter-spacing: .06em; text-transform: uppercase;
  color: var(--vscode-descriptionForeground); font-weight: 600;
}
pre.out { margin: 0 0 8px; max-height: 240px; }
pre.err { color: var(--vscode-errorForeground); white-space: pre-wrap; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } }
/* 不同的行整行标出来：负 margin 让底色顶到代码块边缘，不留白边 */
pre.out .bad {
  background: color-mix(in srgb, var(--oi-wa) 26%, transparent);
  display: block; margin: 0 -14px; padding: 0 14px;
}
ul.problems { list-style: none; margin: 0 0 16px; padding: 0; }
ul.problems li {
  display: flex; align-items: baseline; gap: 10px; padding: 6px 10px;
  border-left: 3px solid transparent; border-radius: 0 3px 3px 0;
  font-family: var(--oi-num); font-size: .92em;
}
ul.problems li + li { margin-top: 3px; }
ul.problems li.p-error { border-left-color: var(--oi-wa); background: color-mix(in srgb, var(--oi-wa) 11%, transparent); }
ul.problems li.p-warning { border-left-color: var(--oi-tle); background: color-mix(in srgb, var(--oi-tle) 11%, transparent); }
ul.problems li.p-note { border-left-color: color-mix(in srgb, var(--vscode-editor-foreground) 25%, transparent); background: var(--oi-tint); }
li.goto { cursor: pointer; }
li.goto:hover { background: color-mix(in srgb, var(--vscode-focusBorder) 18%, transparent); }
.p-sev {
  flex: 0 0 auto; font-family: var(--vscode-font-family); font-size: .82em; letter-spacing: .05em;
  color: var(--vscode-descriptionForeground);
}
.p-text { white-space: pre-wrap; word-break: break-word; }
.p-go { flex: 0 0 auto; margin-left: auto; font-family: var(--vscode-font-family); font-size: .85em; color: var(--vscode-textLink-foreground); }
details.raw { margin: 0 0 16px; }
details.raw summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: .9em; }
.case-actions { margin: 8px 0 0; }
button.tiny { font-size: .85em; padding: 2px 9px; }
button:disabled { opacity: .55; cursor: default; }
button:disabled:hover { background: var(--vscode-button-background); }
@media (prefers-reduced-motion: reduce) {
  .oi-strip i, .case summary::after, button { transition: none; }
}`;

    this.panel.webview.html = buildWebviewHtml({
      webview: this.panel.webview,
      title: "样例评测结果",
      style,
      body: `<script type="application/json" id="data">${jsonForScript(data)}</script>${body}`,
      script,
    });
  }

  private dispose(): void {
    this.closed = true;
    JudgePanel.current = undefined;
    this.panel.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
  }
}

/** JSON 嵌进 <script> 时必须打散 </script> 与 <!-- 。 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export { JudgePanel };
