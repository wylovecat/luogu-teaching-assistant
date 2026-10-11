/**
 * 代码图片域：把当前源文件导出成一张 PNG。
 *
 * 导出目录与两块白板共用同一份记忆（`LAST_EXPORT_DIR_KEY`）。
 */

import * as fs from "node:fs";
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
      const code = fs.readFileSync(file, "utf8");
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