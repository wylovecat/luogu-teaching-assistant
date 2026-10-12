/**
 * 题解板书：Typst 版式与文档模板的**纯逻辑**部分。
 *
 * 为什么单独成文件：本模块**不许 import 'vscode'**，要能被单测直接引用
 * （仓库对纯逻辑模块的统一约定，同 `whiteboard/model.ts`）。
 *
 * 整条流程（对着 `D:\板书\P1395 会议` 那套整理出来的）：
 *   1. 题库根目录放**共享**一份 `banshuconf.typ`（版式），各题目录 `#import "../banshuconf.typ"`；
 *   2. 建题时在题目录生成 `题解板书.typ`（本文件负责它的内容）；
 *   3. 白板导出 PNG 落到题目录，扩展把图写进 `lgAssist:image` 标记块；
 *   4. AC 时快照 `<题号>_AC.cpp`，扩展把引用写进 `lgAssist:code` 标记块；
 *   5. 调 typst 编译成 PDF。
 *
 * ⚠️ **跨目录 import 必须带 `--root <题库根>`**：Typst 默认把「被编译文件所在目录」
 * 当项目根，`../banshuconf.typ` 会被判成 `would escape the project root` 而直接报错
 * （2026-10-12 实测）。`typst.ts` 负责补上这个参数。
 *
 * 模板里所有路径都是**相对题目录**的（`image("P1395 板书.png")` / `read("x_AC.cpp")`）——
 * Typst 的 `image()` / `read()` 按「写这行的那个文件」所在目录解析。
 */

/** 题库根目录下共享版式的文件名。 */
export const CONF_FILE = "banshuconf.typ";
/** 题目录里题解文档的文件名。 */
export const DOC_FILE = "题解板书.typ";
/** 题解 PDF 的文件名。 */
export const PDF_FILE = "题解板书.pdf";

/** AC 代码快照的文件名（`<题号>_AC.cpp`）。 */
export function acCodeName(displayId: string): string {
  return `${displayId}_AC.cpp`;
}

/** 第 n 页板书图的文件名（n 从 1 起；单页不带后缀）。 */
export function boardImageName(displayId: string, page = 1): string {
  return page <= 1 ? `${displayId} 板书.png` : `${displayId} 板书-p${page}.png`;
}

/**
 * 扩展维护的标记块。**手写内容不受影响**，扩展只替换标记之间的部分 ——
 * 这样题解既能有自动写入的图与代码，又能让人自由加思路、易错点。
 */
export function markStart(key: string): string {
  return `// >>> lgAssist:${key}`;
}
export function markEnd(key: string): string {
  return `// <<< lgAssist:${key}`;
}

/**
 * 替换标记块的内容。块不存在时**原样返回**（不猜位置乱插）——
 * 用户可能把整段删了，那时报错让人知道，比偷偷插到文件末尾强。
 */
export function replaceBlock(content: string, key: string, body: string): string {
  const start = markStart(key);
  const end = markEnd(key);
  const from = content.indexOf(start);
  if (from < 0) throw new Error(`题解文档里找不到标记块「${key}」（${start}），无法写入`);
  const to = content.indexOf(end, from + start.length);
  if (to < 0) throw new Error(`题解文档里的标记块「${key}」没有结束标记（${end}）`);
  const inner = body.trim() === "" ? "" : `\n${body.trim()}\n`;
  return content.slice(0, from + start.length) + inner + content.slice(to);
}

/** 读出标记块的内容（没找到就给空串，便于调用方判断「还没插过图/代码」）。 */
export function readBlock(content: string, key: string): string {
  const start = markStart(key);
  const from = content.indexOf(start);
  if (from < 0) return "";
  const to = content.indexOf(markEnd(key), from + start.length);
  if (to < 0) return "";
  return content.slice(from + start.length, to).trim();
}

/** 生成题解文档时用到的元信息。 */
export interface BanshuDocOptions {
  displayId: string;
  /** 题名；空串时标题只显示题号 */
  title: string;
  course: string;
  author: string;
  /** 形如 `2026年10月`；调用方负责生成（纯逻辑模块不碰时钟） */
  date: string;
}

/** 题解文档标题：`P1395 会议 · 题解板书`（没题名就只留题号）。 */
export function banshuTitle(displayId: string, title: string): string {
  return `${[displayId, title].filter((s) => s.trim() !== "").join(" ")} · 题解板书`;
}

