import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildExternalLaunch,
  buildWindowsCommand,
  clearCommand,
  cmdQuote,
  detectExternalTemplate,
  exitSuffix,
  externalTemplateFile,
  fillExternalTemplate,
  isCmdShell,
  shellQuote,
} from "../src/terminal/runner";
import { sanitizeDirName } from "../src/problems/files";
import { resetConfigOverrides, setConfigOverride } from "./vscode-stub";

test("shellQuote 用单引号包裹并转义内部单引号", () => {
  assert.equal(shellQuote("/tmp/a.cpp"), "'/tmp/a.cpp'");
  assert.equal(shellQuote("/tmp/my file.cpp"), "'/tmp/my file.cpp'");
  assert.equal(shellQuote("/tmp/it's.cpp"), `'/tmp/it'\\''s.cpp'`);
});

test("cmdQuote 只在必要时加双引号，并处理结尾反斜杠", () => {
  assert.equal(cmdQuote("C:\\build\\A1131.exe"), "C:\\build\\A1131.exe");
  assert.equal(cmdQuote("C:\\my dir\\A1131.exe"), '"C:\\my dir\\A1131.exe"');
  assert.equal(cmdQuote("C:\\dir\\"), '"C:\\dir\\\\"');
  assert.equal(cmdQuote(""), '""');
  assert.equal(cmdQuote("C:\\a&b\\x.exe"), '"C:\\a&b\\x.exe"');
});

test("fillExternalTemplate 替换 ${exe}/${dir}/${file} 并加引号", () => {
  const cmd = fillExternalTemplate(
    "gnome-terminal -- bash -lc '${exe}; exec bash'",
    "/tmp/build/a.out",
    "/tmp/work",
    "/tmp/work/a.cpp",
  );
  assert.equal(cmd, "gnome-terminal -- bash -lc ''/tmp/build/a.out'; exec bash'");
  const withDir = fillExternalTemplate("cd ${dir} && ${exe}", "/b/a.out", "/my dir", "/my dir/a.cpp");
  assert.equal(withDir, "cd '/my dir' && '/b/a.out'");
});

test("fillExternalTemplate 在 Windows 上按 cmd 规则加引号", () => {
  const cmd = fillExternalTemplate(
    "wt -d ${dir} cmd /k ${exe}",
    "C:\\my dir\\a.exe",
    "C:\\my dir",
    "C:\\my dir\\a.cpp",
    cmdQuote,
  );
  assert.equal(cmd, 'wt -d "C:\\my dir" cmd /k "C:\\my dir\\a.exe"');
});

test("外置终端探测只在 POSIX 上做", () => {
  assert.equal(detectExternalTemplate("win32"), null);
});

test("buildWindowsCommand 用 cmd 的 start 新开窗口", () => {
  // 路径无空格：不引号，直接跑
  assert.equal(
    buildWindowsCommand("C:\\build\\A1131.exe", "C:\\work", { keepOpen: true }),
    'start "OI运行" /D C:\\work cmd /k C:\\build\\A1131.exe',
  );
  // 带样例输入 + 路径含空格：载荷整体再包一层引号，好让内层 cmd 剥掉最外层
  assert.equal(
    buildWindowsCommand("C:\\my dir\\A1131.exe", "C:\\my dir", {
      inputFile: "C:\\my dir\\A1131_1.in",
      keepOpen: true,
    }),
    'start "OI运行" /D "C:\\my dir" cmd /k ""C:\\my dir\\A1131.exe" < "C:\\my dir\\A1131_1.in""',
  );
  // 只有可执行文件有引号（输入文件路径无空格）时也要包一层，否则内层 cmd 会把
  // 可执行文件那对引号当成"最外层"剥掉，路径里的空格就暴露出来了
  assert.equal(
    buildWindowsCommand("C:\\my dir\\A1131.exe", "C:\\my dir", { inputFile: "C:\\in.txt", keepOpen: false }),
    'start "OI运行" /D "C:\\my dir" cmd /c ""C:\\my dir\\A1131.exe" < C:\\in.txt"',
  );
});

test("buildExternalLaunch 在 Windows 上走内置配方，且用 cmd 解释自定义模板", () => {
  assert.deepEqual(buildExternalLaunch("C:\\build\\a.exe", "C:\\work", "C:\\work\\a.cpp", {}, "win32"), {
    command: 'start "OI运行" /D C:\\work cmd /k C:\\build\\a.exe',
    shell: null,
  });

  setConfigOverride("terminal.externalCommand", "wt -d ${dir} cmd /k ${exe}");
  try {
    assert.deepEqual(
      buildExternalLaunch("C:\\my dir\\a.exe", "C:\\my dir", "C:\\my dir\\a.cpp", {}, "win32"),
      { command: 'wt -d "C:\\my dir" cmd /k "C:\\my dir\\a.exe"', shell: null },
    );
    // POSIX 上同一个模板仍然交给 bash 解释
    const posix = buildExternalLaunch("/build/a.out", "/work", "/work/a.cpp", {}, "linux");
    assert.equal(posix.shell, "/bin/bash");
    assert.equal(posix.command, "wt -d '/work' cmd /k '/build/a.out'");
  } finally {
    resetConfigOverrides();
  }
});

test("集成终端的清屏与退出写法按 shell 选", () => {
  const winCmd = "C:\\WINDOWS\\system32\\cmd.exe";
  const winPs = "C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  assert.equal(isCmdShell(winCmd, "win32"), true);
  assert.equal(isCmdShell("cmd.exe", "win32"), true);
  assert.equal(isCmdShell(winPs, "win32"), false);
  assert.equal(isCmdShell("/bin/bash", "linux"), false);
  assert.equal(isCmdShell("/bin/bash", "win32"), false);

  assert.equal(clearCommand(winCmd, "win32"), "cls");
  assert.equal(clearCommand(winPs, "win32"), "clear");
  assert.equal(clearCommand("/bin/bash", "linux"), "clear");

  assert.equal(exitSuffix(winCmd, "win32"), " & exit");
  assert.equal(exitSuffix(winPs, "win32"), "; exit");
  assert.equal(exitSuffix("/bin/bash", "linux"), "; exit");
});

test("sanitizeDirName 去掉路径分隔符等非法字符", () => {
  assert.equal(sanitizeDirName("第三课/练习"), "第三课_练习");
  assert.equal(sanitizeDirName('a:b*c?"<>|'), "a_b_c" + "_".repeat(5));
  assert.equal(sanitizeDirName("  "), "_");
  assert.equal(sanitizeDirName(".."), "_");
  assert.equal(sanitizeDirName("正常题目名"), "正常题目名");
});

test("外置终端模板里的 ${file} 指的是源文件，不是编译产物", () => {
  // 拿到源文件就用它
  assert.equal(externalTemplateFile("C:\\build\\a.exe", "C:\\work\\a.cpp"), "C:\\work\\a.cpp");
  // 拿不到就退回可执行文件（别在命令里留下没替换的 ${file}）
  assert.equal(externalTemplateFile("C:\\build\\a.exe"), "C:\\build\\a.exe");
  assert.equal(externalTemplateFile("C:\\build\\a.exe", "  "), "C:\\build\\a.exe");
});
