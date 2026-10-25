/**
 * 题面面板正文字号缩放的纯逻辑：夹紧与规整。
 *
 * 这些常量同时被 statementPanel.ts 用于「注入内联脚本」与「权威夹紧」，
 * 所以在这里把边界钉死 —— 改边界只会从这一处生效。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_MAX,
  FONT_SCALE_MIN,
  clampFontScale,
} from "../src/ui/fontScale";

test("clampFontScale：超出上限夹到上限", () => {
  assert.equal(clampFontScale(FONT_SCALE_MAX + 1), FONT_SCALE_MAX);
  assert.equal(clampFontScale(100), FONT_SCALE_MAX);
});

test("clampFontScale：低于下限夹到下限", () => {
  assert.equal(clampFontScale(FONT_SCALE_MIN - 1), FONT_SCALE_MIN);
  assert.equal(clampFontScale(0), FONT_SCALE_MIN);
});

test("clampFontScale：非有限值回落默认档", () => {
  assert.equal(clampFontScale(Number.NaN), DEFAULT_FONT_SCALE);
  assert.equal(clampFontScale(Number.POSITIVE_INFINITY), DEFAULT_FONT_SCALE);
  assert.equal(clampFontScale(Number.NEGATIVE_INFINITY), DEFAULT_FONT_SCALE);
});

test("clampFontScale：区间内规整到一位小数（去掉浮点尾数）", () => {
  assert.equal(clampFontScale(1.26), 1.3);
  assert.equal(clampFontScale(1.3000000000000003), 1.3);
  assert.equal(clampFontScale(0.85), 0.9); // 0.85 二进制是 0.8499… → round1 = 0.9
  assert.equal(clampFontScale(DEFAULT_FONT_SCALE), DEFAULT_FONT_SCALE);
});
