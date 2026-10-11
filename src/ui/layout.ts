/**
 * 题面与题目文件的分栏规则：**题面在左，题目文件在右**。
 *
 * 这里只做「谁开在哪一栏」的纯决策，不碰 vscode API（便于单测）；
 * 具体把 ViewColumn.One / ViewColumn.Beside 传下去由建题域（src/app/problems.ts）负责。
 */

export type OpenStatementMode = "webview" | "markdown" | "none";

export interface DisplayPlan {
  /** 左栏放什么：内置题面面板 / 题面 markdown / 不放题面 */
  left: "webview" | "markdown" | null;
  /** 左栏要打开的文件（markdown 模式用） */
  leftPath: string | null;
  /** 源文件是否贴着左栏在其右侧打开；false 表示按 VSCode 默认位置打开 */
  fileBeside: boolean;
}

export function planProblemDisplay(args: {
  openMode: OpenStatementMode;
  hasStatement: boolean;
  mdPath: string | null;
}): DisplayPlan {
  if (args.openMode === "webview" && args.hasStatement) {
    return { left: "webview", leftPath: null, fileBeside: true };
  }
  if (args.openMode === "markdown" && args.mdPath) {
    return { left: "markdown", leftPath: args.mdPath, fileBeside: true };
  }
  return { left: null, leftPath: null, fileBeside: false };
}
