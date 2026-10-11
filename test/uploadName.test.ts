import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeName, stripEventPrefix, uploadImageName } from "../src/problems/uploadName";

test("题名前缀的赛事/时间信息整段去掉", () => {
  assert.equal(stripEventPrefix("【2024年CSP-J第一轮】最大子段和"), "最大子段和");
  assert.equal(stripEventPrefix("[NOIP2018] 铺设道路"), "铺设道路");
  assert.equal(stripEventPrefix("［入门］A+B Problem"), "A+B Problem");
  // 连着几段都要剥
  assert.equal(stripEventPrefix("【2024】[CSP-J] 最大子段和"), "最大子段和");
  // 没有括号前缀时原样返回
  assert.equal(stripEventPrefix("公路"), "公路");
  // 整个题名就是括号信息时剥成空串，由调用方兜底
  assert.equal(stripEventPrefix("  【2024年CSP-J】  "), "");
});

test("默认文件名：<题号>_<题名>_code.png", () => {
  assert.equal(uploadImageName("A1131", "【2024年CSP-J第一轮】最大子段和"), "A1131_最大子段和_code.png");
  assert.equal(uploadImageName("A1131", "公路"), "A1131_公路_code.png");
  assert.equal(uploadImageName("B2404", "[NOIP2018] 铺设道路"), "B2404_铺设道路_code.png");
});

test("兜底：题名剥空了退回原名，题名本身为空就只留题号", () => {
  assert.equal(uploadImageName("A1131", "【2024年CSP-J】"), "A1131_【2024年CSP-J】_code.png");
  assert.equal(uploadImageName("A1131", ""), "A1131_code.png");
  assert.equal(uploadImageName("A1131", "   "), "A1131_code.png");
});

test("文件名里不能出现的字符换成下划线（会变成对象键与站点文件名）", () => {
  assert.equal(sanitizeName('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(uploadImageName("A1131", "a/b:c*d?e"), "A1131_a_b_c_d_e_code.png");
  // 控制字符也要清掉，否则能拿它伪造下载直链
  assert.equal(sanitizeName("a\u0000b\nc"), "a_b_c");
});
