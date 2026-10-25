/**
 * 封面域：调 BiliBiliHelper（`E:\BiliBiliHelper`，洛谷题解封面生成器）渲染题目封面，
 * 落到这道题的**题解目录**里 —— 与 `.cpp`、样例、`题解板书.typ`、`<题号> 板书.png` 同处。
 *
 *   | 文件 | 谁写 |
 *   | --- | --- |
 *   | `<题目录>/<题号> 封面.png` | BiliBiliHelper 的 `cover` 子命令（本域起的进程） |
 *
 * 三个刻意这么定的地方：
 *
 * 1. **自动流程在界面上完全静默**（`loud=false`）。这个功能依赖隔壁那个 Python 项目
 *    （要 Python + Playwright），而 `.vsix` 里装不下它 —— 也就是说**绝大多数装了这个扩展的
 *    学生机器上，封面命令是找不到的**。那种机器上：
 *    - 不弹错误框、不弹警告框；
 *    - **连「正在生成封面…」的进度通知都不给** —— 命令会立刻失败，一个一闪而过的提示
 *      比不提示更让人困惑；
 *    - 只往输出面板写一行（完整说明每个会话只写一次，之后是一句话的短行）。
 *    手动命令（`lgAssist.createCover`）是用户主动要的，才给进度与弹框。
 * 2. **已存在就跳过**。渲染一张 3–7 秒（真机实测），而建题经常是「复用已有文件」——
 *    每次建题都重渲染纯属浪费；要换一张走手动命令（强制重生成）。
 * 3. **永不抛**。调用方是 `void this.host.ensureCoverImage(...)`（不 await），
 *    抛出去就是未处理的 rejection。
 *
 * 跨域调用经 `host`（见 base.ts）：建题域在本域之后调 `ensureCoverImage`。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { output, coverConfig, type CoverConfig } from "../config";
import { CoverToolNotFoundError, coverFailureMessage, renderCover } from "../cover/cli";
import { coverInvocation, coverOutPath, type CoverSpec } from "../cover/spec";
import { problemDir, workspaceRoot } from "../problems/files";
import { stemOf } from "../util";
import { Controller } from "./base";

export class CoverController extends Controller {
  /** 「命令没找到」的完整说明只写一次日志；之后每次建题只留一句短行。 */
  private warnedMissingTool = false;

  // ── 对外：供其它域经 App 调用 ──────────────────────────────────

  /**
   * 建题后调用（自动）。已存在就跳过；失败只记日志。
   *
   * **永不抛**：调用方是 `void this.host.ensureCoverImage(...)` 这种不 await 的写法
   * （渲染那几秒不该挡住「打开源文件」），抛出去就成了未处理的 rejection。
   */
  async ensure(displayId: string, dir: string): Promise<void> {
    try {
      await this.run(displayId, dir, coverConfig(), { force: false, loud: false });
    } catch (e) {
      output.appendLine(`[封面] 生成失败：${this.messageOf(e)}`);
    }
  }

  // ── 命令入口 ─────────────────────────────────────────────────

  /** 命令：为当前题目生成/重新生成封面（强制重渲染，已有也覆盖）。 */
  async generateForCurrent(): Promise<void> {
    const target = this.targetForCurrent();
    if (!target) return;
    const cfg = coverConfig();
    const ok = await this.run(target.displayId, target.dir, cfg, { force: true, loud: true });
    if (!ok) return;
    const file = coverOutPath(this.specFor(target.displayId, target.dir, cfg));
    const pick = await vscode.window.showInformationMessage(
      `封面已生成：${path.basename(file)}`,
      "打开封面",
      "在文件夹中显示",
    );
    if (pick === "打开封面") await vscode.env.openExternal(vscode.Uri.file(file));
    else if (pick === "在文件夹中显示")
      void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
  }

  // ── 内部 ─────────────────────────────────────────────────────

  /** 渲染一张封面。返回是否真的产出了文件。 */
  private async run(
    displayId: string,
    dir: string,
    cfg: CoverConfig,
    opts: { force: boolean; loud: boolean },
  ): Promise<boolean> {
    if (!cfg.enabled) {
      if (opts.loud) {
        void vscode.window.showWarningMessage(
          "封面生成被 `lgAssist.cover.enabled` 关掉了，打开它再试。",
        );
      }
      return false;
    }

    const spec = this.specFor(displayId, dir, cfg);
    const outPath = coverOutPath(spec);
    if (!opts.force && fs.existsSync(outPath)) {
      output.appendLine(`[封面] 已存在，跳过：${path.relative(dir, outPath)}`);
      return true;
    }

    const inv = coverInvocation(
      {
        command: cfg.command,
        args: cfg.args,
        projectDir: cfg.projectDir,
        timeoutMs: cfg.timeoutMs,
      },
      spec,
    );

    try {
      // 自动流程连进度通知都不给：见文件头第 1 条 —— 没装 BiliBiliHelper 的机器上
      // 命令会立刻失败，闪一下的通知比不提示更糟。手动命令才包 withProgress。
      const render = () => renderCover({ ...inv, imagePath: outPath });
      const r = opts.loud
        ? await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `正在生成 ${displayId} 的封面…` },
            render,
          )
        : await render();
      // 退出码 0 不算数：以文件真的在为准（BiliBiliHelper 也会静默走到不写图的分支）
      if (!r.ok || !r.imageWritten) {
        const detail = coverFailureMessage(r);
        output.appendLine(`[封面] 生成失败：\n${detail}`);
        // 自动流程一行 UI 都不出（连输出面板也不顶出来）—— 它只是个可选增强，
        // 不该在建题时把用户的注意力抢走。手动命令才把面板掀开给人看原因。
        if (opts.loud) {
          void vscode.window.showErrorMessage(`封面生成失败：${detail.split("\n")[0]}`);
          output.show(true);
        }
        return false;
      }
      output.appendLine(`[封面] 已生成 ${outPath}`);
      return true;
    } catch (e) {
      if (e instanceof CoverToolNotFoundError) {
        // 完整说明（怎么装、怎么配）每个会话只写一次，之后每次建题只留一句短行 ——
        // 学生机没有 BiliBiliHelper，不该每建一道题就刷一整段。
        if (this.warnedMissingTool) {
          output.appendLine(`[封面] 跳过（未找到封面生成命令「${inv.command}」）`);
        } else {
          this.warnedMissingTool = true;
          output.appendLine(`[封面] ${e.message}`);
        }
        if (opts.loud) void vscode.window.showWarningMessage(e.message);
        return false;
      }
      output.appendLine(`[封面] 生成失败：${this.messageOf(e)}`);
      if (opts.loud) this.reportError("生成封面失败", e);
      return false;
    }
  }

  private specFor(displayId: string, dir: string, cfg: CoverConfig): CoverSpec {
    return {
      problemId: displayId,
      dir,
      displayId,
      template: cfg.template,
      fileTemplate: cfg.fileName,
      palette: cfg.palette,
      size: cfg.size,
      extraArgs: cfg.extraArgs,
    };
  }

  /** 当前文件对应的题（关联优先，其次按文件名当题号 —— 与题解/提交域同一套判据）。 */
  private targetForCurrent(): { dir: string; displayId: string } | null {
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
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showWarningMessage("请先用 VS Code 打开一个文件夹（工作区）。");
      return null;
    }
    const dir = problemDir(root, displayId);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, displayId };
  }
}
