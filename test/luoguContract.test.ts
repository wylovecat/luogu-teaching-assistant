/**
 * 洛谷站点契约的纯逻辑：信封形态、语言 id 换算、Cookie/CSRF 解析。
 *
 * 这里每条断言都对应 2026-10-12 对着真实站点核对出来的一个结论
 * （核对过程与结论表见仓库根目录 AGENTS.md）。写测试不是为了覆盖率，
 * 是为了**钉死那几个最容易悄悄改错的点** —— 尤其是单位与字段名：
 * 它们错了不会报错，只会安静地把「128MB」显示成「0.1MB」。
 *
 * 纯逻辑，不 import 'vscode'，直接引 ../src/luogu/contract。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  csrfFromCookie,
  csrfFromHtml,
  DEFAULT_ENABLE_O2,
  isFinalStatus,
  isLoggedInCookie,
  LANGUAGES,
  LENTILLE_HEADERS,
  LuoguError,
  parseCookieInput,
  resolveLangId,
  statusShortName,
  uidFromCookie,
  unwrapEnvelope,
  verdictFromStatus,
} from "../src/luogu/contract";
import { pickSamples, statementFromLuogu } from "../src/problems/statement";

// ── 信封 ────────────────────────────────────────────────────────

test("信封：Lentille 的 payload 在 data（当前站点形态）", () => {
  const { root, payload } = unwrapEnvelope({
    instance: "main",
    template: "problem.show",
    status: 200,
    data: { problem: { pid: "P1000" } },
    user: null,
  });
  assert.equal((payload.problem as Record<string, unknown>).pid, "P1000");
  assert.equal(root.template, "problem.show");
});

test("信封：旧的 currentData 也收（站点迁移前的形态）", () => {
  const { payload } = unwrapEnvelope({ code: 200, currentData: { problem: { pid: "P1001" } } });
  assert.equal((payload.problem as Record<string, unknown>).pid, "P1001");
});

test("信封：错误信封的 data 是字符串，不能被误认成 payload", () => {
  // 洛谷未登录时的真实返回：data 存的是错误文案（字符串），不是模板数据
  assert.throws(
    () =>
      unwrapEnvelope({
        errorType: "LuoguFramework\\...\\UserNotLoggedInException",
        errorCode: 403,
        status: 403,
        data: "用户尚未登录",
        errorMessage: "用户尚未登录",
      }),
    (e: unknown) => e instanceof LuoguError && e.authExpired,
  );
});

test("信封：data 与 currentData 同时为空时报的是站点自己的话", () => {
  assert.throws(
    () => unwrapEnvelope({ code: 500, message: "炸了" }),
    /炸了/,
  );
});

// ── 读接口的请求头 ──────────────────────────────────────────────

test("读接口要带 x-lentille-request + Accept 两个头（?_contentOnly=1 已失效）", () => {
  assert.equal(LENTILLE_HEADERS["x-lentille-request"], "content-only");
  assert.equal(LENTILLE_HEADERS.Accept, "application/json");
  // 少任何一个，站点都会退回整页 HTML —— 所以两个必须都在这张表里
  assert.equal(Object.keys(LENTILLE_HEADERS).length, 2);
});

// ── 语言 id ────────────────────────────────────────────────────

test("提交语言：lang 是数字 id，别名查表换算（cpp → C++14 = 11）", () => {
  // 11 是洛谷**网页提交框的默认值**（2026-10-12 真机抓包 `{"lang":11,…}`），
  // 扩展跟着它走：手动提交与扩展提交行为一致，排查时能先排除语言版本这个变量
  assert.equal(resolveLangId("cpp"), 11);
  assert.equal(resolveLangId("CPP"), 11, "大小写不敏感");
  assert.equal(resolveLangId("cpp17"), 12);
  assert.equal(resolveLangId("python3"), 7);
  assert.equal(resolveLangId("java8"), 8);
});

test("提交语言：纯数字串按 id 直接用（站点加了新语言、表没跟上时也能配）", () => {
  assert.equal(resolveLangId("34"), 34);
  assert.equal(resolveLangId(15), 15);
});

test("提交语言：空值落回默认（与洛谷网页一致 = C++14）", () => {
  assert.equal(resolveLangId(""), 11);
  assert.equal(resolveLangId("  "), 11);
});

test("提交语言：认不出一律抛错，绝不静默退回默认（否则「选了 Python 却按 C++ 判」）", () => {
  assert.throws(() => resolveLangId("python"), LuoguError);
  assert.throws(() => resolveLangId("cpp17-clang"), /没认出洛谷语言/);
});

test("语言表：cpp 与 cpp14 指向同一个 id，别名表和站点枚举不打架", () => {
  assert.equal(LANGUAGES.cpp, LANGUAGES.cpp14);
  assert.notEqual(LANGUAGES.cpp, LANGUAGES.cpp17);
});

test("O2：默认开着，跟洛谷网页提交框一致（真机抓包 enableO2=1）", () => {
  assert.equal(DEFAULT_ENABLE_O2, true);
});

// ── Cookie / CSRF ──────────────────────────────────────────────

test("Cookie：能剥出 csrf_token 与 _uid", () => {
  const cookie = "_uid=123456; csrf_token=abc%3D%3D; __client_id=xyz";
  assert.equal(csrfFromCookie(cookie), "abc==");
  assert.equal(uidFromCookie(cookie), 123456);
});

test("Cookie：缺 _uid 时返回 0（探活据此要求重粘整段 Cookie）", () => {
  assert.equal(uidFromCookie("csrf_token=abc; other=1"), 0);
  assert.equal(uidFromCookie(""), 0);
  assert.equal(uidFromCookie("_uid=abc"), 0, "非数字不算数");
});

test("CSRF：题目页的令牌从 meta 标签里取（洛谷按页面发，不能用主页那份）", () => {
  const html = '<html><head><meta charset="utf-8"><meta name="csrf-token" content="1791821811:AbC="></head></html>';
  assert.equal(csrfFromHtml(html), "1791821811:AbC=");
});

test("CSRF：页面没给 meta（风控挑战页）时返回空串，让调用方退回 Cookie 里那份", () => {
  assert.equal(csrfFromHtml("<html><body>challenge</body></html>"), "");
});

// ── 评测记录：判定是 record.status 这个**数字**字段 ──────────────

test("判定映射：数字状态码 → 归一化判定词（枚举抄自站点 /_lfe/config）", () => {
  assert.equal(verdictFromStatus(12), "AC");
  assert.equal(verdictFromStatus(6), "WA");
  assert.equal(verdictFromStatus(5), "TLE");
  assert.equal(verdictFromStatus(4), "MLE");
  assert.equal(verdictFromStatus(7), "RE");
  assert.equal(verdictFromStatus(2), "CE");
  assert.equal(verdictFromStatus(14), "WA", "Unaccepted 归 WA");
});

test("判定映射：三个中间态不给具体判定（-1 Unshown / 0 Waiting / 1 Judging）", () => {
  for (const s of [-1, 0, 1]) {
    assert.equal(verdictFromStatus(s), "?", `status=${s} 不该给出具体判定`);
    assert.equal(isFinalStatus(s), false, `status=${s} 不该算终局`);
  }
});

test("判定映射：终局状态码都认（这是「能不能报给用户」的判据）", () => {
  for (const s of [2, 3, 4, 5, 6, 7, 11, 12, 14, 21, 22, 23]) {
    assert.equal(isFinalStatus(s), true, `status=${s} 应算终局`);
  }
});

test("判定映射：不认识的码既不猜判定、也不算终局（宁可继续等）", () => {
  assert.equal(verdictFromStatus(99), "?");
  assert.equal(isFinalStatus(99), false, "新状态码不能当成终局，否则会把中间态报成结果");
  assert.match(statusShortName(99), /99/, "短名至少要能把原始码带出来，方便排查");
});

test("判定映射：站点短名用于展示与日志", () => {
  assert.equal(statusShortName(12), "AC");
  assert.equal(statusShortName(1), "Judging");
  assert.equal(statusShortName(-1), "Unshown");
});

test("判定映射：OLE（输出超限）按 OJ 惯例归到 RE", () => {
  assert.equal(verdictFromStatus(3), "RE");
  assert.equal(statusShortName(3), "OLE");
});

/**
 * 一份按真实形状裁剪的 `/record/<id>` 响应（AC 的 P1000）。
 * 关键是：判定在 **record.status**（12），而 record 下面并没有 judgeResult ——
 * 早先照 `record.judgeResult.verdict` 读会一直读到空、一路轮询到超时，这条就是防它回归的。
 */
