/**
 * 激活冒烟测试：在 node 里加载打包产物 dist/extension.js 并调用 activate()。
 *
 * 目的不是替代真实 VSCode 里的手工验证，而是抓住「模块图加载就崩」这类问题
 * （例如某个依赖的顶层 import 在 node 环境下报错、命令注册 id 写错、
 *  context 上用了不存在的 API），这类问题在有 GUI 之前就能发现。
 */
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");

const disposables = [];
const registered = [];
const handlers = new Map();
let lastWebviewHtml = "";
/** 「问题」面板里被发布出去的条目：{ uri, diagnostics } */
const publishedProblems = [];

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (l) => {
      this.listeners.push(l);
      return { dispose: () => {} };
    };
  }
  fire(v) {
    for (const l of this.listeners) l(v);
  }
  dispose() {
    this.listeners = [];
  }
}

const noop = () => {};
const d = () => ({ dispose: noop });

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }
  static file(p) {
    return new Uri(p);
  }
  static parse(p) {
    return new Uri(p);
  }
  static joinPath(base, ...parts) {
    return new Uri([base.fsPath, ...parts].join("/"));
  }
  toString() {
    return this.fsPath;
  }
}

const memento = () => {
  const store = new Map();
  return {
    get: (k, dv) => (store.has(k) ? store.get(k) : dv),
    update: async (k, v) => {
      store.set(k, v);
    },
  };
};

