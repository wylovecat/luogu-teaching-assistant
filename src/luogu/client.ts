/**
 * 洛谷站点客户端 —— 全项目**唯一**访问 www.luogu.com.cn 的地方。
 *
 * 三条规矩（改之前先读）：
 *
 * ① **串行节流**。洛谷比一般 OJ 敏感，所有请求排成一条队，两次之间至少隔
 *    `luogu.requestIntervalMs`（默认 800ms）。搜索题库、翻评测记录都走这里，别绕过。
 *
 * ② **登录态是 Cookie，不是账号密码**。洛谷登录带验证码/滑块，没法在扩展里自动完成，
 *    所以走「用户在浏览器登录后把 Cookie 粘进来」（见 session.ts）。**不存在静默重登**，
 *    Cookie 过期就是让用户重新粘一次 —— 这与爱思创那版（密码进 SecretStorage 自动重登）
 *    是两回事，别把那边的做法抄过来。
 *
 * ③ **契约的把握程度写在注释里**，别凭直觉改。
 *
 *    2026-10-12 核对结论（洛谷前端已迁到 Lentille 架构，这一轮把三条老假设全推翻了，
 *    详见 AGENTS.md 的契约表；提交那半边仍未在真机登录会话下跑通过）：
 *    - 读接口**不再认 `?_contentOnly=1`**，那个参数已失效（会退回整页 HTML）。
 *      现在必须带请求头 `x-lentille-request: content-only` + `Accept: application/json`。
 *    - 信封有两个形态：新的 payload 在 `data`（Lentille），旧的（已下线）在 `currentData`。
 *      两种都收，别只认一个。
 *    - 提交是 **JSON** POST `{ code, lang, enableO2 }`，成功后直接回 `{ rid }`，
 *      **不是** 302 跳 `/record/<rid>`；CSRF 走 `X-CSRF-Token` 头，且必须是**题目页**
 *      下发的那个令牌（主页那个过不了鉴权）。
 *    - `lang` 是**数字**语言 id（见 `LANGUAGES`），不是 "cpp" 这种字符串。
 *    - ⚠️ `/record/<rid>` 的返回形状仍未在登录会话下核对过（该接口未登录一律 401）。
 *      `poll()` 因此保守：只认判定文本，拿不到就报「未知」，不猜。
 */

import { luoguConfig } from "../config";
import { statementFromLuogu, type Statement } from "../problems/statement";
import { normVerdict } from "../util";
import {
  csrfFromHtml,
  DEFAULT_ENABLE_O2,
  isFinalStatus,
  LENTILLE_HEADERS,
  LuoguError,
  LUOGU_UA,
  resolveLangId,
  statusShortName,
  uidFromCookie,
  unwrapEnvelope,
  verdictFromStatus,
} from "./contract";
import { request, type HttpResponse } from "./http";

// 站点契约的纯逻辑（语言 id、Cookie/CSRF 解析、信封剥离）在 ./contract 里，
// 那边不引 vscode，单元测试可以直接引。既有调用方仍可从本文件拿这些名字。
export {
  csrfFromCookie,
  csrfFromHtml,
  DEFAULT_ENABLE_O2,
  isFinalStatus,
  LANGUAGES,
  LENTILLE_HEADERS,
  LuoguError,
  LUOGU_UA,
  resolveLangId,
  statusShortName,
  uidFromCookie,
  verdictFromStatus,
} from "./contract";


export interface LuoguSession {
  /** 用户粘进来的完整 Cookie 串（含 csrf_token / _uid 等） */
  cookie: string;
  /** 从 Cookie 里剥出来的 csrf_token，提交表单要带 */
  csrfToken: string;
  uid: number;
  uname: string;
}

/** 搜索/题库里的一道题（够用来开题面，不必拉全文）。 */
export interface LuoguHit {
  displayId: string;
  title: string;
  difficulty: number | null;
}

/**
 * 一次评测的结果。
 * 字段刻意与 `isFinalJudgeResult(res)` 的入参对齐（done / id / rawStatus），
 * 提交域那边直接把它交出去判「能不能报给用户」。
 */