function acRecord() {
  return {
    instance: "main",
    template: "record.show",
    status: 200,
    data: {
      record: {
        id: 102495958,
        status: 12,
        score: 100,
        time: 3,
        memory: 684, // KB
        enableO2: true,
        language: 3,
        problem: { pid: "P1000", name: "超级玛丽游戏", difficulty: 1 },
        detail: {
          compileResult: { success: true, message: null, opt2: true },
          judgeResult: {
            subtasks: [{ id: 0, score: 100, status: 12, time: 3, memory: 684 }],
            finishedCaseCount: 1,
            status: 0, // ← 这个字段是「未填充的聚合值」，**不能**拿它当判定（实测 AC 时它给 0）
            time: 0,
            memory: 0,
            score: 0,
          },
          version: 400,
        },
      },
      testCaseGroup: [[0]],
    },
  };
}

test("记录解析：判定取自 record.status，且不理会 detail.judgeResult.status 那个 0", () => {
  const { payload } = unwrapEnvelope(acRecord());
  const record = payload.record as Record<string, unknown>;
  const statusNum = record.status as number;
  assert.equal(statusNum, 12);
  assert.equal(verdictFromStatus(statusNum), "AC", "实测 AC 记录的 judgeResult.status 是 0，取它会显示成等待中");
  assert.equal(isFinalStatus(statusNum), true);
});

