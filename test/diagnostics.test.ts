import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  describeDiagnostic,
  firstDiagnosticText,
  parseCompileDiagnostics,
  summarizeDiagnostics,
} from "../src/judge/diagnostics";
import { judgeFile } from "../src/judge/judge";

const hasGpp = spawnSync("g++", ["--version"], { stdio: "ignore" }).status === 0;
// 产品代码用 path.resolve 把相对路径拼成绝对路径（Windows 上会带上当前盘符），
// 期望值必须用同一个函数算出来：写死 POSIX 形态（path.join）在 Windows 上会误报。
const CWD = "/tmp/oi-demo";
const absInCwd = (name: string): string => path.resolve(CWD, name);
const parse = (text: string, cwd = CWD): ReturnType<typeof parseCompileDiagnostics> =>
  parseCompileDiagnostics(text, { cwd, fallbackFile: absInCwd("A.cpp") });

// g++ -O2 -std=c++17 -pipe -Wall A.cpp 的真实输出（含源码片段与 ^~~ 指示行）
const REAL_GCC_OUTPUT = [
  "A.cpp: In function ‘int main()’:",
  "A.cpp:6:5: error: expected initializer before ‘int’",
  "    6 |     int x = 0;",
  "      |     ^~~",
  "A.cpp:7:13: error: ‘y’ was not declared in this scope; did you mean ‘yn’?",
  "    7 |     cout << y << endl;",
  "      |             ^",
  "A.cpp:8:12: error: ‘n’ was not declared in this scope",
  "",
].join("\n");

test("解析 g++ 报错：位置、级别、正文都对，源码片段行被忽略", () => {
  const diags = parse(REAL_GCC_OUTPUT);
  assert.equal(diags.length, 3, "三行 error 应各成一条诊断");
  assert.deepEqual(
    diags.map((d) => [d.severity, path.basename(d.file), d.line, d.column]),
    [
      ["error", "A.cpp", 6, 5],
      ["error", "A.cpp", 7, 13],
      ["error", "A.cpp", 8, 12],
    ],
  );
  assert.equal(diags[0].message, "expected initializer before ‘int’");
  assert.equal(diags[0].file, absInCwd("A.cpp"), "相对路径按编译时的 cwd 解析为绝对路径");
  assert.ok(
    diags.every((d) => !d.raw.includes("int x = 0")),
    "源码片段与 ^~~ 行不能被当成报错",
  );
  assert.equal(summarizeDiagnostics(diags), "3 个错误");
  assert.equal(firstDiagnosticText(diags), "A.cpp:6:5: expected initializer before ‘int’");
});

test("fatal error 与中文 locale 的写法都认", () => {
  const fatal = parse('C.cpp:1:10: fatal error: nope.h: 没有那个文件或目录\ncompilation terminated.\n');
  assert.equal(fatal.length, 1, "「compilation terminated.」本身不是一条诊断");
  assert.equal(fatal[0].severity, "error");
  assert.equal(fatal[0].message, "nope.h: 没有那个文件或目录");

  const zh = parse("A.cpp:6:5: 错误：需要 ‘;’ 在 ‘int’ 之前\nA.cpp:9:7: 警告：‘x’ 定义而未使用\nA.cpp:6:5: 提示：参考声明\n");
  assert.deepEqual(
    zh.map((d) => [d.severity, d.line, d.column]),
    [
      ["error", 6, 5],
      ["warning", 9, 7],
      ["note", 6, 5],
    ],
  );
  assert.equal(summarizeDiagnostics(zh), "1 个错误、1 个警告");
});

test("链接器这类没有行号的报错保留正文，line 为 null", () => {
  const diags = parse("collect2: error: ld returned 1 exit status\n");
  assert.equal(diags.length, 1);
  assert.equal(diags[0].line, null);
  assert.equal(diags[0].severity, "error");
  assert.equal(diags[0].message, "collect2: ld returned 1 exit status");
  assert.equal(describeDiagnostic(diags[0]), "collect2: ld returned 1 exit status");
  assert.equal(summarizeDiagnostics(diags), "1 个错误");
});

test("告警（编译通过时的 -Wall 输出）也能解析成问题", () => {
  const diags = parse(
    ["D.cpp: In function ‘int main()’:", "D.cpp:1:17: warning: unused variable ‘x’ [-Wunused-variable]", "    1 | int main(){ int x; return 0; }"].join(
      "\n",
    ),
  );
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, "warning");
  assert.equal(diags[0].line, 1);
  assert.equal(summarizeDiagnostics(diags), "1 个警告");
  assert.equal(firstDiagnosticText(diags), "D.cpp:1:17: unused variable ‘x’ [-Wunused-variable]");
});

test("Windows 盘符路径与缺列号的形态", () => {
  const win = parse("C:\\work\\A1131\\A1131.cpp:8:12: error: expected ';' before '}' token\n", CWD);
  assert.equal(win[0].file, "C:\\work\\A1131\\A1131.cpp", "盘符路径不应被当相对路径拼上 cwd");
  assert.equal(win[0].line, 8);
  assert.equal(win[0].column, 12);

  const noCol = parse("A.cpp:42: error: 'x' was not declared in this scope\n");
  assert.equal(noCol[0].line, 42);
  assert.equal(noCol[0].column, null);
  assert.equal(describeDiagnostic(noCol[0]), "A.cpp:42: 'x' was not declared in this scope");
});

test("完全解析不出来时给出兜底文案", () => {
  assert.deepEqual(parse(""), []);
  assert.equal(summarizeDiagnostics([]), "编译失败");
  assert.equal(firstDiagnosticText([]), null);
  assert.equal(firstDiagnosticText(parse("collect2: error: ld returned 1 exit status\n"))?.startsWith("collect2:"), true);
});

test("长报错在提示条里截断，不撑爆通知", () => {
  const long = parse(`A.cpp:1:1: error: ${"很长的报错正文".repeat(40)}\n`);
  const text = firstDiagnosticText(long) ?? "";
  assert.ok(text.length <= 160, `提示文本应截断，实际 ${text.length} 字`);
  assert.ok(text.endsWith("…"));
});

test("对真实 g++ 输出跑一遍解析（需要 g++）", { skip: !hasGpp }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oiassist-diag-"));
  const src = path.join(dir, "Broken.cpp");
  fs.writeFileSync(src, "#include <bits/stdc++.h>\nint main() {\n  int n\n  return 0;\n}\n", "utf8");
  const report = await judgeFile(src);
  assert.equal(report.compile.ok, false);

  const diags = parseCompileDiagnostics(report.compile.message, { cwd: dir, fallbackFile: src });
  const errors = diags.filter((d) => d.severity === "error");
  assert.ok(errors.length >= 1, `应从真实输出里解析出错误，实际：${report.compile.message}`);
  assert.equal(errors[0].file, src);
  assert.equal(errors[0].line, 4);
  assert.equal(errors[0].column, 3);
  assert.match(errors[0].message, /expected initializer/);
});
