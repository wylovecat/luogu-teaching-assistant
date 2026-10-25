import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatBytes,
  indentationFix,
  isFinalJudgeResult,
  judgeSignature,
  looksLikeProblemId,
  maskAccount,
  needsPreSubmitCompile,
  normVerdict,
  normalizeOutput,
  outputsEqual,
  sameFilePath,
  shortHash,
  stemOf,
  verdictLabel,
  verdictNeedsConfirm,
} from "../src/util";

test("normalizeOutput 去掉行尾空白与末尾空行", () => {
  assert.equal(normalizeOutput("1 2  \n3\t\n\n\n"), "1 2\n3");
  assert.equal(normalizeOutput("a\r\nb\r\n"), "a\nb");
  assert.equal(normalizeOutput(""), "");
  assert.equal(normalizeOutput("\n\n"), "");
});

test("outputsEqual 按 OJ 口径比较（容忍行尾空白/末尾换行差异）", () => {
  assert.equal(outputsEqual("42\n", "42"), true);
  assert.equal(outputsEqual("a\nb", "a\nb\n\n"), true);
  assert.equal(outputsEqual("1 2 \n", "1 2"), true);
  // 行内空白与顺序差异不该被容忍
  assert.equal(outputsEqual("1  2", "1 2"), false);
  assert.equal(outputsEqual("b\na", "a\nb"), false);
});

test("normVerdict 覆盖站点各种状态写法", () => {
  assert.equal(normVerdict({ subStatic: "AC" }), "AC");
  assert.equal(normVerdict({ subStatic: "ok" }), "AC");
  assert.equal(normVerdict({ subStatic: "substatic" }), "?");
  assert.equal(normVerdict({ substatic: "wa" }), "WA");
  assert.equal(normVerdict({ status: "Accepted" }), "AC");
  assert.equal(normVerdict({ status: "Wrong Answer" }), "WA");
  assert.equal(normVerdict({ verdict: "Time Limit Exceeded" }), "TLE");
  assert.equal(normVerdict({ result: "Memory Limit Exceeded" }), "MLE");
  assert.equal(normVerdict({ feedback: "Runtime Error" }), "RE");
  assert.equal(normVerdict({ feedback: "Compile Error" }), "CE");
  assert.equal(normVerdict({ feedback: "Presentation Error" }), "PE");
  assert.equal(normVerdict({ subStatic: "评测中" }), "?");
  assert.equal(normVerdict({ subStatic: "编译错误" }), "CE");
  assert.equal(normVerdict({ subStatic: "答案正确" }), "AC");
  assert.equal(normVerdict({}), "?");
  // 空字符串要继续往下找键，而不是当场判定为 ?
  assert.equal(normVerdict({ subStatic: "  ", substatic: "TLE" }), "TLE");
});

test("isFinalJudgeResult：记录里还没有判定就不算最终结果（TLE 被报成 WA 的护栏）", () => {
  // 站点说「评测结束了」，但这只是记录刚入库：id 还是 0、判定文本还是空的。
  // 照着显示就成了「实际 TLE、却报 WA」，所以必须继续等。
  assert.equal(isFinalJudgeResult({ done: true, id: 0, rawStatus: "" }), false);
  assert.equal(isFinalJudgeResult({ done: true, id: 0, rawStatus: "   " }), false);
  // 还在评测中（subIsPass == 7）自然不算
  assert.equal(isFinalJudgeResult({ done: false, id: 0, rawStatus: "" }), false);
  assert.equal(isFinalJudgeResult({ done: false, id: 2610360, rawStatus: "WA" }), false);
  // 提交记录 id 或判定文本任一到位才算拿到最终结果
  assert.equal(isFinalJudgeResult({ done: true, id: 2610360, rawStatus: "" }), true);
  assert.equal(isFinalJudgeResult({ done: true, id: 0, rawStatus: "TLE" }), true);
});

test("needsPreSubmitCompile：刚在评测里编译过的同一份代码不再编译", () => {
  assert.equal(needsPreSubmitCompile(true, "abc", "abc"), false);
  // 代码改过 / 没编译过（undefined、null、空哈希）都要编译
  assert.equal(needsPreSubmitCompile(true, "abc", "def"), true);
  assert.equal(needsPreSubmitCompile(true, "abc", undefined), true);
  assert.equal(needsPreSubmitCompile(true, "abc", null), true);
  assert.equal(needsPreSubmitCompile(true, "abc", ""), true);
  // 关掉「提交前本地编译」时永远不编译
  assert.equal(needsPreSubmitCompile(false, "abc", undefined), false);
  assert.equal(needsPreSubmitCompile(false, "abc", "def"), false);
});

test("verdictLabel 给中文", () => {
  assert.equal(verdictLabel("AC"), "答案正确");
  assert.equal(verdictLabel("TLE"), "运行超时");
  assert.equal(verdictLabel("XX"), "XX");
});

test("looksLikeProblemId 识别题号形态", () => {
  for (const id of ["P1001", "B2001", "T1001", "a1"]) {
    assert.equal(looksLikeProblemId(id), true, id);
  }
  // 洛谷收别的 OJ 的远程题，数字不一定在末尾：UVa100 / HDU1001 / CF1A / SP33713_FCTRL2
  for (const id of ["UVa100", "HDU1001", "CF1A", "CF999D", "SP33713_FCTRL2"]) {
    assert.equal(looksLikeProblemId(id), true, id);
  }
  for (const id of ["main", "1A", "solution", "a-b", "P"]) {
    assert.equal(looksLikeProblemId(id), false, id);
  }
  // 常见的 C++ 文件名不能被误判成题号（数字前面已经有 3 个字符了）
  for (const id of ["main2", "test1", "solution3"]) {
    assert.equal(looksLikeProblemId(id), false, id);
  }
});

