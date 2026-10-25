/**
 * 笔迹稳定器的**接线**断言（纯逻辑在 stabilizer.test.ts 里）。
 *
 * 这一层管的是「设置项怎么一路走到白板」：
 * 设置项 → config.ts → 白板面板 → 载荷 → webview 建滤波器。
 *
 * 为什么要单独钉：断一环的症状都是「老师开了没反应」，而不是报错。
 * ① config.ts 忘了读设置 → 面板永远是关的；
 * ② 面板忘了带进载荷 → 白板里没有这一层；
 * ③ webview 忘了建滤波器 → 载荷带了也不生效；
 * ④ 收笔忘了补尾 → 每一笔尾巴上少一截（写「7」的最后一挑最先露馅）。
 * 四处都不会抛异常，只会「静默地没生效」，所以只能靠断言钉住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type * as vscode from "vscode";
import { buildWhiteboardHtml } from "../src/whiteboard/panelHtml";
import { whiteboardConfig } from "../src/config";
import { DEFAULT_STABILIZE_LEVEL, STABILIZE_LEVELS } from "../src/whiteboard/stabilizer";
// 直接引 stub（与 esbuild alias 指向同一文件，因此与源码共用一个模块实例）
import { resetConfigOverrides, setConfigOverride } from "./vscode-stub";

function fakeWebview(): vscode.Webview {
  return {
    cspSource: "https://file+.vscode-resource.vscode-cdn.net",
    asWebviewUri: (uri: vscode.Uri) => uri,
  } as unknown as vscode.Webview;
}

/** 造一份白板面板 HTML（只要载荷那一段，别的一概不管）。 */
function htmlWith(stabilize?: unknown): string {
  return buildWhiteboardHtml({
    webview: fakeWebview(),
    title: "白板",
    displayId: "A1",
    katexCssUri: "https://cdn/katex.min.css",
    statementHtml: "",
    strokes: [],
    pages: 1,
    stabilize,
    script: "x",
  });
}

function payloadOf(html: string): { stabilize?: unknown } {
  const m = /id="wb-payload">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(m, "缺少 #wb-payload 载荷");
  return JSON.parse(m[1]) as { stabilize?: unknown };
}

// ── ① 设置项 ──────────────────────────────────────────────────────────────

test("稳定器设置项：四档齐全、缺省关，enum 与代码里的档位表一字不差", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  ) as {
    contributes: {
      configuration: {
        properties: Record<string, { type?: string; enum?: string[]; default?: unknown }>;
      };
    };
  };
  const prop = pkg.contributes.configuration.properties["lgAssist.whiteboard.stabilize"];
  assert.ok(prop, "package.json 里没有 lgAssist.whiteboard.stabilize（老师就找不到这个开关）");
  assert.equal(prop.type, "string");
  assert.deepEqual(prop.enum, [...STABILIZE_LEVELS], "enum 与 stabilizer.ts 的档位表不一致（多了/少了档）");
  assert.equal(prop.default, "off", "缺省必须是关：开着会让落墨滞后于笔尖，不能默认替用户决定");
  assert.equal(prop.default, DEFAULT_STABILIZE_LEVEL, "package.json 的缺省与代码里的缺省档不是同一个");
});

test("稳定器设置项：默认值与 config.ts 的回落值一致（只改一处会出现「设置里显示 A、实际是 B」）", () => {
  const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "src", "config.ts"), "utf8");
  assert.match(
    cfgSrc,
    /whiteboard\.stabilize["']?,\s*DEFAULT_STABILIZE_LEVEL/,
    "config.ts 的回落值没跟上 stabilizer.ts 的缺省档",
  );
  // 配置项的键名必须与设置项的键名一致（少写一段 lgAssist. 就是读不到）
  assert.match(cfgSrc, /cfg\(\)\.get[^)]*"whiteboard\.stabilize"/, "config.ts 读的键名与设置项对不上");
});

// ── ② config.ts 读设置并清洗 ──────────────────────────────────────────────

