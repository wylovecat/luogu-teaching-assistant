/**
 * 洛谷站点契约里的**纯逻辑**部分：UA、lentille 请求头、语言 id 换算、Cookie 解析、CSRF 抽取。
 *
 * 为什么单独成文件：这个模块**不许 import 'vscode'** —— 它被 `client.ts` 引用，
 * 也要被 `test/luoguContract.test.ts` 直接引用（`client.ts` 会经 `../config` 拉进 vscode，
 * 单元测试引不动）。这是本仓库对纯逻辑模块的通用约定。
 *
 * ⚠️ 这里的取值全部来自洛谷站点自己，不是猜的（2026-10-12 实测，核对过程见 AGENTS.md 契约表）：
 *  - `LANGUAGES` 抄自 `GET /_lfe/config` 的 `CodeLanguage` 枚举（不登录可读）；
 *  - 「只回 JSON」要靠 `x-lentille-request: content-only` + `Accept` 两个请求头，
 *    `?_contentOnly=1` 那个查询参数**已失效**。
 * 站点加语言时 `LANGUAGES` 会过期 —— 那时把 `_lfe/config` 里对应项的 id 补进来即可。
 */

/** 洛谷对非浏览器客户端会拦 UA，固定一个常见桌面 UA。 */
export const LUOGU_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

/**
 * 读接口「只要 JSON，不要整页 HTML」的两个请求头。
 *
 * 两个都得带：只加 `Accept: application/json` 实测仍会拿到整页 HTML。
 */
export const LENTILLE_HEADERS: Record<string, string> = {
  "x-lentille-request": "content-only",
  Accept: "application/json",
};

/**
 * 洛谷提交语言：别名 → 站点语言 id。
 *
 * `lang` 在提交接口里是**数字**（`{ code, lang: 11, enableO2: 1 }`），不是 "cpp" 字符串。
 * 逐条抄自 `/_lfe/config` 的 `CodeLanguage` 枚举。只收 OI 教学里真会用的几种；
 * 其余语言直接配数字 id（`"34"` 会被当成 id 用）。
 */
export const LANGUAGES: Record<string, number> = {
  // C++ 系：洛谷按标准版本分开。`cpp` 跟洛谷**网页提交框的默认值**一致 = C++14（id 11），
  // 2026-10-12 真机抓包见 `{"lang":11,…}`。这样扩展提交与手动提交行为完全一致，
  // 出现「网页能过、扩展不行」时能立刻排除语言版本这个变量。
  cpp: 11,
  cpp98: 3,
  cpp11: 4,
  cpp14: 11,
  cpp14gcc9: 28,
  cpp17: 12,
  cpp20: 27,
  cpp23: 34,
  c: 2,
  pascal: 1,
  python3: 7,
  py3: 7,
  pypy3: 25,
  java8: 8,
  java21: 33,
  rust: 15,
  go: 14,
  haskell: 19,
  ocaml: 30,
  julia: 31,
  lua: 32,
  kotlin: 21,
  scala: 22,
  csharp: 17,
  nodejs: 9,
  php: 16,
  ruby: 13,
  perl: 23,
};

/**
 * 提交时 O2 优化的默认值。洛谷**网页提交框默认是开的**（真机抓包 `"enableO2":1`），
 * 这里跟着网页走 —— 扩展提交与手动提交行为一致，课堂上「本地能过、洛谷不过」
 * 少一类来自 O2 改变未定义行为表现的原因。要关可以在 `lgAssist.submit.enableO2` 改。
 */
export const DEFAULT_ENABLE_O2 = true;

/**
 * 条评测记录的判定：数字状态码 → 归一化判定词 / 站点短名 / 是否终局。
 *
 * **这才是判定所在的字段** —— 不是 `judgeResult.verdict`（那个字段不存在）。
 * 数字枚举抄自站点自己的 `GET /_lfe/config`（`RecordStatus`，不登录可读，2026-10-12 实测），
 * 字段位置 `record.status` 由两处独立来源交叉验证（见下）。
 *
 * ⚠️ **别改用 `detail.judgeResult.status`**：实测那份响应里它给的是 `0`（Waiting），
 * 而同一份记录的 `record.status` 是 `12`（AC）—— 用错字段会把 AC 显示成「等待中」。
 *
 * 未列出的数字一律按「还没判完」处理（继续等），绝不猜一个判定：
 * 宁可最后报「未知/超时」，也不要把中间态或新状态码显示成某个具体判定。
 */
