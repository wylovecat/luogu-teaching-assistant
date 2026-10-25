/**
 * 白板导出前的题面图片内联（扩展进程侧，纯 Node，不 import vscode —— 便于单测）。
 *
 * 为什么需要：导出把 `#sheet` 克隆进 SVG 的 `foreignObject`，再以 `<img>` 方式加载。
 * SVG 作为图片加载时浏览器**不会取外部资源**（KaTeX 字体因此才专门内联），
 * 所以题面里的 `https://…` 图片在屏幕上能看到、导出的 PNG 里却是空白。
 * 这里先把它们下载成 data URI，由 webview 替换 `src` 后再序列化，
 * 屏幕与导出才真正一致。
 *
 * 约束（都是「别让一张坏图拖死导出」）：
 * - 只处理 http/https，单张 ≤ 8 MB、整批 ≤ 20 MB、最多 20 张；
 * - 只接受 `image/*`（或按魔数认得出的图片），避免把 HTML 错误页当成图片内联；
 * - 单张超时 8 秒、最多跟随 3 次重定向；
 * - 任何一张失败都只跳过它，不影响其余图片与导出。
 *
 * 洛谷题面里的示例图在 `cdn.luogu.com.cn`，图床是否要 Referer 未核对 ——
 * 带上（多半不需要），失败就跳过那张。
 */

import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import { URL } from "node:url";

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const REFERER = "https://www.luogu.com.cn/";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
/** 单张图片的下载超时 */
const TIMEOUT_MS = 8000;
/** 整批图片的总预算：到点就把已经下好的交回去，别让导出一直等 */
const BATCH_DEADLINE_MS = 15000;
const MAX_REDIRECTS = 3;
/** 一次最多处理多少张（再多也不值得为导出等下去） */
export const MAX_INLINE_IMAGES = 20;

export interface InlineImagesResult {
  /** 原 url → data URI（只含成功的） */
  images: Record<string, string>;
  /** 失败原因（输出面板写一行，方便排查是哪张图/哪个域名） */
  failed: string[];
}

/** 是不是值得交给扩展进程下载的图片地址（data:/相对路径不处理）。 */
export function isRemoteImageUrl(url: string): boolean {
  return /^https?:\/\//i.test((url ?? "").trim());
}

/** 按文件头认图片类型；认不出返回空串。 */
export function sniffImageType(body: Buffer): string {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (body.length >= 3 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.length >= 6 && body.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (body.length >= 6 && body.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (body.length >= 12 && body.subarray(0, 4).toString("ascii") === "RIFF" && body.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  // SVG 是文本，可能带 BOM/前导空白/XML 声明
  const head = body.subarray(0, Math.min(body.length, 1024)).toString("utf8").trimStart();
  if (head.startsWith("<?xml") || head.startsWith("<svg") || /<svg[\s>]/i.test(head)) return "image/svg+xml";
  if (body.length >= 2 && body[0] === 0x42 && body[1] === 0x4d) return "image/bmp";
  return "";
}

/** 把图片字节包成 data URI（contentType 已规范化）。 */
export function dataUriOf(contentType: string, body: Buffer): string {
  return `data:${contentType};base64,${body.toString("base64")}`;
}

interface DownloadOnce {
  status: number;
  location?: string;
  contentType: string;
  body: Buffer;
}

/** 发一次 GET（不跟随重定向）。超过 maxBytes 直接中断。 */
function downloadOnce(url: string, maxBytes: number): Promise<DownloadOnce> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const transport = isHttps ? https : http;
    const req = transport.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": UA,
          Referer: REFERER,
          Accept: "image/*,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === "string" ? res.headers.location : undefined;
        if (status >= 300 && status < 400 && location) {
          res.resume(); // 重定向响应不读 body
          resolve({ status, location, contentType: "", body: Buffer.alloc(0) });
          return;
        }
        let stream: NodeJS.ReadableStream = res;
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase();
        if (encoding.includes("gzip")) stream = res.pipe(zlib.createGunzip());
        else if (encoding.includes("deflate")) stream = res.pipe(zlib.createInflate());
        else if (encoding.includes("br")) stream = res.pipe(zlib.createBrotliDecompress());

        const chunks: Buffer[] = [];
        let size = 0;
        let tooLarge = false;
        stream.on("data", (chunk: Buffer) => {
          if (tooLarge) return;
          size += chunk.length;
          if (size > maxBytes) {
            tooLarge = true;
            res.destroy();
            reject(new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)} MB`));
            return;
          }
          chunks.push(chunk);
        });
        stream.on("end", () => {
          if (tooLarge) return;
          const rawType = String(res.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          resolve({ status, contentType: rawType, body: Buffer.concat(chunks) });
        });
        stream.on("error", reject);
      },
    );
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("图片下载超时")));
    req.on("error", reject);
    req.end();
  });
}

/** 下载一张图片，跟随重定向；返回可直接放进 `<img>` 的 data URI。 */
async function downloadAsDataUri(url: string): Promise<string> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await downloadOnce(current, MAX_IMAGE_BYTES);
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current).toString();
      if (!isRemoteImageUrl(current)) throw new Error("重定向到了非 http(s) 地址");
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}`);
    // 服务器可能把图片标成 application/octet-stream；以魔数为准兜底
    const declared = res.contentType.startsWith("image/") ? res.contentType : "";
    const type = declared || sniffImageType(res.body);
    if (!type) throw new Error(`不是图片（Content-Type: ${res.contentType || "无"}）`);
    return dataUriOf(type, res.body);
  }
  throw new Error("重定向次数过多");
}

/**
 * 批量把远程图片内联成 data URI。
 *
 * 并发 4，整体顺序无关；单张失败只记进 `failed`，不抛错（导出流程不能被一张坏图卡死）。
 */
export async function inlineRemoteImages(urls: readonly string[]): Promise<InlineImagesResult> {
  const wanted = [...new Set(urls.map((u) => (u ?? "").trim()).filter(isRemoteImageUrl))].slice(
    0,
    MAX_INLINE_IMAGES,
  );
  const images: Record<string, string> = {};
  const failed: string[] = [];
  if (wanted.length === 0) return { images, failed };

  let total = 0;
  let next = 0;
  const deadline = Date.now() + BATCH_DEADLINE_MS;
  const workers = Array.from({ length: Math.min(4, wanted.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= wanted.length) return;
      const url = wanted[i];
      if (Date.now() > deadline) {
        failed.push(`${url}（整体超时，已跳过）`);
        continue;
      }
      try {
        const uri = await downloadAsDataUri(url);
        // 粗略的总量限制：data URI 的 base64 比原图大约 4/3
        total += Math.round((uri.length * 3) / 4);
        if (total > MAX_TOTAL_BYTES) {
          failed.push(`${url}（整批超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB，已跳过）`);
          continue;
        }
        images[url] = uri;
      } catch (e) {
        failed.push(`${url}（${e instanceof Error ? e.message : String(e)}）`);
      }
    }
  });
  // 整批超时就把**已经下好的**交回去（worker 继续跑也无妨，返回的是快照）
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.all(workers),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, BATCH_DEADLINE_MS);
    }),
  ]);
  if (timer) clearTimeout(timer);
  return { images: { ...images }, failed: [...failed] };
}
