import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import { URL } from "node:url";

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  /** JSON 请求体；给了就会带上 Content-Type: application/json */
  json?: unknown;
  /**
   * 原始请求体（multipart 这类自己组好的字节）；给了就原样发出去，
   * Content-Type 由调用方在 headers 里指定。与 json 二选一。
   */
  body?: Buffer;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  /** 原始响应文本（未解析 JSON） */
  text: string;
  /** 响应头（键统一小写）。提交接口靠 Location 里的跳转地址取回评测记录号。 */
  headers: Record<string, string>;
}

const DEFAULT_TIMEOUT = 20000;

/**
 * 连接复用（keep-alive）。
 *
 * 不显式传 agent 就用 globalAgent，而 globalAgent 的 `keepAlive` 是 **Node 19 才默认打开**的；
 * 本扩展的目标运行时是 Node 18（VS Code 自带的 Electron），于是每个请求都要重做一遍
 * DNS + TCP + TLS 握手。轮询评测结果每 2 秒一次、一次提交能轮询到 30 次 —— 就是 30 次握手。
 *
 * `maxSockets` 刻意不止给 1：站点请求虽然串行节流，但登录探活（`probe`）与排队中的请求
 * 可能正好撞上，只给一个 socket 会让它们排队互等。空闲连接由 Node 自己按
 * `keepAliveTimeout` 回收，这里不用另管。
 */
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 5 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 5 });

/** 极简 HTTP 客户端：只用 node:http(s)，不依赖 fetch 是否可用。 */
export function request(req: HttpRequest): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(req.url);
    const isHttps = url.protocol === "https:";
    const transport = isHttps ? https : http;

    let body: Buffer | undefined;
    const headers: Record<string, string> = {
      "Accept-Encoding": "gzip, identity",
      ...(req.headers ?? {}),
    };
    if (req.body !== undefined) {
      body = req.body;
      headers["Content-Length"] = String(body.length);
    }
    if (req.json !== undefined) {
      body = Buffer.from(JSON.stringify(req.json), "utf8");
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = String(body.length);
    }

    const r = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search,
        method: req.method,
        agent: isHttps ? httpsAgent : httpAgent,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let stream: NodeJS.ReadableStream = res;
        const encoding = (res.headers["content-encoding"] ?? "").toLowerCase();
        if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === "string") headers[k.toLowerCase()] = v;
            else if (Array.isArray(v)) headers[k.toLowerCase()] = v.join(", ");
          }
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), headers });
        });
        stream.on("error", reject);
      },
    );

    r.setTimeout(req.timeoutMs ?? DEFAULT_TIMEOUT, () => {
      r.destroy(new Error("请求超时"));
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}
