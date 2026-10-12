/**
 * 提交域：把代码提交到洛谷、轮询评测结果。
 *
 * 与爱思创那版相比少了一整套「班测登记」：洛谷没有班测，提交就是提交。
 * 另外「定位题目」也不用反查内部 id 了 —— 洛谷的题号就是站点主键，
 * 提交地址直接是 `/fe/api/problem/submit/<题号>`。
 *
 * ⚠️ 这里的时机与字段是**站点契约**，且提交那半边尚未在真机登录会话下核对过
 * （见 src/luogu/client.ts 顶部的 TODO）。已定死的一条判据是：
 *
 *   **只有拿到判定文本才算终局结果**（`isFinalJudgeResult`）。洛谷评测是异步的，
 *   刚提交完去查会拿到「评测中」那条记录，它的 status 已经不是等待值 —— 只看它就会把
 *   中间态当结果报出去。宁可多等一轮，也不要把没判定的记录显示成某个具体判定。
 */

import * as path from "node:path";
import * as vscode from "vscode";
import { output, submitConfig } from "../config";
import type { LuoguResult } from "../luogu/client";
import { resolveLangId } from "../luogu/contract";
import { compile } from "../judge/compile";
import { firstDiagnosticText, summarizeDiagnostics } from "../judge/diagnostics";
import { publishCompileResult } from "../judge/problems";
import type { JudgeReport } from "../judge/judge";
import type { ProblemRef } from "../problems/link";
import { isFinalJudgeResult, needsPreSubmitCompile, shortHash, stemOf, verdictLabel } from "../util";
import { Controller } from "./base";

/**
 * 提交后第一次查评测结果前先等这么久。
 *
 * 洛谷评测是异步的：POST 只把提交排进队列，记录要过一会儿才写判定。刚提交就查会拿到
 * 「还没评测」的那条记录。配合 `isFinalJudgeResult` 双重把关。
 */
const POLL_SETTLE_MS = 1500;

export class SubmitController extends Controller {
  /** 提交进行中（评测面板与快捷键都可能触发），防止并发提交同一份代码 */
  private submitting = false;

  async submit(): Promise<void> {
    const file = this.currentCppFile();
    if (!file) {
      void vscode.window.showWarningMessage("请先打开要提交的 .cpp 文件");
      return;
    }
    await this.submitFile(file);
  }

  /** 评测面板里的「提交到洛谷」：刚评测过的代码直接提交，不再本地编译一遍。 */
  async submitFromJudge(report: JudgeReport): Promise<void> {
    try {
      // 编译没过就不算「已编译」，退回常规的提交前编译检查
      await this.submitFile(report.sourcePath, report.compile.ok ? report.sourceHash : undefined);
    } catch (e) {
      this.reportError("提交失败", e);
    }
  }

