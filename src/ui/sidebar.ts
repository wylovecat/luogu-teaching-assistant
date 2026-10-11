import * as vscode from "vscode";
import type { SessionManager } from "../luogu/session";
import type { ProblemRef } from "../problems/link";
import { maskAccount } from "../util";

export interface RecentProblem {
  displayId: string;
  title: string;
  difficulty: number | null;
}

export type LgNode =
  | { kind: "account" }
  | {
      kind: "action";
      id: string;
      label: string;
      icon?: string;
      description?: string;
      tooltip?: string;
      command: string;
      args?: unknown[];
    }
  | { kind: "group"; id: "problems" | "current"; label?: string }
  | { kind: "problem"; ref: RecentProblem }
  | { kind: "currentRef"; ref: ProblemRef; filePath: string };

const RECENT_KEY = "lgAssist.recentProblems";
const RECENT_LIMIT = 15;

/**
 * 侧边栏（TreeView）。样式由 VS Code 主题接管，这里只管树结构与命令。
 *
 * 结构刻意比爱思创那版简单一截：洛谷没有「班级 / 班测」这层概念，
 * 所以只剩「账号 → 当前文件 → 题库」三块。
 */
export class SidebarProvider implements vscode.TreeDataProvider<LgNode> {
  private readonly emitter = new vscode.EventEmitter<LgNode | undefined | void>();
  readonly onDidChangeTreeData = this.emitter.event;

  /** 当前活动文件关联的题目（由 app 更新）。 */
  currentRef: { ref: ProblemRef; filePath: string } | null = null;

  constructor(
    private readonly session: SessionManager,
    private readonly state: vscode.Memento,
  ) {}

  refresh(): void {
    this.emitter.fire();
  }

  recents(): RecentProblem[] {
    return this.state.get<RecentProblem[]>(RECENT_KEY, []);
  }

  async rememberProblem(p: RecentProblem): Promise<void> {
    const list = this.recents().filter((x) => x.displayId !== p.displayId);
    list.unshift(p);
    await this.state.update(RECENT_KEY, list.slice(0, RECENT_LIMIT));
    this.refresh();
  }

  async clearRecents(): Promise<void> {
    await this.state.update(RECENT_KEY, []);
    this.refresh();
  }

  getTreeItem(node: LgNode): vscode.TreeItem {
    switch (node.kind) {
      case "account": {
        const s = this.session.current;
        if (!s) {
          const item = new vscode.TreeItem("未登录洛谷", vscode.TreeItemCollapsibleState.None);
          item.iconPath = new vscode.ThemeIcon("account");
          item.description = "点击登录";
          item.command = { command: "lgAssist.login", title: "登录" };
          item.contextValue = "lgAccountLoggedOut";
          return item;
        }
        const item = new vscode.TreeItem(`已登录 · ${maskAccount(s.uname)}`, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("account");
        item.description = s.uid ? `uid ${s.uid}` : undefined;
        item.tooltip = `洛谷账号 ${s.uname}（uid ${s.uid}）`;
        item.contextValue = "lgAccountLoggedIn";
        return item;
      }
      case "group": {
        const labels: Record<string, string> = { problems: "题库", current: "当前文件" };
        const icons: Record<string, string> = { problems: "library", current: "file-code" };
        const item = new vscode.TreeItem(labels[node.id], vscode.TreeItemCollapsibleState.Expanded);
        item.iconPath = new vscode.ThemeIcon(icons[node.id]);
        item.contextValue = node.id === "problems" ? "lgProblemsGroup" : "lgCurrentGroup";
        return item;
      }
      case "action": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        if (node.icon) item.iconPath = new vscode.ThemeIcon(node.icon);
        item.description = node.description;
        item.tooltip = node.tooltip ?? node.label;
        item.command = { command: node.command, title: node.label, arguments: node.args };
        item.contextValue = "lgAction";
        return item;
      }
      case "problem": {
        const item = new vscode.TreeItem(`${node.ref.displayId} ${node.ref.title}`.trim(), vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("symbol-namespace");
        item.tooltip = `题号 ${node.ref.displayId}${node.ref.title ? ` · ${node.ref.title}` : ""}\n点击打开题面`;
        item.command = { command: "lgAssist.openProblemById", title: "打开题面", arguments: [node.ref.displayId] };
        item.contextValue = "lgProblem";
        return item;
      }
      case "currentRef": {
        const r = node.ref;
        const item = new vscode.TreeItem(`${r.displayId} ${r.title}`.trim(), vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("link");
        item.description = "已关联题目";
        item.tooltip = `当前文件已关联题目 ${r.displayId}\n点击打开题面`;
        item.command = { command: "lgAssist.openStatement", title: "打开题面" };
        item.contextValue = "lgCurrentRef";
        return item;
      }
    }
  }

  getChildren(node?: LgNode): LgNode[] {
    if (!node) {
      return [
        { kind: "account" },
        // 知识面板不绑题目、不需要登录，所以直接放根上，任何状态下都能点
        {
          kind: "action",
          id: "knowledge",
          label: "打开知识面板（空白讲解）",
          icon: "lightbulb",
          tooltip: "一张空白 A4 纸，用来讲知识点（画图 / 推公式 / 写伪代码），批注自动保存",
          command: "lgAssist.openKnowledgeBoard",
        },
        { kind: "group", id: "current" },
        { kind: "group", id: "problems" },
      ];
    }
    switch (node.kind) {
      case "group":
        return this.childrenOfGroup(node.id);
      default:
        return [];
    }
  }

  private childrenOfGroup(id: "problems" | "current"): LgNode[] {
    if (id === "problems") {
      const out: LgNode[] = [
        { kind: "action", id: "search", label: "搜索题目并创建…", icon: "search", command: "lgAssist.searchAndCreate" },
        { kind: "action", id: "byId", label: "按题号创建…", icon: "add", command: "lgAssist.createFromProblem" },
      ];
      const recents = this.recents();
      if (recents.length) {
        out.push({ kind: "action", id: "clearRecents", label: "清空最近题目", icon: "clear-all", command: "lgAssist.clearRecents" });
        for (const r of recents) out.push({ kind: "problem", ref: r });
      }
      return out;
    }
    // current
    if (this.currentRef) {
      return [
        { kind: "currentRef", ref: this.currentRef.ref, filePath: this.currentRef.filePath },
        { kind: "action", id: "whiteboard", label: "打开题面白板（批注）", icon: "edit", command: "lgAssist.openWhiteboard" },
      ];
    }
    return [
      { kind: "action", id: "noFile", label: "（当前没有关联题目的文件）", icon: "info", command: "lgAssist.showCurrentFileHelp" },
    ];
  }
}