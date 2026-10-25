/**
 * 封面联动（BiliBiliHelper）：文件名与命令行的**纯逻辑**部分。
 *
 * 「联动」指的是：建题时调 `E:\BiliBiliHelper`（洛谷题解封面生成器）渲染一张封面，
 * 落到这道题的题解目录里（`<工作区>/<题目根目录>/<题号>/`），与 `.cpp`、样例、
 * `题解板书.typ` 同处。那边是 Python，走它自己的 CLI（`bili-helper cover <题号>`）。
 *
 * 分工：
 *
 *   | 文件 | 管什么 |
 *   | --- | --- |
 *   | `cover/spec.ts`（本文件） | 文件名怎么取、argv 怎么拼 —— 纯逻辑，不 import 'vscode' |
 *   | `cover/cli.ts` | 起进程、读输出、判有没有真的落盘 |
 *   | `app/cover.ts` | 编排：什么时候调、失败怎么报 |
 *
 * 不 import 'vscode' 是仓库的硬约定（见 AGENTS.md）：`test/cover.test.ts` 直接引它。
 */

import * as path from "node:path";

/** 封面文件名的默认模板。`${id}` 会换成题号。 */
export const DEFAULT_COVER_FILE = "${id} 封面.png";

/** 文件名里不能出现的字符；跨平台统一收紧，与 BiliBiliHelper 的 `safe_stem` 同一套。 */
const ILLEGAL_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/**
 * 把文件名收拾干净。
 *
 * 模板是**用户输入**（`lgAssist.cover.fileName`），所以不能直接往目录里拼：
 * 模板里写个 `../` 就写到题目录外去了。分隔符一律换成 `_`，前后空白与结尾的点也剥掉
 * （Windows 上结尾的点会让文件根本建不出来，且 `a.png` 与 `a.png.png` 会被当成同一个）。
 */
export function sanitizeCoverFileName(raw: string, fallback: string): string {
  const name = raw.replace(ILLEGAL_NAME_CHARS, "_").replace(/^[ .]+/, "").replace(/[ .]+$/, "");
  if (name === "" || name === "." || name === "..") return fallback;
  return name;
}

/**
 * 封面文件名：`<题号> 封面.png`（默认），与题解目录里既有的 `<题号> 板书.png` 同一套命名，
 * 一眼能看出这一堆文件属于同一道题。
 */
export function coverFileName(template: string, displayId: string): string {
  const t = (template ?? "").trim() || DEFAULT_COVER_FILE;
  const fallback = `${displayId} 封面.png`;
  return sanitizeCoverFileName(t.replace(/\$\{id\}/g, displayId), fallback);
}

/** 一次渲染要做的事（题号 + 落盘位置 + 覆盖项）。 */
export interface CoverSpec {
  /** 传给 bili-helper 的题号（位置参数）。它自己会去洛谷拉题名/赛事/标签/难度。 */
  problemId: string;
  /** 题解目录（封面落在它的下面）。 */
  dir: string;
  /** 文件名模板里用的题号；一般与 `problemId` 相同，以站点返回的规范题号为稳。 */
  displayId: string;
  /**
   * 封面**设计**模板（series / dark-tech / minimal），对应 `--template`。
   * 别和 `fileTemplate` 搞混 —— 这两个都是「模板」，但一个是画面长什么样、
   * 一个是文件叫什么名（曾经合用一个字段，结果换模板会连文件名一起变）。
   */
  template: string;
  /** 文件名模板（`${id} 封面.png`）。 */
  fileTemplate: string;
  /** 配色（blue / purple / warm / dark）；留空 = 用对面的默认。 */
  palette: string;
  size: string;
  /** 追加到命令行末尾的原始参数（如 `--ai-bg`）。放最后，同名的后出现的胜出。 */
  extraArgs: string[];
}

/** 封面的完整落盘路径：`<题解目录>/<题号> 封面.png`。 */
export function coverOutPath(spec: CoverSpec): string {
  return path.join(spec.dir, coverFileName(spec.fileTemplate, spec.displayId));
}

/**
 * 拼 `bili-helper` 的参数（不含命令前缀本身）。
 *
 * 空串的覆盖项**不往下传**：`--template ""` 会被 argparse 当成一个空字符串模板，
 * 而「不传」才是「用配置里的默认值」。这两件事在 BiliBiliHelper 那边是不同结果。
 */
export function buildCoverArgv(spec: CoverSpec): string[] {
  const argv = ["cover", spec.problemId, "-o", coverOutPath(spec)];
  if (spec.template.trim()) argv.push("--template", spec.template.trim());
  if (spec.palette.trim()) argv.push("--palette", spec.palette.trim());
  if (spec.size.trim()) argv.push("--size", spec.size.trim());
  for (const extra of spec.extraArgs ?? []) {
    if (extra.trim() !== "") argv.push(extra);
  }
  return argv;
}

/** 怎么把 bili-helper 叫起来（对应 `lgAssist.cover.*` 里那几个设置）。 */
export interface CoverTool {
  /** 可执行文件；默认 `bili-helper`。 */
  command: string;
  /** 命令前缀参数（如 `["-m", "bili_assistant.cli"]`，配合 `projectDir` 用源码跑）。 */
  args: string[];
  /** 进程工作目录。用 `python -m bili_assistant.cli` 时**必须**是 BiliBiliHelper 项目根。 */
  projectDir: string;
  timeoutMs: number;
}

export interface CoverInvocation {
  command: string;
  args: string[];
  cwd?: string;
  timeoutMs: number;
}

/**
 * 把「怎么叫」与「要渲染什么」合成一次进程调用。
 *
 * `cwd` 只在 `projectDir` 非空时给：`python -m bili_assistant.cli` 必须在项目根下跑，
 * 否则 `import bili_assistant` 直接 ModuleNotFoundError（2026-10-12 实测）。
 * 用装着 console script 的 venv（`bili-helper.exe`）时不需要它。
 */
export function coverInvocation(tool: CoverTool, spec: CoverSpec): CoverInvocation {
  return {
    command: tool.command.trim() || "bili-helper",
    args: [...(tool.args ?? []), ...buildCoverArgv(spec)],
    cwd: tool.projectDir.trim() || undefined,
    timeoutMs: tool.timeoutMs,
  };
}
