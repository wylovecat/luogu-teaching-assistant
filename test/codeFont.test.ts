/**
 * 代码图片字号的纯逻辑测试：清洗、步进、行高，以及**注入 webview 脚本的那套字号工具
 * 跟 codeFont.ts 完全同源** —— 这个模块存在的唯一理由就是「谁能改、能改到多少」只有一份事实，
 * 所以两边不一致必须是红的（白板 SHEET_RULES 的坑同源）。
 *
 * 顺带钉住面板那一层：A− / 读数 / A＋ 在、载荷带的是**清洗过**的字号、改完要把新档报回扩展进程。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type * as vscodeNs from "vscode";
import {
  CODE_FONT_FAMILY,
  CODE_FONT_STEP_PX,
  CODE_LINE_HEIGHT_RATIO,
  DEFAULT_CODE_FONT_PX,
  MAX_CODE_FONT_PX,
  MIN_CODE_FONT_PX,
  clampCodeFontPx,
  codeFontRuntime,
  codeFontSpec,
  codeLineHeight,
  stepCodeFontPx,
} from "../src/imgexport/codeFont";
import { buildCodeImageHtml, canvasLimitRuntime, pngBytes } from "../src/imgexport/exportImage";

function fakeWebview(): vscodeNs.Webview {
  return {
    cspSource: "https://file+.vscode-resource.vscode-cdn.net",
    asWebviewUri: (uri: vscodeNs.Uri) => uri,
  } as unknown as vscodeNs.Webview;
}

function codeImageHtml(opts: { fontPx?: number }): string {
  return buildCodeImageHtml({
    webview: fakeWebview(),
    fileName: "P1001.cpp",
    lines: [[{ text: "int main() { return 0; }", color: "#d4d4d4" }]],
    fontPx: opts.fontPx,
  });
}

function payloadOf(html: string): { fileName: string; lines: unknown[]; fontPx: number } {
  const m = /id="payload">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "缺少 #payload 载荷");
  return JSON.parse(m[1]) as { fileName: string; lines: unknown[]; fontPx: number };
}

/** 把注入 webview 的那几行代码真跑一遍（面板脚本里的字号工具就是这么来的）。 */
function loadRuntime(): {
  clampFontPx: (px: number) => number;
  fontSpec: (px: number) => string;
  lineHeight: (px: number) => number;
  FONT_FAMILY: string;
  FONT_MIN: number;
  FONT_MAX: number;
  FONT_STEP: number;
  FONT_RATIO: number;
} {
  const factory = new Function(`${codeFontRuntime()}
return { clampFontPx, fontSpec, lineHeight, FONT_FAMILY, FONT_MIN, FONT_MAX, FONT_STEP, FONT_RATIO };`);
  return factory() as ReturnType<typeof loadRuntime>;
}

test("代码字号：默认档与老版本写死的 14px 一致，清洗夹到 8–32 并取整", () => {
  assert.equal(DEFAULT_CODE_FONT_PX, 14, "默认档变了，所有老用户导出的图就会换尺寸");
  assert.equal(MIN_CODE_FONT_PX, 8);
  assert.equal(MAX_CODE_FONT_PX, 32);
  assert.equal(clampCodeFontPx(Number.NaN), DEFAULT_CODE_FONT_PX, "非有限值回落默认档");
  assert.equal(clampCodeFontPx(Number.POSITIVE_INFINITY), DEFAULT_CODE_FONT_PX);
  assert.equal(clampCodeFontPx(0), MIN_CODE_FONT_PX);
  assert.equal(clampCodeFontPx(999), MAX_CODE_FONT_PX);
  assert.equal(clampCodeFontPx(15.6), 16, "字号取整：小数会让行号栏和行高都错位");
});

test("代码字号：一刀 2px，到头停住，默认档能走到两个端点", () => {
  assert.equal(CODE_FONT_STEP_PX, 2, "步长变了要同步改设置项的说明与面板 title");
  assert.equal(stepCodeFontPx(14, 1), 16);
  assert.equal(stepCodeFontPx(14, -1), 12);
  assert.equal(stepCodeFontPx(MIN_CODE_FONT_PX, -1), MIN_CODE_FONT_PX, "到头就停在最小档");
  assert.equal(stepCodeFontPx(MAX_CODE_FONT_PX, 1), MAX_CODE_FONT_PX, "到头就停在最大档");
  assert.equal(stepCodeFontPx(15, 1), 17, "步进是相对当前值，手改过的奇数档也能继续走");
  assert.equal(stepCodeFontPx(Number.NaN, 1), 16, "脏值按默认档往上走");

  // 14 ± 2k 要能正好踩到 8 和 32，否则某些档位永远调不到（改了步长就会红）
  let px = DEFAULT_CODE_FONT_PX;
  for (let i = 0; i < 20; i++) px = stepCodeFontPx(px, 1);
  assert.equal(px, MAX_CODE_FONT_PX, "从默认档一路调大必须能到最大档");
  for (let i = 0; i < 20; i++) px = stepCodeFontPx(px, -1);
  assert.equal(px, MIN_CODE_FONT_PX, "一路调小必须能到最小档");
});

