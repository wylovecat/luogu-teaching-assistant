/**
 * 封面联动（BiliBiliHelper）：文件名与命令行的纯逻辑测试。
 *
 * 钉的是两类**不会自己报错的**问题：
 *  1. 文件名模板是用户输入 —— 模板里写个 `../` 就会把封面写到题目录外面去，
 *     而功能看起来照常「成功」；结尾带点的名字在 Windows 上则根本建不出来。
 *  2. argv 里空串覆盖项与「不传」是两回事：`--template ""` 会让对面的 argparse
 *     收到一个空模板，而我们要的是「用 BiliBiliHelper 配置里的默认值」。
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  DEFAULT_COVER_FILE,
  buildCoverArgv,
  coverFileName,
  coverInvocation,
  coverOutPath,
  sanitizeCoverFileName,
  type CoverSpec,
  type CoverTool,
} from "../src/cover/spec";

const DIR = path.join("E:", "work", "题库", "P1001 A+B Problem");

function spec(over: Partial<CoverSpec> = {}): CoverSpec {
  return {
    problemId: "P1001",
    dir: DIR,
    displayId: "P1001",
    template: "",
    fileTemplate: DEFAULT_COVER_FILE,
    palette: "",
    size: "",
    extraArgs: [],
    ...over,
  };
}

const TOOL: CoverTool = {
  command: "bili-helper",
  args: [],
  projectDir: "",
  timeoutMs: 120000,
};

// ── 文件名 ────────────────────────────────────────────────────

test("默认文件名与题解目录里的既有命名同一套：<题号> 封面.png", () => {
  assert.equal(DEFAULT_COVER_FILE, "${id} 封面.png");
  assert.equal(coverFileName("", "P1001"), "P1001 封面.png");
  assert.equal(coverFileName(DEFAULT_COVER_FILE, "P1395"), "P1395 封面.png");
});

test("文件名模板里的 ${id} 会全部替换；模板没有 ${id} 就原样用", () => {
  assert.equal(coverFileName("${id}-cover.png", "CF1A"), "CF1A-cover.png");
  assert.equal(coverFileName("${id} 第${id}期.png", "P1001"), "P1001 第P1001期.png");
  assert.equal(coverFileName("封面.png", "P1001"), "封面.png");
});

test("文件名模板是用户输入：路径分隔符一律换掉，落盘位置跑不出题目录", () => {
  // 这一条是重点：不换掉分隔符，`../../evil.png` 会写到题目录之外
  const name = coverFileName("../../evil.png", "P1001");
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes("\\"), false);
  const out = coverOutPath(spec({ fileTemplate: "../../evil.png" }));
  assert.equal(path.dirname(out), DIR, "封面必须落在题目录里");
  assert.equal(path.dirname(out), path.dirname(path.join(DIR, name)));
});

test("文件名清洗：Windows 禁不起的字符与结尾的点都收拾掉", () => {
  assert.equal(sanitizeCoverFileName('a<b>c:d"e/f\\g|h?i*j.png', "fb.png"), "a_b_c_d_e_f_g_h_i_j.png");
  assert.equal(sanitizeCoverFileName("P1001 封面.png.", "fb.png"), "P1001 封面.png", "结尾的点会让文件建不出来");
  assert.equal(sanitizeCoverFileName("  P1001.png  ", "fb.png"), "P1001.png");
  // 只剩分隔符的模板会被换成 `_`：是个难看的名字，但仍然是目录内的合法文件名。
  // 真正必须兜底的是「什么都没有」的那几种 —— 空名字会拼出一个光秃秃的 `.png`。
  assert.equal(sanitizeCoverFileName("/", "fb.png"), "_");
  for (const bad of ["", " ", ".", "..", " . "]) {
    assert.equal(sanitizeCoverFileName(bad, "fb.png"), "fb.png", `「${bad}」要回落到兜底名`);
  }
});

test("封面设计模板与文件名模板是两回事：换 --template 不该改文件名", () => {
  // 这两个都叫「模板」，曾经合用一个字段 —— 于是把画面换成 minimal，文件名也跟着变，
  // 「已存在就跳过」当场失效（每次建题都重新渲染一张、还写到另一个名字上）。
  const a = coverOutPath(spec({ template: "series" }));
  const b = coverOutPath(spec({ template: "minimal" }));
  assert.equal(a, b);
  assert.equal(path.basename(a), "P1001 封面.png");
});

// ── 命令行 ────────────────────────────────────────────────────

test("argv：位置参数与 -o 一定在最前，空串的覆盖项不传", () => {
  const out = coverOutPath(spec());
  assert.deepEqual(buildCoverArgv(spec()), ["cover", "P1001", "-o", out]);
});

test("argv：模板/配色/尺寸按 --x 值 成对追加，多了也不影响顺序", () => {
  const out = coverOutPath(spec());
  assert.deepEqual(
    buildCoverArgv(spec({ template: "series", palette: "dark", size: "1146x717" })),
    ["cover", "P1001", "-o", out, "--template", "series", "--palette", "dark", "--size", "1146x717"],
  );
  // 只写了一个覆盖项时不该把它后面的项也带出来
  assert.deepEqual(buildCoverArgv(spec({ palette: "warm" })), ["cover", "P1001", "-o", out, "--palette", "warm"]);
});

test("argv：两端空白会被去掉，纯空白的覆盖项按「没填」处理", () => {
  const out = coverOutPath(spec());
  assert.deepEqual(buildCoverArgv(spec({ template: "  minimal  " })), [
    "cover",
    "P1001",
    "-o",
    out,
    "--template",
    "minimal",
  ]);
  assert.deepEqual(buildCoverArgv(spec({ template: "   ", palette: "\t" })), ["cover", "P1001", "-o", out]);
});

test("argv：extraArgs 追加在最后，空串丢掉（同名的后出现的胜出）", () => {
  const out = coverOutPath(spec({ template: "series" }));
  assert.deepEqual(buildCoverArgv(spec({ template: "series", extraArgs: ["--ai-bg"] })), [
    "cover",
    "P1001",
    "-o",
    out,
    "--template",
    "series",
    "--ai-bg",
  ]);
  assert.deepEqual(buildCoverArgv(spec({ extraArgs: ["", "   "] })), ["cover", "P1001", "-o", out]);
});

test("argv：传给 CLI 的是 problemId，文件名用的是 displayId（两者可以不同）", () => {
  const s = spec({ problemId: "https://www.luogu.com.cn/problem/P1001", displayId: "P1001" });
  const argv = buildCoverArgv(s);
  assert.equal(argv[0], "cover");
  assert.equal(argv[1], "https://www.luogu.com.cn/problem/P1001", "位置参数原样交给对面（它认 URL）");
  assert.equal(path.basename(coverOutPath(s)), "P1001 封面.png", "文件名用的是题号，不是整条 URL");
});

// ── 怎么把命令叫起来 ──────────────────────────────────────────

test("调用：bili-helper 直呼时不给 cwd（走 PATH 的可执行文件不需要工作目录）", () => {
  const inv = coverInvocation(TOOL, spec());
  assert.equal(inv.command, "bili-helper");
  assert.equal(inv.cwd, undefined);
  assert.deepEqual(inv.args, buildCoverArgv(spec()));
  assert.equal(inv.timeoutMs, 120000);
});

test("调用：走源码方式时把前缀参数与 projectDir 一起带上（python -m 必须在项目根跑）", () => {
  const tool: CoverTool = {
    command: "python",
    args: ["-m", "bili_assistant.cli"],
    projectDir: "E:\\BiliBiliHelper",
    timeoutMs: 30000,
  };
  const inv = coverInvocation(tool, spec());
  assert.equal(inv.command, "python");
  assert.equal(inv.cwd, "E:\\BiliBiliHelper");
  assert.equal(inv.timeoutMs, 30000);
  assert.deepEqual(inv.args.slice(0, 2), ["-m", "bili_assistant.cli"]);
  assert.deepEqual(inv.args.slice(2), buildCoverArgv(spec()), "子命令参数要接在前缀之后");
});

test("调用：command 填成空白串时回落到 bili-helper；projectDir 也一样按「没填」处理", () => {
  const inv = coverInvocation({ ...TOOL, command: "   ", projectDir: "  " }, spec());
  assert.equal(inv.command, "bili-helper");
  assert.equal(inv.cwd, undefined);
});

test("调用：bili-helper 自己的子命令名不能丢（前缀里没有 cover 时由我们补）", () => {
  const inv = coverInvocation(TOOL, spec());
  assert.equal(inv.args[0], "cover");
});
