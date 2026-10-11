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

/** 题目目录：<root>/<题目根目录>/<题号>/ 。 */
export function problemDir(root: string, displayId: string): string {
  return path.join(root, problemsConfig().bankDir, displayId);
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

  const cppPath = path.join(dir, `${args.displayId}.cpp`);
  const reused = fs.existsSync(cppPath);
  if (!reused) {
    fs.writeFileSync(cppPath, args.code ?? cfg.codeTemplate, "utf8");
  }

  const sampleFiles: string[] = [];
  args.samples.forEach((s, i) => {
    const n = i + 1;
    const inFile = path.join(dir, `${args.displayId}_${n}.in`);
    const outFile = path.join(dir, `${args.displayId}_${n}.out`);
    // 有输入才写 .in（judge 以 .in 的存在为准发现样例），有输出才写 .out；
    // 只有输入的样例会被判为「仅运行」，正好对应站点样例输出为空的情形。
    if (s.input.trim() !== "") {
      if (writeFileIfAbsent(inFile, ensureTrailingNewline(s.input))) sampleFiles.push(inFile);
    }
    if (s.output.trim() !== "") {
      if (writeFileIfAbsent(outFile, ensureTrailingNewline(s.output))) sampleFiles.push(outFile);
    }
  });

  let mdPath: string | null = null;
  if (cfg.saveStatementAsMd && args.statement) {
    mdPath = path.join(dir, `${args.displayId}.md`);
    if (!fs.existsSync(mdPath)) {
      fs.writeFileSync(mdPath, statementToMarkdown(args.statement), "utf8");
    }
  }

  return { cppPath, dir, mdPath, sampleFiles, reused };
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}