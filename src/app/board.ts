/**
 * 白板域：题面批注白板 + 知识面板（空白 A4 纸）。
 *
 * 两块白板与「代码图片导出」共用同一份「上次导出目录」记忆（`LAST_EXPORT_DIR_KEY`）。
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { whiteboardConfig } from "../config";
import type { Statement } from "../problems/statement";
import { stemOf } from "../util";
import { showKnowledgeBoard, showWhiteboard, type WhiteboardOptions } from "../whiteboard/panel";
import { Controller } from "./base";
import { LAST_EXPORT_DIR_KEY } from "./deps";

export class BoardController extends Controller {
  /**
   * 打开当前题目题面的批注白板（命令面板 / 侧边栏入口）。
   * 与「打开题面」同一条路径：先认当前文件关联的题，再拉题面 —— 白板要有题面才有意义。
   */
  async openWhiteboard(): Promise<void> {
    const file = this.currentCppFile();
    if (!file) {
      void vscode.window.showWarningMessage("请先打开一个 .cpp 文件");
      return;
    }
    const ref = this.links.get(file);
    if (!ref) {
      const pick = await vscode.window.showInformationMessage(
        "这个文件还没有关联题目。要按文件名当题号去题库找吗？",
        "去题库找",
        "取消",
      );
      if (pick === "去题库找") await this.host.createFromProblem(stemOf(path.basename(file)));
      return;
    }
    if (!this.requireLogin()) return;
    try {
      const statement = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在获取 ${ref.displayId} 题面…` },
        () => this.session.client.statement(ref.displayId),
      );
      this.openWhiteboardForStatement(statement);
    } catch (e) {
      this.reportError("获取题面失败", e);
    }
  }

  /** 白板的导出目录跟代码图片导出共用一份记忆（同一个「上次导出位置」）。 */
  openWhiteboardForStatement(statement: Statement): void {
    showWhiteboard(this.context, statement, this.boardOptions());
  }

  /**
   * 打开知识面板：一张空白 A4 纸，专门用来讲知识点（画图、推公式、写伪代码），
   * 与「题面白板」分开 —— 不绑题目、不拉题面，所以不需要登录，也不看当前文件。
   */
  openKnowledgeBoard(): void {
    showKnowledgeBoard(this.context, this.boardOptions());
  }

  /** 两块白板共用同一份导出目录记忆（和代码图片导出也共用）。 */
  private boardOptions(): WhiteboardOptions {
    return {
      lastDir: this.context.globalState.get<string>(LAST_EXPORT_DIR_KEY),
      // 每次开面板现读一次设置：改了 lgAssist.whiteboard.exportDpi 重开面板就生效
      exportDpi: whiteboardConfig().exportDpi,
      onSaved: async (saved) => {
        await this.context.globalState.update(LAST_EXPORT_DIR_KEY, path.dirname(saved));
      },
    };
  }
}