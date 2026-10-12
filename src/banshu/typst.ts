/**
 * 调 typst CLI 把题解编译成 PDF。
 *
 * **不 import 'vscode'** —— 这样单测可以直接引（仓库对纯逻辑模块的约定）。
 * 进程调用用 `execFile`（不是 `exec`）：参数直接传给进程、不过 shell，
 * 路径里有空格或中文都不会被拆开 —— 题目目录名恰好两者都有
 * （`题库/P1395 会议/题解板书.typ`）。
 *
 * ⚠️ **必须带 `--root <题库根>`**：题解文档用 `#import "../banshuconf.typ"` 引共享版式，
 * 而 Typst 默认把「被编译文件所在目录」当项目根，跨目录读会被判
 * `would escape the project root` 直接报错（2026-10-12 实测）。
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

export interface TypstResult {
  ok: boolean;
  /** typst 的标准输出（正常时基本为空） */
  stdout: string;
  /** 标准错误 —— 编译失败时**报错正文都在这里** */
  stderr: string;
  /** 期望产出的 PDF 路径 */
  pdfPath: string;
  /** PDF 是否真的落盘了 */
  pdfWritten: boolean;
}

/** 找不到 typst 时抛这个，调用方据此给出「安装或配置路径」的提示。 */
export class TypstNotFoundError extends Error {
  constructor(
    readonly typstPath: string,
    cause?: unknown,
  ) {
    super(
      `找不到 typst 命令（试的是「${typstPath}」）。导出题解 PDF 需要它：` +
        "装好 typst 后如果不在 PATH 里，请在设置 `lgAssist.banshu.typstPath` 填完整路径。",
      { cause },
    );
    this.name = "TypstNotFoundError";
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 编译一个 typst 文件成 PDF。
 *
 * @param rootDir Typst 的项目根（`--root`）。传题库根目录，共享版式才读得到。
 */
export async function compileTypst(args: {
  typstPath: string;
  docPath: string;
  pdfPath: string;
  rootDir: string;
  timeoutMs?: number;
}): Promise<TypstResult> {
  const argv = ["compile", args.docPath, args.pdfPath, "--root", args.rootDir];
  const run = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      args.typstPath,
      argv,
      {
        timeout: args.timeoutMs ?? 120000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        // 命令本身没找到 → 交给调用方提示安装，不算「编译失败」
        if (e && (e.code === "ENOENT" || e.code === "EACCES")) {
          reject(new TypstNotFoundError(args.typstPath, e));
          return;
        }
        resolve({ ok: !e, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

  return { ...run, pdfPath: args.pdfPath, pdfWritten: await fileExists(args.pdfPath) };
}

/** 编译失败时给用户看的文案：优先工具原文（含出错文件与行号），其次兜底。 */
export function typstFailureMessage(r: TypstResult): string {
  const detail = (r.stderr || r.stdout).trim();
  return detail === "" ? "typst 编译失败，但它没有输出任何错误信息" : detail;
}
