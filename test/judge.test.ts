import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { discoverSamples, hashOfFile, judgeConcurrency, judgeFile, mapBounded } from "../src/judge/judge";
import { buildDir, cacheRoot, exeNameFor, exePathFor } from "../src/judge/compile";
import { shortHash } from "../src/util";
// 直接引 stub（与 esbuild alias 指向同一文件，因此与源码共用一个模块实例）
import { setConfigOverride } from "./vscode-stub";

const hasGpp = spawnSync("g++", ["--version"], { stdio: "ignore" }).status === 0;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "oiassist-test-"));
}

function write(dir: string, name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

test("discoverSamples 只认 <源文件主干>_N.in 并按序号数值排序", () => {
  const dir = tmpDir();
  write(dir, "A.cpp", "int main(){}");
  write(dir, "A_10.in", "x");
  write(dir, "A_2.in", "x");
  write(dir, "A_2.out", "y");
  write(dir, "B_1.in", "x");
  write(dir, "A.in", "x");

  const found = discoverSamples(path.join(dir, "A.cpp"));
  assert.deepEqual(
    found.map((f) => path.basename(f.inputFile)),
    ["A_2.in", "A_10.in"],
  );
  assert.equal(path.basename(found[0].outputFile ?? ""), "A_2.out");
  assert.equal(found[1].outputFile, null);
});

test("无样例时 discoverSamples 返回空", () => {
  const dir = tmpDir();
  write(dir, "A.cpp", "int main(){}");
  assert.deepEqual(discoverSamples(path.join(dir, "A.cpp")), []);
});

test("judgeFile：编译失败时给出编译输出", async () => {
  const dir = tmpDir();
  const src = write(dir, "Broken.cpp", "int main() { this is not c++ }\n");
  const report = await judgeFile(src);
  assert.equal(report.compile.ok, false);
  assert.equal(report.cases.length, 0);
  assert.match(report.compile.message, /error/i);
});

test("judgeFile：sourceHash 记录被编译的那份代码，编译失败时也要有", async () => {
  const dir = tmpDir();
  const src = write(dir, "Hash.cpp", "int main(){return 0;}\n");
  const report = await judgeFile(src);
  assert.equal(report.sourceHash, shortHash(fs.readFileSync(src, "utf8")));
  assert.equal(report.sourceHash, hashOfFile(src));

  // 改过代码后哈希必须变 —— 提交时据此决定要不要重新编译
  fs.writeFileSync(src, "int main(){return 1;}\n", "utf8");
  assert.notEqual(hashOfFile(src), report.sourceHash);

  const broken = write(dir, "HashBroken.cpp", "int main() { oops }\n");
  const bad = await judgeFile(broken);
  assert.equal(bad.compile.ok, false);
  assert.equal(bad.sourceHash, hashOfFile(broken));
});

test("judgeFile：编译通过但无样例 → noSamples", { skip: !hasGpp }, async () => {
  const dir = tmpDir();
  const src = write(dir, "NoSample.cpp", "#include <bits/stdc++.h>\nint main(){return 0;}\n");
  const report = await judgeFile(src);
  assert.equal(report.compile.ok, true);
  assert.equal(report.noSamples, true);
  assert.equal(report.cases.length, 0);
});

test("judgeFile：正确程序全部 AC，错误程序 WA", { skip: !hasGpp }, async () => {
  const dir = tmpDir();
  const correct = write(
    dir,
    "Sum.cpp",
    `#include <bits/stdc++.h>
int main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n"; }
`,
  );
  write(dir, "Sum_1.in", "1 2\n");
  write(dir, "Sum_1.out", "3\n");
  write(dir, "Sum_2.in", "10 20\n");
  // 期望输出故意带上行尾空白与多余空行，验证 OJ 口径的宽松比较
  write(dir, "Sum_2.out", "30   \n\n");

  const ok = await judgeFile(correct);
  assert.equal(ok.compile.ok, true);
  assert.equal(ok.cases.length, 2);
  assert.deepEqual(ok.cases.map((c) => c.status), ["AC", "AC"]);

  const wrong = write(
    dir,
    "Diff.cpp",
    `#include <bits/stdc++.h>
int main(){ long long a,b; std::cin>>a>>b; std::cout<<a-b<<"\\n"; }
`,
  );
  write(dir, "Diff_1.in", "1 2\n");
  write(dir, "Diff_1.out", "3\n");

  const bad = await judgeFile(wrong);
  assert.deepEqual(bad.cases.map((c) => c.status), ["WA"]);
  assert.equal(bad.cases[0].expectedNormalized, "3");
  assert.equal(bad.cases[0].actualNormalized, "-1");
});

test("judgeFile：只有输入没有期望输出 → NO_EXPECTED", { skip: !hasGpp }, async () => {
  const dir = tmpDir();
  const src = write(dir, "Echo.cpp", `#include <bits/stdc++.h>\nint main(){ std::string s; std::cin>>s; std::cout<<s; }\n`);
  write(dir, "Echo_1.in", "hello\n");
  const report = await judgeFile(src);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].status, "NO_EXPECTED");
});