const vscode = {
  Uri,
  EventEmitter,
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Range: class {
    constructor(startLine, startChar, endLine, endChar) {
      if (typeof startLine === "object") {
        this.start = startLine;
        this.end = startChar;
      } else {
        this.start = { line: startLine, character: startChar };
        this.end = { line: endLine, character: endChar };
      }
    }
  },
  Diagnostic: class {
    constructor(range, message, severity) {
      this.range = range;
      this.message = message;
      this.severity = severity;
    }
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  languages: {
    createDiagnosticCollection: (name) => {
      assert.equal(name, "lgAssist", "诊断集合的名字");
      return {
        // 发布前扩展会先 clear()，这里让记录跟着清空，模拟「整体替换上一次的诊断」
        clear: () => {
          publishedProblems.length = 0;
        },
        set: (uri, diagnostics) => publishedProblems.push({ uri, diagnostics }),
        dispose: noop,
      };
    },
  },
  ThemeIcon: class {
    constructor(id) {
      this.id = id;
    }
  },
  TreeItem: class {
    constructor(label, state) {
      this.label = label;
      this.collapsibleState = state;
    }
  },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2 },
  ProgressLocation: { Notification: 15 },
  Disposable: { from: d },
  env: { clipboard: { writeText: async () => {} }, openExternal: async () => true },
  commands: {
    registerCommand: (id, handler) => {
      registered.push(id);
      handlers.set(id, handler);
      const item = d();
      disposables.push(item);
      return item;
    },
    executeCommand: async () => {},
  },
  window: {
    createOutputChannel: () => ({
      appendLine: noop,
      append: noop,
      show: noop,
      hide: noop,
      clear: noop,
      replace: noop,
      dispose: noop,
    }),
    createStatusBarItem: () => ({ show: noop, hide: noop, dispose: noop, text: "", tooltip: "", command: "" }),
    createTreeView: (id, opts) => {
      assert.equal(id, "lgAssist.sidebar", "TreeView id 必须与 package.json 的 views 一致");
      assert.ok(opts && opts.treeDataProvider, "TreeView 必须提供 treeDataProvider");
      // 走一遍 getChildren，确保侧边栏渲染逻辑在未登录状态下不崩
      const roots = opts.treeDataProvider.getChildren();
      assert.ok(Array.isArray(roots) && roots.length >= 3, "未登录时应至少有账号/当前文件/题库三个根节点");
      for (const r of roots) {
        const item = opts.treeDataProvider.getTreeItem(r);
        assert.ok(item && item.label, "每个根节点都应能生成 TreeItem");
        const kids = opts.treeDataProvider.getChildren(r);
        assert.ok(Array.isArray(kids), "getChildren 必须返回数组");
      }
      const item = d();
      disposables.push(item);
      return item;
    },
    createWebviewPanel: (viewType, title) => {
      const panel = {
        viewType,
        title,
        webview: {
          _html: "",
          get html() {
            return this._html;
          },
          set html(v) {
            this._html = v;
            lastWebviewHtml = v;
          },
          onDidReceiveMessage: d,
          asWebviewUri: (u) => u,
          cspSource: "vscode-webview://stub",
        },
        onDidDispose: d,
        reveal: noop,
        dispose: noop,
      };
      return panel;
    },
    showErrorMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    showInputBox: async () => undefined,
    showQuickPick: async () => undefined,
    showSaveDialog: async () => undefined,
    showTextDocument: async () => ({}),
    withProgress: async (_opts, task) => task({ report: noop }, { isCancellationRequested: false }),
    onDidChangeActiveTextEditor: () => d(),
    createTerminal: () => ({ show: noop, sendText: noop, dispose: noop }),
    activeTextEditor: undefined,
  },
  workspace: {
    getConfiguration: () => ({ get: (_k, dv) => dv }),
    workspaceFolders: undefined,
    onDidChangeConfiguration: () => d(),
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const extensionPath = path.join(__dirname, "..", "dist", "extension.js");
const ext = require(extensionPath);
assert.equal(typeof ext.activate, "function", "dist/extension.js 必须导出 activate");
assert.equal(typeof ext.deactivate, "function", "dist/extension.js 必须导出 deactivate");

const context = {
  subscriptions: [],
  secrets: {
    get: async () => undefined,
    store: async () => {},
    delete: async () => {},
  },
  globalState: memento(),
  workspaceState: memento(),
  extensionUri: Uri.file(path.join(__dirname, "..")),
};

ext.activate(context);

assert.ok(registered.length >= 15, `注册的命令太少：${registered.length}`);
for (const id of registered) {
  assert.match(id, /^lgAssist\./, `命令 id 前缀不对：${id}`);
}
// package.json 里声明过的命令必须都真的注册了
const pkg = require(path.join(__dirname, "..", "package.json"));
const declared = pkg.contributes.commands.map((c) => c.command);
const missing = declared.filter((c) => !registered.includes(c));
assert.deepEqual(missing, [], `package.json 声明但未注册的命令：${missing.join(", ")}`);

/** 从面板 HTML 里取出内嵌的 JSON 载荷（模拟 webview 脚本的读法）。 */
function payloadOf(html, id) {
  const re = new RegExp(`<script type="application/json" id="${id}">([\\s\\S]*?)</script>`);
  const m = re.exec(html);
  assert.ok(m, `面板 HTML 缺少 #${id} 载荷`);
  return JSON.parse(m[1]);
}

function assertWebviewOk(html, label) {
  assert.match(html, /^<!DOCTYPE html>/, `${label} 应是完整 HTML`);
  assert.match(html, /Content-Security-Policy/, `${label} 缺少 CSP`);
  assert.match(html, /default-src 'none'/, `${label} 的 CSP 必须默认全禁`);
  assert.match(html, /script-src 'nonce-/, `${label} 的内联脚本必须走 nonce`);
  assert.ok(!/script-src[^"]*unsafe-inline/.test(html), `${label} 的 script-src 不能放开 unsafe-inline`);
}

(async () => {
  const os = require("node:os");
  const fs = require("node:fs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lgassist-smoke-"));
  const src = path.join(dir, "P1001.cpp");
  fs.writeFileSync(
    src,
    `#include <bits/stdc++.h>
int main(){ long long a,b; std::cin>>a>>b; std::cout<<a+b<<"\\n"; return 0; }
`,
  );
  fs.writeFileSync(path.join(dir, "P1001_1.in"), "1 2\n");
  fs.writeFileSync(path.join(dir, "P1001_1.out"), "3\n");
  fs.writeFileSync(path.join(dir, "P1001_2.in"), "10 20\n");
  fs.writeFileSync(path.join(dir, "P1001_2.out"), "30\n");

  // 假装打开了这个文件
  vscode.window.activeTextEditor = {
    document: { uri: Uri.file(src), isDirty: false, save: async () => {}, getText: () => fs.readFileSync(src, "utf8") },
  };

  // 1) 样例评测：走真实的 g++ 编译 + 评测，再渲染评测面板
  await handlers.get("lgAssist.runSamples")();
  assertWebviewOk(lastWebviewHtml, "评测面板");
  const report = payloadOf(lastWebviewHtml, "data");
  assert.equal(report.compileOk, true, "冒烟用例应当编译通过");
  assert.equal(report.cases.length, 2);
  assert.deepEqual(
    report.cases.map((c) => c.status),
    ["AC", "AC"],
  );
  assert.ok(report.cases[0].expected !== undefined, "面板载荷要带上期望输出以便对比");
  assert.match(lastWebviewHtml, /id="submit"/, "评测面板要有「提交到洛谷」按钮");
  assert.match(lastWebviewHtml, /提交到洛谷/, "提交按钮的文案要说清提交到洛谷");
  assert.match(lastWebviewHtml, /command:'submit'/, "评测面板的提交按钮要把消息发给扩展");

  // 未登录时点「提交」只应提示登录、不能抛异常（面板里 submit 走的就是这条路径）
  await handlers.get("lgAssist.submit")();

  // 2) 代码导出图片：验证载荷里有分词后的行与颜色
  await handlers.get("lgAssist.exportImage")(Uri.file(src));
  assertWebviewOk(lastWebviewHtml, "图片面板");
  const img = payloadOf(lastWebviewHtml, "payload");
  assert.equal(img.fileName, "P1001.cpp");
  assert.ok(img.lines.length >= 3, "代码行数不对");
  const flat = img.lines.flat();
  assert.ok(flat.some((r) => /^#[0-9A-Fa-f]{6}$/.test(r.color)), "分词结果应带颜色");
  assert.ok(
    flat.some((r) => r.text.includes("include")),
    "分词结果应包含代码内容",
  );
  assert.ok(
    img.lines.some((line) => line.some((r) => r.text.includes("int"))),
    "关键字行应被打散成片段",
  );

  // 2b) 图片面板只保存到本地：洛谷没有「班级文件」那种去处，上传入口整块删掉了，
  //     这里钉住它不会被人顺手加回来（加回来就是个必然 404 的死按钮）。
  assert.ok(!lastWebviewHtml.includes('id="upload"'), "图片面板不该有上传按钮");
  assert.ok(!lastWebviewHtml.includes("command:'upload'"), "也不该有上传消息通道");

  // 2c) 白板：webview 脚本由 esbuild 的第二入口产出，面板启动时读它的内容内联进 HTML。
  //     这里钉住「产物确实生成了、确实是白板那份」；面板 HTML/CSP 由 test/whiteboard.test.ts 断言
  //     （白板要「当前文件已关联题目 + 已登录」才开得出来，冒烟测试里没有登录态）。
  const wbScriptPath = path.join(__dirname, "..", "dist", "whiteboard.js");
  assert.ok(fs.existsSync(wbScriptPath), "缺少 dist/whiteboard.js（esbuild 第二入口没产出）");
  const wbScript = fs.readFileSync(wbScriptPath, "utf8");
  assert.ok(wbScript.length > 3000, `白板脚本太小（${wbScript.length} 字节），可能没打进来`);
  assert.match(wbScript, /wb-payload/, "白板脚本要读面板里的载荷");
  assert.match(wbScript, /wb-add-page/, "白板脚本要绑上「加页」（不够写时加一张 A4）");
  assert.match(wbScript, /getCoalescedEvents/, "白板脚本要取数位笔的合并事件才不掉点");
  assert.match(wbScript, /simulatePressure/, "白板脚本要带 perfect-freehand 的压感管线");
  assert.match(wbScript, /wb-width/, "白板脚本要接管笔画粗细档");
  assert.ok(registered.includes("lgAssist.openWhiteboard"), "openWhiteboard 声明了却没注册");

  // 2d) 知识面板：不绑题目、不需要登录，所以整块都能在这里真开出来 —— 一张空白 A4 纸，
  //     同样的 CSP 与工具栏，只是 #sheet 里没有题面（留白列容器照旧，右侧留给学生写）。
  await handlers.get("lgAssist.openKnowledgeBoard")();
  assertWebviewOk(lastWebviewHtml, "知识面板");
  assert.match(
    lastWebviewHtml,
    /<div id="sheet" class="oi-sheet"><div class="oi-sheet-body"><\/div><\/div>/,
    "知识面板的纸上不该有题面内容",
  );
  assert.match(lastWebviewHtml, /\.oi-sheet-body\s*\{[^}]*width:\s*66\.667%/, "题面列要占 2/3 宽");
  assert.match(lastWebviewHtml, /id="wb-export"/, "知识面板也要能导出 A4");
  assert.ok(
    (lastWebviewHtml.match(/class="wb-width"/g) ?? []).length >= 3,
    "白板工具条要有笔画粗细档",
  );

  // 3) 状态栏/侧边栏在未登录态下刷新不崩
  await handlers.get("lgAssist.refresh")();
  await handlers.get("lgAssist.showCurrentFileHelp")();
  // 4) 编译失败：报错要发到「问题」面板（带行列），评测面板要逐条列出来并可点击跳行
  const broken = path.join(dir, "Broken.cpp");
  fs.writeFileSync(broken, "#include <bits/stdc++.h>\nint main() {\n  int n\n  return 0;\n}\n");
  vscode.window.activeTextEditor = {
    document: { uri: Uri.file(broken), isDirty: false, save: async () => {}, getText: () => fs.readFileSync(broken, "utf8") },
  };
  await handlers.get("lgAssist.runSamples")();
  const ce = payloadOf(lastWebviewHtml, "data");
  assert.equal(ce.compileOk, false, "缺分号的代码不应编译通过");
  assert.equal(ce.cases.length, 0);
  const firstError = ce.problems.find((p) => p.severity === "error");
  assert.ok(firstError, `评测面板要给出结构化编译问题，实际载荷：${JSON.stringify(ce.problems)}`);
  assert.equal(firstError.line, 4, "g++ 把缺分号报到下一行");
  assert.equal(firstError.column, 3);
  assert.equal(firstError.inSource, true, "当前源文件里的报错要能跳到该行");
  assert.match(firstError.text, /P1001|Broken\.cpp:4:3/, "问题条目要带位置前缀");
  // 小标题把「几个错误 / 几个警告」弱化成次要信息（<small>），错误条数仍要出现在标题里
  assert.match(lastWebviewHtml, /编译问题<small class="muted"> \d+ 错误/, "面板要按错误条数汇总");
  assert.match(lastWebviewHtml, /跳到该行/, "面板里的报错要能点击跳转");
  assert.match(lastWebviewHtml, /command:'goto'/, "点击报错要把跳转消息发给扩展");

  const published = publishedProblems.find((p) => p.uri.fsPath === broken);
  assert.ok(published, "编译报错要发布到「问题」面板");
  assert.equal(published.diagnostics[0].severity, 0, "severity 应为 Error");
  assert.equal(published.diagnostics[0].range.start.line, 3, "问题面板里的行号是 0 起");
  assert.match(published.diagnostics[0].message, /expected initializer/);
  // 想看面板长什么样：LGASSIST_DUMP_PANEL=/tmp/ce.html npm run test:smoke
  if (process.env.LGASSIST_DUMP_PANEL) {
    fs.writeFileSync(process.env.LGASSIST_DUMP_PANEL, lastWebviewHtml, "utf8");
    console.log(`[smoke] 编译失败面板 HTML → ${process.env.LGASSIST_DUMP_PANEL}`);
  }

  // 5) 编译恢复通过后，上一次的报错要被清掉
  fs.writeFileSync(broken, "#include <bits/stdc++.h>\nint main() { return 0; }\n");
  await handlers.get("lgAssist.compileRun")();
  assert.equal(publishedProblems.length, 0, "编译通过后旧的报错必须清空");

  ext.deactivate();
  console.log(
    `✔ 激活冒烟测试通过：注册 ${registered.length} 个命令、评测面板 ${report.cases.length} 个用例、图片面板 ${img.lines.length} 行`,
  );
  Module._load = originalLoad;
})().catch((e) => {
  console.error("✖ 激活冒烟测试失败：", e);
  process.exitCode = 1;
  Module._load = originalLoad;
});
