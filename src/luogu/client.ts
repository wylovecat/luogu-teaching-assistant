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
 * ③ **契约的把握程度写在注释里**，别凭直觉改：
 *    - 已实测/公开稳定：题面 `_contentOnly=1`、题库列表搜索、用户信息探测。
 *    - ⚠️ 未在真机登录会话下核对：提交表单的字段与跳转、评测记录的字段形状。
 *      相关函数顶部有 `TODO(未验证)` 标记，第一次真机跑通后请回来把结论补进本注释与 AGENTS.md。
 */

import { luoguConfig } from "../config";
import { statementFromLuogu, type Statement } from "../problems/statement";
import { normVerdict } from "../util";
import { request, type HttpResponse } from "./http";
import { buildMultipart, makeBoundary, type MultipartPart } from "./multipart";

/** 洛谷对非浏览器客户端会拦 UA，固定一个常见桌面 UA。 */
export const LUOGU_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

/** 站点业务错误（未登录、限流、题目不存在…）。`authExpired` 为真表示该重新登录了。 */
export class LuoguError extends Error {
  constructor(
    message: string,
    readonly authExpired = false,
  ) {
    super(message);
    this.name = "LuoguError";
  }
}

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

/** 从 Cookie 串里取出 csrf_token（提交表单要用的那个）。 */
export function csrfFromCookie(cookie: string): string {
  const hit = /(?:^|;\s*)csrf_token=([^;]+)/.exec(cookie);
  return hit ? decodeURIComponent(hit[1]) : "";
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class LuoguClient {
  private session: LuoguSession | null = null;
  /** 请求队列：所有请求串行执行，天然实现节流 */
  private queue: Promise<unknown> = Promise.resolve();
  private lastAt = 0;

  constructor(private readonly opts: { onAuthExpired: () => void }) {}

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
      Referer: `${luoguConfig().baseUrl}/`,
      ...(extra ?? {}),
    };
    if (this.session?.cookie) h.Cookie = this.session.cookie;
    return h;
  }

  private async call(
    method: "GET" | "POST",
    path: string,
    extra?: { headers?: Record<string, string>; body?: Buffer; timeoutMs?: number },
  ): Promise<HttpResponse> {
    return this.enqueue(() =>
      request({
        method,
        url: `${luoguConfig().baseUrl}${path}`,
        headers: this.headers(extra?.headers),
        body: extra?.body,
        timeoutMs: extra?.timeoutMs,
      }),
    );
  }

  /**
   * 剥洛谷的 `_contentOnly=1` 信封，取出 `currentData`。
   *
   * 未登录时站点不会给 currentData，而是 `{code, message}` 或跳登录页 —— 那时要抛
   * `authExpired` 让上层引导重新登录，而不是当成「解析失败」。
   */
  private envelope(res: HttpResponse, path: string): Record<string, unknown> {
    if (res.status === 401 || res.status === 403) {
      this.opts.onAuthExpired();
      throw new LuoguError("洛谷拒绝了这个请求（Cookie 无效或已过期），请重新登录", true);
    }
    let json: unknown;
    try {
      json = JSON.parse(res.text);
    } catch {
      // 拿到 HTML 基本就是被风控挡了（验证码页 / 302 到登录），同样按需要重新登录处理
      this.opts.onAuthExpired();
      throw new LuoguError(
        `洛谷 ${path} 返回的不是 JSON（可能被风控拦截或 Cookie 失效）：${res.text.slice(0, 120)}`,
        true,
      );
    }
    const obj = asRecord(json);
    const currentData = obj.currentData;
    if (!currentData) {
      const code = obj.code;
      const message = str(obj.message) || str(obj.msg) || `code=${String(code ?? "?")}`;
      this.opts.onAuthExpired();
      throw new LuoguError(`洛谷 ${path} 未返回数据：${message}`, true);
    }
    return asRecord(currentData);
  }

  // ── 题面 ────────────────────────────────────────────────────────

  /**
   * 拉题面。`GET /problem/<pid>?_contentOnly=1` → `currentData.problem`。
   *
   * 这条是公开接口（不登录也能读），字段形状见 problems/statement.ts 的注释。
   */
  async statement(displayId: string): Promise<Statement> {
    const res = await this.call("GET", `/problem/${encodeURIComponent(displayId)}?_contentOnly=1`);
    const data = this.envelope(res, `题面 ${displayId}`);
    const problem = asRecord(data.problem);
    if (Object.keys(problem).length === 0) {
      throw new LuoguError(`洛谷没有这道题：${displayId}`);
    }
    return statementFromLuogu(problem, { displayId, title: "" });
  }

  // ── 搜索 ────────────────────────────────────────────────────────

  /** 搜索题库：`GET /problem/list?keyword=…&_contentOnly=1` → `currentData.problems.result`。 */
  async searchProblems(keyword: string): Promise<LuoguHit[]> {
    const res = await this.call(
      "GET",
      `/problem/list?keyword=${encodeURIComponent(keyword)}&page=1&_contentOnly=1`,
    );
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
        title: str(it.title),
        difficulty: numOrNull(it.difficulty),
      }));
  }

  // ── 登录态 ──────────────────────────────────────────────────────

  /**
   * 探测当前 Cookie 是否有效：能读到用户信息就算登录中。
   * 站点没登录时会退回信封错误，由 `envelope` 统一转成 authExpired。
   */
  async probe(): Promise<{ uid: number; uname: string }> {
    const res = await this.call("GET", "/user?_contentOnly=1");
    const data = this.envelope(res, "用户信息");
    const user = asRecord(data.user);
    const uid = numOrNull(user.uid) ?? 0;
    const uname = str(user.uname);
    if (!uname) throw new LuoguError("洛谷返回的用户信息里没有 uname，接口形状可能变了", true);
    return { uid, uname };
  }

  // ── 提交与评测 ────────────────────────────────────────────────────
  //
  // ⚠️ TODO(未验证)：下面两个函数的请求形状与响应字段都还没在真机登录会话下核对过，
  //    是按洛谷前端调用点的常规形态写的。首次真机提交后请逐项核对并更新本段注释：
  //      1. 表单域是否只有 csrf_token / lang / enableO2（洛谷的 O2 开关、验证码是否必填）；
  //      2. 成功后跳转的 Location 是否形如 /record/<rid>；
  //      3. 评测记录里判定文本到底落在 judgeResult.verdict 还是别的字段。
  //    在核对之前，`poll` 只认 judgeResult.verdict 这一个文本字段，判不出来就报「未知」
  //    而不是猜一个判定 —— 宁可显示不出结果，也不要显示错的判定。

  /**
   * 提交代码，返回评测记录 id。
   *
   * 站点是表单提交（不是 JSON），成功后 302 到 `/record/<rid>`，记录号从 Location 里取。
   */
  async submit(displayId: string, code: string, lang: string): Promise<number> {
    const session = this.session;
    if (!session) throw new LuoguError("还没登录洛谷", true);
    const boundary = makeBoundary();
    // 源码是一个**文件域**（不是普通文本域），文件名给 <题号>.cpp；
    // buildMultipart 要求文件域放最后 —— 站点按顺序解析，文件后面再跟字段有些服务端会截断。
    const parts: MultipartPart[] = [
      { name: "csrf_token", value: session.csrfToken },
      { name: "lang", value: lang },
      { name: "enableO2", value: "0" },
      {
        name: "code",
        filename: `${displayId}.cpp`,
        contentType: "text/x-c++src",
        data: Buffer.from(code, "utf8"),
      },
    ];
    const body = buildMultipart(parts, boundary);
    const res = await this.call("POST", `/fe/api/problem/submit/${encodeURIComponent(displayId)}`, {
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "X-CSRF-Token": session.csrfToken,
        Accept: "text/html,application/xhtml+xml",
      },
      body,
      timeoutMs: 60000,
    });

    const location = res.headers.location ?? "";
    const rid = /\/record\/(\d+)/.exec(location)?.[1];
    if (rid) return parseInt(rid, 10);

    // 没拿到跳转地址：多半是 CSRF 失效、风控拦截或表单字段不对。把原文截一段带出去，
    // 好在输出面板里一眼看出是哪一类（比只报「提交失败」有用）。
    throw new LuoguError(
      `洛谷提交没有返回评测记录跳转（status=${res.status}，Location=${location || "(空)"}）：` +
        res.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 160),
    );
  }

  /**
   * 查评测记录。`GET /record/<rid>?_contentOnly=1` → `currentData.record`。
   *
   * 只有 `judgeResult.verdict` 拿到非空文本才算「终局判定」（`done`），
   * 免得把「评测中」那条中间记录当成结果报出去。
   */
  async poll(rid: number): Promise<LuoguResult> {
    const res = await this.call("GET", `/record/${rid}?_contentOnly=1`);
    const data = this.envelope(res, `评测记录 ${rid}`);
    const record = asRecord(data.record);
    const judgeResult = asRecord(record.judgeResult);
    const rawStatus = str(judgeResult.verdict);
    return {
      id: numOrNull(record.id) ?? rid,
      done: rawStatus.trim() !== "",
      verdict: rawStatus.trim() === "" ? "?" : normVerdict({ verdict: rawStatus }),
      rawStatus,
      score: numOrNull(judgeResult.score),
      // 洛谷的 time 是毫秒、memory 是字节
      timeMs: numOrNull(judgeResult.time),
      memoryBytes: numOrNull(judgeResult.memory),
      feedback: str(judgeResult.message) || str(record.comment),
    };
  }
}