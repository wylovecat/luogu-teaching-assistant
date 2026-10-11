/**
 * 白板纯逻辑测试：A4 分页、坐标变换、压感笔迹轮廓、批注清洗与落盘上限，
 * 以及面板 HTML 的 CSP 与载荷（真面板要登录态，冒烟测试里拿不到，所以在这一层钉住）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type * as vscode from "vscode";
import { buildWhiteboardHtml } from "../src/whiteboard/panelHtml";
import { collectFontUrls, inlineFontSources } from "../src/whiteboard/fontCss";
import { FrameLoop, type FrameScheduler } from "../src/whiteboard/frameLoop";
import { whiteboardStatementMarkdown } from "../src/whiteboard/source";
import type { Statement } from "../src/problems/statement";
import {
  DEFAULT_EXPORT_DPI,
  DEFAULT_PEN_COLOR,
  DEFAULT_STROKE_WIDTH,
  ERASER_RADIUS,
  EXPORT_HEIGHT,
  EXPORT_WIDTH,
  KNOWLEDGE_BOARD_PAGES_KEY,
  KNOWLEDGE_BOARD_STATE_KEY,
  MAX_EXPORT_DPI,
  MAX_PAGES,
  MAX_PERSIST_BYTES,
  MAX_STROKE_WIDTH,
  MIN_EXPORT_DPI,
  MIN_STROKE_WIDTH,
  MOUSE_PRESSURE,
  PAGE_HEIGHT,
  PAGE_WIDTH,
  PENS,
  PEN_WIDTHS,
  SHEET_CSS,
  SHEET_RULES,
  clampExportDpi,
  clampPageCount,
  clampPressure,
  clampStrokeWidth,
  clampZoom,
  distanceToSegment,
  exportPixels,
  exportScale,
  pageTop,
  pagesHeight,
  penBarHeight,
  resolvePageCount,
  sanitizeStrokes,
  screenToWorld,
  sheetContentHeight,
  strokeHitByPoint,
  strokeOutline,
  strokesToPersist,
  totalPageCount,
  whiteboardFileStem,
  whiteboardPagesKey,
  whiteboardStateKey,
  worldToScreen,
  zoomAt,
  type Stroke,
} from "../src/whiteboard/model";

// ── A4 分页与尺寸 ───────────────────────────────────────────────────────

test("A4 尺寸：页面 CSS px 与默认 150dpi 导出像素对得上", () => {
  assert.ok(Math.abs(PAGE_WIDTH - 793.7) < 0.05, `页面宽应为 793.7，实际 ${PAGE_WIDTH}`);
  assert.ok(Math.abs(PAGE_HEIGHT - 1122.5) < 0.05, `页面高应为 1122.5，实际 ${PAGE_HEIGHT}`);
  // 默认档 = 150dpi → A4 1240 × 1754
  assert.equal(DEFAULT_EXPORT_DPI, 150);
  assert.deepEqual(exportPixels(), { width: 1240, height: 1754 });
  assert.equal(EXPORT_WIDTH, 1240);
  assert.equal(EXPORT_HEIGHT, 1754);
  const s = exportScale();
  assert.ok(Math.abs(s.x - 1.562) < 0.01, `横向导出比例 ${s.x}`);
  assert.ok(Math.abs(s.y - 1.563) < 0.01, `纵向导出比例 ${s.y}`);
  // 打印档：300dpi 还是 2480 × 3508（设置里能调回去）
  assert.deepEqual(exportPixels(300), { width: 2480, height: 3508 });
});

test("导出 dpi：脏值被夹到 72–600，非数字回落默认档", () => {
  assert.equal(clampExportDpi(Number.NaN), DEFAULT_EXPORT_DPI);
  assert.equal(clampExportDpi(Number.POSITIVE_INFINITY), DEFAULT_EXPORT_DPI);
  assert.equal(clampExportDpi(10), MIN_EXPORT_DPI);
  assert.equal(clampExportDpi(9999), MAX_EXPORT_DPI);
  assert.equal(clampExportDpi(300.4), 300, "只取整，不四舍五入到别的档");
  assert.deepEqual(exportPixels(600), { width: 4961, height: 7016 });
});

test("分页：空内容/恰好一页都算一页，超 1px 就分第二页", () => {
  assert.equal(totalPageCount(0), 1);
  assert.equal(totalPageCount(-5), 1);
  assert.equal(totalPageCount(Number.NaN), 1);
  assert.equal(totalPageCount(10), 1);
  assert.equal(totalPageCount(PAGE_HEIGHT), 1);
  assert.equal(totalPageCount(PAGE_HEIGHT + 1), 2);
  assert.equal(totalPageCount(PAGE_HEIGHT * 3), 3);
  assert.equal(totalPageCount(PAGE_HEIGHT * 3 + 1), 4);
});

test("分页：纸张显示高度按整页撑开，页偏移按整页步进", () => {
  assert.equal(sheetContentHeight(0), PAGE_HEIGHT);
  assert.equal(sheetContentHeight(100), PAGE_HEIGHT);
  assert.equal(sheetContentHeight(PAGE_HEIGHT * 2 + 5), PAGE_HEIGHT * 3, "多出一点也要补满整页");
  assert.equal(pageTop(0), 0);
  assert.equal(pageTop(2), PAGE_HEIGHT * 2);
});

test("分页：默认一页，手动加的页只在需要时才铺出来", () => {
  assert.equal(resolvePageCount(0, 1), 1, "空内容就是一页，不该凭空多出第二页");
  assert.equal(resolvePageCount(120, 1), 1, "短题面只有一页");
  assert.equal(resolvePageCount(0, 3), 3, "加过页就按加出来的页数铺");
  assert.equal(resolvePageCount(PAGE_HEIGHT * 2, 1), 2, "题面长到两页，不用手动加也照两页算");
  assert.equal(resolvePageCount(PAGE_HEIGHT * 2, 5), 5);
  assert.equal(resolvePageCount(PAGE_HEIGHT * 3 + 1, 2), 4);
});

test("页数清洗：非有限值/0/负数/小数/离谱大值都夹回合法区间", () => {
  assert.equal(clampPageCount(Number.NaN), 1);
  assert.equal(clampPageCount(-3), 1);
  assert.equal(clampPageCount(0), 1);
  assert.equal(clampPageCount(2.7), 2);
  assert.equal(clampPageCount(1e9), MAX_PAGES, "脏数据不能把纸张撑到天上去");
  assert.equal(pagesHeight(0), PAGE_HEIGHT, "页数再脏也至少一页");
  assert.equal(pagesHeight(3), PAGE_HEIGHT * 3);
});

test("加页数落盘 key：与批注分开存，知识面板单独一份", () => {
  assert.equal(whiteboardPagesKey("A1131"), "lgAssist.whiteboard.A1131.pages");
  assert.equal(whiteboardPagesKey(""), "lgAssist.whiteboard.untitled.pages");
  assert.equal(KNOWLEDGE_BOARD_PAGES_KEY, `${KNOWLEDGE_BOARD_STATE_KEY}.pages`);
  assert.notEqual(KNOWLEDGE_BOARD_PAGES_KEY, whiteboardPagesKey("知识面板"), "知识面板的页数不能和某道题串");
});

// ── 坐标变换 ────────────────────────────────────────────────────────────

test("坐标变换：世界↔屏幕在缩放平移下互逆", () => {
  const view = { zoom: 1.75, panX: -120, panY: 33.5 };
  const [sx, sy] = worldToScreen(300, 700, view);
  const [wx, wy] = screenToWorld(sx, sy, view);
  assert.ok(Math.abs(wx - 300) < 1e-9);
  assert.ok(Math.abs(wy - 700) < 1e-9);
});

test("缩放：锚点下的世界坐标不动，且 zoom 被夹在 0.25~4", () => {
  const view = { zoom: 1, panX: 20, panY: 10 };
  const anchor = { x: 400, y: 300 };
  const before = screenToWorld(anchor.x, anchor.y, view);
  const zoomed = zoomAt(view, anchor.x, anchor.y, 1.8);
  const after = screenToWorld(anchor.x, anchor.y, zoomed);
  assert.ok(Math.abs(after[0] - before[0]) < 1e-9, "锚点 x 漂移了");
  assert.ok(Math.abs(after[1] - before[1]) < 1e-9, "锚点 y 漂移了");
  assert.equal(zoomAt(view, 0, 0, 100).zoom, 4);
  assert.equal(zoomAt(view, 0, 0, 0.0001).zoom, 0.25);
  assert.equal(clampZoom(Number.NaN), 1);
});

// ── 压感 ────────────────────────────────────────────────────────────────

function extentAt(outline: number[][], from: number, to: number): number {
  // 沿 x 取一段，看轮廓在这段的 y 跨度 —— 就是这一段的笔画宽度
  const ys: number[] = [];
  for (const [x, y] of outline) if (x >= from && x <= to) ys.push(y);
  assert.ok(ys.length > 1, `x∈[${from},${to}] 区间没有轮廓点`);
  return Math.max(...ys) - Math.min(...ys);
}

function straightStroke(pressures: number[]): Stroke {
  const points = pressures.map((_, i) => [i * 10, 0]);
  return { color: DEFAULT_PEN_COLOR, width: DEFAULT_STROKE_WIDTH, points, pressures };
}

test("压感：等压（鼠标恒 0.5）画出来是等宽线", () => {
  const stroke = straightStroke(new Array(16).fill(MOUSE_PRESSURE));
  const outline = strokeOutline(stroke);
  const head = extentAt(outline, 0, 40);
  const tail = extentAt(outline, 110, 150);
  assert.ok(head > 0 && tail > 0, "轮廓不该塌成 0");
  assert.ok(Math.abs(head - tail) / head < 0.2, `等压线宽应基本一致：${head} vs ${tail}`);
});

test("压感：真笔压力变化时线宽跟着变（防 simulatePressure 传错）", () => {
  const ramp = Array.from({ length: 16 }, (_, i) => 0.05 + (i / 15) * 0.95);
  const outline = strokeOutline(straightStroke(ramp));
  const light = extentAt(outline, 0, 30);
  const heavy = extentAt(outline, 120, 150);
  assert.ok(heavy > light * 1.3, `压力大的那端应明显更粗：${light} → ${heavy}`);

  const reversed = strokeOutline(straightStroke([...ramp].reverse()));
  assert.ok(
    extentAt(reversed, 0, 30) > light * 1.3,
    "把压力序列反过来，粗细也应该反过来（说明用的是真实压力而不是速度模拟）",
  );
});

test("压力清洗：0/NaN/负数夹到小正数，>1 夹到 1", () => {
  assert.equal(clampPressure(0), 0.05);
  assert.equal(clampPressure(Number.NaN), 0.05);
  assert.equal(clampPressure(-1), 0.05);
  assert.equal(clampPressure(3), 1);
  assert.equal(clampPressure(0.42), 0.42);
});

// ── 笔宽档位 ────────────────────────────────────────────────────────────

test("笔宽档位：细→粗升序，且默认档就在档位表里（否则工具条上一档都不亮）", () => {
  assert.ok(PEN_WIDTHS.length >= 3, `档位太少：${PEN_WIDTHS.length}`);
  const values = PEN_WIDTHS.map((w) => w.value);
  assert.deepEqual(values, [...values].sort((a, b) => a - b), `档位要按粗细升序：${values.join(", ")}`);
  assert.ok(values.includes(DEFAULT_STROKE_WIDTH), "默认笔宽必须是某一档");
  assert.deepEqual(
    PEN_WIDTHS.map((w) => w.label),
    ["极细", "细", "中", "粗", "特粗"],
  );
});

test("笔宽清洗：非正值回落到默认档，极端值夹进合法区间，正常值原样保留", () => {
  assert.equal(clampStrokeWidth(0), DEFAULT_STROKE_WIDTH);
  assert.equal(clampStrokeWidth(Number.NaN), DEFAULT_STROKE_WIDTH);
  assert.equal(clampStrokeWidth(-2), DEFAULT_STROKE_WIDTH);
  assert.equal(clampStrokeWidth(1e6), MAX_STROKE_WIDTH, "脏数据别画出个巨型色块");
  assert.equal(clampStrokeWidth(0.001), MIN_STROKE_WIDTH);
  for (const w of PEN_WIDTHS) assert.equal(clampStrokeWidth(w.value), w.value, `「${w.label}」档不该被改写`);

  // 落盘/恢复走的是同一条清洗路径：加档位之前画的批注（width 都是 1）必须原样留着
  const [kept] = sanitizeStrokes([{ color: "#000000", width: 3, points: [[1, 1]], pressures: [0.5] }]);
  assert.equal(kept.width, 3, "合规范笔宽不该被改写");
  const [legacy] = sanitizeStrokes([{ color: "#000000", width: 1, points: [[1, 1]], pressures: [0.5] }]);
  assert.equal(legacy.width, 1, "老批注的默认笔宽应原样保留");
});

test("工具条上的笔宽条块：每档高度都不一样，且随档位单调加粗", () => {
  const bars = PEN_WIDTHS.map((w) => penBarHeight(w.value));
  assert.deepEqual(bars, [...bars].sort((a, b) => a - b), `条块高度要单调递增：${bars.join(", ")}`);
  assert.equal(
    new Set(bars).size,
    bars.length,
    `每档都得一眼分得出来（尤其是极细与细），不能有两档一样高：${bars.join(", ")}`,
  );
  assert.ok(bars[0] >= 1, `最细档也得看得见，实际 ${bars[0]}px`);
  assert.ok(bars[bars.length - 1] <= 20, `最粗档别把 26px 的按钮撑满，实际 ${bars[bars.length - 1]}px`);
});

test("空笔画不产生轮廓", () => {
  assert.deepEqual(strokeOutline({ color: "#000000", width: 1, points: [], pressures: [] }), []);
});

test("轮廓：含非有限坐标时要么给干净轮廓、要么给空，绝不交出 NaN 串", () => {
  const mk = (points: number[][]): Stroke => ({ color: "#000000", width: 1, points, pressures: points.map(() => 0.5) });
  const cases = [mk([[0, 0], [Number.NaN, 10], [20, 20]]), mk([[0, 0], [10, 10], [Number.POSITIVE_INFINITY, 20]])];
  for (const stroke of cases) {
    const outline = strokeOutline(stroke);
    assert.ok(
      outline.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)),
      `轮廓里出现了非有限坐标：${JSON.stringify(outline.slice(0, 3))}`,
    );
  }
  // canvas 遇到非有限坐标会静默不画，所以这种输入宁可报「空轮廓」，也不能悄悄画不出来
  assert.equal(strokeOutline(cases[0]).length, 0, "退化输入应给空轮廓");
  assert.ok(strokeOutline(mk([[0, 0], [10, 10], [20, 20]])).length >= 3, "正常输入照常有轮廓");
});

// ── 批注清洗与落盘 ──────────────────────────────────────────────────────

test("sanitizeStrokes：丢掉脏数据、补齐压力、认下颜色白名单", () => {
  const cleaned = sanitizeStrokes([
    { color: "#d63031", width: 2, points: [[1.234, 2.345], [3, 4]], pressures: [0.5] },
    { color: "红色", width: 0, points: [[1, 1]], pressures: [] },
    { points: "nope" },
    null,
    { points: [[1, Number.NaN]] },
  ]);
  assert.equal(cleaned.length, 2, `应只留下两条合法笔画：${JSON.stringify(cleaned)}`);
  assert.equal(cleaned[0].color, "#d63031");
  assert.equal(cleaned[0].points[0][0], 1.23, "坐标应压到 2 位小数");
  assert.equal(cleaned[0].pressures.length, 2, "压力不足的要补齐");
  assert.equal(cleaned[1].color, DEFAULT_PEN_COLOR, "非法颜色回落到默认笔色");
  assert.equal(cleaned[1].width, DEFAULT_STROKE_WIDTH, "非法笔宽回落到默认值");
});

test("落盘上限：小数据照存，超 2MB 放弃并给出字节数", () => {
  const small = sanitizeStrokes([{ color: "#000000", width: 1, points: [[0, 0], [10, 10]], pressures: [0.5, 0.5] }]);
  const ok = strokesToPersist(small);
  assert.deepEqual(ok.value, small);
  assert.ok(ok.bytes > 0);

  assert.deepEqual(strokesToPersist([]), { value: [], bytes: 2 });

  // 造一条确定超过上限的笔画。注意断言顺序：先断字节数（失败信息里只有数字），
  // 再断 value —— 反过来的话，失败信息会把 20 万个点的数组整个打印出来（直接把测试进程撑爆）。
  const points: number[][] = [];
  for (let i = 0; i < 200000; i++) points.push([i, 2 * i]);
  const over = strokesToPersist([{ color: "#000000", width: 1, points, pressures: points.map(() => 0.5) }]);
  assert.ok(over.bytes > MAX_PERSIST_BYTES, `字节数应超上限，实际 ${over.bytes}`);
  assert.equal(over.value, null, "超大应放弃保存");
});

test("批注按题号分文件存，题号为空时用 untitled", () => {
  assert.equal(whiteboardStateKey("A1131"), "lgAssist.whiteboard.A1131");
  assert.equal(whiteboardStateKey("  "), "lgAssist.whiteboard.untitled");
});

test("批注落盘 key：知识面板单独一份，和任何题目都串不起来", () => {
  assert.equal(KNOWLEDGE_BOARD_STATE_KEY, "lgAssist.knowledgeBoard");
  // 就算真有题号叫 knowledge，两块板的批注也落在不同的 key 上
  assert.notEqual(KNOWLEDGE_BOARD_STATE_KEY, whiteboardStateKey("knowledge"));
});

test("导出文件名：`题号 题目名`，缺一半就用另一半，都缺退回「题目」", () => {
  assert.equal(whiteboardFileStem("A1131", "公路"), "A1131 公路");
  assert.equal(whiteboardFileStem("", "公路"), "公路");
  assert.equal(whiteboardFileStem("A1131", ""), "A1131");
  assert.equal(whiteboardFileStem("  ", "  "), "题目");
  assert.equal(whiteboardFileStem("A1131", "  "), "A1131", "题名空白时不该留下尾随空格");
});

test("导出文件名：清掉文件名不能有的字符、压掉多余空白、去掉结尾的点", () => {
  // 题名里带 \ / : * ? " < > | 的，直接落盘在 Windows 上会失败
  assert.equal(whiteboardFileStem("A1", 'a/b\\c:d*e?f"g<h>i|j'), "A1 a_b_c_d_e_f_g_h_i_j");
  assert.equal(whiteboardFileStem("A1", "公路\n\t 最长路"), "A1 公路 最长路");
  assert.equal(whiteboardFileStem("A1", "算 24 点."), "A1 算 24 点", "结尾的点会被 Windows 吃掉，提前去掉");
  // 导出文件名剥掉赛事/时间前缀（与上传班级文件那条路一致）
  assert.equal(whiteboardFileStem("A1131", "【2024年CSP-J第一轮】最大子段和"), "A1131 最大子段和");
  assert.equal(whiteboardFileStem("A1131", "[NOIP2018] 铺设道路"), "A1131 铺设道路");
  // 整个题名就是一个括号时不能剥成空，退回原题名（否则导出文件只剩「A1131」）
  assert.equal(whiteboardFileStem("A1131", "【2024年CSP-J】"), "A1131 【2024年CSP-J】");
  // 题号里没有括号，不能被剥
  assert.equal(whiteboardFileStem("【A1】", "公路"), "【A1】 公路");
});

// ── 字体内联（导出用） ──────────────────────────────────────────────────

test("collectFontUrls：去重、保序、跳过 data: URI", () => {
  const css = `@font-face{src:url(fonts/a.woff2) format('woff2'),url("fonts/a.ttf") format('truetype')}
@font-face{src:url(fonts/a.woff2) format('woff2')}
.x{background:url(data:image/png;base64,AAA)}`;
  assert.deepEqual(collectFontUrls(css), ["fonts/a.woff2", "fonts/a.ttf"]);
});

test("inlineFontSources：整条 src 换成内联 woff2；拿不到 dataURI 的保持原样", () => {
  const css = "@font-face{src:url(fonts/a.woff2) format('woff2'),url(fonts/a.ttf) format('truetype')}";
  const out = inlineFontSources(css, new Map([["fonts/a.woff2", "data:font/woff2;base64,QUJD"]]));
  assert.match(out, /src: url\(data:font\/woff2;base64,QUJD\) format\('woff2'\)/);
  assert.ok(!out.includes("fonts/a.ttf"), "已被内联的那条 src 不该再留 ttf");

  const untouched = inlineFontSources(css, new Map());
  assert.equal(untouched, css, "没有可用的 dataURI 时不应改动");
});

test("打包只拷 woff2：.ttf/.woff 是各约 500/300 KB 的死重，不该进 .vsix", () => {
  // 这条不能去读 dist/katex/fonts —— 那是构建产物，`npm test` 跑在构建之前
  // （CI 上更是全新 checkout），断言它必然又红又飘。改为断言两件恒真的事：
  // ①拷贝逻辑只放行 woff2；②只拷 woff2 确实是够的（每条 @font-face 的首选 url 都是 woff2）。
  const build = fs.readFileSync(path.join(__dirname, "..", "esbuild.js"), "utf8");
  assert.match(build, /\.woff2/, "esbuild.js 的字体过滤条件被删了？");
  assert.ok(!/cpSync\([^)]*fonts/.test(build), "esbuild.js 又改回整目录拷贝字体了？");

  const katexCss = fs.readFileSync(
    path.join(__dirname, "..", "node_modules", "katex", "dist", "katex.min.css"),
    "utf8",
  );
  const srcs = [...katexCss.matchAll(/src\s*:\s*([^;}]*)/g)].map((m) => m[1] as string);
  assert.ok(srcs.length > 0, "katex.min.css 里没解析到 @font-face 的 src");
  for (const src of srcs) {
    const first = /url\(\s*['"]?([^'")]+)/.exec(src)?.[1] ?? "";
    assert.match(first, /\.woff2$/i, `首选字体不是 woff2，只拷 woff2 会掉字形：${first}`);
  }
});

// ── 白板纸张内容（只留白名单几段） ──────────────────────────────

function baseStatement(over: Partial<Statement> = {}): Statement {
  return {
    displayId: "A1131",
    title: "公路",
    description: "题目描述正文",
    inputDescription: "输入格式正文",
    outputDescription: "输出格式正文",
    samples: [
      { input: "1 2", output: "3" },
      { input: "10 20", output: "30" },
    ],
    hint: "说明（背景介绍）",
    prompt: "提示正文",
    timeLimitMs: 1000,
    memoryLimitMb: 256,
    difficulty: 3,
    rawMarkdown: "## 站点原始 markdown\n\n不该被用到的正文",
    ...over,
  };
}

test("白板题面：只留标题 + 题目描述/输入格式/输出格式/一组样例/提示", () => {
  const md = whiteboardStatementMarkdown(baseStatement());
  assert.match(md, /^# A1131 公路/);
  for (const title of ["## 题目描述", "## 输入格式", "## 输出格式", "## 样例", "## 提示"]) {
    assert.ok(md.includes(title), `缺 ${title}`);
  }
  assert.ok(!md.includes("## 说明"), "说明不该进白板");
  assert.ok(!md.includes("时间限制"), "时间/内存限制不该进白板");
  assert.ok(!md.includes("10 20"), "只保留第一组样例");
  assert.equal((md.match(/\*\*输入\*\*/g) ?? []).length, 1, "样例只该有一组");
  assert.ok(!md.includes("站点原始 markdown"), "有正规字段时不该用原始 markdown");
});

