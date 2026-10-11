/**
 * multipart/form-data 组包（纯逻辑，不 import 'vscode'）。
 *
 * 这里被 test/ 下的 node:test 直接引用，所以函数内不能碰任何 vscode API。
 *
 * 为什么手写而不引三方：整个请求体要一次算好（对象存储的直传要带 Content-Length），
 * 而且 file 必须是最后一个表单域，顺序得自己控。
 */

export interface MultipartTextPart {
  name: string;
  value: string;
}

export interface MultipartFilePart {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export type MultipartPart = MultipartTextPart | MultipartFilePart;

function isFilePart(part: MultipartPart): part is MultipartFilePart {
  return "data" in part;
}

/** 表单域引号里的值：引号与换行按 RFC 7578 用百分号转义（浏览器也是这么做的）。 */
function escapeQuoted(value: string): string {
  return value.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** 分隔串只要在请求体里不出现即可，随机一段够用了。 */
export function makeBoundary(): string {
  return `----lgassist${Date.now().toString(16)}${Math.random().toString(16).slice(2, 12)}`;
}

/** 按 parts 的顺序组包，调用方负责把文件放在最后。 */
export function buildMultipart(parts: MultipartPart[], boundary: string): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    if (isFilePart(part)) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${escapeQuoted(part.name)}"; ` +
            `filename="${escapeQuoted(part.filename)}"\r\n` +
            `Content-Type: ${part.contentType}\r\n\r\n`,
          "utf8",
        ),
      );
      chunks.push(part.data);
      chunks.push(Buffer.from("\r\n", "utf8"));
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${escapeQuoted(part.name)}"\r\n\r\n${part.value}\r\n`, "utf8"),
      );
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return Buffer.concat(chunks);
}
