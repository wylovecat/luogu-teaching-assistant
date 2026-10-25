/**
 * 建题域：按题号/搜索从洛谷建题、拉题面、题面面板。
 *
 * 与爱思创那版的差别：没有「班测上下文」这一路参数。洛谷没有班级/班测的概念，
 * 题号就是站点主键，建题落盘只需要把「题号 ↔ 源文件」记进文件关联。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { problemsConfig } from "../config";
import { createProblemFiles, problemDir, workspaceRoot } from "../problems/files";
import type { ProblemRef } from "../problems/link";
import { difficultyLabel, statementToMarkdown, type Statement } from "../problems/statement";
import { planProblemDisplay } from "../ui/layout";
import { showStatement } from "../ui/statementPanel";
import { indentationFix, stemOf } from "../util";
import { Controller } from "./base";

export class ProblemsController extends Controller {
  /** 按题号创建题目文件（拉题面 + 样例）。 */
  async createFromProblem(presetDisplayId?: string): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("请先打开一个文件夹作为工作区，题目文件会创建在其中");
      return;
    }
    const displayId = (
      presetDisplayId ??
      (await vscode.window.showInputBox({
        title: "从洛谷创建题目",
        prompt: "请输入题号，例如 P1001（远程题也可以，如 CF1A / AT_abc001_a）",
        ignoreFocusOut: true,
        validateInput: (v) => (/^\S+$/.test(v.trim()) ? undefined : "题号不能为空"),
      }))
    )?.trim();
    if (!displayId) return;
    await this.host.createProblemFilesFlow(root, displayId);
  }

  /** 搜索题号/题名，从命中列表里选一道。 */
  async searchAndCreate(): Promise<void> {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showErrorMessage("请先打开一个文件夹作为工作区");
      return;
    }
    const keyword = await vscode.window.showInputBox({
      title: "搜索洛谷题库",
      prompt: "输入题号或题名关键字",
      ignoreFocusOut: true,
    });
    if (!keyword || !keyword.trim()) return;
    try {
      const hits = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在搜索「${keyword}」…` },
        () => this.session.client.searchProblems(keyword.trim()),
      );
      if (hits.length === 0) {
        void vscode.window.showWarningMessage(`没有搜索到与「${keyword}」相关的题目`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        hits.map((h) => ({
          label: `${h.displayId} ${h.title}`.trim(),
          description: difficultyLabel(h.difficulty),
          hit: h,
        })),
        { title: "选择题目", matchOnDescription: true, ignoreFocusOut: true },
      );
      if (!picked) return;
      await this.host.createProblemFilesFlow(root, picked.hit.displayId);
    } catch (e) {
      this.reportError("搜索失败", e);
    }
  }

  /**
   * 打开某题号的题面（不创建文件）。
   * withFile 传当前源文件时，题面占左栏、源文件挪到它右侧，和建题时的布局一致。
   *
   * 这里**不要求登录**：洛谷的题面是公开接口，游客也能读题、建文件、跑本地评测。
   * 登录只在搜索与提交时才是必须的。
   */
  async openProblemById(displayId: string, withFile?: string): Promise<void> {
    try {
      const statement = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在获取 ${displayId} 题面…` },
        () => this.session.client.statement(displayId),
      );
      this.presentStatement(statement, undefined, vscode.ViewColumn.One);
      if (withFile) {
        await vscode.window.showTextDocument(vscode.Uri.file(withFile), {
          preview: false,
          viewColumn: vscode.ViewColumn.Beside,
        });
        await this.refreshCurrentRef();
      }
    } catch (e) {
      this.reportError("获取题面失败", e);
    }
  }

  /** 拉题面 → 建文件 → 打开源文件 & 题面。 */
  async createProblemFilesFlow(root: string, displayId: string): Promise<void> {
    let statement: Statement | null = null;
    let title = "";
    try {
      statement = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在获取 ${displayId} 的题面与样例…` },
        () => this.session.client.statement(displayId),
      );
      title = statement.title;
    } catch (e) {
      const go = await vscode.window.showWarningMessage(
        `获取 ${displayId} 题面失败：${this.messageOf(e)}。是否仍创建空题目文件？`,
        "仍然创建",
        "取消",
      );
      if (go !== "仍然创建") return;
    }

    const created = createProblemFiles({
      root,
      displayId: statement?.displayId || displayId,
      statement,
      samples: statement?.samples ?? [],
    });

    // 以站点返回的题号/题名为准（用户可能输入了小写或别的前缀）
    const ref: ProblemRef = {
      displayId: created.cppPath ? path.basename(created.cppPath, ".cpp") : displayId,
      title,
      difficulty: statement?.difficulty ?? null,
    };
    await this.links.set(created.cppPath, ref);
    await this.sidebar.rememberProblem({ displayId: ref.displayId, title, difficulty: ref.difficulty ?? null });

    // 题解板书：建题时就铺好模板（幂等，已有则不覆盖）。
    // 放在打开文件之前 —— 出问题也只记日志，不该拦住主流程。
    await this.host.ensureBanshuDoc(ref.displayId, title);

    // 封面：调 BiliBiliHelper 渲染进题目录（幂等，已存在即跳过）。
    // **刻意不 await** —— 一次渲染要 7 秒左右（真机实测），老师要的是源文件马上打开；
    // ensureCoverImage 自己吞掉所有异常，不会变成未处理的 rejection。
    void this.host.ensureCoverImage(ref.displayId, created.dir);

    // 布局：题面（面板或题面 md）先占左栏，源文件贴着它开到右侧
    const plan = planProblemDisplay({
      openMode: problemsConfig().openStatement,
      hasStatement: statement !== null,
      mdPath: created.mdPath,
    });
    if (statement && plan.left === "webview") {
      this.presentStatement(statement, created, vscode.ViewColumn.One);
    } else if (plan.left === "markdown" && plan.leftPath) {
      await vscode.window.showTextDocument(vscode.Uri.file(plan.leftPath), {
        preview: false,
        viewColumn: vscode.ViewColumn.One,
      });
    }
    await this.openCreatedSource(created.cppPath, plan.fileBeside ? vscode.ViewColumn.Beside : undefined);
    await this.refreshCurrentRef();

    const sampleCount = (statement?.samples ?? []).length;
    const info = created.reused
      ? `题目文件已存在，已复用：${path.relative(root, created.cppPath)}`
      : `已创建 ${path.relative(root, created.cppPath)}（样例 ${sampleCount} 组）`;
    void vscode.window.showInformationMessage(info);

    // 样例为空：直接提示走终端运行
    if (sampleCount === 0) {
      const pick = await vscode.window.showInformationMessage(
        "这道题没有可用样例，自动评测无从比对。要现在编译并在终端里运行吗？",
        "编译并运行",
        "稍后",
      );
      if (pick === "编译并运行") await this.compileAndRunFile(created.cppPath);
    }
  }

  /**
   * 打开刚创建的题目源文件，并把缩进对齐到用户的编辑器配置。
   *
   * VSCode 的 `editor.detectIndentation`（默认开启）打开文件时会按内容猜 tabSize，猜出来的值
   * 压过用户的 `editor.tabSize`——模板里只要有一行 4 空格缩进，新建文件就显示成 tabSize 4。
   * 文件内容是我们写的，缩进按用户配置写回编辑器选项即可（与 .editorconfig 插件同样的做法）。
   */
  private async openCreatedSource(file: string, viewColumn?: vscode.ViewColumn): Promise<vscode.TextEditor> {
    const editor = await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false, viewColumn });
    // 带文档取配置，这样 [cpp] 这类语言级覆盖也算数
    const cfg = vscode.workspace.getConfiguration("editor", editor.document);
    const fix = indentationFix(editor.options, {
      tabSize: cfg.get<number>("tabSize", 4),
      insertSpaces: cfg.get<boolean>("insertSpaces", true),
    });
    if (fix) editor.options = fix;
    return editor;
  }

  /**
   * 展示题面面板。badge 传洛谷难度标签（如「普及-」），当作「这道题是什么档」的旁注，
   * 不写进标题行 —— 标题行已经给题名了。留空则不显示这个标记。
   */
  presentStatement(
    statement: Statement,
    created?: { cppPath: string; mdPath: string | null },
    column: vscode.ViewColumn = vscode.ViewColumn.Beside,
  ): void {
    const badge = difficultyLabel(statement.difficulty);
    showStatement(
      this.context,
      statement,
      {
        onCreate: async () => {
          const root = workspaceRoot();
          if (!root) return;
          const made = createProblemFiles({
            root,
            displayId: statement.displayId,
            statement,
            samples: statement.samples,
          });
          await this.links.set(made.cppPath, {
            displayId: path.basename(made.cppPath, ".cpp"),
            title: statement.title,
            difficulty: statement.difficulty,
          });
          // 与「按题号创建」共用同一条封面路径（题解文档那条不在这里补：
          // 面板上的「生成/打开题解板书」本来就会建，别把它的时机悄悄改掉）
          const madeId = path.basename(made.cppPath, ".cpp");
          void this.host.ensureCoverImage(madeId, made.dir);
          // 面板在左栏，源文件开在它右侧
          await this.openCreatedSource(made.cppPath, vscode.ViewColumn.Beside);
          await this.refreshCurrentRef();
          void vscode.window.showInformationMessage(`已创建 ${path.relative(root, made.cppPath)}`);
        },
        onOpenMarkdown: async () => {
          const target = created?.mdPath ?? (await this.writeTempStatementMarkdown(statement));
          if (target) await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false });
        },
        onCopySamples: async () => {
          const text = statement.samples
            .map((s, i) => `# 样例 ${i + 1}\n[输入]\n${s.input.replace(/\s+$/, "")}\n[输出]\n${s.output.replace(/\s+$/, "")}`)
            .join("\n\n");
          await vscode.env.clipboard.writeText(text);
          void vscode.window.showInformationMessage(`已复制 ${statement.samples.length} 组样例到剪贴板`);
        },
        onOpenWhiteboard: () => this.host.openWhiteboardForStatement(statement),
      },
      column,
      badge,
    );
  }

  private async writeTempStatementMarkdown(statement: Statement): Promise<string | null> {
    const root = workspaceRoot();
    if (!root) return null;
    const dir = problemDir(root, statement.displayId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${statement.displayId}.md`);
    fs.writeFileSync(file, statementToMarkdown(statement), "utf8");
    return file;
  }

  /** 命令面板 / 编辑器标题栏的「打开当前题目的题面」：先认文件关联，再按文件名当题号去拉。 */
  async openStatement(): Promise<void> {
    const file = this.currentCppFile();
    if (!file) {
      void vscode.window.showWarningMessage("请先打开一个 .cpp 文件");
      return;
    }
    const ref = this.links.get(file);
    if (!ref) {
      const pick = await vscode.window.showInformationMessage(
        "这个文件还没有关联题目。要按文件名当题号去洛谷找吗？",
        "去洛谷找",
        "取消",
      );
      if (pick === "去洛谷找") await this.host.createFromProblem(stemOf(path.basename(file)));
      return;
    }
    await this.openProblemById(ref.displayId, file);
  }
}