test("白板题面：缺字段不留空小节；一点正文都没有时才退回原始 markdown", () => {
  const partial = whiteboardStatementMarkdown(baseStatement({ samples: [], prompt: "" }));
  assert.ok(!partial.includes("## 样例"), "没有样例就不该有样例小节");
  assert.ok(!partial.includes("## 提示"), "提示为空就不该有提示小节");
  assert.ok(partial.includes("## 题目描述"), "其余小节照常");

  const rawOnly = whiteboardStatementMarkdown({
    ...baseStatement(),
    description: "",
    inputDescription: "",
    outputDescription: "",
    samples: [],
    prompt: "",
    rawMarkdown: "只有原始 markdown",
  });
  assert.equal(rawOnly, "只有原始 markdown");

  const nothing = whiteboardStatementMarkdown({
    ...baseStatement(),
    displayId: "",
    title: "",
    description: "",
    inputDescription: "",
    outputDescription: "",
    samples: [],
    prompt: "",
    rawMarkdown: "   ",
  });
  assert.equal(nothing, "", "什么都没有时应给空串，而不是一个空标题");
});

// ── 橡皮擦判定 ──────────────────────────────────────────────────

test("橡皮擦：划到墨迹上算命中，离得远不算", () => {
  const stroke: Stroke = { color: "#000000", width: 1, points: [[0, 0], [100, 0]], pressures: [0.5, 0.5] };
  assert.ok(strokeHitByPoint(stroke, 50, 0, ERASER_RADIUS), "压在线段上应命中");
  assert.ok(strokeHitByPoint(stroke, 50, 6, ERASER_RADIUS), "挨着线也该命中（容差含笔宽）");
  assert.ok(!strokeHitByPoint(stroke, 50, 60, ERASER_RADIUS), "离得远不该命中");
  assert.ok(!strokeHitByPoint(stroke, 200, 0, ERASER_RADIUS), "线段外的延长线不该命中");
  assert.ok(strokeHitByPoint(stroke, 100, 0, ERASER_RADIUS), "端点上应命中");
});

