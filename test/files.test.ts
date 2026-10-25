import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createProblemFiles, problemDir } from "../src/problems/files";
import { discoverSamples } from "../src/judge/judge";
// 直接引 stub（与 esbuild alias 指向同一文件，因此与源码共用一个模块实例）
import { resetConfigOverrides, setConfigOverride } from "./vscode-stub";

/** 题库子目录名（覆盖掉默认的「题库」，断言时好写）。 */
const BANK = "bank";

/** 每个用例都重置配置，避免相互影响。 */
function setupConfig(): void {
  resetConfigOverrides();
  setConfigOverride("problems.bankDir", BANK);
  setConfigOverride("problems.saveStatementAsMd", false);
}

/** 每次测试一个独立的临时目录，测完删掉（不写进工程目录）。 */
function tmpDir(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lgassist-files-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("样例输入为空、输出非空：也要落一个空的 .in，否则 judge 永远发现不了这个样例", (t) => {
  setupConfig();
  const root = tmpDir(t);
  const created = createProblemFiles({
    root,
    displayId: "P1001",
    statement: null,
    samples: [{ input: "", output: "42" }],
  });

  const inFile = path.join(created.dir, "P1001_1.in");
  assert.ok(fs.existsSync(inFile), "空输入的样例也必须有 .in");
  // 空文件（不是 "\n"）：空输入就是没有输入
  assert.equal(fs.readFileSync(inFile, "utf8"), "", ".in 内容应是空文件");
  assert.equal(fs.readFileSync(path.join(created.dir, "P1001_1.out"), "utf8"), "42\n");
  assert.ok(created.sampleFiles.includes(inFile), "新建的 .in 要进 sampleFiles");

  // 关键：judge 以 .in 的存在为准发现样例，空输入的样例必须能被跑到
  const found = discoverSamples(created.cppPath);
  assert.equal(found.length, 1);
  assert.equal(path.basename(found[0].inputFile), "P1001_1.in");
  assert.equal(path.basename(found[0].outputFile ?? ""), "P1001_1.out");
});

test("样例输入输出都非空：.in 与 .out 都落盘，内容正确", (t) => {
  setupConfig();
  const root = tmpDir(t);
  const created = createProblemFiles({
    root,
    displayId: "P1002",
    statement: null,
    samples: [{ input: "1 2", output: "3" }],
  });

  const inFile = path.join(created.dir, "P1002_1.in");
  const outFile = path.join(created.dir, "P1002_1.out");
  assert.equal(fs.readFileSync(inFile, "utf8"), "1 2\n");
  assert.equal(fs.readFileSync(outFile, "utf8"), "3\n");
  assert.deepEqual(
    created.sampleFiles.map((f) => path.basename(f)).sort(),
    ["P1002_1.in", "P1002_1.out"],
  );

  const found = discoverSamples(created.cppPath);
  assert.equal(found.length, 1);
  assert.equal(path.basename(found[0].inputFile), "P1002_1.in");
  assert.equal(path.basename(found[0].outputFile ?? ""), "P1002_1.out");
});

test("样例输入非空、输出为空：有 .in、没有 .out（保留「只运行不判定」的语义）", (t) => {
  setupConfig();
  const root = tmpDir(t);
  const created = createProblemFiles({
    root,
    displayId: "P1003",
    statement: null,
    samples: [{ input: "1 2", output: "" }],
  });

  const inFile = path.join(created.dir, "P1003_1.in");
  const outFile = path.join(created.dir, "P1003_1.out");
  assert.ok(fs.existsSync(inFile), "有输入就必须有 .in");
  assert.equal(fs.readFileSync(inFile, "utf8"), "1 2\n");
  assert.equal(fs.existsSync(outFile), false, "输出为空不写 .out");

  const found = discoverSamples(created.cppPath);
  assert.equal(found.length, 1);
  assert.equal(found[0].outputFile, null, "缺 .out = 只运行不判定");
});

test("problemDir：题号里的路径分隔符不能把目录写到题库外面", () => {
  setupConfig();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lgassist-files-"));
  const bank = path.resolve(root, BANK);

  for (const evil of ["../evil", "..", "../../evil", "..\\evil"]) {
    const dir = path.resolve(problemDir(root, evil));
    assert.equal(
      path.dirname(dir),
      bank,
      `题号 ${JSON.stringify(evil)} 的目录必须正好在题库目录里，实际是 ${dir}`,
    );
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test("problemDir：正常题号原样保留（别把清洗做过头）", () => {
  setupConfig();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lgassist-files-"));
  const bank = path.resolve(root, BANK);

  for (const id of ["P1001", "CF1A", "AT_abc001_a", "B2077", "P1102A-B"]) {
    assert.equal(path.basename(problemDir(root, id)), id, `题号 ${id} 不该被改动`);
    assert.equal(path.resolve(problemDir(root, id)), path.resolve(bank, id));
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test("createProblemFiles：题号带路径分隔符时，落盘的目录仍留在题库里", (t) => {
  setupConfig();
  const root = tmpDir(t);
  const created = createProblemFiles({
    root,
    displayId: "../evil",
    statement: null,
    samples: [],
  });

  const bank = path.resolve(root, BANK);
  assert.equal(path.dirname(path.resolve(created.dir)), bank);
  assert.equal(path.resolve(created.dir), path.resolve(bank, ".._evil"));
});