  /**
   * 提交指定文件到关联题目。
   *
   * compiledHash 传「刚在本地编译通过的那份代码」的内容哈希时，提交前那次本地编译会被
   * 跳过（见 needsPreSubmitCompile）；代码若在评测后又被改过，哈希对不上，照常编译。
   */
  private async submitFile(file: string, compiledHash?: string): Promise<void> {
    if (!this.requireLogin()) return;
    if (this.submitting) {
      void vscode.window.showWarningMessage("上一次提交还在进行中，请稍候");
      return;
    }
    const code = await this.readSource(file);
    if (!code.trim()) {
      void vscode.window.showWarningMessage("文件内容为空，未提交");
      return;
    }

    const ref = this.resolveRef(file);
    if (!ref) return;

    const cfg = submitConfig();
    if (needsPreSubmitCompile(cfg.compileFirst, shortHash(code), compiledHash)) {
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "提交前本地编译检查…" },
        () => compile(file),
      );
      const diags = publishCompileResult(file, res);
      if (!res.ok) {
        const first = firstDiagnosticText(diags);
        const force = await vscode.window.showWarningMessage(
          `本地编译未通过：${summarizeDiagnostics(diags)}。仍要提交吗？`,
          {
            modal: true,
            detail: first
              ? `${first}\n\n完整报错见「问题」面板（可点着跳到出错行）与「洛谷教学助手」输出面板。`
              : "完整输出见「洛谷教学助手」输出面板。",
          },
          "强制提交",
        );
        if (force !== "强制提交") return;
      }
    } else if (cfg.compileFirst) {
      output.appendLine("[编译] 跳过：与刚通过评测的代码一致");
    }

    const target = `洛谷 ${ref.displayId}`;
    let rid = 0;
    this.submitting = true;
    try {
      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `正在提交到 ${target}…`, cancellable: true },
        async (progress, token) => {
          rid = await this.session.client.submit(ref.displayId, code, cfg.language, cfg.enableO2);
          // 语言与 O2 一起打进日志：真机跑通时，「提交被判语言不符/O2 相关怪现象」
          // 回头看这一行就能确认，不用再去翻设置。
          output.appendLine(
            `[提交] ${target} record=${rid} lang=${cfg.language}(id=${resolveLangId(cfg.language)})` +
              ` O2=${cfg.enableO2 ? "开" : "关"}`,
          );
          return this.pollResult(rid, progress, token);
        },
      );
      if (!result) return;

      const summary =
        `${verdictLabel(result.verdict)}（${result.verdict}）` +
        (result.score !== null ? ` · ${result.score} 分` : "") +
        (result.timeMs !== null ? ` · ${result.timeMs} ms` : "") +
        (result.memoryBytes !== null ? ` · ${(result.memoryBytes / 1024 / 1024).toFixed(1)} MB` : "");
      output.appendLine(`[结果] ${target} → ${summary}`);

      if (result.feedback.trim()) {
        output.appendLine(result.feedback.trim());
        if (result.verdict === "CE") output.show(true);
      }

      // 拿到 AC 就把这份代码快照进题解（快照而非引用源文件：
      // 之后继续改代码做变体，题解里留的仍是「当时 AC 的那份」）。
      // 写完后才弹通知 —— 这样「查看评测记录」按钮出来时题解已经更新好了。
      if (result.verdict === "AC") {
        await this.host.writeBanshuCode(ref.displayId, code);
      }

      const action = await vscode.window.showInformationMessage(`${target}：${summary}`, "查看评测记录");
      if (action === "查看评测记录") {
        await vscode.env.openExternal(vscode.Uri.parse(`https://www.luogu.com.cn/record/${rid}`));
      }
    } catch (e) {
      this.reportError("提交失败", e);
    } finally {
      this.submitting = false;
    }
  }

  private async pollResult(
    rid: number,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<LuoguResult | null> {
    const { pollIntervalMs, pollTimeoutMs } = submitConfig();
    const deadline = Date.now() + pollTimeoutMs;
    let waited = 0;
    /** 最后一次拿到的结果：超时兜底时用它，比只报「超时」有用 */
    let last: LuoguResult | null = null;

    // 先等一拍再查：刚提交时记录里还没有判定
    progress.report({ message: "已提交，等待评测…" });
    await this.wait(POLL_SETTLE_MS, token);

    while (Date.now() < deadline) {
      if (token.isCancellationRequested) {
        void vscode.window.showInformationMessage("已停止等待评测结果，可稍后到洛谷查看。");
        return null;
      }
      const res = await this.session.client.poll(rid);
      last = res;
      if (isFinalJudgeResult(res)) return res;
      if (res.done) {
        // 站点说「结束了」，但记录里还没有判定文本 —— 这是还没写回的中间态，
        // 直接报出去就是错判。继续等下一轮。
        output.appendLine(`[评测] 记录还没有最终判定（verdict=${res.rawStatus || "(空)"}），继续等待…`);
      } else if (waited === 0) {
        // 第一轮就没读到判定：把「读到什么」说明白。
        // 判定在 `record.status`（数字）；这一行是定位它的线索（配合上一条「诊断」）。
        output.appendLine(
          `[评测] 记录还没有终局判定（读到 status=${res.rawStatus || "(空)"}）——` +
            "若 status 不是已知的数字码，请看上一条「诊断」里的字段名。",
        );
      }
      waited += pollIntervalMs;
      progress.report({ message: `评测中… 已等待 ${Math.round(waited / 1000)} 秒` });
      await this.wait(pollIntervalMs, token);
    }
    // 超时收场：只有最后一次真的是「可交付的结果」才报出去。
    // 已知不准的那份（记录里还没有判定）宁可不报。
    if (last && isFinalJudgeResult(last)) {
      output.appendLine(`[评测] 轮询超时，返回最后一次结果（verdict=${last.rawStatus}）`);
      return last;
    }
    if (last) {
      output.appendLine(`[评测] 轮询超时，最后一次仍不是最终结果（verdict=${last.rawStatus || "(空)"}）`);
    }
    void vscode.window.showWarningMessage(
      `等待评测结果超时（${Math.round(pollTimeoutMs / 1000)} 秒），请到洛谷查看结果。`,
    );
    return null;
  }

  /**
   * 可取消的等待：取消时立刻返回，由调用方自己看 token 决定怎么收场。
   * 计时器与取消订阅都要清掉，别让每次提交往 token 上挂一堆回不去的监听。
   */
  private wait(ms: number, token: vscode.CancellationToken): Promise<void> {
    if (ms <= 0 || token.isCancellationRequested) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let sub: vscode.Disposable | undefined;
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        sub?.dispose();
        resolve();
      };
      timer = setTimeout(finish, ms);
      sub = token.onCancellationRequested(finish);
      // 极端情况：注册订阅的那一瞬间 token 已经取消（回调会同步进来，那时 sub 还没赋值）
      if (token.isCancellationRequested) finish();
    });
  }

  /**
   * 这份文件对应哪道题。
   *
   * 洛谷的题号就是站点主键，所以这里**不需要反查**——拿不到关联就按文件名当题号，
   * 再不行才提示用户先建题。爱思创那版要拿题库行 id，这里整段逻辑省掉了。
   */
  private resolveRef(file: string): ProblemRef | null {
    const ref = this.links.get(file);
    if (ref) return ref;
    const guessed = stemOf(path.basename(file));
    if (!/^[A-Za-z0-9_]+$/.test(guessed)) {
      void vscode.window.showErrorMessage(
        "这个文件没有关联题目，文件名也不是题号形态。请先「按题号创建」建立关联后再提交。",
      );
      return null;
    }
    void vscode.window.showWarningMessage(
      `这个文件还没建立题目关联，先按文件名把 ${guessed} 当作题号提交了。建议用「按题号创建」建一次关联，这样题名与难度也能显示出来。`,
    );
    return { displayId: guessed, title: "", difficulty: null };
  }
}