test("稳定器设置：config.ts 认设置值，脏值退回「关」，没写就是关", () => {
  resetConfigOverrides();
  try {
    assert.equal(whiteboardConfig().stabilize, "off", "没写过设置时必须是关");

    setConfigOverride("whiteboard.stabilize", "medium");
    assert.equal(whiteboardConfig().stabilize, "medium");

    for (const level of STABILIZE_LEVELS) {
      setConfigOverride("whiteboard.stabilize", level);
      assert.equal(whiteboardConfig().stabilize, level);
    }

    // 脏值一律退回「关」：**不猜**用户是想开着 —— 开着的代价是落墨滞后（stabilizer.ts 取舍 ①）
    for (const bad of ["FAST", "ON", "Strong", "", 0, 3, true, {}, []]) {
      setConfigOverride("whiteboard.stabilize", bad);
      assert.equal(
        whiteboardConfig().stabilize,
        "off",
        `脏值 ${JSON.stringify(bad)} 应退回「关」，而不是被当成某个档`,
      );
    }
  } finally {
    resetConfigOverrides();
  }
});

// ── ③ 面板载荷 ────────────────────────────────────────────────────────────

test("稳定器接线：面板把档位带进载荷；没传就不带这个键（缺省即关）", () => {
  assert.equal(payloadOf(htmlWith()).stabilize, undefined, "没传时载荷里不该有这个键");
  for (const level of STABILIZE_LEVELS) {
    assert.equal(payloadOf(htmlWith(level)).stabilize, level, `${level} 档没带进载荷`);
  }
  // 载荷是 JSON：脏值能被原样带过去，由 webview 侧 clampStabilize 洗（纵深防御，不在两处各判一次）
  assert.equal(payloadOf(htmlWith("FAST")).stabilize, "FAST");
});

test("稳定器接线：白板面板把 opts.stabilize 放进载荷，题板控制器把设置项传下来", () => {
  const panelSrc = fs.readFileSync(path.join(__dirname, "..", "src", "whiteboard", "panel.ts"), "utf8");
  assert.match(panelSrc, /stabilize:\s*this\.opts\.stabilize/, "白板面板没把 stabilize 放进载荷");

  const boardSrc = fs.readFileSync(path.join(__dirname, "..", "src", "app", "board.ts"), "utf8");
  assert.match(
    boardSrc,
    /stabilize:\s*whiteboardConfig\(\)\.stabilize/,
    "题板控制器没把设置项传给白板面板（症状：改了设置没反应）",
  );
});

// ── ④ webview 侧真的建了滤波器 ────────────────────────────────────────────

test("稳定器接线：webview 读载荷的档位、逐笔建滤波器、收笔补尾、视角变化丢弃滤波器", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "whiteboard", "webview.ts"), "utf8");

  // 读载荷
  assert.match(src, /stabilizeLevel\s*=\s*clampStabilize\(payload\.stabilize\)/, "webview 没读载荷里的档位");

  // 逐笔新建：滤波器带着上一笔的滞后状态就废了（上一笔的尾巴会拽着新落点跑）
  const startAt = src.indexOf("function startStroke");
  const finishAt = src.indexOf("function finishStroke");
  assert.ok(startAt > 0 && finishAt > startAt);
  const startBody = src.slice(startAt, finishAt);
  assert.match(startBody, /new StrokeStabilizer\(/, "起笔时没建滤波器");
  assert.match(startBody, /stabilizeEnabled\(stabilizeLevel\)/, "起笔时没判断该档要不要挂滤波器");

  const finishBody = src.slice(finishAt, src.indexOf("function ", finishAt + 10));
  assert.match(finishBody, /filter\.tail\(\)/, "收笔没补尾（每一笔的尾巴会少一截）");
  assert.match(finishBody, /filter\s*=\s*null/, "收笔后没丢掉滤波器（下一笔会带着上一笔的状态）");

  // 视角变化时正在写的这一笔：滤波器攒的是屏幕坐标，换算到世界坐标会整体错位
  assert.match(
    src,
    /if \(live && filter\) filter = null;/,
    "视角变化时没丢弃滤波器（笔尾会突然甩出一截）",
  );

  // off 档不许建实例：一条 pointermove 都不多跑
  assert.match(src, /stabilizeEnabled\(stabilizeLevel\)\s*\?\s*new StrokeStabilizer/, "off 档也会建滤波器");
});
