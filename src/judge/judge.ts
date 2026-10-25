import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { judgeConfig } from "../config";
import { compile, type CompileResult } from "./compile";
import { normalizeOutput, outputsEqual, shortHash, stemOf } from "../util";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  spawnError?: string;
}

export interface RunOptions {
  input?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  cwd?: string;
}

/**
 * 运行一个进程，喂 stdin、限时、限输出量。
 * 必须边跑边抽干 stdout/stderr —— 管道缓冲区（约 64KB）写满后子进程会阻塞，
 * 那种情况下“超时”是假象，把输出读干净才是对的。
 */
export function runProcess(exe: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? judgeConfig().timeoutMs;
  const maxOut = opts.maxOutputBytes ?? judgeConfig().maxOutputBytes;
  const start = Date.now();

  return new Promise<RunResult>((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { cwd: opts.cwd });
    } catch (e) {
      resolve({
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        timedOut: false,
        truncated: false,
        durationMs: 0,
        spawnError: String(e),
      });
      return;
    }

    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    // maxOutputBytes 的单位是字节，所以这里也按字节截断；解码交给 StringDecoder —— 逐 chunk
    // 直接 toString 会把恰好被切开的多字节字符（中文输出很常见）解成 U+FFFD。
    const outDecoder = new StringDecoder("utf8");
    const errDecoder = new StringDecoder("utf8");
    const flushDecoders = () => {
      stdout += outDecoder.end();
      stderr += errDecoder.end();
    };

    const collect = (chunk: Buffer, sink: "out" | "err") => {
      const remain = maxOut - outBytes;
      if (remain <= 0) {
        truncated = true;
        return;
      }
      const buf = chunk.length > remain ? chunk.subarray(0, remain) : chunk;
      if (buf.length < chunk.length) truncated = true;
      outBytes += buf.length;
      const text = (sink === "out" ? outDecoder : errDecoder).write(buf);
      if (sink === "out") stdout += text;
      else stderr += text;
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // 进程可能已退出
      }
    }, Math.max(1, timeoutMs));

    child.stdout.on("data", (d: Buffer) => collect(d, "out"));
    child.stderr.on("data", (d: Buffer) => collect(d, "err"));

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      flushDecoders();
      resolve({
        stdout,
        stderr,
        exitCode: null,
        signal: null,
        timedOut,
        truncated,
        durationMs: Date.now() - start,
        spawnError: err.message,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      flushDecoders();
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal ?? null,
        timedOut,
        truncated,
        durationMs: Date.now() - start,
      });
    });

    if (opts.input !== undefined) {
      child.stdin.on("error", () => {
        // 程序可能在读完输入前就退出了（EPIPE），忽略即可
      });
      child.stdin.end(opts.input);
    } else {
      child.stdin.end();
    }
  });
}

export type CaseStatus = "AC" | "WA" | "TLE" | "RE" | "NO_OUT" | "NO_EXPECTED";

export interface SampleCase {
  index: number;
  inputFile: string;
  outputFile: string | null;
}

export interface CaseResult extends SampleCase {
  status: CaseStatus;
  input: string;
  expected: string | null;
  actual: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  expectedNormalized: string | null;
  actualNormalized: string;
}

export interface JudgeReport {
  compile: CompileResult;
  cases: CaseResult[];
  sourcePath: string;
  /** 是否一个样例文件都没找到 */
  noSamples: boolean;
  /**
   * 被评测的源文件内容哈希（编译前算的）。
   * 提交时拿它和磁盘上的当前内容比对，一致就说明代码没改过、不必再编译一次。
   */
  sourceHash: string;
}

/** 源文件内容的短哈希；读不到文件时返回空串（调用方据此判定「无法认定为已编译」）。 */
export function hashOfFile(sourcePath: string): string {
  try {
    return shortHash(fs.readFileSync(sourcePath, "utf8"));
  } catch {
    return "";
  }
}

/**
 * 找同目录下的样例文件：`A.cpp` ↔ `A_1.in` / `A_1.out`，按序号数值排序。
 * `.out` 缺失时该样例只运行不判定（视为交互/仅运行用例）。
 */
