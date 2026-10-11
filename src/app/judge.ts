/**
 * 评测域：F6 编译运行、样例评测、评测面板与「跳到出错行」。
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { compile } from "../judge/compile";
import { publishCompileResult } from "../judge/problems";
import { judgeFile, type JudgeReport } from "../judge/judge";
import { runProgram } from "../terminal/runner";
import { JudgePanel } from "../ui/judgePanel";
import { Controller } from "./base";
import { reportCompileFailure } from "./judgeOps";

export class JudgeController extends Controller {
  async compileRun(): Promise<void> {
    const file = await this.requireCppFile();
    if (!file) return;
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

  async runSamples(): Promise<void> {
    const file = await this.requireCppFile();
    if (!file) return;
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在编译并评测样例…" },
      () => judgeFile(file),
    );
    publishCompileResult(report.sourcePath, report.compile);
    this.showJudgeReport(report);
    if (report.noSamples && report.compile.ok) {
      const pick = await vscode.window.showInformationMessage(
        "该题目没有样例文件，无法自动评测。要在终端里直接运行吗？",
        "在终端运行",
        "取消",
      );
      if (pick === "在终端运行") runProgram(report.compile.exe, path.dirname(file), { title: `运行 ${path.basename(file)}` });
    }
  }

  private showJudgeReport(report: JudgeReport): void {
    JudgePanel.show(this.context, report, {
      onRerun: () => void this.rerunJudge(report.sourcePath),
      onRunInTerminal: (inputFile) => {
        if (!report.compile.ok) {
          void vscode.window.showWarningMessage("请先通过编译再运行");
          return;
        }
        runProgram(report.compile.exe, path.dirname(report.sourcePath), {
          inputFile: inputFile ?? undefined,
          title: `运行 ${path.basename(report.sourcePath)}`,
        });
      },
      onOpenSource: () => void vscode.window.showTextDocument(vscode.Uri.file(report.sourcePath), { preview: false }),
      onGotoLocation: (line, column) => void this.gotoLocation(report.sourcePath, line, column),
      onSubmit: () => this.host.submitFromJudge(report),
    });
  }

  /** 跳到指定行列（评测面板里点编译报错用）。行列都是 1 起。 */
  private async gotoLocation(file: string, line: number, column: number | null): Promise<void> {
    const position = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1));
    try {
      await vscode.window.showTextDocument(vscode.Uri.file(file), {
        preview: false,
        selection: new vscode.Range(position, position),
      });
    } catch (e) {
      this.reportError("跳转到出错行失败", e);
    }
  }

  private async rerunJudge(file: string): Promise<void> {
    const report = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在重新评测…" },
      () => judgeFile(file),
    );
    publishCompileResult(report.sourcePath, report.compile);
    this.showJudgeReport(report);
  }
}