/**
 * 生成 `题解板书.typ` 的初始内容。
 *
 * **只放两样东西：板书图 + 代码实现** —— 与 `D:\板书\P1395 会议\题解板书.typ` 一致。
 * 不预置「题意理解 / 思路 / 复杂度分析」那些小节：板书图里已经讲完了，正文再摆一遍是重复，
 * 而且现场（比如录课）也不需要再去填。
 *
 * 需要额外说明时直接在标记块外面写 —— 扩展只替换 `lgAssist:*` 标记之间的部分。
 * 共享版式里的常用组件（`note` / `tip` / `warn` / `chip` / `divider` / `c-fill`）
 * **已经默认 import 好了**，想用直接写 `#tip[……]` 就行，不用再改 import
 * —— 否则现场（比如录课）临时想加个提示，会先撞一次「unknown variable」。
 */
export function buildBanshuDoc(opts: BanshuDocOptions): string {
  const title = banshuTitle(opts.displayId, opts.title);
  return `// ${title} —— 由「洛谷教学助手」生成
//
// 正文只有板书图与代码实现两块，都由扩展自动维护。
// \`lgAssist:*\` 标记**之间**的内容会被「导出并插入题解 / 写入 AC 代码」覆盖，
// 标记**之外**随便加（要补说明就直接写）。
//
// 常用组件已经 import 好了：#tip[……] / #warn[……] / #note[……] / #chip[……] / #divider[……]
//
// 编译成 PDF：命令面板 →「洛谷：导出题解 PDF」
#import "../${CONF_FILE}": conf, note, tip, warn, chip, divider, c-fill

#show: doc => conf(
  course: "${opts.course}",
  title: "${title}",
  author: "${opts.author}",
  date: "${opts.date}",
  type: "题解板书",
  doc,
)

${markStart("image")}
${markEnd("image")}

= 代码实现

${markStart("code")}
${markEnd("code")}
`;
}

/**
 * `lgAssist:code` 块的内容：引用同目录的 AC 代码快照。
 *
 * ⚠️ `read()` 必须**写在题解文档里**（就是这里），不能包进 banshuconf.typ 的 helper ——
 * Typst 按「写这行字的文件」解析路径，包进 helper 就会去题库根找文件（实测踩过）。
 */
export function codeBlockBody(displayId: string): string {
  return `#raw(read("${acCodeName(displayId)}"), lang: "cpp", block: true)`;
}

/**
 * `lgAssist:image` 块的内容：按顺序插入板书图。
 *
 * @param pages 板书图页数（白板导出多页时是 2、3…）；0 表示还没导出过
 * @param width Typst 宽度表达式，默认 89%（沿用原 P1395 的比例）
 */
export function imageBlockBody(displayId: string, pages: number, width = "89%"): string {
  if (pages <= 0) return "";
  const lines: string[] = [];
  for (let i = 1; i <= pages; i++) {
    if (i > 1) lines.push("");
    lines.push(`#image("${boardImageName(displayId, i)}", width: ${width})`);
  }
  return lines.join("\n");
}

/**
 * 从 `lgAssist:image` 块的内容里数出已经插了几页（用于「导出并插入」时接着往后排）。
 * 数 `#image(` 的出现次数即可 —— 这个块是扩展自己写的，格式可控。
 */