export function discoverSamples(sourcePath: string): SampleCase[] {
  const dir = path.dirname(sourcePath);
  const stem = stemOf(path.basename(sourcePath));
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const re = new RegExp(`^${escapeRegExp(stem)}_(\\d+)\\.in$`, "i");
  const found: Array<{ n: number; inputFile: string; outputFile: string | null }> = [];
  for (const name of entries) {
    const m = re.exec(name);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const outName = entries.find((e) => e.toLowerCase() === `${stem}_${n}.out`.toLowerCase());
    found.push({
      n,
      inputFile: path.join(dir, name),
      outputFile: outName ? path.join(dir, outName) : null,
    });
  }
  found.sort((a, b) => a.n - b.n);
  return found.map((f, i) => ({ index: i + 1, inputFile: f.inputFile, outputFile: f.outputFile }));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 编译 + 跑全部样例。样例为空时 noSamples=true，调用方转终端交互运行。 */
export async function judgeFile(sourcePath: string): Promise<JudgeReport> {
  const sourceHash = hashOfFile(sourcePath);
  const compiled = await compile(sourcePath);
  if (!compiled.ok) {
    return { compile: compiled, cases: [], sourcePath, noSamples: false, sourceHash };
  }
  const samples = discoverSamples(sourcePath);
  if (samples.length === 0) {
    return { compile: compiled, cases: [], sourcePath, noSamples: true, sourceHash };
  }
  const cases: CaseResult[] = await mapBounded(samples, judgeConcurrency(), (s) => runCase(compiled.exe, s));
  return { compile: compiled, cases, sourcePath, noSamples: false, sourceHash };
}

/**
 * 同时跑几个样例。
 *
 * 串行时等待时间是**按样例数线性放大**的：默认限时 10 秒（`judge.timeoutMs`），
 * 学生写出死循环、一道 10 个样例的题点一次「重新评测」要等 100 秒 —— 而他改一版就是一次。
 * 这是本地评测里最容易被感觉到的一段，所以把它压成几批。
 *
 * 上限取 `核数 - 1` 且封顶 4：留一格给编辑器与宿主进程，全占满会让界面卡顿（老师正在讲题）；
 * 封顶是因为再多也只是让每个进程分到的时间片更少，`durationMs` 会一起虚高。
 * 单核机器（精简虚拟机 / 部分 CI 容器）上退化成 1，也就是原来的串行行为。
 *
 * 参数化 `cpus` 而不是直接读 `os.cpus()`：跟 `cacheRoot(platform)` / `exeNameFor(stem)` 同一套约定，
 * 测试要能显式传值，不依赖跑测试那台机器的核数。
 */
export function judgeConcurrency(cpus: number = os.cpus().length): number {
  return Math.max(1, Math.min(4, Math.floor(cpus) - 1));
}

/**
 * 有界并发地跑一批异步任务，**结果按输入顺序回填**。
 *
 * 顺序这一条是硬要求：`CaseResult.index` 与面板上的样例编号都靠它，
 * 并发完成顺序不同 ≠ 展示顺序可以乱。
 *
 * 单独抽出来是因为「并发度有界」和「顺序不乱」这两条都得有测试盯着，而拿真实编译产物
 * 去测时序在 CI 上会飘；用小任务加计数器就能确定性地钉住。
 */
export async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      // 取号是同步自增，单线程的事件循环里不会有两个 worker 拿到同一个 i
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function runCase(exe: string, sample: SampleCase): Promise<CaseResult> {
  const cfg = judgeConfig();
  let input = "";
  try {
    input = fs.readFileSync(sample.inputFile, "utf8");
  } catch {
    input = "";
  }
  let expected: string | null = null;
  if (sample.outputFile) {
    try {
      expected = fs.readFileSync(sample.outputFile, "utf8");
    } catch {
      expected = null;
    }
  }

  const run = await runProcess(exe, [], {
    input,
    timeoutMs: cfg.timeoutMs,
    maxOutputBytes: cfg.maxOutputBytes,
    cwd: path.dirname(exe),
  });

  let status: CaseStatus;
  if (run.timedOut) status = "TLE";
  else if (run.spawnError || (run.exitCode !== 0 && run.exitCode !== null)) status = "RE";
  else if (expected === null) status = "NO_EXPECTED";
  else if (outputsEqual(run.stdout, expected)) status = "AC";
  else status = "WA";

  return {
    ...sample,
    status,
    input,
    expected,
    actual: run.stdout,
    stderr: run.stderr,
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    truncated: run.truncated,
    durationMs: run.durationMs,
    expectedNormalized: expected === null ? null : normalizeOutput(expected),
    actualNormalized: normalizeOutput(run.stdout),
  };
}

export function statusText(status: CaseStatus): string {
  switch (status) {
    case "AC":
      return "通过";
    case "WA":
      return "答案错误";
    case "TLE":
      return "超时";
    case "RE":
      return "运行错误";
    case "NO_OUT":
      return "缺少输出";
    case "NO_EXPECTED":
      return "仅运行（无期望输出）";
  }
}