test("橡皮擦：单点笔画、空笔画、半径影响都合理", () => {
  const dot: Stroke = { color: "#000000", width: 1, points: [[10, 10]], pressures: [0.5] };
  assert.ok(strokeHitByPoint(dot, 10, 10, ERASER_RADIUS));
  assert.ok(!strokeHitByPoint(dot, 80, 10, ERASER_RADIUS));
  assert.ok(!strokeHitByPoint({ ...dot, points: [] }, 10, 10, ERASER_RADIUS), "空笔画不该命中");

  const line: Stroke = { color: "#000000", width: 1, points: [[0, 0], [100, 0]], pressures: [0.5, 0.5] };
  assert.ok(!strokeHitByPoint(line, 50, 12, 0), "半径 0 时 12px 外不该命中");
  assert.ok(strokeHitByPoint(line, 50, 12, 20), "半径大了就该命中");
});

test("点到线段距离：投影落在线段内/外都对", () => {
  assert.equal(distanceToSegment(50, 10, [0, 0], [100, 0]), 10);
  assert.equal(distanceToSegment(-10, 0, [0, 0], [100, 0]), 10, "线段外应取端点距离");
  assert.equal(distanceToSegment(5, 5, [5, 5], [5, 5]), 0, "退化线段应回落到点距");
});

