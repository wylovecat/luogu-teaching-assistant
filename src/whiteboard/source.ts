/**
 * 白板纸张上放的题面内容（纯逻辑，无 vscode/DOM 依赖，便于测试）。
 *
 * 白板是拿来当讲义批注的，只要讲课用得上的几段，其余一律不进纸张：
 * 保留 题号+题名标题、题目描述、输入格式、输出格式、**一组**样例、提示、**说明里的数据范围**；
 * 不留 时间/内存限制、多组样例、说明里与数据范围无关的背景介绍。
 *
 * 样例固定取 `samples[0]` 而不是去裁原始 markdown：样例的字段解析有 pickSamples 兜底，
 * 比按标题切 markdown 可靠。
 *
 * 说明（站点 hint）整段砍掉是错的：洛谷把「数据范围」写在 hint 里（如 `对于 100% 的数据，
 * 1 ≤ n ≤ 1e5`），老师照着写代码要用它估算法、学生也对不上数据档位。所以这里只**留数据范围**，
 * 其余背景介绍（题目由来、故事、"本题改编自…"）照样不上纸，免得占掉半页讲义。
 */

import type { Statement } from "../problems/statement";

/**
 * 判断一行是不是「数据范围」的**标题或开场句**（用来决定从这里开收）。
 *
 * 必须**窄**：宽了就会把整段样例说明、多语言程序范例一起收进讲义（P1001 的
 * hint 里挂着十几种语言的完整程序，P1909/P2141/P1563 挂着大段解题过程）。
 *
 * ⚠️ 「保证」**不能**单独进这个表：P2141 的 `【样例说明】` 里有
 * 「注意，加数和被加数必须…」，句句带「必须/保证」的解题正文一抓一大把。
 * 只有「保证」跟着数据/范围语境（下面 RANGE_INK 那条路）才算。
 */
const RANGE_HEAD =
  /数据范围|数据规模|数据约定|约束条件|取值范围|数据说明|测试点(?:的)?(?:数据规模|规模|数量)|子任务的分值|测试点分|分值分布|(?:^|[^%])数据(?:规模|范围|说明|约定)|subtask/i;

/**
 * 仅在「已经是数据范围块」时才认的**延伸**标志。
 *
 * ⚠️ `子任务` 不能进 RANGE_HEAD：P1563 的 `**子任务**` 前面是一大段样例讲解，
 * 一认它就等于把讲解也收进来。但它出现在**块内**（如 P1909 的数据范围→子任务→表格）
 * 时，说明后面的表格就是数据规模表，要跟着收。所以它只在块内生效。
 */
const RANGE_CONT = /子任务|如下表|下表|测试点/i;

/**
 * 「标题」的宽判据：markdown 井号标题、`**粗体**`、`【方括号】`、以及两者套着写的
 * `**【题目来源】**`。
 *
 * ⚠️ 这里**绝不能**给 `**…**` 加「后面必须紧跟行尾」的限制：真实标题长这样 ——
 * `**数据范围**` 后面什么都没有但也可能就是唯一一行，`**【题目来源】**` 是方括号外套粗体。
 * 早先的写法要求 `**` 之后立刻行尾，于是 P1001 的 `**广告**`、P1046 的 `**【题目来源】**`
 * 全被当成普通正文落进块内，白板上就蹭出一块跟数据范围无关的内容。
 */
