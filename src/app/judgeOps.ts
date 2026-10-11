/**
 * 编译相关的共用操作：编译失败统一处理、编译并运行。
 *
 * 「建题后直接跑起来」与「F6 编译运行」两条路径最终汇到 `compileAndRunFile`，
 * 所以它放在控制器之外共用一份（放控制器里就得让 problems 反向依赖 judge 域）。
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { output } from "../config";
import { compile, type CompileResult } from "../judge/compile";
import { firstDiagnosticText, summarizeDiagnostics, type CompileDiagnostic } from "../judge/diagnostics";
import { publishCompileResult } from "../judge/problems";
import { runProgram } from "../terminal/runner";

/**
 * 编译失败的统一处理：报错发布到「问题」面板（编辑器里带波浪线、可点着跳到出错行），
 * 完整编译器输出进「OI教学助手」输出面板，再给一条带按钮的提示。
 *
 * 以前这里只说一句「详见输出面板」，而输出面板里其实只有「失败(退出码 1)」——
 * g++ 的报错文本压根没打过。
 */
export async function reportCompileFailure(res: CompileResult, file: string): Promise<void> {
  const diags = publishCompileResult(file, res);
  const first = firstDiagnosticText(diags);
  // 一条都定位不到行（例如链接器报错）时，输出面板才是唯一能看到细节的地方
  if (!diags.some((d: CompileDiagnostic) => d.line !== null)) output.show(true);
  const pick = await vscode.window.showErrorMessage(
    `编译失败：${summarizeDiagnostics(diags)}${first ? `。${first}` : ""}`,
    "查看问题",
    "打开输出面板",
  );
  if (pick === "查看问题") await vscode.commands.executeCommand("workbench.actions.view.problems");
  else if (pick === "打开输出面板") output.show(true);
}

/** 编译某个文件并把可执行文件跑起来（建题后的「编译并运行」提示与 F6 都走这里）。 */
export async function compileAndRunFile(file: string): Promise<void> {
  const res = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `正在编译 ${path.basename(file)}…` },
    () => compile(file),
  );
  if (!res.ok) {
    await reportCompileFailure(res, file);
    return;
  }
  publishCompileResult(file, res);
  runProgram(res.exe, path.dirname(file), { title: `运行 ${path.basename(file)}` });
}