// ── 重绘节流 + 丢帧兜底 ─────────────────────────────────────────

function fakeScheduler(): {
  scheduler: FrameScheduler;
  fireFrame(): boolean;
  fireWatchdog(): boolean;
  pendingFrames(): number;
  pendingTimers(): number;
} {
  let nextId = 1;
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  return {
    scheduler: {
      request: (cb) => {
        const id = nextId++;
        frames.set(id, cb);
        return id;
      },
      cancel: (id) => void frames.delete(id),
      timeout: (cb) => {
        const id = nextId++;
        timers.set(id, cb);
        return id;
      },
      clear: (id) => void timers.delete(id),
    },
    fireFrame: () => {
      const next = frames.entries().next();
      if (next.done) return false;
      frames.delete(next.value[0]);
      next.value[1]();
      return true;
    },
    fireWatchdog: () => {
      const next = timers.entries().next();
      if (next.done) return false;
      timers.delete(next.value[0]);
      next.value[1]();
      return true;
    },
    pendingFrames: () => frames.size,
    pendingTimers: () => timers.size,
  };
}

test("重绘节流：同一帧内多次 schedule 只画一次", () => {
  const fake = fakeScheduler();
  let drawn = 0;
  const loop = new FrameLoop(() => drawn++, fake.scheduler, undefined);

  loop.schedule();
  loop.schedule();
  loop.schedule();
  assert.equal(fake.pendingFrames(), 1, "应只排队一帧");
  assert.equal(drawn, 0, "还没到帧就不该画");
  fake.fireFrame();
  assert.equal(drawn, 1);
  assert.equal(fake.pendingTimers(), 0, "正常帧之后兜底计时器要清掉");
});

