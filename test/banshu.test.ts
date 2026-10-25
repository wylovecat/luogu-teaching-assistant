/**
 * 题解板书：模板生成与标记块读写的纯逻辑测试。
 *
 * 这里钉的主要是**两类容易静默出错的点**：
 *  1. 标记块替换必须只动「标记之间」—— 手写的思路/易错点被覆盖掉是灾难性的；
 *  2. 模板里**不能**出现「读文件」helper —— Typst 的 read()/image() 路径按
 *     「写这行字的文件」解析，包进 banshuconf.typ 的 helper 会指向题库根而不是题目录
 *     （2026-10-12 实测踩过，报 file not found (searched at <root>/x_AC.cpp)）。
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BANSHU_CONF,
  acCodeName,
  banshuImageWidth,
  banshuTitle,
  boardImageName,
  buildBanshuDoc,
  codeBlockBody,
  CONF_FILE,
  countImages,
  DOC_FILE,
  imageBlockBody,
  markEnd,
  markStart,
  readBlock,
  replaceBlock,
  blockBody,
  blockSpan,
} from "../src/banshu/template";

const DOC_OPTS = {
  displayId: "P1395",
  title: "会议",
  course: "《深入浅出程序设计竞赛 进阶篇》题解",
  author: "某老师",
  date: "2026年10月",
};

// ── 文件名约定 ────────────────────────────────────────────────

test("文件名约定：共享版式 / 题解文档 / AC 快照 / 板书图", () => {
  assert.equal(CONF_FILE, "banshuconf.typ");
  assert.equal(DOC_FILE, "题解板书.typ");
  assert.equal(acCodeName("P1395"), "P1395_AC.cpp");
  assert.equal(boardImageName("P1395", 1), "P1395 板书.png", "单页不带页码后缀");
  assert.equal(boardImageName("P1395", 2), "P1395 板书-p2.png", "多页从第 2 页起带后缀");
});

test("标题：有题名时是「题号 题名 · 题解板书」，没题名时不留多余空格", () => {
  assert.equal(banshuTitle("P1395", "会议"), "P1395 会议 · 题解板书");
  assert.equal(banshuTitle("P1395", ""), "P1395 · 题解板书");
  assert.equal(banshuTitle("P1395", "   "), "P1395 · 题解板书");
});

// ── 标记块读写 ────────────────────────────────────────────────

/** 一份带手写内容的题解文档，用于验证「替换不碰手写部分」。 */
function docWithHandWritten() {
  return [
    "#import \"../banshuconf.typ\": conf",
    markStart("image"),
    markEnd("image"),
    "= 思路",
    "",
    "这里是老师手写的思路，**绝不能被覆盖**。",
    "",
    markStart("code"),
    markEnd("code"),
    "= 小结",
    "手写的小结。",
    "",
  ].join("\n");
}

test("标记块：替换只动标记之间，手写内容一字不动", () => {
  const before = docWithHandWritten();
  const after = replaceBlock(before, "code", '#raw(read("P1395_AC.cpp"), lang: "cpp", block: true)');
  assert.ok(after.includes("这里是老师手写的思路，**绝不能被覆盖**。"));
  assert.ok(after.includes("手写的小结。"));
  assert.ok(after.includes('#raw(read("P1395_AC.cpp"), lang: "cpp", block: true)'));
  // 另一个块不受影响
  assert.equal(readBlock(after, "image"), "");
  // 除了插入的那一行，其余行序不变
  assert.deepEqual(
    after.split("\n").filter((l) => l.includes("手写")),
    before.split("\n").filter((l) => l.includes("手写")),
  );
});

test("标记块：空 body 把块清空（还没导出图/还没 AC 时就是空的）", () => {
  const filled = replaceBlock(docWithHandWritten(), "image", '#image("P1395 板书.png", width: 89%)');
  assert.equal(readBlock(filled, "image"), '#image("P1395 板书.png", width: 89%)');
  assert.equal(readBlock(replaceBlock(filled, "image", ""), "image"), "");
});

test("标记块：读写往返一致", () => {
  const body = '#image("P1395 板书.png", width: 89%)';
  assert.equal(readBlock(replaceBlock(docWithHandWritten(), "image", body), "image"), body);
});

test("标记块：找不到标记就抛错，绝不悄悄插到别处", () => {
  // 用户把整段删了的情形 —— 必须显式失败，而不是把代码插到文件末尾冒充成功
  assert.throws(() => replaceBlock("= 思路\n\n只有手写内容\n", "code", "x"), /找不到标记块/);
  const broken = `${markStart("code")}\n没有结束标记\n`;
  assert.throws(() => replaceBlock(broken, "code", "x"), /没有结束标记/);
});