test("记录解析：得分/时间/内存在 record 层，内存单位是 KB", () => {
  const { payload } = unwrapEnvelope(acRecord());
  const record = payload.record as Record<string, unknown>;
  assert.equal(record.score, 100);
  assert.equal(record.time, 3);
  // record.memory 是 KB（与 limits.memory 同量纲）→ 684KB = 700416 字节
  assert.equal((record.memory as number) * 1024, 700416);
  assert.equal((((record.memory as number) * 1024) / 1024 / 1024).toFixed(1), "0.7", "界面上显示 0.7 MB");
});

test("记录解析：CE 的编译报错在 detail.compileResult.message", () => {
  const raw = acRecord();
  const rec = raw.data.record as Record<string, unknown>;
  rec.status = 2;
  (rec.detail as Record<string, unknown>).compileResult = {
    success: false,
    message: "main.cpp:3:5: error: 'x' was not declared in this scope",
  };
  const { payload } = unwrapEnvelope(raw);
  const record = payload.record as Record<string, unknown>;
  const detail = record.detail as Record<string, unknown>;
  assert.equal(verdictFromStatus(record.status as number), "CE");
  assert.match((detail.compileResult as Record<string, unknown>).message as string, /not declared/);
});

test("记录解析：评测中的记录（status=1）不该算终局", () => {
  const raw = acRecord();
  (raw.data.record as Record<string, unknown>).status = 1;
  const { payload } = unwrapEnvelope(raw);
  const statusNum = (payload.record as Record<string, unknown>).status as number;
  assert.equal(isFinalStatus(statusNum), false, "中间态报出去就是把「评测中」当结果");
});

// ── Cookie 粘贴：洛谷上是一段段的，整段/分段/换行都要认 ──────
//
// ⚠️ 下面这些值全是**编造的占位**，别从真机抓包里复制真 Cookie 进来 ——
// `__client_id` 是会话凭据，混进测试就等于把它写进了仓库（本项目是公开仓库）。