test("重绘节流：动画帧回调被丢掉后，兜底要能补画并让后续重绘继续工作", () => {
  const fake = fakeScheduler();
  let drawn = 0;
  let stalls = 0;
  const loop = new FrameLoop(
    () => drawn++,
    fake.scheduler,
    () => stalls++,
  );

  loop.schedule();
  // 模拟 webview 被冻结：排队的 rAF 回调永远不会触发，兜底超时先到
  assert.equal(fake.fireWatchdog(), true);
  assert.equal(drawn, 1, "丢帧后必须兜底补画");
  assert.equal(stalls, 1, "应上报一次丢帧");
  assert.equal(fake.pendingFrames(), 0, "丢掉的那一帧要取消掉，不能留闩");

  // 关键：闩必须已经打开，不然画布就永久冻住了
  loop.schedule();
  assert.equal(fake.pendingFrames(), 1, "兜底之后应能重新排队重绘");
  fake.fireFrame();
  assert.equal(drawn, 2);

  // 再丢一次也不该重复上报
  loop.schedule();
  fake.fireWatchdog();
  assert.equal(drawn, 3);
  assert.equal(stalls, 1, "丢帧只报一次，别刷屏");
});

test("重绘节流：flush 立刻画且不留排队帧", () => {
  const fake = fakeScheduler();
  let drawn = 0;
  const loop = new FrameLoop(() => drawn++, fake.scheduler, undefined);
  loop.schedule();
  loop.flush();
  assert.equal(drawn, 1);
  assert.equal(fake.pendingFrames(), 0);
  assert.equal(fake.pendingTimers(), 0);
  assert.equal(fake.fireWatchdog(), false, "flush 之后兜底不该再画一次");
  assert.equal(drawn, 1);
});

