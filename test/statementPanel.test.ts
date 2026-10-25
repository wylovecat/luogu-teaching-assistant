/**
 * 题面面板（单例复用）的两件事：
 *
 * ①**换题时回调必须跟着换**：面板是复用的，只换题面会让「创建题目文件 / 打开白板」作用到上一道题上；
 * ②**难度标记要看得见**：面板会带一个难度旁注（如「普及-」），但换题时也要跟着换 ——
 *   标记留在上一道题上就是误导。
 *
 * 另加字号缩放的三条：工具栏有增减按钮与读数、`fontScale` 消息夹紧后落 globalState 且下次渲染注入、
 * 持久化的值在开面板时恢复（含边界禁用态）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { Uri, setWebviewPanelFactory } from "./vscode-stub";
import { showStatement, type StatementActions } from "../src/ui/statementPanel";
import type { Statement } from "../src/problems/statement";

function statement(displayId: string, title: string): Statement {
  return {
    displayId,
    title,
    description: "题目描述",
    inputDescription: "",
    outputDescription: "",
    samples: [],
    hint: "",
    prompt: "",
    timeLimitMs: 1000,
    memoryLimitMb: 256,
    difficulty: 2,
    rawMarkdown: "",
  };
}

/** 假面板：记下 HTML、题名与收到的消息处理器，`click`/`send` 用来模拟 webview 里发消息 */
function installFakePanel(): {
  panel: { title: string; webview: { html: string } };
  click(command: string): void;
  send(msg: { command?: string; scale?: number }): void;
  close(): void;
} {
  let messageHandler: ((msg: { command?: string; scale?: number }) => void) | null = null;
  let disposeHandler: (() => void) | null = null;
  const panel = {
    title: "",
    webview: {
      cspSource: "https://file+.vscode-resource.vscode-cdn.net",
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: (h: (msg: { command?: string; scale?: number }) => void) => {
        messageHandler = h;
        return { dispose: () => {} };
      },
      html: "",
    },
    reveal: () => {},
    onDidDispose: (h: () => void) => {
      disposeHandler = h;
      return { dispose: () => {} };
    },
    dispose: () => {},
  };
  setWebviewPanelFactory(() => panel);
  return {
    panel,
    click: (command) => messageHandler?.({ command }),
    send: (msg) => messageHandler?.(msg),
    // 关掉面板 = 让单例里的「当前面板」清空，免得漏到下个用例（面板是复用的）
    close: () => {
      disposeHandler?.();
      setWebviewPanelFactory(undefined);
    },
  };
}

/** 每个用例都在自己的假面板里跑，结束时一定关掉（断言失败也要关，否则会串到下一个用例） */
function withPanel(run: (h: { panel: { title: string; webview: { html: string } }; click(command: string): void; send(msg: { command?: string; scale?: number }): void }) => void): void {
  const handle = installFakePanel();
  // 字号是全局偏好，落在一个共享的假 globalState 里；每个用例开跑前清一次，免得串味、依赖执行顺序
  globalState.store.clear();
  try {
    run(handle);
  } finally {
    handle.close();
  }
}

/** 假的 globalState（Map 版）：update 的赋值是同步发生的，测试里可以「发消息后立刻断言」 */
function fakeGlobalState(): { get(key: string, def?: unknown): unknown; update(key: string, value: unknown): Promise<void>; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  return {
    get: (key, def) => (store.has(key) ? store.get(key) : def),
    update: async (key, value) => {
      store.set(key, value);
    },
    store,
  };
}

const globalState = fakeGlobalState();
const context = { extensionUri: Uri.file("/ext"), globalState } as unknown as vscode.ExtensionContext;

function actionsFor(name: string, calls: string[]): StatementActions {
  return {
    onCreate: () => {
      calls.push(`${name}:create`);
    },
    onOpenMarkdown: () => {
      calls.push(`${name}:md`);
    },
    onCopySamples: () => {
      calls.push(`${name}:copy`);
    },
    onOpenWhiteboard: () => {
      calls.push(`${name}:board`);
    },
  };
}

