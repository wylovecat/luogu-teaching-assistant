import { test } from "node:test";
import assert from "node:assert/strict";
import { planProblemDisplay } from "../src/ui/layout";

test("webview 模式：题面面板占左栏，源文件开到右侧", () => {
  const plan = planProblemDisplay({ openMode: "webview", hasStatement: true, mdPath: "/w/题库/A1131/A1131.md" });
  assert.equal(plan.left, "webview");
  assert.equal(plan.leftPath, null);
  assert.equal(plan.fileBeside, true);
});

test("markdown 模式：题面 md 占左栏，源文件开到右侧", () => {
  const plan = planProblemDisplay({ openMode: "markdown", hasStatement: true, mdPath: "/w/题库/A1131/A1131.md" });
  assert.equal(plan.left, "markdown");
  assert.equal(plan.leftPath, "/w/题库/A1131/A1131.md");
  assert.equal(plan.fileBeside, true);
});

test("none 模式：不显示题面，源文件按默认位置打开", () => {
  const plan = planProblemDisplay({ openMode: "none", hasStatement: true, mdPath: "/w/A1131.md" });
  assert.equal(plan.left, null);
  assert.equal(plan.leftPath, null);
  assert.equal(plan.fileBeside, false);
});

test("题面拉取失败（hasStatement=false）时不能开空面板", () => {
  const plan = planProblemDisplay({ openMode: "webview", hasStatement: false, mdPath: null });
  assert.equal(plan.left, null);
  assert.equal(plan.fileBeside, false);
});

test("markdown 模式但没落盘 md：退回只开源文件", () => {
  const plan = planProblemDisplay({ openMode: "markdown", hasStatement: true, mdPath: null });
  assert.equal(plan.left, null);
  assert.equal(plan.fileBeside, false);
});
