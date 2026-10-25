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
 * | `banshu` | 题解板书：生成 Typst 文档、插板书图与 AC 代码、导出 PDF |
 * | `cover` | 封面：建题时调 BiliBiliHelper 渲染封面到题目录 |
 *
 * App 同时充当控制器的 `PeerHost`：控制器之间不直接互相 import，跨域调用都回到这里
 * （见 base.ts）。新增一个域就是加一个控制器 + 在这里挂一个方法。
 */

import * as vscode from "vscode";
import type { JudgeReport } from "../judge/judge";
import type { Statement } from "../problems/statement";
import { updateEditorFontSize } from "../config";
import {
  DEFAULT_EDITOR_FONT_PX,
  MAX_EDITOR_FONT_PX,
  MIN_EDITOR_FONT_PX,
  clampEditorFontPx,
  editorFontHint,
  stepEditorFontPx,
} from "../editorFont";
import { type PeerHost, refreshCurrentRef } from "./base";
import { type AppDeps } from "./deps";
import { BanshuController } from "./banshu";
import { BoardController } from "./board";
import { CoverController } from "./cover";
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
  private readonly banshuCtl: BanshuController;
  private readonly coverCtl: CoverController;

  constructor(private readonly deps: AppDeps) {
    // 控制器的构造只存引用、不会回调 host，所以传 this 是安全的
    this.judgeCtl = new JudgeController(deps, this);
    this.problemsCtl = new ProblemsController(deps, this);
    this.boardCtl = new BoardController(deps, this);
    this.submitCtl = new SubmitController(deps, this);
    this.imagesCtl = new ImageExportController(deps, this);
    this.banshuCtl = new BanshuController(deps, this);
    this.coverCtl = new CoverController(deps, this);
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

  // ── 代码字号（编辑器，不是导出的图片） ────────────────────────

  /**
   * 调「代码源文件」的字号：写 VS Code 自己的 `editor.fontSize`。
   *
   * 投屏时老师常要把代码放大，而 VS Code 自带的 Ctrl+= 是**整窗缩放**（菜单栏、侧边栏、
   * 终端一起变大）—— 这里只动代码字号那一份。到头了要明说一句，别让按钮看着像坏的。
   */
  async changeCodeFontSize(delta: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    // 传 TextDocument 而不是 Uri：这样 `[cpp]` 的语言专属设置也一起算进来，
    // 读到的才是老师**眼里**那个字号（不然读了通用值，改了却看不见变化）
    const setting = vscode.workspace.getConfiguration("editor", editor?.document);
    const current = clampEditorFontPx(setting.get<number>("fontSize", DEFAULT_EDITOR_FONT_PX));
    const next = stepEditorFontPx(current, delta);
    if (next === current) {
      vscode.window.setStatusBarMessage(
        `代码字号已经是 ${current}px（可调范围 ${MIN_EDITOR_FONT_PX}–${MAX_EDITOR_FONT_PX}）`,
        3000,
      );
      return;
    }
    await updateEditorFontSize(next);
    vscode.window.setStatusBarMessage(editorFontHint(next), 2500);
  }

  // ── 题解板书 ──────────────────────────────────────────────────

  /** 为当前文件生成/补齐题解文档并打开。 */
  createBanshuDoc(): Promise<void> {
    return this.banshuCtl.createDocForCurrent();
  }

  /** 把当前代码写进题解（不必等 AC）。 */
  insertBanshuCode(): Promise<void> {
    return this.banshuCtl.insertCurrentCode();
  }

  /** 编译题解成 PDF。 */
  exportBanshuPdf(): Promise<void> {
    return this.banshuCtl.exportPdf();
  }

  /** 写入/重建题库根目录里的共享版式。 */
  writeBanshuConf(): Promise<void> {
    return this.banshuCtl.writeSharedConf();
  }

  // ── 封面（联动 BiliBiliHelper） ───────────────────────────────

  /** 为当前题目生成/重新生成封面。 */
  createCover(): Promise<void> {
    return this.coverCtl.generateForCurrent();
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

  // ── PeerHost：题解域（建题后 / AC 后 / 白板导出后） ────────────

  ensureBanshuDoc(displayId: string, title: string): Promise<void> {
    return this.banshuCtl.ensureDoc(displayId, title);
  }

  writeBanshuCode(displayId: string, code: string): Promise<void> {
    return this.banshuCtl.snapshotAcCode(displayId, code);
  }

  insertBanshuImages(displayId: string, files: string[]): Promise<void> {
    return this.banshuCtl.insertBoardImages(displayId, files);
  }

  // ── PeerHost：封面域（建题后） ────────────────────────────────

  ensureCoverImage(displayId: string, dir: string): Promise<void> {
    return this.coverCtl.ensure(displayId, dir);
  }
}