test("Cookie 解析：整条请求头（带不带 Cookie: 这个词都行）", () => {
  const raw = "Cookie: _uid=123456; __client_id=18a7c9f2; C3VK=f1e2d3";
  assert.equal(parseCookieInput(raw).header, "_uid=123456; __client_id=18a7c9f2; C3VK=f1e2d3");
  assert.equal(parseCookieInput(raw.replace(/^Cookie:\s*/i, "")).header, "_uid=123456; __client_id=18a7c9f2; C3VK=f1e2d3");
});

test("Cookie 解析：一段一段粘、每行一条（用户从「应用程序 → Cookie」表格复制的情况）", () => {
  const raw = ["_uid=123456", "__client_id=deadbeefdeadbeefdeadbeefdeadbeef", "C3VK=f1e2d3"].join("\n");
  const { header, pairs } = parseCookieInput(raw);
  assert.equal(header, "_uid=123456; __client_id=deadbeefdeadbeefdeadbeefdeadbeef; C3VK=f1e2d3");
  assert.equal(pairs._uid, "123456");
  assert.equal(pairs.C3VK, "f1e2d3");
});

test("Cookie 解析：F12 里被折行的 Cookie 也能拼回一条", () => {
  const raw = "Cookie: _uid=123456; __client_id=18a7c9f2;\n C3VK=f1e2d3";
  const { header, pairs } = parseCookieInput(raw);
  assert.equal(pairs._uid, "123456");
  assert.equal(pairs.C3VK, "f1e2d3");
  assert.equal(header, "_uid=123456; __client_id=18a7c9f2; C3VK=f1e2d3");
});

test("Cookie 解析：等号两边有空格也认（DevTools 表格里常见的 `名字 = 值`）", () => {
  const { pairs } = parseCookieInput("_uid = 123456\n__client_id = abc");
  assert.equal(pairs._uid, "123456");
  assert.equal(pairs.__client_id, "abc");
});

test("Cookie 解析：值里含等号不被切断（按第一个 = 拆）", () => {
  const { pairs } = parseCookieInput("csrf_token=1700000000:FAKE0fake0FAKE0fake0FAKE0fake0=");
  assert.equal(pairs.csrf_token, "1700000000:FAKE0fake0FAKE0fake0FAKE0fake0=");
});

test("Cookie 解析：同名后者覆盖前者（与浏览器一致）", () => {
  assert.equal(parseCookieInput("_uid=1; _uid=2").pairs._uid, "2");
});

test("Cookie 解析：普通句子/空行不会混进来", () => {
  assert.equal(parseCookieInput("随便一段文字").header, "");
  assert.equal(parseCookieInput("   \n\n  ").header, "");
  assert.equal(parseCookieInput("_uid=123456\n这是一句说明").header, "_uid=123456");
});

test("登录判据：认 _uid 或 __client_id，**不认 csrf_token**", () => {
  // ⚠️ 洛谷真实会话里就没有 csrf_token（真机抓包 `Cookie: _uid=…; __client_id=…; C3VK=…`），
  // 拿它当必要条件会让登录永远走不通 —— 这条就是防那个回归的。
  assert.equal(isLoggedInCookie("_uid=123456; __client_id=18a7c9f2; C3VK=f1e2d3"), true);
  assert.equal(isLoggedInCookie("__client_id=18a7c9f2"), true);
  assert.equal(isLoggedInCookie("csrf_token=abc; C3VK=f1e2d3"), false);
  assert.equal(isLoggedInCookie(""), false);
});

// ── 题面字段映射（形状照 2026-10-12 实测的 P1000 返回裁剪） ──

