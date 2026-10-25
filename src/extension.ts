import * as vscode from "vscode";
import { App } from "./app/index";
import { output } from "./config";
import { disposeCompileDiagnostics } from "./judge/problems";
import { SessionManager } from "./luogu/session";
import { ProblemLinkStore } from "./problems/link";
import { SidebarProvider } from "./ui/sidebar";

export function activate(context: vscode.ExtensionContext): void {
  const session = new SessionManager(context.secrets);
  const links = new ProblemLinkStore(context.workspaceState);
  const sidebar = new SidebarProvider(session, context.globalState);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);

  const app = new App({ context, session, links, sidebar, status });

  const treeView = vscode.window.createTreeView("lgAssist.sidebar", {
    treeDataProvider: sidebar,
    showCollapseAll: true,
  });
  context.subscriptions.push(treeView, status, output, { dispose: disposeCompileDiagnostics });

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args: unknown[]) => {
        try {
          await handler(...args);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          output.appendLine(`[错误] 命令 ${id} 失败：${msg}`);
          void vscode.window.showErrorMessage(`${id} 失败：${msg}`);
        }
      }),
    );
  };

  register("lgAssist.login", () => app.login());
  register("lgAssist.logout", () => app.logout());
  register("lgAssist.compileRun", () => app.compileRun());
  register("lgAssist.runSamples", () => app.runSamples());
  register("lgAssist.searchAndCreate", () => app.searchAndCreate());
  register("lgAssist.createFromProblem", () => app.createFromProblem());
  register("lgAssist.openProblemById", (displayId) => app.openProblemById(String(displayId)));
  register("lgAssist.openStatement", () => app.openStatement());
  register("lgAssist.openWhiteboard", () => app.openWhiteboard());
  register("lgAssist.openKnowledgeBoard", () => app.openKnowledgeBoard());
  register("lgAssist.submit", () => app.submit());
  register("lgAssist.exportImage", (uri) => app.exportImage(uri as vscode.Uri | undefined));
  register("lgAssist.increaseCodeFontSize", () => app.changeCodeFontSize(1));
  register("lgAssist.decreaseCodeFontSize", () => app.changeCodeFontSize(-1));
  register("lgAssist.createBanshuDoc", () => app.createBanshuDoc());
  register("lgAssist.insertBanshuCode", () => app.insertBanshuCode());
  register("lgAssist.exportBanshuPdf", () => app.exportBanshuPdf());
  register("lgAssist.writeBanshuConf", () => app.writeBanshuConf());
  register("lgAssist.createCover", () => app.createCover());
  register("lgAssist.refresh", async () => {
    await app.refreshCurrentRef();
    sidebar.refresh();
  });
  register("lgAssist.clearRecents", () => app.clearRecents());
  register("lgAssist.showCurrentFileHelp", () => app.showCurrentFileHelp());

  // 会话变化（登录/登出/Cookie 过期）后刷新状态栏与侧边栏
  context.subscriptions.push(session.onDidChange(() => {
    app.updateStatus();
    sidebar.refresh();
  }));

  // 切换编辑器时更新「当前文件」节点
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => void app.refreshCurrentRef()),
  );

  app.updateStatus();
  void app.refreshCurrentRef();

  // 启动时尝试恢复登录态（不阻塞激活）。恢复不了也不影响用：
  // 题面是公开接口，建题、跑本地评测都不需要登录。
  void (async () => {
    const ok = await session.restore();
    if (!ok) output.appendLine("[启动] 未恢复洛谷登录态，可点击状态栏或侧边栏登录（搜索与提交需要登录）");
  })();

  output.appendLine("[启动] 洛谷教学助手已激活");
}

export function deactivate(): void {
  // 无需特殊清理：所有 disposables 已进 context.subscriptions
}