const RECORD_STATUS: Record<number, { verdict: string; short: string; final: boolean }> = {
  // 三个中间态：都不算终局
  [-1]: { verdict: "?", short: "Unshown", final: false },
  0: { verdict: "?", short: "Waiting", final: false },
  1: { verdict: "?", short: "Judging", final: false },
  2: { verdict: "CE", short: "CE", final: true },
  // 输出超限：按 OJ 惯例归到 RE（与第三方适配器的做法一致）
  3: { verdict: "RE", short: "OLE", final: true },
  4: { verdict: "MLE", short: "MLE", final: true },
  5: { verdict: "TLE", short: "TLE", final: true },
  6: { verdict: "WA", short: "WA", final: true },
  7: { verdict: "RE", short: "RE", final: true },
  11: { verdict: "RE", short: "UKE", final: true },
  12: { verdict: "AC", short: "AC", final: true },
  14: { verdict: "WA", short: "NAC", final: true },
  21: { verdict: "?", short: "Hack Success", final: true },
  22: { verdict: "WA", short: "Hack Failure", final: true },
  23: { verdict: "?", short: "Hack Skipped", final: true },
};

/** 数字状态码 → 归一化判定词（AC/WA/TLE/MLE/RE/CE/?）。不认识的码给 "?"。 */
export function verdictFromStatus(status: number): string {
  return RECORD_STATUS[status]?.verdict ?? "?";
}

/** 数字状态码 → 站点短名（展示/日志用，比归一化后的词更贴近站点）。 */
export function statusShortName(status: number): string {
  return RECORD_STATUS[status]?.short ?? `status=${status}`;
}

/**
 * 这个数字状态码是不是**终局**。
 *
 * 不认识的码返回 false：继续等，比猜一个判定安全。真遇到新码，
 * 输出面板的「诊断」一行会把数字打出来，照着补进 `RECORD_STATUS` 即可。
 */
export function isFinalStatus(status: number): boolean {
  return RECORD_STATUS[status]?.final ?? false;
}

/**
 * 把配置里的 `submit.language` 解析成站点要的语言 id。
 *
 * 纯数字串按 id 直接用（站点加了新语言、这张表还没跟上时也能配），否则查别名表。
 * 查不到就抛错并把可用值列出来 —— 静默退回默认值会让「我明明选了 Python 却按 C++ 判」，
 * 这种错比直接报错难查得多。
 */
export function resolveLangId(lang: string | number): number {
  if (typeof lang === "number" && Number.isFinite(lang)) return Math.trunc(lang);
  const raw = String(lang ?? "").trim();
  if (raw === "") return LANGUAGES.cpp;
  if (/^\d+$/.test(raw)) return Number(raw);
  const hit = LANGUAGES[raw.toLowerCase()];
  if (hit === undefined) {
    throw new LuoguError(
      `没认出洛谷语言「${raw}」。可填数字 id（如 12 = C++17），或用这些别名：${Object.keys(LANGUAGES).join(" / ")}`,
    );
  }
  return hit;
}

/** 从 Cookie 串里取出 csrf_token（旧登录态自检仍用；提交改走题目页的令牌，见 csrfFromHtml）。 */
export function csrfFromCookie(cookie: string): string {
  const hit = /(?:^|;\s*)csrf_token=([^;]+)/.exec(cookie);
  return hit ? decodeURIComponent(hit[1]) : "";
}

/**
 * 从题目页 HTML 里抠出该页下发的 CSRF 令牌。
 *
 * 洛谷**按页面**发 CSRF 令牌：提交某题要用那题页面下发的那个，
 * 拿主页/登录页那个（也就是 Cookie 里那份）会被鉴权挡掉。
 */
export function csrfFromHtml(html: string): string {
  return /<meta\s+name="csrf-token"\s+content="([^"]+)"/i.exec(html)?.[1] ?? "";
}

