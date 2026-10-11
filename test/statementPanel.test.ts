/**
 * 题面面板（单例复用）的两件事：
 *
 * ①**换题时回调必须跟着换**：面板是复用的，只换题面会让「创建题目文件 / 打开白板」作用到上一道题上；
 * ②**难度标记要看得见**：面板会带一个难度旁注（如「普及-」），但换题时也要跟着换 ——
 *   标记留在上一道题上就是误导。
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

/** 假面板：记下 HTML、题名与收到的消息处理器，`click` 用来模拟 webview 里点按钮 */
function installFakePanel(): {
  panel: { title: string; webview: { html: string } };
  click(command: string): void;
  close(): void;
} {
  let messageHandler: ((msg: { command?: string }) => void) | null = null;
  let disposeHandler: (() => void) | null = null;
  const panel = {
    title: "",
    webview: {
      cspSource: "https://file+.vscode-resource.vscode-cdn.net",
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: (h: (msg: { command?: string }) => void) => {
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
    // 关掉面板 = 让单例里的「当前面板」清空，免得漏到下个用例（面板是复用的）
    close: () => {
      disposeHandler?.();
      setWebviewPanelFactory(undefined);
    },
  };
}

/** 每个用例都在自己的假面板里跑，结束时一定关掉（断言失败也要关，否则会串到下一个用例） */
function withPanel(run: (h: { panel: { title: string; webview: { html: string } }; click(command: string): void }) => void): void {
  const handle = installFakePanel();
  try {
    run(handle);
  } finally {
    handle.close();
  }
}

const context = { extensionUri: Uri.file("/ext") } as unknown as vscode.ExtensionContext;

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
