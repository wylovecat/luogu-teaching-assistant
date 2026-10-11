import { test } from "node:test";
import assert from "node:assert/strict";
import {
  difficultyLabel,
  pickSamples,
  statementFromLuogu,
  statementToMarkdown,
  type Statement,
} from "../src/problems/statement";

test("pickSamples 只认 input/output，两侧全空的占位对象丢掉", () => {
  assert.deepEqual(pickSamples([{ input: "1", output: "2" }]), [{ input: "1", output: "2" }]);
  // 全空占位对象要丢掉
  assert.deepEqual(pickSamples([{}, { input: "", output: "" }]), []);
  assert.deepEqual(pickSamples(null), []);
  assert.deepEqual(pickSamples("x"), []);
});

test("statementFromLuogu 取 currentData.problem 的字段", () => {
  const s = statementFromLuogu(
    {
      pid: "P1001",
      title: "A+B Problem",
      description: "两个数相加",
      inputFormat: "一行两个整数",
      outputFormat: "一行一个整数",
      samples: [{ input: "1 2", output: "3" }],
      hint: "注意数据范围",
      prompt: "背景说明",
      timeLimit: 1000,
      // 洛谷给的是**字节**，125MB = 131072000
      memoryLimit: 131072000,
      difficulty: 2,
    },
    { displayId: "X", title: "Y" },
  );
  assert.equal(s.displayId, "P1001");
  assert.equal(s.title, "A+B Problem");
  assert.equal(s.description, "两个数相加");
  assert.equal(s.inputDescription, "一行两个整数");
  assert.equal(s.outputDescription, "一行一个整数");
  assert.equal(s.samples.length, 1);
  assert.equal(s.samples[0].input, "1 2");
  // 时间是毫秒，原样用
  assert.equal(s.timeLimitMs, 1000);
  // 内存是字节，必须换算成 MB —— 直接显示会差三个数量级
  assert.equal(s.memoryLimitMb, 125);
  assert.equal(s.difficulty, 2);
  assert.equal(s.prompt, "背景说明");
  assert.equal(s.hint, "注意数据范围");
});

test("statementFromLuogu 字段缺失时给空值而不是崩", () => {
  const s = statementFromLuogu({}, { displayId: "P1000", title: "占位" });
  assert.equal(s.displayId, "P1000", "站点没给 pid 就用调用方的题号");
  assert.equal(s.title, "占位");
  assert.equal(s.description, "");
  assert.deepEqual(s.samples, []);
  assert.equal(s.timeLimitMs, null);
  assert.equal(s.memoryLimitMb, null);
  assert.equal(s.difficulty, null);
});

test("statementFromLuogu 难度给成字符串也能收", () => {
  const s = statementFromLuogu({ difficulty: "3" }, { displayId: "P1", title: "" });
  assert.equal(s.difficulty, 3);
});

test("difficultyLabel 按洛谷分档，越界与空值返回空串", () => {
  assert.equal(difficultyLabel(0), "暂无");
  assert.equal(difficultyLabel(1), "入门");
  assert.equal(difficultyLabel(2), "普及-");
  assert.equal(difficultyLabel(7), "NOI/NOI+/CTSC");
  assert.equal(difficultyLabel(9), "", "越界不硬编一个标签出来");
  assert.equal(difficultyLabel(-1), "");
  assert.equal(difficultyLabel(null), "");
});

const stmt: Statement = {
  displayId: "P1001",
  title: "A+B Problem",
  description: "描述正文",
  inputDescription: "输入格式",
  outputDescription: "输出格式",
  samples: [{ input: "1 2\n", output: "3\n" }],
  hint: "",
  prompt: "注意数据范围",
  timeLimitMs: 1000,
  memoryLimitMb: 256,
  difficulty: 3,
  rawMarkdown: "",
};

test("statementToMarkdown 产出可读 Markdown", () => {
  const md = statementToMarkdown(stmt);
  assert.match(md, /^# P1001 A\+B Problem/);
  assert.match(md, /难度 普及\/提高-/);
  assert.match(md, /时间限制 1000 ms · 内存限制 256 MB/);
  assert.match(md, /## 题目描述\n\n描述正文/);
  assert.match(md, /### 样例 1/);
  assert.match(md, /```\n1 2\n```/);
  assert.match(md, /## 提示\n\n注意数据范围/);
  // 空的说明段落不该出现
  assert.doesNotMatch(md, /## 说明/);
});

test("statementToMarkdown 没有难度时不硬塞一个标签", () => {
  const md = statementToMarkdown({ ...stmt, difficulty: null });
  assert.doesNotMatch(md, /难度/);
});