export interface LuoguResult {
  /** 评测记录 id */
  id: number;
  /** 站点是否已经给出终局判定 */
  done: boolean;
  /** 归一化判定：AC / WA / TLE / MLE / RE / CE / PE / ? */
  verdict: string;
  /** 站点原始判定文本（judgeResult.verdict），空字符串表示「还没写」 */
  rawStatus: string;
  score: number | null;
  timeMs: number | null;
  memoryBytes: number | null;
  /** 编译错误详情等补充说明 */
  feedback: string;
}


/** 题面地址（题号当 URL 路径用，远程题如 AT_abc001_a 原样拼）。 */
export function problemUrl(baseUrl: string, displayId: string): string {
  return `${baseUrl}/problem/${encodeURIComponent(displayId)}`;
}

/** 评测记录地址。 */
export function recordUrl(baseUrl: string, rid: number): string {
  return `${baseUrl}/record/${rid}`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function numOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** 尽力解析 JSON：解析不了就给空对象，让调用方按「响应不是 JSON」那条路报错。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 洛谷 C3VK 反爬挑战码的有效期。站点下发 `Max-Age=300`（2026-10-12 实测）。 */
const C3VK_TTL_MS = 300_000;
/** 提前失效的余量：宁可边界处多走一次挑战，也不把可能已过期的码当有效的发出去。 */
const C3VK_SAFETY_MS = 10_000;

export class LuoguClient {
  private session: LuoguSession | null = null;
  /** 请求队列：所有请求串行执行，天然实现节流 */
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;
  /** 反爬挑战码（`C3VK=…`）与它的到期时刻；跨请求复用，别每次都重走一遍挑战 */
  private c3vk = "";
  private c3vkExpiresAt = 0;
  /** 已经打过原文诊断的评测记录号（每条只打一次，别刷屏） */
  private readonly pollLogged = new Set<number>();

  constructor(private readonly opts: { onAuthExpired: () => void; onDebug?: (msg: string) => void }) {}

  /**
   * 打一条诊断到输出面板。
   *
   * 存在的理由很具体：`/record/<rid>` 是**唯一**没法一个人核对的接口（未登录一律 401），
   * 只能靠一次真机提交把它的真实形状带回来。与其让用户报「等很久没结果」，
   * 不如把站点原文直接打出来 —— 一次就能把字段名定死（见 AGENTS.md）。
   */
  private debug(msg: string): void {
    this.opts.onDebug?.(msg);
  }

  get current(): LuoguSession | null {
    return this.session;
  }

  setSession(session: LuoguSession | null): void {
    this.session = session;
  }

  /**
   * 排队执行并保证两次请求的间隔。调用方只需要 await 这个，别自己并发打站点。
   */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      const gap = luoguConfig().requestIntervalMs;
      const wait = this.lastAt + gap - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await fn();
      } finally {
        this.lastAt = Date.now();
      }
    };
    const next = this.queue.then(run, run);
    // 队列本身不该被某次失败打断，否则后面所有请求都跟着挂掉
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": LUOGU_UA,
      "Accept-Language": "zh-CN,zh;q=0.9",
      // 这两个头是「读接口只回 JSON」的开关（见 contract.LENTILLE_HEADERS）：
      // 洛谷前端搬到 Lentille 之后，`?_contentOnly=1` 这个查询参数已经**失效**，
      // 不带这两个头会拿到整页 HTML（单加 `Accept` 也不够 —— 2026-10-12 实测）。
      ...LENTILLE_HEADERS,
      Referer: `${luoguConfig().baseUrl}/`,
      ...(extra ?? {}),
    };
    const cookie = this.cookieHeader();
    if (cookie) h.Cookie = cookie;
    return h;
  }

  /** 要发出去的整段 Cookie = 用户 Cookie + 反爬挑战码（同名覆盖，与浏览器合并语义一致）。 */
  private cookieHeader(): string {
    const base = this.session?.cookie ?? "";
    if (Date.now() >= this.c3vkExpiresAt) this.c3vk = "";
    if (!this.c3vk) return base;
    return base.includes("C3VK=")
      ? base.replace(/C3VK=[^;]*/, this.c3vk)
      : `${base.replace(/;\s*$/, "")}${base ? "; " : ""}${this.c3vk}`;
  }

  /**
   * 从响应头里吸收洛谷的 C3VK 反爬挑战码。
   *
   * 洛谷会先 302 跳回自身、并下发 `Set-Cookie: C3VK=…; Max-Age=300; Path=/`，
   * 带上重试才放行（而且每次放行都会**再换一枚**新的码）。
   * 不处理它的后果很具体：`http.ts` 不跟随重定向，于是题面抓取会拿到一个 302，
   * 被 `envelopeFull` 当成「登录态过期」—— 报出来的却是假原因。
   * 2026-10-12 真机撞到过这个（`redirect count exceeded`）。
   *
   * @returns 是否吸到了新码。没吸到就别重试 —— 那种 302 是真的「跳登录」。
   */
  private absorbChallenge(setCookie: string | undefined): boolean {
    const fresh = /C3VK=([^;,\s]+)/.exec(setCookie ?? "")?.[1];
    if (!fresh) return false;
    this.c3vk = `C3VK=${fresh}`;
    // 站点给 Max-Age=300；留 10 秒余量，宁可边界处多走一次挑战也不发可能已过期的码
    this.c3vkExpiresAt = Date.now() + C3VK_TTL_MS - C3VK_SAFETY_MS;
    return true;
  }

  /**
   * 发一次请求，必要时带反爬挑战码重试。
   *
   * ⚠️ **`retryChallenge` 只有 GET 能开**：POST 遇到 302 时**绝不能自动重试**。
   * 洛谷的挑战 302 是「跳回自身」，看起来无害，但提交接口有可能已经把记录建好、
   * 只是用 302 回跳 —— 自动重放就会变成**两条重复提交**。
   * 提交那边改为「发之前先 GET 题目页把挑战码备好」（`csrfFor` 走的就是这条路），
   * 真遇上挑战就报给人，由人决定要不要再点一次提交。
   */
  private async call(
    method: "GET" | "POST",
    path: string,
    extra?: {
      headers?: Record<string, string>;
      json?: unknown;
      body?: Buffer;
      timeoutMs?: number;
      retryChallenge?: boolean;
    },
  ): Promise<HttpResponse> {
    const retry = extra?.retryChallenge ?? method === "GET";
    return this.enqueue(async () => {
      let res: HttpResponse | undefined;
      // 最多两次：第一次拿挑战码，第二次带上它重试；还不行就是真的被拒了
      for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
        res = await request({
          method,
          url: `${luoguConfig().baseUrl}${path}`,
          headers: this.headers(extra?.headers),
          json: extra?.json,
          body: extra?.body,
          timeoutMs: extra?.timeoutMs,
        });
        if (!isRedirect(res.status)) return res;
        if (!this.absorbChallenge(res.headers["set-cookie"])) return res;
      }
      return res as HttpResponse;
    });
  }

  /**
   * 剥洛谷的信封，取出 payload（形态判定在 contract.unwrapEnvelope 里）。
   *
   * 未登录时站点不会给 payload，而是错误信封或直接跳登录页 —— 那时要抛
   * `authExpired` 让上层引导重新登录，而不是当成「解析失败」。
   */
  private envelopeFull(
    res: HttpResponse,
    path: string,
  ): { root: Record<string, unknown>; payload: Record<string, unknown> } {
    // 401/403 与 3xx 跳登录都是同一件事：登录态没了。
    // （之前只认 401/403，站点改用 302 跳登录时会掉进下面的「不是 JSON」分支。）
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      this.opts.onAuthExpired();
      throw new LuoguError(`洛谷 ${path} 需要登录（HTTP ${res.status}），Cookie 无效或已过期`, true);
    }
    try {
      return unwrapEnvelope(JSON.parse(res.text));
    } catch (e) {
      if (e instanceof LuoguError) {
        this.opts.onAuthExpired();
        throw new LuoguError(`洛谷 ${path} ${e.message}`, true);
      }
      // 拿到 HTML 基本就是风控挑战页（C3VK）或登录页，同样按需要重新登录处理
      this.opts.onAuthExpired();
      throw new LuoguError(
        `洛谷 ${path} 返回的不是 JSON（可能被风控拦截或 Cookie 失效）：${res.text.slice(0, 120)}`,
        true,
      );
    }
  }

  private envelope(res: HttpResponse, path: string): Record<string, unknown> {
    return this.envelopeFull(res, path).payload;
  }

  // ── 题面 ────────────────────────────────────────────────────────

  /**
   * 拉题面。`GET /problem/<pid>`（配 `x-lentille-request: content-only`）→ `data.problem`。
   *
   * 这条是公开接口（不登录也能读），字段形状见 problems/statement.ts 的注释。
   */
  async statement(displayId: string): Promise<Statement> {
    const res = await this.call("GET", `/problem/${encodeURIComponent(displayId)}`);
    const data = this.envelope(res, `题面 ${displayId}`);
    const problem = asRecord(data.problem);
    if (Object.keys(problem).length === 0) {
      throw new LuoguError(`洛谷没有这道题：${displayId}`);
    }
    return statementFromLuogu(problem, { displayId, title: "" });
  }

  // ── 搜索 ────────────────────────────────────────────────────────

  /** 搜索题库：`GET /problem/list?keyword=…` → `data.problems.result`。 */
  async searchProblems(keyword: string): Promise<LuoguHit[]> {
    const res = await this.call("GET", `/problem/list?keyword=${encodeURIComponent(keyword)}&page=1`);
    const data = this.envelope(res, `搜索「${keyword}」`);
    const problems = asRecord(data.problems);
    const raw = problems.result;
    // result 在不同站点版本里可能是数组，也可能是以 pid 为键的对象，两种都收
    const items: Record<string, unknown>[] = Array.isArray(raw)
      ? raw.map(asRecord)
      : Object.values(asRecord(raw)).map(asRecord);
    return items
      .filter((it) => typeof it.pid === "string" && it.pid !== "")
      .map((it) => ({
        displayId: str(it.pid),
        // 标题字段在新接口里叫 `name`（旧的 `title` 已经是空串），两个都收
        title: str(it.name) || str(it.title),
        difficulty: numOrNull(it.difficulty),
      }));
  }

  // ── 登录态 ──────────────────────────────────────────────────────

  /**
   * 探测当前 Cookie 是否有效。
   *
   * ⚠️ 旧实现打的是 `GET /user`，那个自检端点**已经 404 下线**了（2026-10-12 实测），
   * 也就是说登录探活一直是坏的。这里改用与洛谷前端同款、且确实要登录才拿得到的
   * 提交列表：`GET /record/list?user=<uid>&page=1`。
   */
  async probe(): Promise<{ uid: number; uname: string }> {
    const uid = uidFromCookie(this.session?.cookie ?? "");
    if (!uid) {
      throw new LuoguError(
        "这段 Cookie 里没有 _uid。请在开发者工具的「网络」面板里复制**整段** Cookie" +
          "（形如 `Cookie: _uid=…; csrf_token=…; …`）后重试。",
      );
    }
    const res = await this.call("GET", `/record/list?user=${uid}&page=1`);
    const { root, payload } = this.envelopeFull(res, "提交记录");
    // 登录成功才拿得到 records.result 数组；否则这里会是别的形状
    if (!Array.isArray(asRecord(payload.records).result)) {
      throw new LuoguError("洛谷返回的提交记录结构不对（没有 result 数组），Cookie 可能已失效", true);
    }
    // 用户名在信封顶层，不在 payload 里（老接口 /user 也是从那儿取的）
    const me = asRecord(root.user);
    return { uid, uname: str(me.name) || str(me.uname) };
  }

  // ── 提交与评测 ────────────────────────────────────────────────────
  //
  // 契约（2026-10-12 核对；提交那半边仍未在真机登录会话下跑通，核对完请回来更新本段）：
  //   1. `POST /fe/api/problem/submit/<pid>`，请求体是 **JSON** `{ lang, code, enableO2 }`。
  //      旧实现按 multipart 表单（`csrf_token` / `lang` / `enableO2` + 文件域 `code`）组包，
  //      那是照着「表单提交 + 302 跳转」的常规形态猜的，与站点实际不符。
  //   2. `lang` 是**数字**语言 id（`LANGUAGES`），不是 "cpp" 字符串。抓包里网页默认
  //      选的是 11（C++14），不是 12。
  //   3. CSRF 只走请求头，body 里**没有** csrf 域；且令牌必须是**该题目页**下发的 ——
  //      主页/登录页那个过不了鉴权（洛谷把令牌按页面发了）。
  //   4. `Origin` 与 `X-Requested-With: XMLHttpRequest` 是浏览器自动加的，Node 必须手动补。
  //   5. 成功后**直接返回 JSON `{ rid }`**，不是 302 跳 `/record/<rid>` —— ⚠️ 这条还差
  //      响应原件确认（见 AGENTS.md）。
  //   6. `/record/<rid>` 的字段形状仍未核对（未登录一律 401），所以 `poll()` 保守处理：
  //      只认判定文本，判不出来报「未知」。

  /** 拿题目页 HTML（**不带** lentille 头，否则只会回 JSON）。走同一条队列，同样受节流。 */
  private html(path: string): Promise<HttpResponse> {
    return this.enqueue(async () => {
      let res: HttpResponse | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const h = this.headers({ Accept: "text/html,application/xhtml+xml" });
        // 把「只回 JSON」开关摘掉，否则拿不到带 csrf meta 的 HTML 页面
        delete h["x-lentille-request"];
        res = await request({ method: "GET", url: `${luoguConfig().baseUrl}${path}`, headers: h });
        if (!isRedirect(res.status)) return res;
        if (!this.absorbChallenge(res.headers["set-cookie"])) return res;
      }
      return res as HttpResponse;
    });
  }

  /**
   * 取这道题的 CSRF 令牌。
   *
   * 洛谷按**页面**发 CSRF 令牌，提交某题就得用那题页面下发的那个 ——
   * 拿主页那个（也就是 Cookie 里那份）会被鉴权挡掉。所以这里现取题目页：
   * 页面顺带把题面数据也带来了，本来也要拉，不算额外开销。
   * 页面没给（风控挑战页之类）时退回 Cookie 里那份，好过直接失败。
   */
  private async csrfFor(displayId: string): Promise<string> {
    const res = await this.html(`/problem/${encodeURIComponent(displayId)}`);
    if (res.status >= 200 && res.status < 300) {
      const token = csrfFromHtml(res.text);
      if (token) return token;
    }
    return this.session?.csrfToken ?? "";
  }

  /**
   * 提交代码，返回评测记录 id。
   *
   * 站点是 **JSON** 提交，成功后直接回 `{ rid }`（不是 302 跳转）。
   */
  async submit(
    displayId: string,
    code: string,
    lang: string | number,
    enableO2: boolean = DEFAULT_ENABLE_O2,
  ): Promise<number> {
    const session = this.session;
    if (!session) throw new LuoguError("还没登录洛谷", true);
    const langId = resolveLangId(lang);
    const csrf = await this.csrfFor(displayId);
    const problemPage = `${luoguConfig().baseUrl}/problem/${encodeURIComponent(displayId)}`;
    const res = await this.call(
      "POST",
      `/fe/api/problem/submit/${encodeURIComponent(displayId)}`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": csrf,
          Referer: problemPage,
          // Origin / X-Requested-With 是**浏览器自动加的**，Node 不会替我们补。
          // 洛谷前端的提交请求两者都有（2026-10-12 真机抓包确认），少了可能被鉴权挡。
          Origin: luoguConfig().baseUrl,
          "X-Requested-With": "XMLHttpRequest",
          Accept: "application/json, text/plain, */*",
        },
        json: { code, lang: langId, enableO2: enableO2 ? 1 : 0 },
        timeoutMs: 60000,
        // 关掉挑战自动重试：重放一次 POST 可能变成两条重复提交（见 call 的注释）
        retryChallenge: false,
      },
    );

    // 失败时把站点自己的话带出来：洛谷的错误信封是
    // `{ errorType, errorCode, status, data, errorMessage }`，比「提交失败」有用得多
    const obj = asRecord(safeJson(res.text));
    this.debug(
      `[诊断] 提交响应 HTTP ${res.status}，原文：${res.text.replace(/\s+/g, " ").slice(0, 400) || "(空)"}`,
    );
    if (isRedirect(res.status)) {
      // 这里只可能是反爬挑战（提交前 csrfFor 已备过挑战码，所以平时到不了这）
      this.absorbChallenge(res.headers["set-cookie"]);
      throw new LuoguError(
        "洛谷要求反爬验证（提交被 302 拦下）。请**手动**再点一次提交 —— " +
          "这里不会自动重试：提交接口有可能已经把记录建好，自动重放会变成两条重复提交。",
      );
    }
    if (res.status >= 400) {
      const why =
        str(obj.errorMessage) || (typeof obj.data === "string" ? obj.data : "") || `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        this.opts.onAuthExpired();
        throw new LuoguError(`洛谷拒绝了这次提交：${why}`, true);
      }
      throw new LuoguError(`洛谷提交失败（HTTP ${res.status}）：${why}`);
    }
    const rid = numOrNull(obj.rid);
    if (rid === null) {
      // 拿到 JSON 但没有 rid —— 形状又变了，或站点返回了别的东西。把原文截一段便于一眼看出
      throw new LuoguError(
        `洛谷提交没有返回评测记录号（HTTP ${res.status}）：` +
          res.text.replace(/\s+/g, " ").slice(0, 200),
      );
    }
    return rid;
  }

  /**
   * 查评测记录。`GET /record/<rid>`（配 lentille 头）→ `data.record`。
   *
   * ⚠️ 这条接口未登录一律 401，返回形状**仍未核对**。所以判「终局」只认判定文本：
   * `judgeResult.verdict` 非空才算 `done`。拿不到就 `verdict: "?"` 显示「未知」——
   * 宁可显示不出结果，也不要显示错的判定。
   *
   * 形状对不上时会把**顶层键名**和原文片段一起抛出去：这条契约只能靠一次真机提交来定，
   * 与其让人对着一句「解析失败」猜，不如一次把线索给全（见 AGENTS.md）。
   */
  async poll(rid: number): Promise<LuoguResult> {
    const res = await this.call("GET", `/record/${rid}`);
    const data = this.envelope(res, `评测记录 ${rid}`);
    const record = asRecord(data.record);
    const detail = asRecord(record.detail);
    const judgeResult = asRecord(detail.judgeResult);
    const compileResult = asRecord(detail.compileResult);
    // 每条记录只打一次：一开始这条接口没法一个人核对（未登录一律 401），
    // 这一行就是核对它的凭据。**只列字段名不打值** —— 够定契约，又不会把代码/输出刷进来。
    if (!this.pollLogged.has(rid)) {
      this.pollLogged.add(rid);
      this.debug(
        `[诊断] 记录 ${rid} HTTP ${res.status}；` +
          `data 键=[${Object.keys(data).join(", ") || "空"}]；` +
          `record 键=[${Object.keys(record).join(", ") || "空"}]；` +
          `status=${String(record.status ?? "(无)")}`,
      );
    }
    if (Object.keys(record).length === 0) {
      throw new LuoguError(
        `洛谷评测记录 ${rid} 里没找到 record 字段（data 顶层键：${Object.keys(data).join(" / ") || "空"}）：` +
          res.text.replace(/\s+/g, " ").slice(0, 300),
      );
    }

    // 判定取 `record.status`（**数字**，站点 RecordStatus 枚举）——
    // 不是 `judgeResult.verdict`：那个字段不存在，早先照它读会一直读到空、一路轮询到超时。
    // 文本 verdict 仅作旧形态兜底。
    const statusNum = numOrNull(record.status);
    const textVerdict = str(judgeResult.verdict);
    const byStatus = statusNum !== null;
    const rawStatus = byStatus ? statusShortName(statusNum) : textVerdict;
    const done = byStatus ? isFinalStatus(statusNum) : textVerdict.trim() !== "";

    // 内存：`record.memory` 是 **KB**（与 `limits.memory` 同一个量纲），统一收成字节
    const memoryKb = numOrNull(record.memory) ?? numOrNull(judgeResult.memory);
    return {
      id: numOrNull(record.id) ?? rid,
      done,
      verdict: byStatus
        ? verdictFromStatus(statusNum)
        : textVerdict.trim() === ""
          ? "?"
          : normVerdict({ verdict: textVerdict }),
      rawStatus,
      score: numOrNull(record.score) ?? numOrNull(judgeResult.score),
      // `record.time` 是毫秒
      timeMs: numOrNull(record.time) ?? numOrNull(judgeResult.time),
      memoryBytes: memoryKb === null ? null : memoryKb * 1024,
      // 编译报错在 detail.compileResult.message；评测侧的补充说明在 judgeResult.message
      feedback: str(compileResult.message) || str(judgeResult.message) || str(record.comment),
    };
  }
}
