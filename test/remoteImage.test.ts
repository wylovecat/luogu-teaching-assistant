/**
 * 白板导出前的题面图片内联。
 *
 * 钉的是三件事：① 认得出哪些地址值得下载、② 认得出哪些字节是图片、
 * ③ 下载失败/非图片**只跳过那一张**，不影响其余（导出不能被一张坏图卡死）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import {
  dataUriOf,
  inlineRemoteImages,
  isRemoteImageUrl,
  sniffImageType,
} from "../src/whiteboard/remoteImage";

/** 1×1 透明 PNG */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("远程图片内联：正常图/重定向/octet-stream 都能转 data URI，非图片跳过", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect.png") {
      res.writeHead(302, { Location: "/ok.png" });
      res.end();
      return;
    }
    if (req.url === "/ok.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
      return;
    }
    if (req.url === "/octet.png") {
      res.writeHead(200, { "Content-Type": "application/octet-stream" });
      res.end(PNG);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("not an image");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const { images, failed } = await inlineRemoteImages([
      `${base}/ok.png`,
      `${base}/redirect.png`,
      `${base}/octet.png`,
      `${base}/text`,
    ]);
    assert.ok(images[`${base}/ok.png`].startsWith("data:image/png;base64,"));
    assert.ok(images[`${base}/redirect.png`].startsWith("data:image/png;base64,"), "重定向要跟着走");
    assert.ok(images[`${base}/octet.png`].startsWith("data:image/png;base64,"), "octet-stream 要按文件头认");
    assert.equal(failed.length, 1, "非图片不应内联");
    assert.match(failed[0], /text/, "失败原因里带上哪张图");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("远程图片：一张坏图不影响其余（导出不能被一张图卡死）", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/ok.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(PNG);
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("missing");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const { images, failed } = await inlineRemoteImages([`${base}/missing.png`, `${base}/ok.png`]);
    assert.ok(images[`${base}/ok.png`], "好图照样要内联上");
    assert.equal(failed.length, 1);
    assert.match(failed[0], /404/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("远程图片：只认 http(s)，类型嗅探覆盖常见图片", () => {
  assert.equal(isRemoteImageUrl("https://a/b.png"), true);
  assert.equal(isRemoteImageUrl("http://a/b.png"), true);
  assert.equal(isRemoteImageUrl("data:image/png;base64,xx"), false);
  assert.equal(isRemoteImageUrl("./img/a.png"), false);
  assert.equal(isRemoteImageUrl(""), false);
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniffImageType(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniffImageType(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(
    sniffImageType(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')),
    "image/svg+xml",
  );
  assert.equal(sniffImageType(Buffer.from("hello")), "");
  assert.equal(dataUriOf("image/png", PNG), `data:image/png;base64,${PNG.toString("base64")}`);
});

test("远程图片：空列表与非 http 地址都不发请求", async () => {
  assert.deepEqual(await inlineRemoteImages([]), { images: {}, failed: [] });
  assert.deepEqual(await inlineRemoteImages(["./img/a.png", "data:image/png;base64,xx"]), {
    images: {},
    failed: [],
  });
});