const HEADING_LINE = /^\s*(?:#{1,6}\s|\*\*\s*(?:【[^】]{1,20}】|[^*]{1,24})\s*\*\*|【[^】]{1,20}】\s*$)/;

/** 代码围栏 —— 进去以后整段跳过（P1001 里挂着十几种语言的完整程序）。 */
const FENCE_LINE = /^\s*```/;

/** 表格行 / 表格说明项 —— 洛谷把「每个测试点的数据规模」画成 cute-table。 */
const TABLE_LINE = /^\s*(?:::\s*cute-table|\|)|^\s*-\s*\S+：/;

/**
 * 取值范围的样子。
 *
 * ⚠️ 这里踩过两次，都是「字符太常见」导致的：
 *  ① 光秃秃的 `=` 不行 —— 广告 URL 里的 `id=637730514783` 自带 `=` 和数字；
 *  ② 光秃秃的 `<`/`>` 也不行 —— 广告里的 `>>>` 箭头就是它们。
 * 所以 ASCII 比较符必须是**数学语境**：`\le`/`\leq` 这类 LaTeX 命令，或
 * `数字 < 字母/数字` 这种真正的不等式（`1 < n`、`n <= 100`）。
 * 中文与 Unicode 符号（≤≥、不超过/至少…）本身就极少出现在广告或正文里，可以直接认。
 */
const RANGE_INK = /\\le|\\leq|\\ge|\\geq|[≤≥]|不超过|不少于|至少|至多|最多|不小于|不大于|\d\s*(?:<|<=|>|>=)\s*[\w$\\]/;

/** 链接/图片行（`[![](…)](…)`、`![](…)`、裸 URL）—— 永远不是数据范围。 */
const LINK_LINE = /^\s*\[?!?\[|^\s*https?:\/\//;

/**
 * 一句中文里「像在限定取值范围」的样子。用来给裸句子（没有 `$` 公式、没有标题壳）把关。
 *
 * ⚠️ 光看「至少 / 不超过」这类词**不够**：P1909 的样例讲解里有一句
 * 「P 老师需要购买**至少** 57 支铅笔。」，只按词判就会从这句开块，把后面一整段
 * 「如果她选择…所以答案是 54」的解题过程全收进讲义（实测）. 真正的约束句长这样：
 *   - 数字**紧挨着**比较符或量词（`n ≤ 10^5`、`不超过 10000 的正整数`）；
 *   - 或不含句末标点的短句配上「数据/范围/保证」语境。
 * 所以这里要求「数字与限制词贴在一起」，而不是只要句子出现过这两个元素。
 */
function isConstraintSpoken(text: string): boolean {
  // ① 显式的不等式/量词贴着数字：「n ≤ 10^5」「不超过 10000 的正整数」
  if (/(?:不超过|不少于|不小于|不大于)\s*\$?\s*[\d{]/.test(text)) return true;
  // ② 「至多/最多/至少」要配一个**上限语境的词**（个/条/位/次 + 数字），
  //    否则「购买至少 57 支铅笔」这种叙述句也会命中 —— P1909 的样例讲解正是它。
  if (/(?:至多|最多|至少)\s*\$?\s*\d+\s*(?:个|条|位|次|种|组|支)?\s*(?:的)?\s*(?:数据|测试点|正整数|整数|元素|节点|字符)/.test(text)) return true;
  // ③ 数字与 ≤ / ≥ 直接相邻
  if (/[\d}]\s*(?:≤|≥)\s*[\w$\\]|\\le\s*[\d{]|\\ge\s*[\d{]/.test(text)) return true;
  // ④ 带「保证 / 数据 / 范围」语境的短句
  return /(?:保证|数据|范围|约束)[^。；]{0,40}$/.test(text) && RANGE_INK.test(text);
}

/** 行内公式（`$1 \leq n \leq 10^5$`）—— 块外要配合 RANGE_INK 才认，免得收到讲解正文。 */
function looksLikeFormula(text: string): boolean {
  return /[$]{1,2}[^$]*[$]{1,2}/.test(text) || /\\le|\\leq|\\ge|\\geq/.test(text);
}

function isTableLine(text: string): boolean {
  return TABLE_LINE.test(text.trim());
}

/**
 * 从说明（站点 hint）里挑出「数据范围」相关的内容，其余背景介绍、样例讲解、
 * 多语言程序范例一律丢掉。
 *
 * 做法不是「一行行判」而是**认块**：命中一个像数据范围开头的标题/句子就开收，
 * 一直收到下一个标题（只要那个标题自己不是讲数据范围的，就结束）为止。
 *
 * 为什么必须认块、不能单行判：洛谷的 hint 是一锅大杂烩 —— P1001 挂着十几种语言的
 * 完整程序，P1909/P2141/P1563 挂着大段解题过程。单行判（有数字、有 `$` 就留）会把这些
 * 全收进来，纸上就是好几页废内容。2026-10-13 老师反馈 P2085 数据范围被截断时一并发现的。
 *
 * ⚠️ 折行也在这条路径上（P2085）：
 * ```
 * 对于全部的测试点，保证 $1 \leq n,m\le10000$，$1 \leq A_i\le10$,
 * $0 \leq B_i\le100$,
 * $0 \leq C_i\le10^4$。
 * ```
 * 续行没有关键词、也没有「数字 + 不等号」的完整形状，所以**在块内**一律跟着收。
 * 块内还额外收表格行与 `- 说明：…` 项（P1563「每个测试点的数据规模及特点如下表」那条路径）。
 */
export function dataRangeFromHint(hint: string): string {
  const lines = hint.split(/\r?\n/);
  const out: string[] = [];
  let inRange = false;
  let inFence = false;

  for (const raw of lines) {
    const text = raw.trim();
    const blank = text === "";

    // 代码围栏：进出都整段按原样吞掉（围栏内的 `#include` 之类不是标题）
    if (FENCE_LINE.test(text)) {
      inFence = !inFence;
      if (inRange) out.push(raw.replace(/\s+$/, ""));
      continue;
    }
    if (inFence) {
      if (inRange) out.push(raw.replace(/\s+$/, ""));
      continue;
    }

    if (!blank && HEADING_LINE.test(text)) {
      // 新标题 = 新话题。块外只有「它自己就在讲数据范围」的标题才开新块
      // （`**广告**`、`**【题目来源】**` 这种一律收手）；
      // 块内则允许 `**子任务**` 这类延伸标题继续带着收。
      //
      // ⚠️ 那个**结束**当前块、自己又不属于数据范围的标题**不能输出**：
      // 早先的输出条件只看「是不是非空行」，于是 `**广告**` 这种收场标题也被打进纸上。
      inRange = RANGE_HEAD.test(text) || (inRange && RANGE_CONT.test(text));
      if (!inRange) continue;
    } else if (!blank && isTableLine(text)) {
      // 表格与表格说明项：只在数据范围块内才有意义
      // （块外的 `- 2021-10-27：增加一组 hack 数据` 是更新日志，不该收）
      if (!inRange) continue;
    } else if (!blank && RANGE_HEAD.test(text)) {
      // 数据范围的开场句（不带标题壳的那种，如「数据范围」单独一行）
      inRange = true;
    } else if (blank) {
      // 空行不清状态：数据范围常被空行切成好几段（P1308 每句一个空行）
    } else if (inRange) {
      // 块内的续行一律跟着收 —— 折行、行内公式、纯文字条件都算
    } else if (LINK_LINE.test(text)) {
      // 链接/图片行一律不收，也不开块（P1001 的广告图 URL 自带 `=` 和数字）
      continue;
    } else if (looksLikeFormula(text) && RANGE_INK.test(text) && isConstraintSpoken(text)) {
      // 块外的裸数据行：「对于 100% 的数据，$1\le n\le10^5$」这种带公式的取值范围。
      // 要求**同时**有公式、取值范围的样子、并且整句像约束 —— 三者缺一不可：
      // 只看「有 `$` 且含数字」会把 P1909 的样例讲解（「购买至少 $57$ 支铅笔」）收进来，
      // 而那是叙述句不是取值范围。
      inRange = true;
    } else if (/\d/.test(text) && RANGE_INK.test(text) && isConstraintSpoken(text)) {
      // 纯文字的取值范围（「n 不超过 10^5」这种一句人话）
      inRange = true;
    } else {
      continue;
    }

    if (!blank || (inRange && out.length)) out.push(raw.replace(/\s+$/, ""));
  }

  // 收尾：去掉两端空行，压掉连续空行
  const cleaned: string[] = [];
  for (const line of out) {
    if (!line.trim() && (!cleaned.length || !cleaned[cleaned.length - 1].trim())) continue;
    cleaned.push(line);
  }
  while (cleaned.length && !cleaned[0].trim()) cleaned.shift();
  while (cleaned.length && !cleaned[cleaned.length - 1].trim()) cleaned.pop();
  return cleaned.join("\n");
}

