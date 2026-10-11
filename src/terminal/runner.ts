import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { terminalConfig } from "../config";

const IS_WINDOWS = process.platform === "win32";

/** 用单引号包裹 shell 参数（POSIX）。 */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * 用双引号包裹 cmd.exe 参数。Windows 文件名里不会出现 `"`，所以不必处理引号
 * 转义；只有两处要照顾：含空格/cmd 元字符时加引号，以及结尾的反斜杠
 * （`"C:\dir\"` 会被解析成 `C:\dir"`，补一个反斜杠才对）。
 */
export function cmdQuote(s: string): string {
  let out = s;
  if (out.endsWith("\\")) out += "\\";
  const needs = out === "" || out !== s || /[\s&()^|<>]/.test(out);
  return needs ? `"${out}"` : out;
}

/**
 * 把模板里的占位符替换成实际路径。模板里出现的裸路径一律由调用方负责
 * 加引号（我们用 ${exe}/${dir}/${file}），quote 按平台传 shellQuote / cmdQuote。
 */
export function fillExternalTemplate(
  template: string,
  exe: string,
  dir: string,
  file: string,
  quote: (s: string) => string = shellQuote,
): string {
  return template
    .replace(/\$\{exe\}/g, quote(exe))
    .replace(/\$\{dir\}/g, quote(dir))
    .replace(/\$\{file\}/g, quote(file));
}

/** 已知外置终端 → 启动命令模板（POSIX）。 */
const KNOWN_TERMINALS: Array<{ names: string[]; template: string }> = [
  {
    names: ["gnome-terminal"],
    template: "gnome-terminal --wait -- bash -lc 'cd ${dir} && {EXE}; echo; read -n1 -p \"按任意键关闭…\"'",
  },
  {
    names: ["konsole"],
    template: "konsole -e bash -lc 'cd ${dir} && {EXE}; echo; read -n1 -p \"按任意键关闭…\"'",
  },
  {
    names: ["xfce4-terminal"],
    template: "xfce4-terminal --hold -e \"bash -lc 'cd ${dir} && {EXE}'\"",
  },
  {
    names: ["kitty"],
    template: "kitty --hold bash -lc 'cd ${dir} && {EXE}'",
  },
  {
    names: ["alacritty"],
    template: "alacritty --hold -e bash -lc 'cd ${dir} && {EXE}'",
  },
  {
    names: ["wezterm"],
    template: "wezterm start --cwd ${dir} -- bash -lc '{EXE}; echo; read -n1'",
  },
  {
    names: ["xterm"],
    template: "xterm -hold -e bash -lc 'cd ${dir} && {EXE}'",
  },
  {
    names: ["deepin-terminal"],
    template: "deepin-terminal -e \"bash -lc 'cd ${dir} && {EXE}; echo; read -n1'\"",
  },
];

/**
 * 探测可用的外置终端，返回其命令模板（含 {EXE} 占位，调用方替换为
 * 实际执行命令）。找不到返回 null。
 *
 * 仅用于 POSIX：Windows 上各终端的命令行规则互不兼容（Windows Terminal 会把
 * 参数重新拼成命令行，cmd /k 又会剥引号），所以那边走 buildWindowsCommand 的
 * 内置配方，不去探测。
 * 结果按平台缓存：一次探测要遍历 PATH 的每个目录 × 每个候选终端名（同步 accessSync，
 * 几十上百次系统调用），而 PATH 在会话内基本不变 —— 每次运行都重扫属白费。
 */
const externalTemplateCache = new Map<NodeJS.Platform, string | null>();

export function detectExternalTemplate(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") return null;
  const cached = externalTemplateCache.get(platform);
  if (cached !== undefined) return cached;
  for (const entry of KNOWN_TERMINALS) {
    for (const name of entry.names) {
      for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
        if (!dir) continue;
        try {
          fs.accessSync(path.join(dir, name), fs.constants.X_OK);
          externalTemplateCache.set(platform, entry.template);
          return entry.template;
        } catch {
          // 继续找
        }
      }
    }
  }
  externalTemplateCache.set(platform, null);
  return null;
}

export interface ExternalLaunch {
  /** 要执行的命令行 */
  command: string;
  /** 非 null 表示用 `shell -lc command` 启动（POSIX）；null 表示整条命令行交给平台解释器（Windows → cmd /d /s /c） */
  shell: string | null;
}

/**
 * Windows 外置终端：用 cmd 的 `start` 新开一个控制台窗口。
 *
 * 这里是纯 cmd 语法，外层由 node 自己拼 `cmd /d /s /c "…"`（/S 会剥掉最外层
 * 那一对引号，所以整串不会被撕碎）。内层 `cmd /k` 的载荷若以引号开头，必须再包
 * 一层：cmd 会把最外层的第一个和最后一个引号剥掉，只剩中间的 `"exe" < "in"`
 * 才是我们想要的。
 */
export function buildWindowsCommand(exe: string, dir: string, opts: { inputFile?: string; keepOpen: boolean }): string {
  let payload = cmdQuote(exe);
  if (opts.inputFile) payload += ` < ${cmdQuote(opts.inputFile)}`;
  const switchArg = opts.keepOpen ? "/k" : "/c";
  const inner = payload.includes('"') ? `cmd ${switchArg} "${payload}"` : `cmd ${switchArg} ${payload}`;
  // start 的第一个带引号的参数是窗口标题；/D 指定新窗口的工作目录。
  return `start "OI运行" /D ${cmdQuote(dir)} ${inner}`;
}

/**
 * 构造外置终端的启动方式。config 里给了模板就按它填 ${exe}/${dir}/${file}；
 * 否则用探测到的终端（POSIX）或内置的 cmd start 配方（Windows）。
 */
