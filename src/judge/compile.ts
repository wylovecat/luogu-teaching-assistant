import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { compileConfig, output } from "../config";
import { shortHash, stemOf } from "../util";

export interface CompileResult {
  ok: boolean;
  exe: string;
  /** 编译器的 stdout+stderr（出错时用来展示） */
  message: string;
  /** 这次编译花的时间（毫秒） */
  durationMs: number;
}

/** 缓存根目录：POSIX 用 ~/.cache，Windows 用 %LOCALAPPDATA%（缺省回落到家目录）。 */
export function cacheRoot(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local) return local;
  }
  return path.join(os.homedir(), ".cache");
}

/**
 * 编译产物放在缓存目录而不是源码目录旁边：学生的工作区往往被
 * 文件监视/同步工具盯着，往源目录丢可执行文件会污染题目文件夹。
 */
export function buildDir(sourcePath: string): string {
  const key = shortHash(path.dirname(path.resolve(sourcePath)));
  return path.join(cacheRoot(), "oi-assistant", "build", key);
}

/**
 * 可执行文件名。Windows 上必须带 .exe：MinGW 的 g++ 会自动补后缀生成
 * `A1131.exe`，而我们后续要用这个路径去 spawn，不能指望它替我们补。
 */
export function exeNameFor(stem: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `${stem}.exe` : stem;
}

export function exePathFor(sourcePath: string): string {
  return path.join(buildDir(sourcePath), exeNameFor(stemOf(path.basename(sourcePath))));
}

export function compile(sourcePath: string): Promise<CompileResult> {
  const { command, args } = compileConfig();
  const exe = exePathFor(sourcePath);
  const dir = path.dirname(exe);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return Promise.resolve({ ok: false, exe, message: `无法创建编译输出目录:${String(e)}`, durationMs: 0 });
  }

  const argv = [...args, "-o", exe, sourcePath];
  output.appendLine(`[编译] ${command} ${argv.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`);

  return new Promise<CompileResult>((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, argv, { cwd: path.dirname(sourcePath) });
    let buf = "";
    const cap = 1024 * 1024;
    const push = (s: string) => {
      if (buf.length < cap) buf += s;
    };
    child.stdout.on("data", (d: Buffer) => push(d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => push(d.toString("utf8")));
    child.on("error", (err) => {
      const durationMs = Date.now() - startedAt;
      output.appendLine(`[编译] 无法启动编译器（${durationMs} ms）：${err.message}`);
      resolve({
        ok: false,
        exe,
        message:
          `无法启动编译器「${command}」:${err.message}\n` +
          "请确认 g++ 已安装并在 PATH 中（Windows 上通常随 Dev-C++、MinGW-w64 或 MSYS2 提供），" +
          "或在设置 lgAssist.compile.command 里填写编译器的完整路径。",
        durationMs,
      });
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - startedAt;
      const text = buf.trim();
      if (code === 0) {
        output.appendLine(`[编译] 通过（${durationMs} ms）`);
        // 通过也可能有告警（-Wall），一并打进面板：diagnostics 会把它们做成问题条目
        if (text) dumpCompilerOutput(text);
        resolve({ ok: true, exe, message: text, durationMs });
      } else {
        output.appendLine(`[编译] 失败（退出码 ${code}，${durationMs} ms）`);
        if (text) dumpCompilerOutput(text);
        resolve({ ok: false, exe, message: text || `编译器退出码 ${code}`, durationMs });
      }
    });
  });
}

/**
 * 原样回显编译器输出：不加前缀，VSCode 才能把 `文件:行:列` 识别成可点击的链接。
 * 「问题」面板只收得下能定位到行列的诊断，链接器错误、头文件路径这类消息只在这里看得到。
 */
function dumpCompilerOutput(text: string): void {
  output.appendLine("[编译] ---- 编译器输出 ----");
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) output.appendLine(line);
  output.appendLine("[编译] ---- 输出结束 ----");
}
