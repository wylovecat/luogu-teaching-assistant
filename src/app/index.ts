/**
 * App —— 命令编排的 façade。
 *
 * `extension.ts` 注册的命令、以及侧边栏/面板回调，全部挂在这个类上（方法签名是对外契约，
 * 别改）；每个方法只是把活派给对应域的控制器，真正的流程在同目录：
 *
 * | 控制器 | 管什么 |
 * | --- | --- |
 * | `judge` | F6 编译运行、样例评测、评测面板 |
 * | `problems` | 按题号/搜索建题、拉题面、题面面板 |
 * | `board` | 题面批注白板、知识面板 |
 * | `submit` | 提交到洛谷、轮询评测结果 |
 * | `imageExport` | 代码导出 PNG |
 *
 * App 同时充当控制器的 `PeerHost`：控制器之间不直接互相 import，跨域调用都回到这里
 * （见 base.ts）。新增一个域就是加一个控制器 + 在这里挂一个方法。
 */

import * as vscode from "vscode";
import type { JudgeReport } from "../judge/judge";
import type { Statement } from "../problems/statement";
import { type PeerHost, refreshCurrentRef } from "./base";
import { type AppDeps } from "./deps";
import { BoardController } from "./board";
import { ImageExportController } from "./imageExport";
import { JudgeController } from "./judge";
import { ProblemsController } from "./problems";
import { SubmitController } from "./submit";
import * as auth from "./authOps";

export class App implements PeerHost {
  private readonly judgeCtl: JudgeController;
  private readonly problemsCtl: ProblemsController;
  private readonly boardCtl: BoardController;
  private readonly submitCtl: SubmitController;
  private readonly imagesCtl: ImageExportController;

  constructor(private readonly deps: AppDeps) {
    // 控制器的构造只存引用、不会回调 host，所以传 this 是安全的
    this.judgeCtl = new JudgeController(deps, this);
    this.problemsCtl = new ProblemsController(deps, this);
    this.boardCtl = new BoardController(deps, this);
    this.submitCtl = new SubmitController(deps, this);
    this.imagesCtl = new ImageExportController(deps, this);
  }

  // ── 登录 ──────────────────────────────────────────────────────

  login(): Promise<void> {
    return auth.login(this.deps);
  }

  logout(): Promise<void> {
    return auth.logout(this.deps);
  }

  updateStatus(): void {
    auth.updateStatus(this.deps);
  }

  // ── 编译运行 ──────────────────────────────────────────────────

  compileRun(): Promise<void> {
    return this.judgeCtl.compileRun();
  }

  runSamples(): Promise<void> {
    return this.judgeCtl.runSamples();
  }

  // ── 建题与题面 ────────────────────────────────────────────────

  createFromProblem(presetDisplayId?: string): Promise<void> {
    return this.problemsCtl.createFromProblem(presetDisplayId);
  }

  searchAndCreate(): Promise<void> {
    return this.problemsCtl.searchAndCreate();
  }

  openProblemById(displayId: string, withFile?: string): Promise<void> {
    return this.problemsCtl.openProblemById(displayId, withFile);
  }

  openStatement(): Promise<void> {
    return this.problemsCtl.openStatement();
  }

  // ── 题面白板 ──────────────────────────────────────────────────

  openWhiteboard(): Promise<void> {
    return this.boardCtl.openWhiteboard();
  }

  openKnowledgeBoard(): void {
    this.boardCtl.openKnowledgeBoard();
  }

  // ── 提交 ──────────────────────────────────────────────────────

  submit(): Promise<void> {
    return this.submitCtl.submit();
  }

  // ── 图片导出 ──────────────────────────────────────────────────

  exportImage(uri?: vscode.Uri): Promise<void> {
    return this.imagesCtl.exportImage(uri);
  }

  // ── 其他 ──────────────────────────────────────────────────────

  async clearRecents(): Promise<void> {
    await this.deps.sidebar.clearRecents();
  }

  async refreshCurrentRef(): Promise<void> {
    await refreshCurrentRef(this.deps);
  }

  async showCurrentFileHelp(): Promise<void> {
    void vscode.window.showInformationMessage(
      "当前文件没有关联题目。可用「按题号创建」或「搜索题目」从洛谷建立题目文件；文件名形如 P1001.cpp 也会被识别为题号。",
    );
  }

  // ── PeerHost：控制器跨域调用落在这里（见 base.ts） ──────────────

  /** 评测面板里的「提交到洛谷」。 */
  submitFromJudge(report: JudgeReport): Promise<void> {
    return this.submitCtl.submitFromJudge(report);
  }

  /** 题面面板上的「打开白板」。 */
  openWhiteboardForStatement(statement: Statement): void {
    this.boardCtl.openWhiteboardForStatement(statement);
  }

  /** 建题流程（「按题号创建」与搜索建题共用）。 */
  createProblemFilesFlow(root: string, displayId: string): Promise<void> {
    return this.problemsCtl.createProblemFilesFlow(root, displayId);
  }
}