test("judgeFile：非零退出码判 RE", { skip: !hasGpp }, async () => {
  const dir = tmpDir();
  const src = write(dir, "Crash.cpp", `int main(){ return 3; }\n`);
  write(dir, "Crash_1.in", "");
  write(dir, "Crash_1.out", "");
  const report = await judgeFile(src);
  assert.equal(report.cases.length, 1);
  assert.equal(report.cases[0].status, "RE");
  assert.equal(report.cases[0].exitCode, 3);
});

test("judgeFile：死循环在时间限制内被杀 → TLE", { skip: !hasGpp }, async () => {
  setConfigOverride("judge.timeoutMs", 1500);
  try {
    const dir = tmpDir();
    const src = write(dir, "Loop.cpp", `int main(){ volatile long long x=0; while(true) x++; }\n`);
    write(dir, "Loop_1.in", "");
    write(dir, "Loop_1.out", "");
    const report = await judgeFile(src);
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].status, "TLE");
    assert.equal(report.cases[0].timedOut, true);
    // 被 kill 时不应该耗到远超时间限制
    assert.ok(report.cases[0].durationMs < 6000, `耗时 ${report.cases[0].durationMs}ms`);
  } finally {
    setConfigOverride("judge.timeoutMs", 10000);
  }
});

test("judgeFile：大输出（超过管道缓冲）不会误判超时", { skip: !hasGpp }, async () => {
  setConfigOverride("judge.timeoutMs", 8000);
  try {
    const dir = tmpDir();
    const src = write(
      dir,
      "Big.cpp",
      `#include <bits/stdc++.h>
int main(){ std::string out; for(int i=1;i<=80000;i++) out += std::to_string(i) + "\\n"; std::cout<<out; }
`,
    );
    let expected = "";
    for (let i = 1; i <= 80000; i++) expected += `${i}\n`;
    write(dir, "Big_1.in", "");
    write(dir, "Big_1.out", expected);
    const report = await judgeFile(src);
    assert.equal(report.cases.length, 1);
    assert.equal(report.cases[0].status, "AC");
    assert.equal(report.cases[0].truncated, false);
    assert.ok(report.cases[0].actual.length > 64 * 1024, "输出应超过 64KB 以覆盖管道死锁场景");
  } finally {
    setConfigOverride("judge.timeoutMs", 10000);
  }
});

