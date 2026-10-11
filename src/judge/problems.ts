/**
 * 把一次编译的结果发到 VSCode「问题」面板：报错/告警带波浪线，点一下跳到出错行。
 *
 * 只在真有东西要发时才创建集合，所以从没编译失败的会话里不会凭空多出这个来源。
 * 完整编译器输出（含解析不出来的链接器消息）走输出面板，见 compile.ts。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { CompileResult } from "./compile";
import { parseCompileDiagnostics, type CompileDiagnostic, type CompileSeverity } from "./diagnostics";

let collection: vscode.DiagnosticCollection | undefined;

const SEVERITY: Record<CompileSeverity, vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  note: vscode.DiagnosticSeverity.Information,
};

export function disposeCompileDiagnostics(): void {
  collection?.dispose();
  collection = undefined;
}

function ensure(): vscode.DiagnosticCollection {
  if (!collection) collection = vscode.languages.createDiagnosticCollection("lgAssist");
  return collection;
}

/**
 * 发布这次编译的诊断，并清掉上一次留下的。编译通过但带告警（`-Wall`）时同样发布，
 * 学生就能在编辑器里看到「变量没用过」这类提示，而不只是输出面板里一闪而过。
 *
 * 返回解析出的全部诊断（含无法定位的那些），供调用方做摘要提示。
 */
export function publishCompileResult(file: string, res: CompileResult): CompileDiagnostic[] {
  const diags = parseCompileDiagnostics(res.message, {
    cwd: path.dirname(file),
    fallbackFile: file,
  });

  // note 是报错的补充说明，单独发到问题面板只会刷屏；定位不到行的（链接器、
  // 头文件路径等）也没法画波浪线，它们留在输出面板里看。
  const publishable = diags.filter((d) => d.severity !== "note" && d.line !== null && fs.existsSync(d.file));

  collection?.clear();
  if (publishable.length > 0) {
    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const d of publishable) {
      const line = d.line! - 1;
      const column = Math.max(0, (d.column ?? 1) - 1);
      const item = new vscode.Diagnostic(
        new vscode.Range(line, column, line, column + 1),
        d.message,
        SEVERITY[d.severity],
      );
      item.source = "OI教学助手";
      const list = byFile.get(d.file);
      if (list) list.push(item);
      else byFile.set(d.file, [item]);
    }
    const target = ensure();
    for (const [f, list] of byFile) target.set(vscode.Uri.file(f), list);
  }
  return diags;
}
