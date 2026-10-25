import * as vscode from "vscode";
import { DEFAULT_COVER_FILE } from "./cover/spec";
import { DEFAULT_ENABLE_O2 } from "./luogu/contract";
import { DEFAULT_EXPORT_DPI, clampExportDpi } from "./whiteboard/model";

function cfg() {
  return vscode.workspace.getConfiguration("lgAssist");
}

export interface CompileConfig {
  command: string;
  args: string[];
}

export interface TerminalConfig {
  mode: "integrated" | "external";
  externalCommand: string;
  keepOpen: boolean;
  clearBeforeRun: boolean;
}

export interface JudgeConfig {
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProblemsConfig {
  bankDir: string;
  saveStatementAsMd: boolean;
  codeTemplate: string;
  openStatement: "webview" | "markdown" | "none";
}

export interface SubmitConfig {
  /**
   * 提交语言。可以填人话别名（`cpp` / `python3` / …，见 client.ts 的 `LANGUAGES`），
   * 也可以直接填洛谷的数字语言 id（`"34"` = C++23）。提交前由 `resolveLangId` 换算。
   * 别名表抄自站点自己的 `GET /_lfe/config`（CodeLanguage 枚举）。
   */
  language: string;
  /**
   * 提交时是否开 O2 优化。默认跟洛谷网页一致（开）—— 2026-10-12 真机抓包是
   * `"enableO2":1`。关掉少一类「本地能过、洛谷不过」的讲评难题。
   */
  enableO2: boolean;
  compileFirst: boolean;
  pollIntervalMs: number;
  pollTimeoutMs: number;
}

export interface LuoguConfig {
  baseUrl: string;
  /** 串行节流的最小间隔。洛谷比爱思创敏感，默认给得保守些。 */
  requestIntervalMs: number;
}

export interface WhiteboardConfig {
  /** 导出 A4 PNG 的分辨率（dpi） */
  exportDpi: number;
}

export function compileConfig(): CompileConfig {
  const c = cfg();
  return {
    command: c.get<string>("compile.command", "g++"),
    args: c.get<string[]>("compile.args", ["-O2", "-std=c++17", "-pipe", "-Wall"]),
  };
}

export function terminalConfig(): TerminalConfig {
  const c = cfg();
  return {
    mode: c.get<"integrated" | "external">("terminal.mode", "integrated"),
    externalCommand: c.get<string>("terminal.externalCommand", ""),
    keepOpen: c.get<boolean>("terminal.keepOpen", true),
    clearBeforeRun: c.get<boolean>("terminal.clearBeforeRun", true),
  };
}

export function judgeConfig(): JudgeConfig {
  const c = cfg();
  return {
    timeoutMs: c.get<number>("judge.timeoutMs", 10000),
    maxOutputBytes: c.get<number>("judge.maxOutputBytes", 16 * 1024 * 1024),
  };
}

export function problemsConfig(): ProblemsConfig {
  const c = cfg();
  return {
    bankDir: c.get<string>("problems.bankDir", "题库"),
    saveStatementAsMd: c.get<boolean>("problems.saveStatementAsMd", true),
    codeTemplate: c.get<string>(
      "problems.codeTemplate",
      // 缩进用 2 空格：VSCode 的 detectIndentation 会按内容猜 tabSize，模板里出现 4 空格缩进
      // 就会把新建文件的 tabSize 猜成 4（打开后的纠正见 ProblemsController.openCreatedSource）。
      "#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n\n  return 0;\n}\n",
    ),
    openStatement: c.get<"webview" | "markdown" | "none">("problems.openStatement", "webview"),
  };
}

export function submitConfig(): SubmitConfig {
  const c = cfg();
  return {
    language: c.get<string>("submit.language", "cpp"),
    enableO2: c.get<boolean>("submit.enableO2", DEFAULT_ENABLE_O2),
    compileFirst: c.get<boolean>("submit.compileFirst", true),
    pollIntervalMs: c.get<number>("submit.pollIntervalMs", 2000),
    pollTimeoutMs: c.get<number>("submit.pollTimeoutMs", 120000),
  };
}

export interface BanshuConfig {
  /** 建题时是否自动生成 `题解板书.typ`（以及题库根目录的共享版式）。 */
  enabled: boolean;
  /** 共享版式所在目录；空串 = `<工作区>/<题目根目录>`。 */
  confDir: string;
  /** 题解里的署名；留空则标题区不显示署名栏。 */
  author: string;
  /** 题解眉行/页眉里的课程名。 */
  course: string;
  /** typst 可执行文件；不在 PATH 里时填完整路径。 */
  typstPath: string;
  /** 板书图在题解里的宽度（Typst 长度表达式）。 */
  imageWidth: string;
}

export function banshuConfig(): BanshuConfig {
  const c = cfg();
  return {
    enabled: c.get<boolean>("banshu.enabled", true),
    confDir: c.get<string>("banshu.confDir", ""),
    author: c.get<string>("banshu.author", "爱学习的咸鱼君"),
    course: c.get<string>("banshu.course", "《深入浅出程序设计竞赛》题解"),
    typstPath: c.get<string>("banshu.typstPath", "typst"),
    imageWidth: c.get<string>("banshu.imageWidth", "89%"),
  };
}

export interface CoverConfig {
  /** 建题时是否自动调 BiliBiliHelper 生成封面（落到题目录）。关掉后只剩手动命令。 */
  enabled: boolean;
  /** bili-helper 可执行文件；也可以用 `args` + `projectDir` 走 `python -m bili_assistant.cli`。 */
  command: string;
  /** 命令前缀参数（如 `["-m", "bili_assistant.cli"]`）。 */
  args: string[];
  /** 进程工作目录；走 `python -m` 时必须是 BiliBiliHelper 项目根（否则 import 不到包）。 */
  projectDir: string;
  /** 模板/配色/尺寸：留空 = 用 BiliBiliHelper 自己 config.toml 里的默认。 */
  template: string;
  palette: string;
  size: string;
  /** 追加到命令行末尾的原始参数，如 `["--ai-bg"]`（AI 背景**按次计费**）。 */
  extraArgs: string[];
  /** 封面文件名模板，`${id}` 换成题号。 */
  fileName: string;
  timeoutMs: number;
}

export function coverConfig(): CoverConfig {
  const c = cfg();
  return {
    enabled: c.get<boolean>("cover.enabled", true),
    command: c.get<string>("cover.command", "bili-helper"),
    args: c.get<string[]>("cover.args", []),
    projectDir: c.get<string>("cover.projectDir", ""),
    template: c.get<string>("cover.template", ""),
    palette: c.get<string>("cover.palette", ""),
    size: c.get<string>("cover.size", ""),
    extraArgs: c.get<string[]>("cover.extraArgs", []),
    fileName: c.get<string>("cover.fileName", DEFAULT_COVER_FILE),
    // 一张封面要起一次 Playwright，首次或冷启动能到十几秒；下限给 5 秒，免得填个 0 就必超时。
    timeoutMs: Math.max(5000, c.get<number>("cover.timeoutMs", 120000)),
  };
}

export function luoguConfig(): LuoguConfig {
  const c = cfg();
  return {
    baseUrl: c.get<string>("luogu.baseUrl", "https://www.luogu.com.cn").replace(/\/+$/, ""),
    requestIntervalMs: c.get<number>("luogu.requestIntervalMs", 800),
  };
}

export function whiteboardConfig(): WhiteboardConfig {
  return { exportDpi: clampExportDpi(cfg().get<number>("whiteboard.exportDpi", DEFAULT_EXPORT_DPI)) };
}

/** 输出通道，供各处统一打印日志。 */
export const output = vscode.window.createOutputChannel("洛谷教学助手");