test("编译产物路径：Windows 带 .exe 后缀，缓存目录跟平台走", () => {
  assert.equal(exeNameFor("A1131", "linux"), "A1131");
  assert.equal(exeNameFor("A1131", "darwin"), "A1131");
  assert.equal(exeNameFor("A1131", "win32"), "A1131.exe");

  assert.equal(cacheRoot("win32", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }), "C:\\Users\\x\\AppData\\Local");
  // LOCALAPPDATA 缺失（精简环境）时回落到家目录，不能返回空路径
  assert.equal(cacheRoot("win32", {}), path.join(os.homedir(), ".cache"));
  assert.equal(cacheRoot("linux", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" }), path.join(os.homedir(), ".cache"));

  // 同一份源文件 → 同一个构建目录，与平台无关（避免升级后重复编译）；
  // 可执行文件名则跟当前平台走（Windows 补 .exe），所以两半分开断言
  const bankSrc = path.join("/tmp", "题库", "A1131", "A1131.cpp");
  assert.equal(path.dirname(exePathFor(bankSrc)), buildDir(bankSrc));
  assert.equal(path.basename(exePathFor(bankSrc)), exeNameFor("A1131"));
});

test("judgeFile：输出上限按字节算，中文输出不会被多收一倍", { skip: !hasGpp }, async () => {
  // 每行「中」占 3 字节 + 换行 1 字节，60 行共 240 字节。上限设成 100 字节时，
  // 旧实现按 text.length（字符数）计数，会把远超上限的中文当成「还没到上限」收下。
  setConfigOverride("judge.maxOutputBytes", 100);
  try {
    const dir = tmpDir();
    const src = write(
      dir,
      "Bytes.cpp",
      `#include <bits/stdc++.h>\nint main(){ for (int i = 0; i < 60; i++) std::cout << "中\\n"; }\n`,
    );
    write(dir, "Bytes_1.in", "");
    write(dir, "Bytes_1.out", "中\n");

    const report = await judgeFile(src);
    const c = report.cases[0];
    assert.equal(c.truncated, true, "超过字节上限必须标记截断");
    const bytes = Buffer.byteLength(c.actual, "utf8");
    assert.ok(bytes <= 100, `实际收取 ${bytes} 字节，超过 100 字节上限`);
    assert.ok(bytes >= 97, `实际只收取 ${bytes} 字节，离上限太远`);
  } finally {
    setConfigOverride("judge.maxOutputBytes", 16 * 1024 * 1024);
  }
});

test("judgeConcurrency：留一格给编辑器，封顶 4，单核退化成串行", () => {
  // 封顶 4：再多只是让每个进程分到的时间片更少，面板上的 durationMs 会一起虚高
  assert.equal(judgeConcurrency(1), 1);
  assert.equal(judgeConcurrency(2), 1);
  assert.equal(judgeConcurrency(4), 3);
  assert.equal(judgeConcurrency(8), 4);
  assert.equal(judgeConcurrency(64), 4);
  // 逻辑核数拿不到（0 / 异常值）时必须是 1，不能算出 0 个 worker 导致一个样例都不跑
  assert.equal(judgeConcurrency(0), 1);
  assert.equal(judgeConcurrency(-3), 1);
  // 显式传参是硬约定：测试不能依赖跑测试那台机器的核数
  assert.equal(judgeConcurrency(2.9), 1, "小数核数应向下取整");
});

test("mapBounded：完成顺序被打乱，但结果仍按输入顺序回填", async () => {
  const items = ["a", "b", "c", "d"];
  // 手动控制完成顺序：倒序 resolve，不依赖墙钟 —— 计时器在 CI 上会飘，顺序错乱必须是真的错乱
  const pending: Array<{ index: number; resolve: () => void }> = [];
  const completionOrder: number[] = [];
  const running = mapBounded(items, items.length, (item, index) =>
    new Promise<string>((resolve) => {
      pending.push({
        index,
        resolve: () => {
          completionOrder.push(index);
          resolve(item);
        },
      });
    }),
  );
  // 等所有任务都拿到号（limit ≥ 条数时应当已经齐了）
  while (pending.length < items.length) await new Promise((r) => setTimeout(r, 0));
  for (const p of [...pending].sort((a, b) => b.index - a.index)) p.resolve();

  const out = await running;
  assert.deepEqual(completionOrder, [3, 2, 1, 0], "完成顺序应当是倒序的（否则这用例测不出东西）");
  assert.deepEqual(out, ["a", "b", "c", "d"], "返回顺序必须按输入顺序，不能按完成顺序");
});

test("mapBounded：并发度不超过 limit，且确实并发（不退化成串行）", async () => {
  const run = async (limit: number, count: number): Promise<number> => {
    let inFlight = 0;
    let peak = 0;
    await mapBounded(Array.from({ length: count }, (_, i) => i), limit, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    return peak;
  };
  const peak2 = await run(2, 6);
  assert.ok(peak2 <= 2, `并发峰值 ${peak2} 不得超过 limit`);
  assert.equal(peak2, 2, "必须真的并发（峰值 2），否则等于没并发");
  assert.equal(await run(1, 5), 1, "limit 1 必须退化成串行");
  assert.equal(await run(10, 3), 3, "只有 3 条时不该开出第 4 个 worker");
  assert.equal(await run(0, 3), 1, "limit 为 0 也不能卡死，按串行处理");
});

test("mapBounded：fn 收到的 index 是输入下标，不是完成顺序的计数", async () => {
  const items = ["x", "y", "z"];
  // 三个任务耗时不同，完成顺序与输入顺序不同
  const pairs = await mapBounded(items, items.length, async (item, index) => {
    await new Promise((r) => setTimeout(r, (items.length - index) * 10));
    return { item, index };
  });
  assert.deepEqual(
    pairs,
    [
      { item: "x", index: 0 },
      { item: "y", index: 1 },
      { item: "z", index: 2 },
    ],
    "index 必须与输入下标一一对应",
  );
});

test("mapBounded：空数组返回空数组，不报错", async () => {
  assert.deepEqual(await mapBounded([], 4, async () => 1), []);
  assert.deepEqual(await mapBounded([], 1, async () => 1), []);
});

test("judgeFile：多个样例并发跑完，状态与编号仍按样例顺序", { skip: !hasGpp }, async () => {
  const dir = tmpDir();
  const src = write(
    dir,
    "Order.cpp",
    `#include <bits/stdc++.h>
int main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n"; }
`,
  );
  // 三个样例给出**互不相同**的判定，顺序一错就能看出来：WA / AC / NO_EXPECTED
  write(dir, "Order_1.in", "1 2\n");
  write(dir, "Order_1.out", "99\n");
  write(dir, "Order_2.in", "3 4\n");
  write(dir, "Order_2.out", "7\n");
  write(dir, "Order_3.in", "5 6\n");

  const report = await judgeFile(src);
  assert.equal(report.compile.ok, true);
  assert.equal(report.cases.length, 3);
  assert.deepEqual(report.cases.map((c) => c.index), [1, 2, 3]);
  assert.deepEqual(report.cases.map((c) => c.status), ["WA", "AC", "NO_EXPECTED"]);
  assert.deepEqual(
    report.cases.map((c) => path.basename(c.inputFile)),
    ["Order_1.in", "Order_2.in", "Order_3.in"],
  );
});
