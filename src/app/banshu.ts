/**
 * 题解板书域：把白板图与 AC 代码整理成 Typst 文档并导出 PDF。
 *
 * 整条流程参照 `D:\板书\P1395 会议` 那套整理而成，落的目录是**扩展自己的题目录**
 * （`<工作区>/<题目根目录>/<题号>/`），与 `.cpp`、样例同处：
 *
 *   | 文件 | 谁写 |
 *   | --- | --- |
 *   | `<题库根>/banshuconf.typ` | 扩展（**共享**一份版式；已存在就不覆盖） |
 *   | `<题目录>/题解板书.typ` | 扩展生成，之后由人随意补充；扩展只替换 `lgAssist:*` 标记块 |
 *   | `<题目录>/<题号> 板书.png` | 白板「导出并插入题解」写 |
 *   | `<题目录>/<题号>_AC.cpp` | 拿到 AC 时的代码快照 |
 *   | `<题目录>/题解板书.pdf` | typst 编译产物 |
 *
 * 跨域调用（建题后、AC 后、白板导出后）都经 `host` 回到 App，控制器之间不互相 import
 * （见 base.ts）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { banshuConfig, output, problemsConfig } from "../config";
import {
  BANSHU_CONF,
  CONF_FILE,
  DOC_FILE,
  PDF_FILE,
  acCodeName,
  banshuImageWidth,
  blockBody,
  blockSpan,
  buildBanshuDoc,
  codeBlockBody,
  replaceBlock,
} from "../banshu/template";
import { compileTypst, TypstNotFoundError, typstFailureMessage } from "../banshu/typst";
import { problemDir, workspaceRoot } from "../problems/files";
import { sameFilePath, stemOf } from "../util";
import { Controller } from "./base";

export class BanshuController extends Controller {
  // ── 对外：供其它域经 App 调用 ──────────────────────────────────

  /**
   * 建题后调用：确保共享版式在、题解文档在。
   *
   * 幂等 —— 文档已存在就**不覆盖**（里面可能已经写满了思路），只补缺失的东西。
   */
  async ensureDoc(displayId: string, title: string): Promise<void> {
    const cfg = banshuConfig();
    if (!cfg.enabled) return;
    const dir = this.problemDirFor(displayId);
    if (!dir) return;
    try {
      this.writeConfIfAbsent();
      const docPath = path.join(dir, DOC_FILE);
      if (!fs.existsSync(docPath)) {
        fs.writeFileSync(docPath, buildBanshuDoc(this.docOptions(displayId, title)), "utf8");
        output.appendLine(`[题解] 已生成 ${path.relative(this.root() ?? dir, docPath)}`);
      }
    } catch (e) {
      // 建题主流程不该因为题解生成失败而中断，记日志即可
      output.appendLine(`[题解] 生成题解文档失败：${this.messageOf(e)}`);
    }
  }

  /**
   * 拿到 AC 后调用：快照代码并写进题解。
   *
   * 快照而不是直接引用源文件 —— 之后继续改代码（换更快的写法、做变体）都不会让题解里的
   * 「当时 AC 的那份」跟着变。想同步新版就再点一次「把当前代码写进题解」。
   */
  async snapshotAcCode(displayId: string, code: string): Promise<void> {
    const cfg = banshuConfig();
    if (!cfg.enabled) return;
    const dir = this.problemDirFor(displayId);
    if (!dir) return;
    try {
      this.writeConfIfAbsent();
      fs.writeFileSync(path.join(dir, acCodeName(displayId)), code, "utf8");
      const docPath = await this.ensureDocFile(dir, displayId, "");
      await this.updateBlock(docPath, "code", codeBlockBody(displayId));
      output.appendLine(`[题解] 已把 AC 代码写进题解（${acCodeName(displayId)}）`);
    } catch (e) {
      output.appendLine(`[题解] 写入 AC 代码失败：${this.messageOf(e)}`);
    }
  }

  /** 白板「导出并插入题解」落盘后调用：把这几页图写进题解的图片块。 */
  async insertBoardImages(displayId: string, files: string[]): Promise<void> {
    const cfg = banshuConfig();
    if (!cfg.enabled || files.length === 0) return;
    const dir = this.problemDirFor(displayId);
    if (!dir) return;
    try {
      const docPath = await this.ensureDocFile(dir, displayId, "");
      // 用落盘后的真实文件名（面板按约定命名，但以磁盘为准更稳）
      const names = files.map((f) => path.basename(f));
      // 宽度先清洗：这个值是原样拼进 Typst 源码的，坏值会让整份 PDF 编译不过
      const width = banshuImageWidth(cfg.imageWidth);
      const body = names
        .map((n, i) => {
          const img = `#image("${n}", width: ${width})`;
          return i === 0 ? img : `\n${img}`;
        })
        .join("\n");
      await this.updateBlock(docPath, "image", body);
      output.appendLine(`[题解] 已插入 ${names.length} 张板书图`);
    } catch (e) {
      this.reportError("插入板书图失败", e);
    }
  }

  // ── 命令入口 ─────────────────────────────────────────────────

  /** 命令：为当前文件生成/补齐题解文档，并打开它。 */
  async createDocForCurrent(): Promise<void> {
    const target = this.targetForCurrent();
    if (!target) return;
    await this.ensureDoc(target.displayId, target.title);
    const docPath = path.join(target.dir, DOC_FILE);
    if (!fs.existsSync(docPath)) {
      void vscode.window.showWarningMessage(
        "没能生成题解文档（题解功能可能被 `lgAssist.banshu.enabled` 关掉了）。",
      );
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.file(docPath));
  }

  /** 命令：把当前代码快照进题解（不必等 AC —— 有时讲的就是一份没提交的代码）。 */
  async insertCurrentCode(): Promise<void> {
    const target = this.targetForCurrent();
    if (!target) return;
    const code = await this.readSource(target.file);
    await this.snapshotAcCode(target.displayId, code);
    void vscode.window.showInformationMessage(`已把当前代码写进 ${target.displayId} 的题解。`);
  }

  /** 命令：导出题解 PDF。 */
  async exportPdf(): Promise<void> {
    const target = this.targetForCurrent();
    if (!target) return;
    await this.ensureDoc(target.displayId, target.title);
    const docPath = path.join(target.dir, DOC_FILE);
    if (!fs.existsSync(docPath)) {
      void vscode.window.showWarningMessage("还没有题解文档，先运行「生成题解文档」。");
      return;
    }

    const cfg = banshuConfig();
    const pdfPath = path.join(target.dir, PDF_FILE);
    // 共享版式在题库根，题解用 `#import "../banshuconf.typ"` →
    // Typst 必须把项目根放宽到工作区，否则报 would escape the project root
    const root = this.root() ?? target.dir;
    try {
      const r = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "正在编译题解 PDF…" },
        () =>
          compileTypst({ typstPath: cfg.typstPath, docPath, pdfPath, rootDir: root }),
      );
      if (!r.ok || !r.pdfWritten) {
        const detail = typstFailureMessage(r);
        output.appendLine(`[题解] typst 编译失败：\n${detail}`);
        void vscode.window.showErrorMessage(`题解编译失败：${detail.split("\n")[0]}`);
        output.show(true);
        return;
      }
      output.appendLine(`[题解] 已生成 ${pdfPath}`);
      const pick = await vscode.window.showInformationMessage(
        `题解 PDF 已生成：${path.basename(pdfPath)}`,
        "打开 PDF",
        "在文件夹中显示",
      );
      if (pick === "打开 PDF") await vscode.env.openExternal(vscode.Uri.file(pdfPath));
      else if (pick === "在文件夹中显示")
        void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(pdfPath));
    } catch (e) {
      if (e instanceof TypstNotFoundError) {
        void vscode.window.showErrorMessage(e.message);
        return;
      }
      this.reportError("导出题解 PDF 失败", e);
    }
  }

  /** 命令：把共享版式写进题库根目录（已存在时先问一句再覆盖）。 */
  async writeSharedConf(): Promise<void> {
    const confPath = this.confPath();
    if (!confPath) {
      void vscode.window.showWarningMessage("请先用 VS Code 打开一个文件夹（工作区）。");
      return;
    }
    if (fs.existsSync(confPath)) {
      const pick = await vscode.window.showWarningMessage(
        `共享版式已存在：${confPath}`,
        { modal: true, detail: "覆盖会丢掉你对版式做过的改动（各题解的正文不受影响）。" },
        "覆盖",
      );
      if (pick !== "覆盖") return;
    } else {
      fs.mkdirSync(path.dirname(confPath), { recursive: true });
    }
    fs.writeFileSync(confPath, BANSHU_CONF, "utf8");
    output.appendLine(`[题解] 已写入共享版式 ${confPath}`);
    void vscode.window.showInformationMessage(`共享版式已写入：${confPath}`);
  }

  // ── 内部 ─────────────────────────────────────────────────────

  private root(): string | null {
    return workspaceRoot();
  }

  /** 共享版式的完整路径：`<工作区>/<题目根目录>/banshuconf.typ`（或 `banshu.confDir`）。 */
  private confPath(): string | null {
    const root = this.root();
    if (!root) return null;
    const dir = banshuConfig().confDir.trim() || path.join(root, problemsConfig().bankDir);
    return path.join(dir, CONF_FILE);
  }

  private problemDirFor(displayId: string): string | null {
    const root = this.root();
    if (!root) {
      void vscode.window.showWarningMessage("请先用 VS Code 打开一个文件夹（工作区）。");
      return null;
    }
    const dir = problemDir(root, displayId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 共享版式不存在就写一份；**已存在不动**（用户可能自己改过版式）。 */
  private writeConfIfAbsent(): void {
    const confPath = this.confPath();
    if (!confPath || fs.existsSync(confPath)) return;
    fs.mkdirSync(path.dirname(confPath), { recursive: true });
    fs.writeFileSync(confPath, BANSHU_CONF, "utf8");
    output.appendLine(`[题解] 已写入共享版式 ${confPath}`);
  }

  /** 题解文档不在就建一个，返回它的路径。 */
  private async ensureDocFile(dir: string, displayId: string, title: string): Promise<string> {
    const docPath = path.join(dir, DOC_FILE);
    if (!fs.existsSync(docPath)) {
      fs.writeFileSync(docPath, buildBanshuDoc(this.docOptions(displayId, title)), "utf8");
    }
    return docPath;
  }

  /**
   * 替换题解文档里的标记块；块被删了就把话说清楚，别静默失败。
   *
   * ⚠️ **文档在编辑器里开着时走 WorkspaceEdit，不要直接改盘**。
   * 直接 `fs.writeFileSync` 会和老师未保存的改动打架：编辑器缓冲区里的那份才是
   * 「活」的，磁盘上刚写进去的内容会被他下一次保存覆盖回去 —— 症状就是
   * 「点了没反应，题解里还是老的」。走 WorkspaceEdit 改的是缓冲区，两边都保住。
   * 文档没开时仍然直接改盘（省得把它开成个脏文档）。
   *
   * 改动只覆盖标记之间的那几个字（最小编辑），文档其余部分一个字节都不动。
   */
  private async updateBlock(docPath: string, key: string, body: string): Promise<void> {
    const open = (vscode.workspace.textDocuments ?? []).find((d) => sameFilePath(d.uri.fsPath, docPath));
    if (open) {
      const content = open.getText();
      let span: { from: number; to: number };
      try {
        span = blockSpan(content, key);
      } catch (e) {
        void vscode.window.showWarningMessage(
          `${this.messageOf(e)}。请恢复题解文档里那段标记后再试（或用「生成题解文档」重建）。`,
        );
        return;
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        open.uri,
        new vscode.Range(open.positionAt(span.from), open.positionAt(span.to)),
        blockBody(body),
      );
      await vscode.workspace.applyEdit(edit);
      // 存盘：Typst 编译读的是磁盘上的文件，编辑器里改了不存，PDF 还是旧的
      await open.save();
      return;
    }
    const content = fs.readFileSync(docPath, "utf8");
    try {
      fs.writeFileSync(docPath, replaceBlock(content, key, body), "utf8");
    } catch (e) {
      void vscode.window.showWarningMessage(
        `${this.messageOf(e)}。请恢复题解文档里那段标记后再试（或用「生成题解文档」重建）。`,
      );
    }
  }

  private docOptions(displayId: string, title: string) {
    const cfg = banshuConfig();
    return {
      displayId,
      title,
      course: cfg.course,
      author: cfg.author,
      date: formatChineseDate(new Date()),
    };
  }

  /** 当前文件对应的题（关联优先，其次按文件名当题号 —— 与提交域同一套判据）。 */
  private targetForCurrent(): { file: string; dir: string; displayId: string; title: string } | null {
    const file = this.currentCppFile();
    if (!file) {
      void vscode.window.showWarningMessage("请先打开一个 C/C++ 源文件");
      return null;
    }
    const linked = this.links.get(file);
    const displayId = linked?.displayId ?? stemOf(path.basename(file));
    if (!/^[A-Za-z0-9_]+$/.test(displayId)) {
      void vscode.window.showErrorMessage(
        "这个文件没有关联题目，文件名也不是题号形态。请先「按题号创建」建立关联。",
      );
      return null;
    }
    const dir = this.problemDirFor(displayId);
    if (!dir) return null;
    return { file, dir, displayId, title: linked?.title ?? "" };
  }
}

/** `2026年10月`。纯逻辑模块不碰时钟，所以日期在这里生成。 */
function formatChineseDate(d: Date): string {
  return `${d.getFullYear()}年${d.getMonth() + 1}月`;
}