test("标记块：readBlock 对缺失/不完整标记返回空串而不是抛错", () => {
  assert.equal(readBlock("什么都没有", "code"), "");
  assert.equal(readBlock(markStart("code"), "code"), "");
});

test("标记块：标记本身含 lgAssist 前缀，便于一眼认出是扩展维护区", () => {
  assert.match(markStart("image"), /lgAssist:image/);
  assert.match(markEnd("image"), /lgAssist:image/);
});

// ── 生成的题解文档 ────────────────────────────────────────────

test("题解文档：只有板书图 + 代码实现两块，不预置别的小节", () => {
  const doc = buildBanshuDoc(DOC_OPTS);
  assert.ok(doc.includes(`#import "../${CONF_FILE}"`), "必须从题库根引共享版式");
  assert.ok(doc.includes("#show: doc => conf("));
  assert.ok(doc.includes('title: "P1395 会议 · 题解板书"'));
  assert.ok(doc.includes('type: "题解板书"'));
  assert.ok(doc.includes(markStart("image")) && doc.includes(markEnd("image")));
  assert.ok(doc.includes(markStart("code")) && doc.includes(markEnd("code")));
  assert.ok(doc.includes("= 代码实现"));
  // 这几个是**特意去掉**的：板书图里已经讲完，正文再摆一遍是重复
  for (const gone of ["题意理解", "复杂度分析", "易错点", "小结"]) {
    assert.ok(!doc.includes(`= ${gone}`), `不该再预置小节：${gone}`);
  }
});

test("题解文档：板书图前有一级标题「= 题解板书」，且在 image 块之前", () => {
  const doc = buildBanshuDoc(DOC_OPTS);
  assert.ok(doc.includes("= 题解板书"), "板书图前该有一个一级标题");
  // 位置：标题必须在 image 标记块**之前** —— 放到块里会被「导出并插入」覆盖掉
  assert.ok(
    doc.indexOf("= 题解板书") < doc.indexOf(markStart("image")),
    "标题要放在 image 标记块之外（块内的内容会被扩展覆盖）",
  );
  assert.ok(doc.indexOf("= 题解板书") < doc.indexOf("= 代码实现"), "板书标题在代码实现之前");
});

test("题解文档：初始时两个标记块都是空的（图与代码都要等真做出来再插）", () => {
  const doc = buildBanshuDoc(DOC_OPTS);
  assert.equal(readBlock(doc, "image"), "");
  assert.equal(readBlock(doc, "code"), "");
});

test("题解文档：尾部完整 —— 模板字符串没被反引号之类截断", () => {
  // 这条是真实踩过的坑的探针：注释里混进未转义的反引号会把 TS 模板串提前截断，
  // 表现就是「后半篇文档凭空消失」。末尾是代码块的结束标记＝没被截断。
  const doc = buildBanshuDoc(DOC_OPTS);
  assert.ok(doc.trimEnd().endsWith(markEnd("code")), "末尾标记缺失，说明模板字符串被截断了");
  assert.ok(doc.includes("lgAssist"), "头部注释应写明标记块归属");
});

// ── 写入块的内容 ──────────────────────────────────────────────

test("代码块：用 raw(read(...)) 引用 AC 快照，路径是相对的（相对题目录）", () => {
  const body = codeBlockBody("P1395");
  assert.equal(body, '#raw(read("P1395_AC.cpp"), lang: "cpp", block: true)');
  // 引用必须是相对路径：写绝对路径会让题解换个目录/换台机器就崩
  const ref = /read\("([^"]+)"\)/.exec(body)?.[1] ?? "";
  assert.equal(ref, "P1395_AC.cpp");
  assert.ok(!ref.includes(":") && !ref.includes("\\") && !ref.startsWith("/"), `引用不是相对路径：${ref}`);
});

