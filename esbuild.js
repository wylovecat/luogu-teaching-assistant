const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/**
 * KaTeX 的样式与字体随插件一起打包，避免运行环境无外网时公式渲染失败。
 *
 * 字体**只拷 woff2**（约 254 KB），不带同名的 .woff（296 KB）与 .ttf（502 KB）——
 * 这两者没有任何消费者：webview 跑在 VS Code 的 Chromium 里，katex.min.css 的
 * @font-face 里 woff2 排第一，浏览器直接选它；白板导出则由 panel.ts 里
 * `if (!/\.woff2$/i.test(url)) continue;` 显式只读 woff2。把整目录拷进来会让
 * 每个 .vsix 多背约 800 KB 的死重（曾使 1 MB 的包有一多半是永不加载的字体）。
 * `test/whiteboard.test.ts` 有一条断言守着这个取舍，改动后跑 npm test。
 */
function copyKatex() {
  const from = path.join(__dirname, "node_modules", "katex", "dist");
  const to = path.join(__dirname, "dist", "katex");
  if (!fs.existsSync(from)) {
    console.warn("[esbuild] 未找到 node_modules/katex/dist，跳过 KaTeX 资源拷贝（请先 npm install）");
    return;
  }
  fs.rmSync(to, { recursive: true, force: true });
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(from, "katex.min.css"), path.join(to, "katex.min.css"));

  const fontsFrom = path.join(from, "fonts");
  const fontsTo = path.join(to, "fonts");
  fs.mkdirSync(fontsTo, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(fontsFrom)) {
    if (!name.toLowerCase().endsWith(".woff2")) continue;
    fs.copyFileSync(path.join(fontsFrom, name), path.join(fontsTo, name));
    copied += 1;
  }
  console.log(`[esbuild] 已拷贝 KaTeX 资源 → dist/katex（woff2 字体 ${copied} 个，不含 .woff/.ttf）`);
}

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(__dirname, "src", "extension.ts")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "extension.js"),
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/**
 * 白板的 webview 脚本：跑在浏览器（webview）里，单独打一份。
 * 面板把它的内容内联进 HTML（走 nonce），所以不许出现 import 'vscode'
 * —— 那样浏览器这次打包会因为解析不到 vscode 直接失败。
 *
 * @type {import('esbuild').BuildOptions}
 */
const whiteboardOptions = {
  entryPoints: [path.join(__dirname, "src", "whiteboard", "webview.ts")],
  bundle: true,
  outfile: path.join(__dirname, "dist", "whiteboard.js"),
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function main() {
  copyKatex();
  if (watch) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    const wbCtx = await esbuild.context(whiteboardOptions);
    await wbCtx.watch();
    console.log("[esbuild] 监听中…");
  } else {
    await Promise.all([esbuild.build(options), esbuild.build(whiteboardOptions)]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
