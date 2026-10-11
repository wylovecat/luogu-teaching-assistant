import * as vscode from "vscode";
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
  /** 洛谷提交表单的 lang 取值（cpp / gcc / cf…），以站点提交框实际选项为准 */
  language: string;
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
    compileFirst: c.get<boolean>("submit.compileFirst", true),
    pollIntervalMs: c.get<number>("submit.pollIntervalMs", 2000),
    pollTimeoutMs: c.get<number>("submit.pollTimeoutMs", 120000),
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