test("题面面板：换题时回调跟着换，按钮不会作用到上一道题上", () => {
  withPanel(({ panel, click }) => {
    const calls: string[] = [];
    showStatement(context, statement("A1131", "公路"), actionsFor("first", calls));
    showStatement(context, statement("A0001", "单选"), actionsFor("second", calls));

    click("create");
    click("whiteboard");
    click("openMd");
    click("copySamples");

    assert.deepEqual(calls, ["second:create", "second:board", "second:md", "second:copy"], "回调要换成当前这道题的");
    assert.equal(panel.title, "A0001 单选", "窗口标题要跟着换题");
    assert.ok(panel.webview.html.includes("A0001"), "题面要渲染成新题");
    assert.ok(!panel.webview.html.includes("A1131"), "不该还留着上一道题的题面");
  });
});

test("题面面板：换题时难度标记也跟着换", () => {
  withPanel(({ panel }) => {
    showStatement(context, statement("P1001", "A+B Problem"), actionsFor("first", []), undefined, "入门");
    showStatement(context, statement("P1002", "过河卒"), actionsFor("second", []), undefined, "普及-");
    assert.match(panel.webview.html, /<span class="badge">普及-<\/span>/, "标记要是当前这道题的");
    assert.ok(!panel.webview.html.includes('class="badge">入门<'), "上一道题的标记不能留着");
  });
});

test("题面面板：没有难度时不出标记，创建按钮仍说清建到哪", () => {
  withPanel(({ panel }) => {
    showStatement(context, statement("AT_abc001_a", "AtCoder 题"), actionsFor("remote", []));
    assert.ok(!panel.webview.html.includes('class="badge"'), "没有难度就不显示标记");
    assert.match(panel.webview.html, /title="在题目目录里创建 \.cpp、样例与题面 md"/);
  });
});

test("题面面板：工具栏有字号增减按钮与当前读数，并注入缩放系数", () => {
  withPanel(({ panel }) => {
    showStatement(context, statement("P1001", "A+B Problem"), actionsFor("first", []));
    assert.match(panel.webview.html, /id="fontDown"/, "要有减小字号按钮");
    assert.match(panel.webview.html, /id="fontUp"/, "要有增大字号按钮");
    assert.match(panel.webview.html, /id="fontScale"[^>]*>100%<\/span>/, "读数要显示当前字号（默认 100%）");
    // 缩放系数要由扩展注入到 :root 与脚本文本里（脚本常量与 CSS 都来自 fontScale.ts）
    assert.match(panel.webview.html, /--oi-font-scale:\s*1/, "要注入缩放系数");
    assert.match(panel.webview.html, /font-size:\s*calc\(var\(--vscode-font-size\)\s*\*\s*var\(--oi-font-scale\)\)/, "正文要用缩放系数");
  });
});

test("题面面板：fontScale 消息夹紧后写进 globalState，并在下次渲染注入", () => {
  withPanel(({ panel, send }) => {
    showStatement(context, statement("P1001", "A+B Problem"), actionsFor("first", []));

    // 超出上限的脏值：应夹到上限（2）后落盘
    send({ command: "fontScale", scale: 5 });
    assert.equal(globalState.store.get("lgAssist.statement.fontScale"), 2, "脏值要夹到上限再持久化");

    // 换题触发重渲染：注入的应是夹紧后的值，而不是发进来的 5
    showStatement(context, statement("P1002", "过河卒"), actionsFor("second", []));
    assert.match(panel.webview.html, /--oi-font-scale:\s*2\b/, "重渲染要注入夹紧后的字号");
    assert.match(panel.webview.html, /id="fontScale"[^>]*>200%<\/span>/, "读数要跟着变");
    assert.match(panel.webview.html, /id="fontUp" class="secondary"[^>]* disabled/, "到上限后增大按钮要禁用");
  });
});

test("题面面板：持久化的字号在开面板时恢复（含禁用态）", () => {
  withPanel(({ panel }) => {
    // 预置一个恰好在下限的值：新开的题面面板应直接以下限渲染，且减小按钮已禁用
    globalState.store.set("lgAssist.statement.fontScale", 0.7);
    showStatement(context, statement("P1003", "数字反转"), actionsFor("first", []));
    assert.match(panel.webview.html, /--oi-font-scale:\s*0\.7\b/, "开面板要用持久化的字号");
    assert.match(panel.webview.html, /id="fontDown" class="secondary"[^>]* disabled/, "下限时减小按钮要禁用");
    assert.ok(!panel.webview.html.includes('id="fontUp" class="secondary" disabled'), "下限时增大按钮不该禁用");
  });
});