export function buildExternalLaunch(
  exe: string,
  dir: string,
  file: string,
  opts: { inputFile?: string; keepOpen?: boolean } = {},
  platform: NodeJS.Platform = process.platform,
): ExternalLaunch {
  const c = terminalConfig();
  const keepOpen = opts.keepOpen ?? c.keepOpen;
  const custom = c.externalCommand.trim();

  if (platform === "win32") {
    if (custom) {
      // 自定义模板在 Windows 上按 cmd 语法解释，占位符用双引号包裹。
      return { command: fillExternalTemplate(custom, exe, dir, file, cmdQuote), shell: null };
    }
    return { command: buildWindowsCommand(exe, dir, { inputFile: opts.inputFile, keepOpen }), shell: null };
  }

  if (custom) {
    // 用户模板：先把 ${exe}/${dir}/${file} 换成带引号的真实路径
    const filled = fillExternalTemplate(custom, exe, dir, file);
    return { command: injectInput(filled, exe, opts.inputFile), shell: "/bin/bash" };
  }
  const detected = detectExternalTemplate(platform);
  if (!detected) {
    throw new Error(
      "未检测到可用的外置终端。请在设置 lgAssist.terminal.externalCommand 中填写终端启动命令，" +
        "或把 lgAssist.terminal.mode 改为 integrated。",
    );
  }
  const execCmd = keepOpen ? `"${exe}"; echo; read -n1 -p "按任意键关闭…"` : `"${exe}"`;
  const filled = detected
    .replace(/\{EXE\}/g, execCmd)
    .replace(/\$\{dir\}/g, shellQuote(dir))
    .replace(/\$\{exe\}/g, shellQuote(exe));
  return { command: injectInput(filled, exe, opts.inputFile), shell: "/bin/bash" };
}

/**
 * 外部终端输入重定向：模板里的可执行文件已被 shellQuote 或双引号包裹，
 * 把第一次出现的那处替换成 `'exe' < 'input'` 即可。
 */
function injectInput(command: string, exe: string, inputFile?: string): string {
  if (!inputFile) return command;
  const quoted = shellQuote(exe);
  if (command.includes(quoted)) return command.replace(quoted, `${quoted} < ${shellQuote(inputFile)}`);
  if (command.includes(`"${exe}"`)) return command.replace(`"${exe}"`, `"${exe}" < "${inputFile}"`);
  return command;
}

/** VSCode 集成终端默认 shell 的路径；拿不到（例如测试桩）时返回空串。 */
function integratedShellPath(): string {
  try {
    return vscode.env?.shell ?? "";
  } catch {
    return "";
  }
}

/** 是否是 cmd.exe。用 path.win32 解析，测试在 Linux 上也能判 Windows 路径。 */
export function isCmdShell(shellPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== "win32") return false;
  const name = path.win32.basename(shellPath.trim()).toLowerCase();
  return name === "cmd" || name === "cmd.exe";
}

/** 集成终端里的清屏命令：cmd 只认 cls，PowerShell 与 bash 都认 clear。 */
export function clearCommand(shellPath: string, platform: NodeJS.Platform = process.platform): string {
  return isCmdShell(shellPath, platform) ? "cls" : "clear";
}

/** 连写「运行完关掉终端」的分隔符：cmd 用 &，PowerShell / POSIX 用 ; */
export function exitSuffix(shellPath: string, platform: NodeJS.Platform = process.platform): string {
  return isCmdShell(shellPath, platform) ? " & exit" : "; exit";
}

let integratedCounter = 0;

/**
 * 在集成终端里运行可执行文件（可选重定向输入文件）。
 *
 * Windows 上带输入重定向时固定用 cmd 开这个终端：PowerShell 不支持 `<`
 * 重定向，而绕过它的写法（嵌套 `cmd /c "…"`、`--%`）在引号规则上都不牢靠。
 */
export function runInIntegratedTerminal(exe: string, cwd: string, opts: { inputFile?: string; title?: string } = {}): void {
  const c = terminalConfig();
  const forceCmd = IS_WINDOWS && !!opts.inputFile;
  const shellPath = forceCmd ? process.env.ComSpec || "cmd.exe" : integratedShellPath();
  const term = vscode.window.createTerminal({
    name: opts.title ?? `OI运行 ${++integratedCounter}`,
    cwd,
    iconPath: new vscode.ThemeIcon("play"),
    ...(forceCmd ? { shellPath } : {}),
  });
  term.show(true);
  if (c.clearBeforeRun) term.sendText(clearCommand(shellPath));
  const cmd = opts.inputFile ? `"${exe}" < "${opts.inputFile}"` : `"${exe}"`;
  term.sendText(c.keepOpen ? cmd : cmd + exitSuffix(shellPath));
}

/** 在外部终端里运行可执行文件。 */
export function runInExternalTerminal(exe: string, cwd: string, options: { inputFile?: string } = {}): void {
  const launch = buildExternalLaunch(exe, cwd, exe, { inputFile: options.inputFile });
  if (launch.shell) {
    spawn(launch.shell, ["-lc", launch.command], { detached: true, stdio: "ignore", cwd }).unref();
    return;
  }
  // Windows：整条命令行交给 cmd 执行；自己不带窗口（windowsHide），可见的终端
  // 窗口由命令里的 start 创建，否则会先闪一个黑框。
  spawn(launch.command, { shell: true, stdio: "ignore", cwd, windowsHide: true }).unref();
}

/** 一键运行：按配置分发到集成/外置终端。 */
export function runProgram(exe: string, cwd: string, opts: { inputFile?: string; title?: string } = {}): void {
  const c = terminalConfig();
  if (c.mode === "external") runInExternalTerminal(exe, cwd, { inputFile: opts.inputFile });
  else runInIntegratedTerminal(exe, cwd, opts);
}
