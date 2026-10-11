/**
 * 把 test/*.test.ts 用 esbuild 打包成可直接被 node --test 运行的 CJS 文件，
 * 并把 'vscode' 指到 test/vscode-stub.ts。
 *
 * 之所以要打包：源码用的是无扩展名相对导入（VSCode 的 CJS 解析），node 原生的
 * 类型剥离 + ESM 解析跑不了；而 vscode 模块在 node 里根本不存在，必须替换。
 */
const esbuild = require("esbuild");
const fs = require("node:fs");
const path = require("node:path");

const testDir = path.join(__dirname, "test");
const outDir = path.join(__dirname, "test-dist");

const entries = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join(testDir, f));

if (entries.length === 0) {
  console.error("[test-build] test/ 下没有 *.test.ts");
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });

esbuild
  .build({
    entryPoints: entries,
    outdir: outDir,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    sourcemap: "inline",
    logLevel: "info",
    alias: { vscode: path.join(testDir, "vscode-stub.ts") },
  })
  .then(() => console.log(`[test-build] ${entries.length} 个测试文件 → test-dist/`))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
