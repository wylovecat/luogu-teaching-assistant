import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMultipart, makeBoundary, type MultipartPart } from "../src/luogu/multipart";

const text = (raw: Buffer, needle: string): number => raw.indexOf(Buffer.from(needle, "utf8"));

test("multipart：表单域按给定顺序、file 在最后，结尾有闭合分隔符", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const parts: MultipartPart[] = [
    { name: "key", value: "A1131_公路_code.png" },
    { name: "policy", value: "cG9saWN5" },
    { name: "file", filename: "A1131_公路_code.png", contentType: "image/png", data: png },
  ];
  const boundary = "BOUNDARY-1";
  const raw = buildMultipart(parts, boundary);

  for (const name of ["key", "policy", "file"]) {
    assert.ok(text(raw, `name="${name}"`) >= 0, `缺少表单域 ${name}`);
  }
  // 顺序即出现顺序，file 必须最后（对象存储的要求）
  assert.ok(text(raw, 'name="key"') < text(raw, 'name="policy"'));
  assert.ok(text(raw, 'name="policy"') < text(raw, 'name="file"'));

  // 每个域前面都有分隔串
  assert.equal(raw.toString("utf8").split(`--${boundary}\r\n`).length - 1, 3, "每个表单域前一个分隔串");
  assert.ok(raw.toString("utf8").endsWith(`--${boundary}--\r\n`), "结尾要有闭合分隔符");

  // 文本域与文件域的头部形态
  assert.ok(text(raw, `Content-Disposition: form-data; name="key"\r\n\r\nA1131_公路_code.png\r\n`) >= 0);
  assert.ok(text(raw, `Content-Disposition: form-data; name="file"; filename="A1131_公路_code.png"`) >= 0);
  assert.ok(text(raw, "Content-Type: image/png\r\n\r\n") >= 0);
  // 二进制要原样出现在文件域之后
  assert.ok(text(raw, "Content-Type: image/png\r\n\r\n") < raw.indexOf(png));
});

test("multipart：文件名与表单域名里的引号/换行按 RFC 7578 转义", () => {
  const raw = buildMultipart(
    [{ name: 'we"ird', value: "v" }, { name: "file", filename: 'a"b\r\nc.png', contentType: "image/png", data: Buffer.from("x") }],
    "B",
  ).toString("utf8");
  assert.ok(raw.includes('name="we%22ird"'), "表单域名里的引号要转义");
  assert.ok(raw.includes('filename="a%22b%0D%0Ac.png"'), "文件名里的引号与换行要转义");
  // 转义后不能凭空多出一个头
  assert.equal(raw.split("Content-Disposition:").length - 1, 2);
});

test("multipart：分隔串随机且够长", () => {
  const a = makeBoundary();
  const b = makeBoundary();
  assert.notEqual(a, b);
  assert.ok(a.length >= 16, `分隔串太短：${a}`);
});
