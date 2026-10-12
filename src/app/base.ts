/**
 * 各域控制器共用的基类与跨域接口。
 *
 * `PeerHost` 是控制器**唯一**的对外依赖（实际传进来的是 App 实例）：
 * 「评测面板提交」要回提交域、「题面面板开白板」要回白板域、「白板里没关联题目」要回建题域 ——
 * 这几条边都走 App，不在控制器之间直接 import，省掉环形依赖。
 */

import * as fs from "node:fs";
import * as vscode from "vscode";
import type { JudgeReport } from "../judge/judge";
import type { Statement } from "../problems/statement";
import { CPP_EXT, type AppDeps } from "./deps";
import { login, messageOf, reportError, requireLogin } from "./authOps";
import { compileAndRunFile } from "./judgeOps";

/** 控制器跨域调用所落到的那几个能力（App 实现）。 */
export interface PeerHost {
  /** 提交域：评测面板里点「提交到洛谷」。 */
  submitFromJudge(report: JudgeReport): Promise<void>;
  /** 白板域：题面面板上的「打开白板」。 */
  openWhiteboardForStatement(statement: Statement): void;
  /** 建题域：按题号建文件（白板入口遇到「没关联题目」时要走它）。 */
  createFromProblem(presetDisplayId?: string): Promise<void>;
  /** 建题域：拉题面 → 建文件 → 打开源文件 & 题面（「按题号创建」与搜索建题共用）。 */
  createProblemFilesFlow(root: string, displayId: string): Promise<void>;
  /** 题解域：建题后生成/补齐题解文档（幂等，已存在不动）。 */
  ensureBanshuDoc(displayId: string, title: string): Promise<void>;
  /** 题解域：拿到 AC 后快照代码并写进题解。 */
  writeBanshuCode(displayId: string, code: string): Promise<void>;
  /** 题解域：白板导出到题目录后，把这几页图写进题解。 */
  insertBanshuImages(displayId: string, files: string[]): Promise<void>;
}

/**
 * 把当前文件关联同步给侧边栏（「当前文件」节点）。
 *
 * App 与所有控制器都要用（建题后、题面打开后、切换编辑器时），所以做成独立函数而不是
 * 某个域的私有方法。
 */
export async function refreshCurrentRef(deps: AppDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const file = editor && CPP_EXT.test(editor.document.uri.fsPath) ? editor.document.uri.fsPath : null;
  if (!file) {
    deps.sidebar.currentRef = null;
    deps.sidebar.refresh();
    return;
  }
  const ref = deps.links.get(file);
  deps.sidebar.currentRef = ref ? { ref, filePath: file } : null;
  deps.sidebar.refresh();
}

export abstract class Controller {
  constructor(
    protected readonly deps: AppDeps,
    /** 跨域回调（实际是 App 实例）；控制流不会在构造期调它。 */
    protected readonly host: PeerHost,
  ) {}

  // 依赖快捷方式：域内代码照旧写 this.session / this.links …，读起来和拆之前一样。
  protected get context(): vscode.ExtensionContext {
    return this.deps.context;
  }

  protected get session(): AppDeps["session"] {
    return this.deps.session;
  }

  protected get links(): AppDeps["links"] {
    return this.deps.links;
  }

  protected get sidebar(): AppDeps["sidebar"] {
    return this.deps.sidebar;
  }

  protected get status(): vscode.StatusBarItem {
    return this.deps.status;
  }

  protected messageOf(e: unknown): string {
    return messageOf(e);
  }

  protected requireLogin(): boolean {
    return requireLogin(this.deps);
  }

  protected reportError(prefix: string, e: unknown): void {
    reportError(this.deps, prefix, e);
  }

  protected login(): Promise<void> {
    return login(this.deps);
  }

  protected compileAndRunFile(file: string): Promise<void> {
    return compileAndRunFile(file);
  }

  /** 当前活动的源文件（没有活动编辑器、或不是 C/C++ 就返回 null）。 */
  protected currentCppFile(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (editor && CPP_EXT.test(editor.document.uri.fsPath)) return editor.document.uri.fsPath;
    return null;
  }

  /** 要跑编译/评测的命令用：先确认有源文件，并把它存盘（否则跑的不是屏幕上这份代码）。 */
  protected async requireCppFile(): Promise<string | null> {
    const file = this.currentCppFile();
    if (!file) {
      void vscode.window.showWarningMessage("请先打开一个 C/C++ 源文件（.cpp/.cc/.cxx/.c）");
      return null;
    }
    if (vscode.window.activeTextEditor?.document.isDirty) {
      await vscode.window.activeTextEditor.document.save();
    }
    return file;
  }

  /** 把当前文件关联同步给侧边栏（「当前文件」节点）。 */
  refreshCurrentRef(): Promise<void> {
    return refreshCurrentRef(this.deps);
  }

  /**
   * 读源文件内容。文档在编辑器里改过还没保存时先存盘再读 ——
   * 提交/编译的必须是同一份代码，否则评测过的和提交上去的可能不是同一个版本。
   */
  protected async readSource(file: string): Promise<string> {
    const doc = (vscode.workspace.textDocuments ?? []).find((d) => d.uri.fsPath === file);
    if (doc?.isDirty) await doc.save();
    return fs.readFileSync(file, "utf8");
  }
}