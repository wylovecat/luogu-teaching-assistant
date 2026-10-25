/**
 * 代码图片域：把当前源文件导出成一张 PNG。
 *
 * 导出目录与两块白板共用同一份记忆（`LAST_EXPORT_DIR_KEY`）。
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { exportCodeImage } from "../imgexport/exportImage";
import { Controller } from "./base";
import { LAST_EXPORT_DIR_KEY } from "./deps";

export class ImageExportController extends Controller {
  async exportImage(uri?: vscode.Uri): Promise<void> {
    const file = uri?.fsPath ?? this.currentCppFile();
    if (!file) {
      void vscode.window.showWarningMessage("请先打开或用右键选中一个 .cpp 文件");
      return;
    }
    try {
      // 走 readSource：编辑器里改了没存盘时先存盘 —— 导出的 PNG 必须是**屏幕上这份**代码，
      // 直接读盘会导出上一版，投影出去就是错代码。
      const code = await this.readSource(file);
      await exportCodeImage(code, path.basename(file), {
        lastDir: this.context.globalState.get<string>(LAST_EXPORT_DIR_KEY),
        onSaved: async (saved) => {
          await this.context.globalState.update(LAST_EXPORT_DIR_KEY, path.dirname(saved));
        },
      });
    } catch (e) {
      this.reportError("导出图片失败", e);
    }
  }
}