// ── 面板 HTML（CSP 与载荷） ─────────────────────────────────────────────

function fakeWebview(): vscode.Webview {
  return {
    cspSource: "https://file+.vscode-resource.vscode-cdn.net",
    asWebviewUri: (uri: vscode.Uri) => uri,
  } as unknown as vscode.Webview;
}

function whiteboardHtml(): string {
  return buildWhiteboardHtml({
    webview: fakeWebview(),
    title: "白板 · A1131 公路",
    displayId: "A1131",
    katexCssUri: "https://cdn/katex.min.css",
    statementHtml: "<h1>A1131 公路</h1><p>$a+b$</p>",
    strokes: sanitizeStrokes([{ color: "#0984e3", width: 1, points: [[1, 2], [3, 4]], pressures: [0.5, 0.8] }]),
    pages: 1,
    script: "/* whiteboard script */",
  });
}

test("白板面板：严格 CSP + 脚本走 nonce，不放 unsafe-inline", () => {
  const html = whiteboardHtml();
  assert.match(html, /^<!DOCTYPE html>/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.match(html, /script-src 'nonce-/);
  assert.ok(!/script-src[^"]*unsafe-inline/.test(html), "script-src 不能放开 unsafe-inline");
  assert.match(html, /katex\.min\.css/, "题面公式要带 KaTeX 样式");
});

test("白板面板：必备元素、三色笔（黑默认）与橡皮擦都在", () => {
  const html = whiteboardHtml();
  for (const id of [
    "viewport",
    "world",
    "sheet",
    "ink",
    "marks",
    "marks-out",
    "wb-eraser",
    "wb-undo",
    "wb-clear",
    "wb-add-page",
    "wb-del-page",
    "wb-export",
    "wb-zoom",
    "wb-pages",
    "wb-stats",
    "wb-payload",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `缺少 #${id}`);
  }
  assert.equal((html.match(/class="wb-pen"/g) ?? []).length, PENS.length, "应有三支笔");
  assert.deepEqual(
    PENS.map((p) => p.value),
    ["#000000", "#d63031", "#0984e3"],
  );
  assert.equal(DEFAULT_PEN_COLOR, "#d63031", "默认笔色是红（讲义上红笔写重点、黑色是题面本身）");

  assert.equal((html.match(/class="wb-width"/g) ?? []).length, PEN_WIDTHS.length, "应有一组粗细档");
  for (const w of PEN_WIDTHS) {
    assert.match(html, new RegExp(`data-width="${w.value}"`), `缺少粗细档「${w.label}」`);
    assert.match(html, new RegExp(`height:${penBarHeight(w.value)}px`), `粗细档「${w.label}」的条块高度不对`);
  }
});

test("白板面板：A4 标界在 #sheet 之外（导出克隆只取 #sheet，标记不会被带进图片）", () => {
  const html = whiteboardHtml();
  const sheetStart = html.indexOf('<div id="sheet"');
  const sheetEnd = html.indexOf('<div id="marks">');
  assert.ok(sheetStart > 0 && sheetEnd > sheetStart, "标记层应排在 #sheet 之后");
  assert.ok(!html.slice(sheetStart, sheetEnd).includes('id="marks"'), "分页/橡皮标记不能在纸张里");
  assert.match(html, /#marks-out\s*\{[^}]*box-shadow:[^}]*20000px/, "纸张外的压暗遮罩要够大");
  assert.match(html, /\.oi-page-frame\s*\{[^}]*border:\s*1px dashed/, "页框应是虚线框");
});

test("白板面板：数位笔时藏掉系统光标（笔形指示器由脚本自己画）", () => {
  const html = whiteboardHtml();
  assert.match(html, /#viewport\.wb-pen-cursor\s*\{\s*cursor:\s*none/, "笔/触摸时要藏掉系统光标，否则两个指示器打架");
  // 顺序：笔的这条要排在平移/擦除之前，否则拖动画布时看不出「正在抓取」
  const pen = html.indexOf("#viewport.wb-pen-cursor");
  assert.ok(pen > 0 && pen < html.indexOf("#viewport.wb-pan"), "wb-pen-cursor 必须排在 .wb-pan 之前");
  assert.ok(pen < html.indexOf("#viewport.wb-erase"), "wb-pen-cursor 必须排在 .wb-erase 之前");
  // 鼠标照旧是十字光标：藏光标只发生在带 wb-pen-cursor 这个类的视口上
  assert.match(html, /#viewport\s*\{[^}]*cursor:\s*crosshair/, "鼠标仍用十字光标");
});

test("白板面板：纸张规则在页面样式里（白底），导出样式是它的超集", () => {
  const html = whiteboardHtml();
  // 页面必须带 .oi-sheet —— 少这一份，暗色主题下题面就不是白底了
  assert.match(html, /\.oi-sheet\s*\{/, "页面样式缺少 .oi-sheet 规则");
  assert.match(html, /\.oi-sheet\s*\{[^}]*background:\s*#ffffff/, ".oi-sheet 应是白底");
  assert.ok(SHEET_CSS.includes(SHEET_RULES), "导出样式应包含纸张规则");
  assert.match(SHEET_CSS, /--vscode-/, "导出样式自带 BASE_STYLE（SVG 里没有主题变量，靠后面的完整声明盖掉）");
});

test("白板面板：纸面的字阶与内边距钉在 SHEET_RULES 里，不随 BASE_STYLE 漂移", () => {
  /*
   * 界面样式（BASE_STYLE）的字阶、代码块内边距是给「跟随主题的面板」调的，
   * 但纸面元素会继承它们。字号或行距一变，内容高就变，分页页数跟着变 ——
   * 整页内容高一旦越过一页就凭空多一页（AGENTS.md 里那条「量高度前先摘 min-height」的根因）。
   * 所以凡是纸面可见的排版参数，都必须在 SHEET_RULES 里显式写死，改动时同步改这里的断言。
   */
  const pinned: Array<[RegExp, string]> = [
    [/\.oi-sheet h1\s*\{[^}]*font-size:\s*1\.25em/, "h1 字号（与 h2 同号，见下面那条）"],
    [/\.oi-sheet h2\s*\{[^}]*font-size:\s*1\.25em/, "h2 字号"],
    [/\.oi-sheet h3\s*\{[^}]*font-size:\s*1\.1em/, "h3 字号"],
    [/\.oi-sheet h1, \.oi-sheet h2, \.oi-sheet h3\s*\{[^}]*line-height:\s*1\.25/, "标题行距"],
    [/\.oi-sheet pre\s*\{[^}]*padding:\s*10px 12px/, "代码块内边距（改动前是 10px 12px）"],
    [/\.oi-sheet code\s*\{[^}]*padding:\s*\.1em \.35em/, "行内代码内边距"],
    [/\.oi-sheet th, \.oi-sheet td\s*\{[^}]*padding:\s*4px 10px/, "表格内边距"],
    [/\.oi-sheet table\s*\{[^}]*font-size:\s*1em/, "表格字号"],
    [/\.oi-sheet th\s*\{[^}]*background:\s*#f6f8fa/, "表头底色（不能跟 BASE_STYLE 的 --oi-tint 走）"],
  ];
  for (const [re, what] of pinned) {
    assert.match(SHEET_RULES, re, `纸面的${what}应在 SHEET_RULES 里写死，不能继承 BASE_STYLE`);
  }
});

test("白板面板：题面只占纸宽 2/3，右侧留白给学生写", () => {
  assert.match(whiteboardHtml(), /<div id="sheet" class="oi-sheet"><div class="oi-sheet-body"/, "题面要包在 .oi-sheet-body 里");
  assert.match(SHEET_RULES, /\.oi-sheet-body\s*\{[^}]*width:\s*66\.667%/, "题面列应占纸宽 2/3");
  // 留白靠「列只占 2/3」实现：纸张本身仍是满 A4 宽，批注才能一直写到右边缘
  assert.match(SHEET_RULES, /\.oi-sheet\s*\{[^}]*width:\s*793\.\d+px/, "纸张仍是满 A4 宽");
});

test("白板面板：题面离纸张左边界更近（老师反馈左侧空得太多）", () => {
  const pad = /\.oi-sheet\s*\{[^}]*padding:\s*(\d+)px\s+(\d+)px\s+(\d+)px\s+(\d+)px/.exec(SHEET_RULES);
  assert.ok(pad, "纸张内边距应写「上 右 下 左」四值（左边单独收窄，不能再用两值写法）");
  // 左边距：老师明确要求题面离左边界更近
  assert.ok(Number(pad[4]) <= 24, `左边距该收到 24px 以内，实际 ${pad[4]}px`);
  // 右边仍是留白侧，别顺手一起收掉
  assert.ok(Number(pad[2]) >= 32, `右边距不该跟着收窄（右侧 1/3 要留给学生写），实际 ${pad[2]}px`);
  // 上边距收窄到 24px 以内（老师反馈题面离上边界太远）。缩小这个方向是安全的：
  // 内容高按内边距一起量，变小只会让内容更矮，页数只可能变少。
  assert.ok(Number(pad[1]) <= 24, `上内边距该收到 24px 以内，实际 ${pad[1]}px`);
  assert.equal(Number(pad[3]), 48, "下内边距别动（批注常常写到纸尾，太贴边会被切片切到）");
});

test("白板面板：行距与段间距比阅读面板更紧凑（BASE_STYLE 是 1.7）", () => {
  const sheetHeight = /\.oi-sheet\s*\{[^}]*line-height:\s*([\d.]+)/.exec(SHEET_RULES);
  assert.ok(sheetHeight, "纸张应显式声明行距");
  assert.ok(Number(sheetHeight[1]) < 1.7, `纸张行距该比 1.7 紧，实际 ${sheetHeight[1]}`);
  // 老师要求再收一档：一页多塞点内容，讲义翻页越少越好
  assert.ok(Number(sheetHeight[1]) <= 1.35, `纸张行距该收到 1.35 以内，实际 ${sheetHeight[1]}`);
  assert.match(SHEET_RULES, /\.oi-sheet p\s*\{[^}]*margin:\s*\.4em 0/, "段落间距要收紧");
  assert.match(SHEET_RULES, /\.oi-sheet h1,\s*\.oi-sheet h2\s*\{[^}]*margin:\s*\.55em 0 \.3em/, "小节标题间距要收紧");
});

test("白板面板：题名（h1）与小节标题（h2）同号（题名不再顶着两行大字）", () => {
  const h1 = /\.oi-sheet h1\s*\{[^}]*font-size:\s*([\d.]+)em/.exec(SHEET_RULES);
  const h2 = /\.oi-sheet h2\s*\{[^}]*font-size:\s*([\d.]+)em/.exec(SHEET_RULES);
  assert.ok(h1 && h2, "h1/h2 的字号都要显式写在 SHEET_RULES 里");
  assert.equal(h1[1], h2[1], `题名应与小节标题同号，实际 h1=${h1[1]}em / h2=${h2[1]}em`);
  // 也要比正文大，否则就分不出标题层级了
  assert.ok(Number(h1[1]) > 1, "题名还得比正文大一号");
});

test("白板面板：样例代码块折行（导出用的 SVG 里没有滚动条，长行会被整段裁掉）", () => {
  assert.match(SHEET_RULES, /\.oi-sheet pre\s*\{[^}]*white-space:\s*pre-wrap/, "代码块要跟着列宽折行");
});

test("白板面板：题面 DOM 对指针「隐身」（原生选字/拖拽会终止整条指针序列 → 写几厘米就断笔）", () => {
  const html = whiteboardHtml();
  const viewportRule = /#viewport,\s*#viewport \*\s*\{([^}]*)\}/.exec(html);
  assert.ok(viewportRule, "白板要有「视口内一切都不参与选字/拖拽」的规则");
  assert.match(viewportRule[1], /user-select:\s*none/, "白板里不该能选中文字（选中后一拖就是从选区拖拽）");
  assert.match(viewportRule[1], /-webkit-user-drag:\s*none/, "题面里的图片/链接不该能被拖走");
  assert.match(html, /\.oi-sheet-body\s*\{[^}]*pointer-events:\s*none/, "题面要对指针隐身，跟右侧空白纸一样只是纸");
});

test("白板面板：知识面板是整页白纸（#sheet 里没有题面，只留 2/3 列容器）", () => {
  const html = buildWhiteboardHtml({
    webview: fakeWebview(),
    title: "知识面板",
    displayId: "知识面板",
    katexCssUri: "https://cdn/katex.min.css",
    statementHtml: "",
    strokes: [],
    pages: 1,
    script: "/* whiteboard script */",
  });
  assert.match(html, /<div id="sheet" class="oi-sheet"><div class="oi-sheet-body"><\/div><\/div>/, "空白纸上不该有题面内容");
  assert.ok(!html.includes("<h1>"), "知识面板不该带题号标题");
  assert.match(html, /id="wb-export"/, "空白纸照样要能导出 A4");
});

test("白板面板：题面 HTML 进 #sheet 的 2/3 列里，批注进载荷，`<` 转义防脚本注入", () => {
  const html = whiteboardHtml();
  assert.match(html, /<div id="sheet" class="oi-sheet"><div class="oi-sheet-body"><h1>A1131 公路<\/h1>/);

  const m = /<script type="application\/json" id="wb-payload">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "缺少 #wb-payload 载荷");
  const payload = JSON.parse(m[1]) as { displayId: string; strokes: Stroke[]; pages: number };
  assert.equal(payload.strokes.length, 1);
  assert.deepEqual(payload.strokes[0].pressures, [0.5, 0.8]);
  assert.equal(payload.pages, 1, "载荷要带上手动加出来的页数（缺了重开面板就丢）");

  const withScript = buildWhiteboardHtml({
    webview: fakeWebview(),
    title: "t",
    displayId: "A1131",
    katexCssUri: "k",
    statementHtml: "<p>&lt;script&gt;</p>",
    strokes: [{ color: "#000000", width: 1, points: [[0, 0]], pressures: [0.5] }],
    pages: 3,
    script: "x",
  });
  const inner = /id="wb-payload">([\s\S]*?)<\/script>/.exec(withScript);
  assert.ok(inner && !inner[1].includes("</"), "载荷里的 < 必须转义成 \\u003c");
  assert.equal((JSON.parse(inner[1]) as { pages: number }).pages, 3, "加页数要原样带进载荷");
});

test("白板面板：载荷带上导出像素尺寸（默认 150dpi，面板按设置可改）", () => {
  const payloadOf = (html: string): { exportWidth: number; exportHeight: number } => {
    const m = /id="wb-payload">([\s\S]*?)<\/script>/.exec(html);
    assert.ok(m, "缺少 #wb-payload 载荷");
    return JSON.parse(m[1]) as { exportWidth: number; exportHeight: number };
  };

  const fallback = payloadOf(whiteboardHtml());
  assert.deepEqual([fallback.exportWidth, fallback.exportHeight], [EXPORT_WIDTH, EXPORT_HEIGHT]);
  assert.deepEqual([fallback.exportWidth, fallback.exportHeight], [1240, 1754], "不传就该是默认 150dpi 的尺寸");

  const custom = payloadOf(
    buildWhiteboardHtml({
      webview: fakeWebview(),
      title: "t",
      displayId: "A1",
      katexCssUri: "k",
      statementHtml: "",
      strokes: [],
      pages: 1,
      exportWidth: 2480,
      exportHeight: 3508,
      script: "x",
    }),
  );
  assert.deepEqual([custom.exportWidth, custom.exportHeight], [2480, 3508], "300dpi 时导出尺寸要跟着走");
});

test("白板面板：笔迹画布单独提一层（重绘别把题面 DOM 一起重画）", () => {
  assert.match(whiteboardHtml(), /#ink\s*\{[^}]*will-change:\s*transform/, "少了这一层，书写时会连题面一起重绘");
});