export function countImages(blockBody: string): number {
  return (blockBody.match(/#image\(/g) ?? []).length;
}

/**
 * 题库根目录里共享的那份 `banshuconf.typ`。
 *
 * 版式沿用原 `D:\板书` 那套视觉语言（深蓝主色 + 琥珀点缀的表单风），
 * 按「题解板书」调了两处：
 *   - 默认 `type` 改成「题解板书」、`course` 默认给题解用，署名栏留空时不显示；
 *   - 去掉原版里教案专用的注释，并**明确不放**「读文件」helper（Typst 的路径按
 *     写这行字的文件解析，放 helper 里会指向题库根，见文件内注释）。
 * 编辑器/页眉页脚/标题样式/提示块这些**没动**，改它就是改所有题目的观感。
 */
export const BANSHU_CONF = `// banshuconf.typ —— 题解板书版式配置（由「洛谷教学助手」写入，可自行修改）
// ================================================================
// 设计语言：深蓝主色 + 琥珀点缀的表单风版面
//   · 一级标题：浅蓝底色带 + 主色粗左边线
//   · 二三级标题：琥珀色序号 + 竖条标记
//   · 提示块：彩底 + 粗左边线的卡片式 callout
//   · 时间 / 标签徽章：#chip[10 min]
//   · 时段分隔线：#divider[课间休息 · 10 min]
// 放在题库根目录，各题目录用 #import "../banshuconf.typ" 引用。
// ⚠️ 跨目录 import 编译时**必须带 --root <题库根>**，否则 Typst 会报
//    「would escape the project root」。扩展的导出命令已经带上了。
// ================================================================

#import "@preview/numbly:0.1.0": numbly
#import "@preview/cuti:0.2.1": show-cn-fakebold
#show: show-cn-fakebold

// ---------- 主题色 ----------
#let c-primary = rgb("#1a5680") // 主色：深蓝（标题带、粗线、页眉）
#let c-fill = rgb("#edf4fa") // 主色浅底（标题带底色、表头、行内代码）
#let c-line = rgb("#c9d9e7") // 浅蓝灰分隔线 / 表格框线
#let c-accent = rgb("#b45309") // 点缀：琥珀（徽章、次级序号、竖条）
#let c-ink = luma(30) // 正文重色
#let c-muted = luma(105) // 次要文字

// ---------- 提示块配色 ----------
#let _c-note = (fg: luma(75), bg: rgb("#f5f5f4"), bar: luma(150))
#let _c-tip = (fg: rgb("#0d7268"), bg: rgb("#e8f5f3"))
#let _c-warn = (fg: rgb("#b4232a"), bg: rgb("#fcf0f0"))

// ---------- 小组件 ----------

// 徽章：时长、难度、标签等小圆角标签
// 用法：== 复习导入 #chip[10 min]
#let chip(body, fill: c-accent) = box(
  radius: 8pt,
  inset: (x: 5.5pt, y: 1.8pt),
  outset: (y: 1.6pt, x: 0.5pt),
  fill: fill.lighten(90%),
  stroke: 0.5pt + fill.lighten(45%),
  text(fill: fill, size: 9pt, weight: "bold", body),
)

// 居中分隔线：时段标记
// 用法：#divider[课间休息 · 10 min]
#let divider(body) = block(
  above: 1.5em,
  below: 1.5em,
  grid(
    columns: (1fr, auto, 1fr),
    align: (right + horizon, center, left + horizon),
    column-gutter: 10pt,
    line(length: 100%, stroke: 0.7pt + c-line),
    box(inset: (x: 4pt), text(fill: c-muted, size: 10pt, weight: "bold", body)),
    line(length: 100%, stroke: 0.7pt + c-line),
  ),
)

// ---------- 提示块（卡片式 callout） ----------
#let _callout(fg, bg, mark, label, body) = block(
  width: 100%,
  above: 1em,
  below: 1em,
  fill: bg,
  stroke: (left: 2.5pt + fg),
  radius: (right: 3pt),
  inset: (left: 10pt, rest: 9pt),
  {
    if mark != none { mark }
    if label != none { text(fill: fg, weight: "bold", label) }
    if label != none { h(6pt) }
    body
  },
)

// 灰底块：无标签，用于结论、作业信息等普通强调
// 用法：#note[内容]
#let note(body) = _callout(_c-note.fg, _c-note.bg, none, none, body)

// 蓝绿块：思路提示、补充说明
// 用法：#tip[内容]
#let tip(body) = _callout(
  _c-tip.fg,
  _c-tip.bg,
  box(
    align(center + horizon, text(fill: _c-tip.fg, size: 13pt, weight: "bold")[i]),
  ),
  [提示],
  body,
)

// 红块：易错警示
// 用法：#warn[内容]
#let warn(body) = _callout(
  _c-warn.fg,
  _c-warn.bg,
  box(
    align(center + horizon, text(fill: _c-warn.fg, size: 15pt, weight: "bold")[!]
    ),
  ),
  [易错点],
  body,
)

// ---------- 题解专用 ----------
//
// ⚠️ **这里故意不放「读同目录文件」的 helper**（比如 codefile(path)）：
// Typst 的 read() / image() 路径是**按写这行字的那个文件**解析的，不是按调用处。
// 所以 helper 定义在这里的话，codefile("x_AC.cpp") 会去**题库根**找文件（实测报
// file not found (searched at <root>/x_AC.cpp)），而不是题目录。
// 贴代码请**在题解文档里**直接写：
//     #raw(read("P1395_AC.cpp"), lang: "cpp", block: true)
// 这样路径就是相对题目录的。扩展写入的就是这一行（见 template.ts 的 build* / markCode）。

// ---------- 版式配置 ----------
#let conf(
  course: "《深入浅出程序设计竞赛》题解",
  title: "默认标题",
  author: "",
  date: "默认日期",
  type: "题解板书",
  name-label: "作者", // 兼容 classnote.conf 的署名栏标签
  doc,
) = {
  // 序号渲染：标题编号由 show 规则手动排版
  let num(it) = if it.numbering != none {
    numbering(it.numbering, ..counter(heading).get())
  } else { [] }

  // 代码块：浅底细框 + 主色行号
  show raw.where(block: true): code => block(
    fill: rgb("#f7f9fb"),
    stroke: 0.5pt + c-line,
    inset: 9pt,
    radius: 3pt,
    width: 100%,
    grid(
      columns: (auto, auto),
      column-gutter: 0.9em,
      row-gutter: par.leading,
      align: (right, raw.align),
      ..for line in code.lines {
        (
          text(fill: rgb("#9db4c8"), size: 0.85em)[#line.number],
          line.body,
        )
      },
    ),
  )

  // 行内代码：浅蓝底圆角
  show raw.where(block: false): it => box(
    fill: c-fill,
    radius: 2pt,
    inset: (x: 3pt, y: 0pt),
    outset: (y: 0.35pt),
    it,
  )

  show link: set text(fill: c-primary)

  // 一级标题：浅蓝底色带 + 主色粗左边线
  show heading.where(level: 1): it => block(
    breakable: false,
    width: 100%,
    above: 2.1em,
    below: 1.1em,
    fill: c-fill,
    stroke: (left: 3.5pt + c-primary),
    radius: (right: 3pt),
    inset: (left: 10pt, right: 10pt, y: 6.5pt),
    text(size: 14pt, weight: "bold", fill: c-primary)[#num(it) #it.body],
  )

  // 二级标题：琥珀浅底色带 + 琥珀粗左边线 + 琥珀序号 + 深色标题
  show heading.where(level: 2): it => block(
    breakable: false,
    width: 100%,
    above: 1.5em,
    below: 0.75em,
    fill: c-accent.lighten(93%),
    stroke: (left: 3pt + c-accent),
    radius: (right: 3pt),
    inset: (left: 9pt, right: 9pt, y: 5.5pt),
    {
      text(size: 12pt, weight: "bold", fill: c-accent)[#num(it)]
      h(4pt)
      text(size: 12pt, weight: "bold", fill: c-ink)[#it.body]
    },
  )

  // 三级标题：主色序号 + 深色标题
  show heading.where(level: 3): it => block(
    breakable: false,
    above: 1.2em,
    below: 0.55em,
    {
      text(size: 11pt, weight: "bold", fill: c-primary)[#num(it)]
      h(4pt)
      text(size: 11pt, weight: "bold", fill: c-ink)[#it.body]
    },
  )

  set page(
    paper: "a4",
    margin: (x: 1.9cm, top: 2.4cm, bottom: 2.2cm),
    // 页眉：首页不显示，次页起左侧课程信息、右侧文档类型
    header: context {
      if counter(page).get().first() > 1 {
        grid(
          columns: (1fr, auto),
          align: (left, right),
          text(size: 9.5pt, fill: c-muted)[#course　·　#title],
          text(size: 9.5pt, fill: c-primary, weight: "bold")[#type],
        )
        v(3pt)
        line(length: 100%, stroke: 0.7pt + c-line)
      }
    },
    // 页脚：居中页码
    footer: context {
      align(
        center,
        text(
          size: 9.5pt,
          fill: c-muted,
        )[第 #counter(page).get().first() 页　·　共 #counter(page).final().first() 页],
      )
    },
  )

  set text(
    font: (
      (name: "fira code", covers: "latin-in-cjk"), // 西文字体
      "Sarasa Mono SC", // 中文字体
    ),
    size: 13pt,
    lang: "zh",
  )
  set par(justify: true)
  set list(marker: text(fill: c-primary)[•])
  set table(stroke: 0.6pt + c-line, inset: (x: 7pt, y: 5.5pt))

  // 标题编号：一、 (1) 1. a.
  set heading(numbering: numbly(
    "{1:一}、",
    "({2:1})",
    "{3:1.}",
    "{3}.{4}",
  ))

  // 标题区：小字眉行 + 大标题 + 粗细双线
  {
    grid(
      columns: (1fr, auto),
      align: (left, right + horizon),
      {
        box(width: 4pt, height: 10pt, fill: c-accent, outset: (right: 6pt))
         h(10pt)
        text(size: 11pt, fill: c-primary, weight: "bold")[#course · #type]
      },
      if author != "" {
        text(size: 10pt, fill: c-muted)[#name-label：#author　｜　#date]
      } else {
        text(size: 10pt, fill: c-muted)[#date]
      },
    )
    text(size: 22pt, weight: "bold", fill: c-primary)[#title]
    line(length: 100%, stroke: 2.2pt + c-primary)
  }

  doc
}
`;
