/**
 * 把编译器输出解析成结构化诊断（位置 + 级别 + 正文）。
 *
 * 只认 GCC / Clang 的 `文件:行:列: 级别: 信息` 形态，中英文 locale 都认
 * （`error:` / `错误：`）。解析不出来的行不会丢——它们仍然原样进输出面板，
 * 所以这个函数只负责「能不能定位到行列」，不负责兜底展示。
 *
 * 这里不要 import 'vscode'：test/diagnostics.test.ts 直接引用本文件。
 */
import * as path from "node:path";

export type CompileSeverity = "error" | "warning" | "note";

export interface CompileDiagnostic {
  severity: CompileSeverity;
  /** 源文件绝对路径（报错里的相对路径按编译时的 cwd 解析） */
  file: string;
  /** 1 起；定位不到时为 null，例如链接器错误 */
  line: number | null;
  /** 1 起；编译器没给列号时为 null */
  column: number | null;
  /** 报错正文（不含位置前缀） */
  message: string;
  /** 原始整行，供输出面板与面板展示 */
  raw: string;
}

const SEV = "(?:fatal error|error|warning|note|致命错误|错误|警告|提示|注意)";
/** 文件:行:列: 级别: 正文 */
const LOCATED = new RegExp(`^(.+?):(\\d+):(\\d+):\\s*(${SEV})\\s*[:：]\\s*(.*)$`, "i");
/** 文件:行: 级别: 正文（少数告警没有列号） */
const LOCATED_NO_COL = new RegExp(`^(.+?):(\\d+):\\s*(${SEV})\\s*[:：]\\s*(.*)$`, "i");
/** 级别: 正文，或 程序名: 级别: 正文（如 `collect2: error: ld returned 1 exit status`） */
const UNLOCATED = new RegExp(`^(?:(.+?):\\s*)?(${SEV})\\s*[:：]\\s*(.*)$`, "i");
/** gcc/clang 紧跟报错的源码片段与 `^~~` 指示行：`    6 |     int x = 0;`、`      |   ^` */
const SOURCE_SNIPPET = /^\s*(?:\d+\s*)?\|/;

const SEVERITY_OF: Record<string, CompileSeverity> = {
  "fatal error": "error",
  error: "error",
  致命错误: "error",
  错误: "error",
  warning: "warning",
  警告: "warning",
  note: "note",
  提示: "note",
  注意: "note",
};

function severityOf(word: string): CompileSeverity {
  return SEVERITY_OF[word.toLowerCase()] ?? "note";
}

function resolveFile(reported: string, cwd: string): string {
  const p = reported.trim();
  // 盘符路径在 POSIX 上不算绝对路径，但报错里出现它就说明是 Windows 编译器的输出，原样留着
  if (path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p)) return p;
  return path.resolve(cwd, p);
}

export function parseCompileDiagnostics(
  text: string,
  opts: { cwd: string; fallbackFile: string },
): CompileDiagnostic[] {
  const out: CompileDiagnostic[] = [];
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (line.trim() === "" || SOURCE_SNIPPET.test(line)) continue;

    const located = LOCATED.exec(line);
    if (located) {
      out.push({
        severity: severityOf(located[4]),
        file: resolveFile(located[1], opts.cwd),
        line: parseInt(located[2], 10),
        column: parseInt(located[3], 10),
        message: located[5].trim(),
        raw: line,
      });
      continue;
    }

    const noCol = LOCATED_NO_COL.exec(line);
    if (noCol) {
      out.push({
        severity: severityOf(noCol[3]),
        file: resolveFile(noCol[1], opts.cwd),
        line: parseInt(noCol[2], 10),
        column: null,
        message: noCol[4].trim(),
        raw: line,
      });
      continue;
    }

    const unlocated = UNLOCATED.exec(line);
    if (unlocated) {
      const prefix = unlocated[1]?.trim();
      out.push({
        severity: severityOf(unlocated[2]),
        file: opts.fallbackFile,
        line: null,
        column: null,
        message: prefix ? `${prefix}: ${unlocated[3].trim()}` : unlocated[3].trim(),
        raw: line,
      });
    }
  }
  return out;
}

/** `A1131.cpp:6:5: expected initializer before 'int'`；没有位置时只有正文。 */
export function describeDiagnostic(d: CompileDiagnostic): string {
  if (d.line === null) return d.message;
  const at = `${path.basename(d.file)}:${d.line}${d.column === null ? "" : `:${d.column}`}`;
  return `${at}: ${d.message}`;
}

/** 提示条里能塞下的第一条错误（优先 error，其次第一条）。 */
export function firstDiagnosticText(diags: CompileDiagnostic[]): string | null {
  const d = diags.find((x) => x.severity === "error") ?? diags[0];
  if (!d) return null;
  const text = describeDiagnostic(d);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

/** `2 个错误、1 个警告`；什么都没有时给「编译失败」。 */
export function summarizeDiagnostics(diags: CompileDiagnostic[]): string {
  const errors = diags.filter((d) => d.severity === "error").length;
  const warnings = diags.filter((d) => d.severity === "warning").length;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} 个错误`);
  if (warnings) parts.push(`${warnings} 个警告`);
  return parts.length ? parts.join("、") : "编译失败";
}