/** 一份按真实形状裁出来的 P1000 题面：标题在 name、正文在 content、限制在 limits。 */
const LENTILLE_PROBLEM = {
  pid: "P1000",
  name: "超级玛丽游戏",
  title: "", // ← 实测：顶层 title 存在但是空串，只认 title 会得到空标题
  difficulty: 1,
  fullScore: 100,
  tags: [2, 108],
  samples: [["1 2", "3"]], // ← 实测是 [输入, 输出] 元组，不是对象
  acceptLanguages: [5, 1, 2, 28, 3, 4, 11, 12, 27, 34],
  content: {
    name: "超级玛丽游戏",
    background: "background",
    description: "description",
    formatI: "formatI",
    formatO: "formatO",
    hint: "hint",
    locale: "zh-CN",
  },
  limits: { time: [1000], memory: [131072] }, // ← 毫秒 / KB
};

test("题面：标题取 name（顶层 title 是空串，取它会得到空标题）", () => {
  const s = statementFromLuogu(LENTILLE_PROBLEM, { displayId: "P1000", title: "" });
  assert.equal(s.title, "超级玛丽游戏");
  assert.equal(s.displayId, "P1000");
});

test("题面：正文在 content 子对象里（formatI/formatO，不是 inputFormat/outputFormat）", () => {
  const s = statementFromLuogu(LENTILLE_PROBLEM, { displayId: "P1000", title: "" });
  assert.equal(s.description, "description");
  assert.equal(s.inputDescription, "formatI");
  assert.equal(s.outputDescription, "formatO");
  assert.equal(s.prompt, "background");
  assert.equal(s.hint, "hint");
});

test("题面：limits.time 是毫秒，直接用", () => {
  assert.equal(statementFromLuogu(LENTILLE_PROBLEM, { displayId: "P1000", title: "" }).timeLimitMs, 1000);
});

test("题面：limits.memory 是 KB 不是字节（131072KB = 128MB，当字节算会差三个数量级）", () => {
  const s = statementFromLuogu(LENTILLE_PROBLEM, { displayId: "P1000", title: "" });
  assert.equal(s.memoryLimitMb, 128);
  // 旧形态的 memoryLimit 是字节，128MB 应给 134217728
  assert.equal(
    statementFromLuogu({ memoryLimit: 134217728 }, { displayId: "x", title: "" }).memoryLimitMb,
    128,
  );
});

test("题面：限制给的是数组（每个数据点一份），取最大值", () => {
  const s = statementFromLuogu(
    { limits: { time: [1000, 2000], memory: [131072, 262144] } },
    { displayId: "x", title: "" },
  );
  assert.equal(s.timeLimitMs, 2000);
  assert.equal(s.memoryLimitMb, 256);
});

test("题面：旧的平铺字段仍然收（老缓存与老测试用例还是它）", () => {
  const s = statementFromLuogu(
    {
      pid: "P1001",
      title: "A+B Problem",
      description: "d",
      inputFormat: "i",
      outputFormat: "o",
      background: "b",
      hint: "h",
      timeLimit: 1000,
      memoryLimit: 131072000,
      samples: [{ input: "1 2", output: "3" }],
    },
    { displayId: "P1001", title: "" },
  );
  assert.equal(s.title, "A+B Problem");
  assert.equal(s.inputDescription, "i");
  assert.equal(s.timeLimitMs, 1000);
  assert.equal(s.memoryLimitMb, 125);
  assert.deepEqual(s.samples, [{ input: "1 2", output: "3" }]);
});

test("样例：[输入,输出] 元组与 {input,output} 对象两种形状都收", () => {
  assert.deepEqual(pickSamples([["a", "b"]]), [{ input: "a", output: "b" }]);
  assert.deepEqual(pickSamples([{ input: "a", output: "b" }]), [{ input: "a", output: "b" }]);
});

test("样例：占位空元组丢弃，别弄出一个空样例框", () => {
  assert.deepEqual(pickSamples([["", ""], ["x", ""]]), [{ input: "x", output: "" }]);
  assert.deepEqual(pickSamples(null), []);
});

test("样例：样例数据不足两格时按空输出处理，不越界", () => {
  assert.deepEqual(pickSamples([["only-input"]]), [{ input: "only-input", output: "" }]);
});