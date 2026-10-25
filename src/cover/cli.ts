/**
 * 调 BiliBiliHelper 的 CLI 渲染一张封面。
 *
 * **不 import 'vscode'**（仓库对纯逻辑模块的约定，`test/cover.test.ts` 直接引）。
 * 用 `execFile` 而不是 `exec`：参数直接交给进程、不过 shell，路径里的空格与中文
 * （`题库/P1001 题目/P1001 封面.png`）不会被拆开 —— 2026-10-12 真机跑通。
 *
 * ⚠️ 两条真机踩出来的坑（改这个文件前先读）：
 *
 * 1. **必须给子进程 `PYTHONIOENCODING=utf-8`**。Windows 上 Python 的 stdout 走管道时按
 *    本地代码页（中文系统 cp936）编码，我们按 utf8 读就是乱码：`[ok] 已生成封面：…`
 *    会变成 `[ok] �����ɷ��棺…`。图其实已经出来了，但日志里看着像失败 —— 这种
 *    「报错指向错的地方」最费时间。CLI 自己只 `reconfigure(errors="replace")`，
 *    不动编码，所以只能由调用方指定。
 * 2. **`python -m bili_assistant.cli` 需要 cwd 在 BiliBiliHelper 项目根**，否则
 *    `ModuleNotFoundError: No module named 'bili_assistant'`。cwd 来自
 *    `lgAssist.cover.projectDir`（见 `cover/spec.ts` 的 `coverInvocation`）。
 */

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

export interface CoverResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** 期望产出的封面路径 */
  imagePath: string;
  /** 封面是否真的落盘了 —— 退出码为 0 不等于文件在（别只信 `ok`） */
  imageWritten: boolean;
}

/** 叫不起 bili-helper 时抛这个，调用方据此给出「装/配路径」的提示，而不是当成渲染失败。 */
export class CoverToolNotFoundError extends Error {
  constructor(
    readonly command: string,
    cause?: unknown,
  ) {
    super(
      `找不到封面生成命令「${command}」。它来自 BiliBiliHelper：先用 ` +
        "`pip install -e .` 装好，然后在设置里配 `lgAssist.cover.command`（可执行文件，" +
        "如 <venv>\\Scripts\\bili-helper.exe），或用 `lgAssist.cover.args` = " +
        '["-m", "bili_assistant.cli"] 配 `lgAssist.cover.projectDir` = BiliBiliHelper 项目根' +
        "（用 python 跑源码）。不需要这个功能就把 `lgAssist.cover.enabled` 关掉。",
      { cause },
    );
    this.name = "CoverToolNotFoundError";
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
 * 渲染一张封面到 `imagePath`。
 *
 * 不碰磁盘上的其它东西，也不去猜输出名 —— 命令行里 `-o` 给的就是期望路径，渲染完只确认它
 * 在不在。BiliBiliHelper 的 `cover` 子命令不写侧车 JSON（只有 `batch` 写），所以产物
 * 就是一张 PNG。
 */
export async function renderCover(args: {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
  imagePath: string;
}): Promise<CoverResult> {
  const run = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      args.command,
      args.args,
      {
        cwd: args.cwd,
        timeout: args.timeoutMs ?? 120000,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "utf8",
        // 见文件头第 1 条：不加这个，中文日志在 Windows 上必乱码
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
      },
      (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        // 命令本身没找到 → 交给调用方提示「装/配路径」，不算渲染失败
        if (e && (e.code === "ENOENT" || e.code === "EACCES" || e.code === "EINVAL")) {
          reject(new CoverToolNotFoundError(args.command, e));
          return;
        }
        resolve({ ok: !e, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });

  return {
    ...run,
    imagePath: args.imagePath,
    imageWritten: await fileExists(args.imagePath),
  };
}

/**
 * 失败时给用户看的文案。
 *
 * 退出码非 0 且没有任何输出时，最可能的是「命令找到了、但它自己起不来」——
 * 比如 Playwright 的 chromium 没装（`python -m playwright install chromium`）。
 * 这种话 CLI 一个字都不会打，只能由这里补上，否则用户只看到「失败」两个字。
 */
export function coverFailureMessage(r: CoverResult): string {
  const detail = (r.stderr || r.stdout).trim();
  if (detail !== "") return detail;
  return (
    "封面命令没有输出任何信息就失败了。最常见的原因是 BiliBiliHelper 缺 Playwright 浏览器：" +
    "在它的项目目录里跑 `python -m playwright install chromium` 再试。"
  );
}