test("代码块：不依赖 banshuconf.typ 里的「读文件」调用（路径会解析错目录）", () => {
  assert.ok(!codeBlockBody("P1395").includes("codefile("));
  assert.ok(!BANSHU_CONF.includes("#let codefile"));
  // 共享版式里不能出现**真正执行**的 read("…") —— Typst 会把它解析到题库根而不是题目录。
  // 注释里示范写法是允许的，所以只挑非注释行。
  const offenders = BANSHU_CONF.split("\n").filter(
    (line) => /read\("/.test(line) && !line.trim().startsWith("//"),
  );
  assert.deepEqual(offenders, [], "共享版式里出现了真正的读文件调用，会导致路径解析到题库根");
});

test("图纸块：还没导出时为空，多页按顺序排列", () => {
  assert.equal(imageBlockBody("P1395", 0), "");
  const one = imageBlockBody("P1395", 1);
  assert.equal(one, '#image("P1395 板书.png", width: 89%)');
  const two = imageBlockBody("P1395", 2);
  assert.ok(two.indexOf("板书.png") < two.indexOf("板书-p2.png"), "页序不能乱");
});

test("图纸块：宽度可覆盖（不同题版式可能需要不同缩放）", () => {
  assert.ok(imageBlockBody("P1395", 1, "100%").includes("width: 100%"));
});

test("插件图页数：数 #image( 的出现次数", () => {
  assert.equal(countImages(""), 0);
  assert.equal(countImages(imageBlockBody("P1395", 3)), 3);
  assert.equal(countImages("#image(\"a.png\")\n\n#image(\"b.png\")"), 2);
});

// ── 共享版式本身 ──────────────────────────────────────────────

test("共享版式：提供 conf 与题解要用的组件", () => {
  assert.ok(BANSHU_CONF.includes("#let conf("));
  for (const name of ["note", "tip", "warn", "chip", "divider"]) {
    assert.ok(BANSHU_CONF.includes(`#let ${name}(`), `版式缺组件：${name}`);
  }
});

test("共享版式：写明跨目录 import 要带 --root（否则使用者会撞 escape project root）", () => {
  assert.ok(BANSHU_CONF.includes("--root"));
});

test("共享版式：默认面向题解（type/course 默认值）", () => {
  assert.ok(BANSHU_CONF.includes('type: "题解板书"'));
  assert.ok(BANSHU_CONF.includes("题解"));
});

test("署名默认值：package.json 与 config 回落值都是「爱学习的咸鱼君」", () => {
  // 两处必须一致：一处是 VSCode 设置界面上显示/写入的默认值（package.json），
  // 一处是没读到设置时的兜底（config.ts）。只改一处会出现「设置里显示 A、实际生成 B」。
  const pkg = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  ) as { contributes: { configuration: { properties: Record<string, { default?: unknown }> } } };
  const declared = pkg.contributes.configuration.properties["lgAssist.banshu.author"]?.default;
  assert.equal(declared, "爱学习的咸鱼君", "设置项默认值被改了");

  const cfgSrc = fs.readFileSync(path.join(__dirname, "..", "src", "config.ts"), "utf8");
  assert.match(cfgSrc, /banshu\.author",\s*"爱学习的咸鱼君"/, "config.ts 的回落值没跟上");
});

test("标记块范围只含块内容（标记之间），供最小编辑用", () => {
  const content = ["前置说明", markStart("image"), "旧内容", markEnd("image"), "后置说明"].join("\n");
  const span = blockSpan(content, "image");
  // 范围里**只有**块内容，两头的标记不在里面
  assert.equal(content.slice(span.from, span.to), "\n旧内容\n");
  // 标记块不见了要报错（别偷偷插到文件末尾）
  assert.throws(() => blockSpan("没有标记的文档", "image"), /找不到标记块/);
  // 只有开始标记（结束标记被删了）也要报错
  assert.throws(() => blockSpan(`前面\n${markStart("image")}\n内容`, "image"), /没有结束标记/);
});

test("写进标记块的内容：空块不留空行", () => {
  assert.equal(blockBody("代码"), "\n代码\n");
  assert.equal(blockBody("  代码  "), "\n代码\n");
  assert.equal(blockBody(""), "");
  assert.equal(blockBody("   "), "");
});

test("板书图宽度：认得的 Typst 长度照用，认不出的回落默认", () => {
  // 百分比
  assert.equal(banshuImageWidth("89%"), "89%");
  assert.equal(banshuImageWidth(" 60% "), "60%");
  // 绝对长度与其它单位
  assert.equal(banshuImageWidth("10cm"), "10cm");
  assert.equal(banshuImageWidth("12pt"), "12pt");
  assert.equal(banshuImageWidth("1.5in"), "1.5in");
  // 自适应
  assert.equal(banshuImageWidth("auto"), "auto");
  // ⚠️ 坏值必须回落：这个值是原样拼进 Typst 源码的，
  // 一个坏字符就会让**整份 PDF 编译不过**（`width: 89 %` 是语法错误）。
  assert.equal(banshuImageWidth("89 %"), "89%");
  assert.equal(banshuImageWidth("abc"), "89%");
  assert.equal(banshuImageWidth("89%%"), "89%");
  assert.equal(banshuImageWidth('"89%"'), "89%");
  assert.equal(banshuImageWidth("89%\n#panic()"), "89%");
  assert.equal(banshuImageWidth(""), "89%");
  assert.equal(banshuImageWidth(undefined), "89%");
  assert.equal(banshuImageWidth(null), "89%");
});