test("代码字号：行高与 canvas font 简写（默认仍是 21px 行高）", () => {
  assert.equal(codeLineHeight(DEFAULT_CODE_FONT_PX), 21, "默认档的行高要和历史写死的 21px 一致");
  assert.equal(CODE_LINE_HEIGHT_RATIO, 1.5);
  for (const px of [8, 13, 14, 21, 32]) {
    assert.equal(codeLineHeight(px), Math.round(px * 1.5), `${px}px 的行高`);
  }
  assert.equal(codeLineHeight(999), Math.round(MAX_CODE_FONT_PX * 1.5), "越界值与最大档同结果");
  assert.equal(codeFontSpec(14), `14px ${CODE_FONT_FAMILY}`);
  assert.match(codeFontSpec(999), /^32px /, "简写里的字号也要先清洗");
  assert.ok(!codeFontSpec(14).includes("undefined"));
});

test("代码字号：注入面板脚本的工具与 codeFont.ts 同源（两份事实立刻红）", () => {
  const rt = loadRuntime();
  assert.equal(rt.FONT_FAMILY, CODE_FONT_FAMILY);
  assert.equal(rt.FONT_MIN, MIN_CODE_FONT_PX);
  assert.equal(rt.FONT_MAX, MAX_CODE_FONT_PX);
  assert.equal(rt.FONT_STEP, CODE_FONT_STEP_PX);
  assert.equal(rt.FONT_RATIO, CODE_LINE_HEIGHT_RATIO);

  for (const px of [-5, 0, 7.4, 8, 13, 14, 14.5, 15.6, 16, 21, 31, 32, 33, 99, Number.NaN]) {
    const mine = clampCodeFontPx(px);
    assert.equal(rt.clampFontPx(px), mine, `clampFontPx(${px})`);
    assert.equal(rt.fontSpec(rt.clampFontPx(px)), codeFontSpec(px), `fontSpec(${px})`);
    assert.equal(rt.lineHeight(rt.clampFontPx(px)), codeLineHeight(px), `lineHeight(${px})`);
  }
});