test("stemOf 去掉扩展名", () => {
  assert.equal(stemOf("A1131.cpp"), "A1131");
  assert.equal(stemOf("dir/A1131.cpp"), "dir/A1131");
  assert.equal(stemOf("noext"), "noext");
});

test("formatBytes 分级展示", () => {
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(1048576), "1.0 MB");
  assert.equal(formatBytes(-1), "?");
});

test("shortHash 稳定且不同输入不同", () => {
  assert.equal(shortHash("/a/b"), shortHash("/a/b"));
  assert.notEqual(shortHash("/a/b"), shortHash("/a/c"));
  assert.match(shortHash("/a/b"), /^[0-9a-f]{8}$/);
});

test("maskAccount 脱敏", () => {
  assert.equal(maskAccount("13800000000"), "138****00");
  assert.equal(maskAccount("123"), "123");
});

test("indentationFix 只在探测结果与用户配置不一致时纠正新建文件", () => {
  // 探测按 4 空格模板猜成 4，用户设的是 2 → 纠正
  assert.deepEqual(indentationFix({ tabSize: 4, insertSpaces: true }, { tabSize: 2, insertSpaces: true }), {
    tabSize: 2,
    insertSpaces: true,
  });
  // 已一致 → 不动（不无谓地给文件加一层覆盖）
  assert.equal(indentationFix({ tabSize: 2, insertSpaces: true }, { tabSize: 2, insertSpaces: true }), null);
  // 用户用 tab 缩进、模板是空格 → 纠正 insertSpaces
  assert.deepEqual(indentationFix({ tabSize: 4, insertSpaces: true }, { tabSize: 4, insertSpaces: false }), {
    tabSize: 4,
    insertSpaces: false,
  });
  // 配置成 "auto"（按内容探测）时不要插手
  assert.equal(indentationFix({ tabSize: 4, insertSpaces: true }, { tabSize: "auto", insertSpaces: true }), null);
  assert.equal(indentationFix({ tabSize: 4, insertSpaces: true }, { tabSize: 4 }), null);
});

test("sameFilePath 认同一个文件的多种写法（Windows 不区分大小写）", () => {
  // 完全相同
  assert.equal(sameFilePath("C:\\work\\P1001.cpp", "C:\\work\\P1001.cpp", "win32"), true);
  // Windows 上大小写不敏感
  assert.equal(sameFilePath("C:\\work\\P1001.cpp", "c:\\work\\p1001.cpp", "win32"), true);
  // 结尾多一个分隔符
  assert.equal(sameFilePath("C:\\work\\P1001.cpp", "C:\\work\\P1001.cpp\\", "win32"), true);
  // `..` 与相对段先 resolve 掉
  assert.equal(sameFilePath("C:\\work\\sub\\..\\P1001.cpp", "C:\\work\\P1001.cpp", "win32"), true);
  // 不同文件
  assert.equal(sameFilePath("C:\\work\\P1001.cpp", "C:\\work\\P1002.cpp", "win32"), false);
  // Linux 上大小写敏感
  assert.equal(sameFilePath("/work/P1001.cpp", "/work/p1001.cpp", "linux"), false);
  assert.equal(sameFilePath("/work/P1001.cpp", "/work/P1001.cpp", "linux"), true);
  // 空串不算同一个文件（别把「不知道」当成「是」）
  assert.equal(sameFilePath("", "/work/P1001.cpp", "linux"), false);
  assert.equal(sameFilePath("/work/P1001.cpp", "", "linux"), false);
});

test("verdictNeedsConfirm：AC/CE 直接认，其余终局判定要再确认一拍", () => {
  // 稳定的判定：编译失败就是编译失败，跑过了就是跑过了
  assert.equal(verdictNeedsConfirm("AC"), false);
  assert.equal(verdictNeedsConfirm("CE"), false);
  // 可能是站点写回中途的中间态：WA 先落、TLE 后盖
  assert.equal(verdictNeedsConfirm("WA"), true);
  assert.equal(verdictNeedsConfirm("TLE"), true);
  assert.equal(verdictNeedsConfirm("MLE"), true);
  assert.equal(verdictNeedsConfirm("RE"), true);
  // "?" 本来就不是判定，确认它也确认不出什么
  assert.equal(verdictNeedsConfirm("?"), false);
});

test("judgeSignature：判定相同才算同一个判定（分数与耗时不算）", () => {
  // 分数会随着测试点跑完而变，算进来就永远对不上
  assert.equal(
    judgeSignature({ verdict: "WA", rawStatus: "WA", score: 10, timeMs: 100 }),
    judgeSignature({ verdict: "WA", rawStatus: "WA", score: 60, timeMs: 300 }),
  );
  // 判定变了 → 身份串不同
  assert.notEqual(
    judgeSignature({ verdict: "WA", rawStatus: "WA" }),
    judgeSignature({ verdict: "TLE", rawStatus: "TLE" }),
  );
});