export function whiteboardStatementMarkdown(s: Statement): string {
  const head = `# ${s.displayId} ${s.title}`.trim();
  const parts: string[] = [];
  if (head.length > 1) parts.push(head);

  const block = (title: string, body: string): void => {
    if (!body.trim()) return;
    parts.push("", `## ${title}`, "", body.trim());
  };

  block("题目描述", s.description);
  block("输入格式", s.inputDescription);
  block("输出格式", s.outputDescription);

  const sample = s.samples[0];
  if (sample) {
    parts.push(
      "",
      "## 样例",
      "",
      "**输入**",
      "",
      "```",
      sample.input.replace(/\s+$/, ""),
      "```",
      "",
      "**输出**",
      "",
      "```",
      sample.output.replace(/\s+$/, ""),
      "```",
    );
  }
  block("提示", s.prompt);
  // 说明只留数据范围（站点把 n 的上限写在这里，讲课时要用它估算法）
  block("说明", dataRangeFromHint(s.hint));

  // 白名单里一段正文都没攒出来（站点偶发只给 rawMarkdown）时，退回站点原始 markdown，
  // 免得白板上是一张白纸。
  if (parts.length <= (head.length > 1 ? 1 : 0)) {
    const raw = s.rawMarkdown.trim();
    if (raw) return raw;
    return head.length > 1 ? head : "";
  }
  return parts.join("\n").trim();
}
