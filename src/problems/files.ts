import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { problemsConfig } from "../config";
import type { Sample, Statement } from "./statement";
import { statementToMarkdown } from "./statement";

export interface CreatedProblem {
  cppPath: string;
  dir: string;
  mdPath: string | null;
  sampleFiles: string[];
  /** 是否复用了已存在的源文件（没有覆盖） */
  reused: boolean;
}

export function workspaceRoot(): string | null {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return null;
  return folders[0].uri.fsPath;
}

/**
 * 题目目录：<root>/<题目根目录>/<题号>/ 。
 *
 * 目录名必须清洗：题号来自用户的输入框（只挡了空白），`../foo` 这种题号
 * 会把目录写到题库外面一层去 —— 所有走 problemDir 的调用点（建题、白板、
 * 题解板书、封面）都在这里收口。
 */
export function problemDir(root: string, displayId: string): string {
  return path.join(root, problemsConfig().bankDir, sanitizeDirName(displayId));
}

/** 目录名里不能出现路径分隔符与控制字符。 */
export function sanitizeDirName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+$/, "_").trim() || "_";
}

function writeFileIfAbsent(file: string, content: string): boolean {
  if (fs.existsSync(file)) return false;
  fs.writeFileSync(file, content, "utf8");
  return true;
}

/**
 * 创建题目文件：源文件 + 样例文件（<题号>_N.in/.out）+（可选）题面 markdown。
 * 已存在的源文件不会被覆盖。
 */
export function createProblemFiles(args: {
  root: string;
  displayId: string;
  statement: Statement | null;
  samples: Sample[];
  code?: string;
}): CreatedProblem {
  const cfg = problemsConfig();
  const dir = problemDir(args.root, args.displayId);
  fs.mkdirSync(dir, { recursive: true });

  /*
   * 文件名也要过一遍清洗：题号是用户输入的，`../../evil` 拼成文件名后
   * `path.join(dir, "../../evil.cpp")` 照样能落到题库目录外面去。
   * 正常题号（P1001 / CF1A / AT_abc001_a）清洗后是恒等变换，不影响既有工作区。
   */
  const name = sanitizeDirName(args.displayId);

  const cppPath = path.join(dir, `${name}.cpp`);
  const reused = fs.existsSync(cppPath);
  if (!reused) {
    fs.writeFileSync(cppPath, args.code ?? cfg.codeTemplate, "utf8");
  }

  const sampleFiles: string[] = [];
  args.samples.forEach((s, i) => {
    const n = i + 1;
    const inFile = path.join(dir, `${name}_${n}.in`);
    const outFile = path.join(dir, `${name}_${n}.out`);
    // judge 以 .in 的存在为准发现样例（discoverSamples 只认 ^<题号>_(\d+)\.in$），
    // 所以「输入为空、输出非空」的样例也必须落一个 .in —— 内容是**空文件**（不是换行）。
    // 否则这种样例永远不会被评测，而洛谷题里「输出一个数字」的空输入样例真实存在。
    // 反过来 .out 缺失的语义是「只运行不判定」，要保留：输出为空就不写 .out。
    const hasInput = s.input.trim() !== "";
    const hasOutput = s.output.trim() !== "";
    if (hasInput || hasOutput) {
      if (writeFileIfAbsent(inFile, hasInput ? ensureTrailingNewline(s.input) : "")) sampleFiles.push(inFile);
    }
    if (hasOutput) {
      if (writeFileIfAbsent(outFile, ensureTrailingNewline(s.output))) sampleFiles.push(outFile);
    }
  });

  let mdPath: string | null = null;
  if (cfg.saveStatementAsMd && args.statement) {
    mdPath = path.join(dir, `${name}.md`);
    if (!fs.existsSync(mdPath)) {
      fs.writeFileSync(mdPath, statementToMarkdown(args.statement), "utf8");
    }
  }

  return { cppPath, dir, mdPath, sampleFiles, reused };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}