test("代码图片面板：字号控件在动作行、载荷带清洗过的字号，CSP 不松", () => {
  const html = codeImageHtml({ fontPx: 14 });
  for (const id of ["save", "canvas", "payload", "font-minus", "fontsize", "font-plus"]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`);
  }
  assert.match(
    html,
    /id="font-minus"[\s\S]*?id="fontsize"[\s\S]*?id="font-plus"/,
    "A− / 读数 / A＋ 的顺序不能乱（读数是两边的中间态）",
  );
  assert.match(html, /<span id="fontsize"[^>]*>14px<\/span>/, "首帧读数就是当前字号，别等脚本跑起来才显示");
  assert.match(html, /#save \{\s*display\s*:\s*none;\s*\}/, "保存按钮仍由脚本显式打开");
  assert.match(html, /command:'fontSize'/, "改完字号要把新档报回扩展进程，否则下次导出又回到旧字号");
  assert.match(html, /e\.key === '-'[\s\S]{0,160}e\.key === '='/, "面板里 - / = 也能调字号");
  assert.match(html, /script-src 'nonce-/);
  assert.ok(!/script-src[^"]*unsafe-inline/.test(html), "script-src 不能放开 unsafe-inline");

  assert.equal(payloadOf(html).fontPx, 14);
  assert.equal(payloadOf(html).fileName, "P1001.cpp", "标题栏文件名走载荷");

  const noFont = codeImageHtml({});
  assert.equal(payloadOf(noFont).fontPx, DEFAULT_CODE_FONT_PX, "不传字号就是默认档");

  const dirty = codeImageHtml({ fontPx: 999 });
  assert.equal(payloadOf(dirty).fontPx, MAX_CODE_FONT_PX, "载荷里的字号要清洗过");
  assert.match(dirty, /<span id="fontsize"[^>]*>32px<\/span>/, "读数也要跟着清洗");
});

test("代码图片面板：洛谷没有班级文件那种去处，上传入口不许长回来", () => {
  const html = codeImageHtml({ fontPx: 14 });
  assert.ok(!html.includes('id="upload"'), "图片面板不该有上传按钮");
  assert.ok(!html.includes("command:'upload'"), "也不该有上传消息通道");
});

// ── 画布上限与「空图当成成功」的防护 ────────────────────────────────────
//
// 这一组针对的是一个**静默**故障：Chromium 的 canvas 超过上限时**不抛错**，
// `toDataURL()` 只给一个 "data:,"。旧实现直接把它写盘 —— 老师看到「已保存图片」，
// 点开却是一个 0 字节的坏 PNG。这组断言守住「不把空图当成功」。

/** 一张真 PNG 的最小合法载荷（1×1 像素，IHDR + IDAT + IEND 都带上）。 */
function realPngBase64(): string {
  const bytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // 签名
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, // IDAT
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND
    0x42, 0x60, 0x82,
  ]);
  return bytes.toString("base64");
}

test("画布超限的产物（\"data:,\"）不许被当成一张成功的图写盘", () => {
  // 画布超限时 Chromium 给的就是这个：写盘会得到 0 字节 PNG，而面板上显示「已保存图片」
  assert.equal(pngBytes("data:,"), null, "\"data:,\" 必须被拒（否则会写出 0 字节 PNG）");
  assert.equal(pngBytes("data:image/png;base64,"), null, "空载荷必须被拒");
  assert.equal(pngBytes("data:image/png;base64,!!!!"), null, "不是 base64 的载荷必须被拒");
  assert.equal(pngBytes("data:text/plain;base64,aGk="), null, "不是 PNG 的 MIME 必须被拒");
  assert.equal(pngBytes(""), null);
  assert.equal(pngBytes(undefined as unknown as string), null, "非字符串不许崩");
});

test("真 PNG 才放行，且拿到的字节带正确的 PNG 签名", () => {
  const url = `data:image/png;base64,${realPngBase64()}`;
  const bytes = pngBytes(url);
  assert.ok(bytes, "合法的 PNG 不该被拒");
  assert.deepEqual(
    [...bytes.slice(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "PNG 签名不对",
  );
  // 签名不对的载荷（头几字节被改坏）必须被拒 —— 只看 MIME 前缀是不够的
  const broken = Buffer.from(realPngBase64(), "base64");
  broken[1] = 0x00;
  assert.equal(pngBytes(`data:image/png;base64,${broken.toString("base64")}`), null, "签名坏了必须被拒");
});

test("画布上限判据：单边或总面积越界都算超限，正常尺寸放行", () => {
  const factory = new Function(`${canvasLimitRuntime()}
return { canvasTooLarge, MAX_CANVAS_SIDE, MAX_CANVAS_AREA };`) as () => {
    canvasTooLarge: (w: number, h: number) => boolean;
    MAX_CANVAS_SIDE: number;
    MAX_CANVAS_AREA: number;
  };
  const rt = factory();
  assert.ok(rt.MAX_CANVAS_SIDE > 0 && rt.MAX_CANVAS_AREA > 0, "上限常量不该是 0（那样什么都超限）");
  assert.equal(rt.canvasTooLarge(1240, 1754), false, "正常的 A4 尺寸不该被判超限");
  assert.equal(rt.canvasTooLarge(rt.MAX_CANVAS_SIDE + 1, 100), true, "单边越界必须判超限");
  assert.equal(rt.canvasTooLarge(100, rt.MAX_CANVAS_SIDE + 1), true, "另一边越界也要判超限");
  assert.equal(rt.canvasTooLarge(20000, 20000), true, "单边没超但面积超了，也要判超限");
  assert.equal(rt.canvasTooLarge(0, 100), true, "尺寸非法（0）要判超限");
  assert.equal(rt.canvasTooLarge(Number.NaN, 100), true, "尺寸非法（NaN）要判超限");
});

test("代码图片面板：画布上限与空图校验都在面板脚本里（不然超限时只有一张空图）", () => {
  const html = codeImageHtml({ fontPx: 14 });
  assert.match(html, /canvasTooLarge\(pxW, pxH\)/, "画之前没问尺寸（超限时 Chromium 只给空图）");
  assert.match(html, /data:image\/png/, "空图校验没写进面板");
  assert.match(html, /command:'error'/, "画布出错时要能报给扩展进程（否则点保存彻底没反应）");
});
