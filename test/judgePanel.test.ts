/**
 * 评测面板：提交结果**按文件投递**。
 *
 * 面板是单例复用的（A 题评测开着面板 → 切去 B 题提交 → 结果直接贴上来就成了
 * 「A 题的样例下面挂着 B 题的提交结果」）。这条测试钉住「不是同一份代码就不投递」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type * as vscode from "vscode";
import { setWebviewPanelFactory } from "./vscode-stub";
import { JudgePanel } from "../src/ui/judgePanel";
import type { JudgeReport } from "../src/judge/judge";

interface Posted {
  command?: string;
  outcome?: { sourcePath?: string; verdict?: string };
}

/** 假面板：记下扩展往 webview 推的消息 */
function installFakePanel(): {
  posted: Posted[];
  close(): void;
} {
  const posted: Posted[] = [];
  let disposeHandler: (() => void) | null = null;
  const panel = {
    title: "",
    webview: {
      cspSource: "https://file+.vscode-resource.vscode-cdn.net",
      asWebviewUri: (uri: vscode.Uri) => uri,
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: async (msg: Posted) => {
        posted.push(msg);
        return true;
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
    posted,
    // 关掉面板 = 让单例里的「当前面板」清空，免得漏到下个用例（面板是复用的）
    close: () => {
      disposeHandler?.();
      setWebviewPanelFactory(undefined);
    },
  };
}

function report(sourcePath: string): JudgeReport {
  return {
    compile: { ok: true, exe: "C:\\build\\a.exe", message: "", durationMs: 12 },
    cases: [],
    sourcePath,
    noSamples: false,
    sourceHash: "deadbeef",
  };
}

function outcome(sourcePath: string): Parameters<typeof JudgePanel.publishSubmit>[0] {
  return {
    sourcePath,
    ok: true,
    rid: 12345,
    verdict: "AC",
    summary: "答案正确（AC）",
    feedback: "",
    score: 100,
    timeMs: 12,
    memoryMb: 1.2,
    error: "",
    at: "10:00:00",
  };
}

const callbacks = {
  onRerun: () => {},
  onRunInTerminal: () => {},
  onOpenSource: () => {},
  onGotoLocation: () => {},
  onSubmit: async () => {},
  onOpenRecord: () => {},
};

test("提交结果只投递给正在显示同一份代码的面板", () => {
  const handle = installFakePanel();
  try {
    JudgePanel.show({} as unknown as vscode.ExtensionContext, report("C:\\work\\P1001.cpp"), callbacks);

    // 同一份代码 → 投递
    assert.equal(JudgePanel.publishSubmit(outcome("C:\\work\\P1001.cpp")), true);
    assert.equal(handle.posted.length, 1);
    assert.equal(handle.posted[0].command, "submitResult");
    assert.equal(handle.posted[0].outcome?.verdict, "AC");

    // 另一份代码 → **不投递**（否则就是「A 题的面板挂着 B 题的结果」）
    assert.equal(JudgePanel.publishSubmit(outcome("C:\\work\\P1002.cpp")), false);
    assert.equal(handle.posted.length, 1, "不该把别题的结果推到这个面板上");
  } finally {
    handle.close();
  }
});

test("面板关掉后不再投递结果", () => {
  const handle = installFakePanel();
  try {
    JudgePanel.show({} as unknown as vscode.ExtensionContext, report("C:\\work\\P1001.cpp"), callbacks);
    handle.close();
    assert.equal(JudgePanel.publishSubmit(outcome("C:\\work\\P1001.cpp")), false);
    assert.equal(handle.posted.length, 0);
  } finally {
    setWebviewPanelFactory(undefined);
  }
});