/** 从 Cookie 串里取出 `_uid`（洛谷的用户主键，探活要用）。 */
export function uidFromCookie(cookie: string): number {
  const hit = /(?:^|;\s*)_uid=([^;\s]+)/.exec(cookie);
  const n = hit ? Number(decodeURIComponent(hit[1])) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 解析出来的 Cookie：`header` 是归一化后的请求头值，`pairs` 是逐项键值。 */
export interface ParsedCookie {
  /** 归一化成 `a=1; b=2`，可直接放进 Cookie 请求头 */
  header: string;
  pairs: Record<string, string>;
}

/** Cookie 名允许的字符（RFC 6265 token 的子集，够用且能挡掉误粘的普通句子）。 */
const COOKIE_NAME = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/;

/**
 * 宽容地解析用户粘进来的 Cookie —— 从「洛谷上是一段段的」到整条请求头都能吃。
 *
 * 用户实际会粘到的形状很多，全都要能收（少收一种就是「登录不进去」）：
 *  1. 整条请求头：`Cookie: _uid=1; __client_id=…`（带不带 `Cookie:` 这个词都行）
 *  2. 只有值：`_uid=1; __client_id=…; C3VK=…`
 *  3. **一段一段**、每行一条（用户从「应用程序 → Cookie」表格里逐条复制的情况）
 *  4. 上面那种但在 F12 里被折了行：`…; C3VK=` 顶格续行
 *  5. 等号两边带空格：`_uid = 1`
 * 值里含 `=`（base64 之类）不会被切断 —— 只按第一个 `=` 拆。
 *
 * 与浏览器一致的覆盖语义：同名后者覆盖前者。
 */
export function parseCookieInput(raw: string): ParsedCookie {
  const pairs = new Map<string, string>();
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    // 折行续接的情况：去掉行首空白后并到上一行末尾的 `;` 里
    let chunk = line.trim();
    if (chunk === "") continue;
    chunk = chunk.replace(/^cookie\s*:\s*/i, "");
    // 一行里可能有多个（`a=1; b=2`），也可能只有一条（`a=1`）
    for (const piece of chunk.split(";")) {
      const item = piece.trim();
      if (item === "") continue;
      const eq = item.indexOf("=");
      if (eq <= 0) continue;
      const name = item.slice(0, eq).trim();
      const value = item.slice(eq + 1).trim();
      if (!COOKIE_NAME.test(name) || value === "") continue;
      pairs.set(name, value);
    }
  }
  const header = [...pairs].map(([k, v]) => `${k}=${v}`).join("; ");
  return { header, pairs: Object.fromEntries(pairs) };
}

/**
 * 这段 Cookie 够不够当洛谷登录态。
 *
 * ⚠️ **不要**拿 `csrf_token` 当必要条件：洛谷真实会话里根本没有它
 * （真机抓包 `Cookie: _uid=…; __client_id=…; C3VK=…`）。CSRF 走的是题目页
 * 下发的那个令牌，见 `client.ts` 的 `csrfFor`。
 */
export function isLoggedInCookie(cookie: string): boolean {
  const { pairs } = parseCookieInput(cookie);
  return pairs._uid !== undefined || pairs.__client_id !== undefined;
}

/**
 * 剥洛谷的信封，取出 payload。
 *
 * 两种形态都收（站点迁移过）：Lentille 的 payload 在 `data`，旧的（已下线）在 `currentData`。
 * 按「是不是非空对象」判定 —— 错误信封的 `data` 是个字符串（"用户尚未登录"），
 * 不能被误认成 payload。
 *
 * @returns root 是信封本体（顶层还有 `user` 等），payload 是模板数据。
 * @throws LuoguError 未登录 / 被风控 / 结构不认识时抛。
 */
export function unwrapEnvelope(json: unknown): { root: Record<string, unknown>; payload: Record<string, unknown> } {
  const root =
    json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const lentille = obj(root.data);
  const legacy = obj(root.currentData);
  const payload = Object.keys(lentille).length > 0 ? lentille : legacy;
  if (Object.keys(payload).length === 0) {
    const message =
      text(root.errorMessage) ||
      text(root.message) ||
      text(root.msg) ||
      (typeof root.data === "string" ? root.data : "") ||
      `code=${String(root.code ?? root.status ?? "?")}`;
    throw new LuoguError(`洛谷未返回数据：${message}`, true);
  }
  return { root, payload };
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 站点业务错误（未登录、限流、题目不存在…）。`authExpired` 为真表示该重新登录了。
 *
 * 放在纯逻辑模块里，是因为 `resolveLangId` / `unwrapEnvelope` 这些纯函数也要抛它；
 * `client.ts` 会再导出一次，既有调用方不用改 import。
 */
export class LuoguError extends Error {
  constructor(
    message: string,
    readonly authExpired = false,
  ) {
    super(message);
    this.name = "LuoguError";
  }
}