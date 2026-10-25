/**
 * 「代码源文件」字号（VS Code 自己的 `editor.fontSize`）的纯逻辑。
 *
 * 盯三件事：脏值被夹住、步进从**当前实际值**起身（老师可能自己在设置里写过 13px）、
 * 到头就停住不越界 —— 调用方靠 `next === current` 判「已经到头了」并给提示。
 * 注意别和 `imgexport/codeFont.ts`（导出 PNG 里的字号）混起来：两套档位互不相干。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_EDITOR_FONT_PX,
  EDITOR_FONT_STEP_PX,
  MAX_EDITOR_FONT_PX,
  MIN_EDITOR_FONT_PX,
  clampEditorFontPx,
  editorFontHint,
  stepEditorFontPx,
} from "../src/editorFont";

test("代码字号：脏值回落默认值，其余取整并夹到区间", () => {
  assert.equal(clampEditorFontPx(undefined), DEFAULT_EDITOR_FONT_PX, "没写过设置时按默认起身");
  assert.equal(clampEditorFontPx(Number.NaN), DEFAULT_EDITOR_FONT_PX);
  assert.equal(clampEditorFontPx("16"), 16, "设置项里写成字符串也要认");
  assert.equal(clampEditorFontPx(13.6), 14, "取整");
  assert.equal(clampEditorFontPx(1), MIN_EDITOR_FONT_PX, "下限");
  assert.equal(clampEditorFontPx(999), MAX_EDITOR_FONT_PX, "上限");
});

test("代码字号：从当前实际值步进，而不是从默认值", () => {
  assert.equal(stepEditorFontPx(13, 1), 15, "老师自己写过 13px，就从 13 起身");
  assert.equal(stepEditorFontPx(13, -1), 11);
  assert.equal(stepEditorFontPx(DEFAULT_EDITOR_FONT_PX, 1), DEFAULT_EDITOR_FONT_PX + EDITOR_FONT_STEP_PX);
  assert.equal(stepEditorFontPx(20, 0), 20, "dir 为 0 不动");
});

test("代码字号：贴到端点就停住，最后一步不会被步长迈过去", () => {
  assert.equal(stepEditorFontPx(MAX_EDITOR_FONT_PX, 1), MAX_EDITOR_FONT_PX);
  assert.equal(stepEditorFontPx(MAX_EDITOR_FONT_PX - 1, 1), MAX_EDITOR_FONT_PX);
  assert.equal(stepEditorFontPx(MIN_EDITOR_FONT_PX, -1), MIN_EDITOR_FONT_PX);
  assert.equal(stepEditorFontPx(MIN_EDITOR_FONT_PX + 1, -1), MIN_EDITOR_FONT_PX);
});

test("代码字号：状态栏提示带当前值与快捷键", () => {
  assert.match(editorFontHint(18), /18px/);
  assert.match(editorFontHint(18), /Ctrl\+Alt\+=/, "提示要把快捷键写出来（不然没人知道怎么调）");
  assert.match(editorFontHint(999), /40px/, "提示里的值也走清洗");
});
