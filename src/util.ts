/**
 * 与 VSCode / 站点无关的纯逻辑：输出规范化比较、判定归一化、题号识别等。
 * 这里的函数被 test/ 下的 node:test 直接引用，不要 import 'vscode'。
 */

/**
 * 题号形态：短前缀 + 一段数字，数字后面还能跟字母/下划线。
 *
 * 洛谷除了自家编号（P1001 / B2001 / T1001）还收别的 OJ 的远程题，那批 ID 前缀长短不一，
 * 且**数字不一定在末尾**：`UVa100`、`HDU1001`、`CF1A`、`SP33713_FCTRL2`。
 * 只按「字母+数字结尾」判会漏掉它们，于是这类题没法靠文件名直接认出来。
 *
 * 前缀限长 1~3 个字符是为了**不误判普通 C++ 文件名**：`test1.cpp`、`main2.cpp` 这类太常见，
 * 放宽成「字母开头、含数字就行」会把它们全认成题号，提交时反而莫名其妙。
 *
 * 已知漏网：AtCoder 风格（`AT_abc001_a`）—— 数字前面夹着下划线且带小写段，
 * 要覆盖它得为单个平台硬编码前缀，不划算。这类题走「按题号创建」建一次显式关联即可
 * （显式关联不走这条兜底判断）。
 */
export function looksLikeProblemId(stem: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{0,2}\d[A-Za-z0-9_]*$/.test(stem);
}

/** 取文件名主干（去掉最后一个扩展名）。 */
export function stemOf(fileName: string): string {
  return fileName.replace(/\.[^.\\/]+$/, "");
}

/**
 * OJ 口径的输出规范化：每行去行尾空白，再去掉末尾连续空行。
 * 与 cpide judge.rs 的 norm() 一致。
 */
export function normalizeOutput(s: string): string {
  const lines = s.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t]+$/, ""));
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end).join("\n");
}

export function outputsEqual(actual: string, expected: string): boolean {
  return normalizeOutput(actual) === normalizeOutput(expected);
}

/**
 * 提交前是否还要再本地编译一次。
 *
 * 样例评测刚编译过的同一份代码（compiledHash 等于当前内容哈希）不必重复编译：
 * 学生点「评测 → 提交」的常见路径只该编译一次。代码改过了哈希就对不上，照常编译。
 */
export function needsPreSubmitCompile(
  compileFirst: boolean,
  currentHash: string,
  compiledHash?: string | null,
): boolean {
  if (!compileFirst) return false;
  return !compiledHash || compiledHash !== currentHash;
}

/** 站点评测状态 → 统一判定词（AC/WA/TLE/MLE/RE/CE/PE/?）。移植 cpide norm_verdict。 */
export function normVerdict(rec: Record<string, unknown>): string {
  const keys = ["subStatic", "substatic", "status", "feedback", "result", "verdict"];
  for (const key of keys) {
    const raw = rec[key];
    if (typeof raw !== "string" || raw.trim() === "") continue;
    const text = raw.trim();
    const compact = text.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
    if (["AC", "WA", "TLE", "MLE", "RE", "CE", "PE"].includes(compact)) return compact;
    if (compact === "OK") return "AC";
    if (compact.startsWith("ACCEPT")) return "AC";
    if (compact.startsWith("WRONG")) return "WA";
    if (compact.startsWith("TIME")) return "TLE";
    if (compact.startsWith("MEMORY")) return "MLE";
    if (compact.startsWith("RUNTIME")) return "RE";
    if (compact.startsWith("COMPILE")) return "CE";
    if (compact.startsWith("PRESENTATION")) return "PE";
    const zh: Array<[string, string]> = [
      ["编译", "CE"],
      ["超时", "TLE"],
      ["内存", "MLE"],
      ["运行错误", "RE"],
      ["答案错误", "WA"],
      ["格式", "PE"],
      ["答案正确", "AC"],
      ["通过", "AC"],
    ];
    for (const [tok, v] of zh) if (text.includes(tok)) return v;
    return "?";
  }
  return "?";
}

/**
 * 查到的评测结果是不是「可以报给用户」的最终结果。
 *
 * 站点是异步评测：`POST /api/submission` 立刻返回 submissionId，但这条记录要过一会儿才有真正的
 * 判定。刚提交就去查，拿到的往往是「还没开始评测」的那一份 —— 它的 `subIsPass` 已经不是 7
 * （所以按站点口径已经算「评测结束」），可 `subStatic` 还是空的、`id` 还是 0；照着显示就成了
 * 那个经典的错判：**实际 TLE，却报 WA**。
 *
 * 判据：提交记录 id 已经生成，或者判定文本已经写上（任一成立才认）。都不成立就继续轮询。
 * 站点前端自己也是提交后先 `setTimeout(…, 2000)` 再轮询（站点 chunk-f2966914 的 submitTopic），
 * 所以调用方在第一次查询前也会先等一拍。
 */
export function isFinalJudgeResult(res: { done: boolean; id: number; rawStatus: string }): boolean {
  if (!res.done) return false;
  return res.id > 0 || res.rawStatus.trim() !== "";
}

/** 判定词的中文简述，用于界面展示。 */
export function verdictLabel(verdict: string): string {
  const map: Record<string, string> = {
    AC: "答案正确",
    WA: "答案错误",
    TLE: "运行超时",
    MLE: "内存超限",
    RE: "运行错误",
    CE: "编译错误",
    PE: "格式错误",
    "?": "未知状态",
  };
  return map[verdict] ?? verdict;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 稳定的短哈希，用于给编译产物目录命名。FNV-1a 32 位。 */
export function shortHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * 新建文件打开后，编辑器实际生效的缩进（`editor.options`，已被 detectIndentation 按内容猜过）
 * 与用户 `editor` 配置不一致时，返回要写回编辑器的选项；一致、或配置不是具体值时返回 null。
 *
 * VSCode 的 `editor.detectIndentation` 默认开启：打开文件时按内容猜 tabSize，猜出来的值会压过
 * 用户的 `editor.tabSize`。新建文件的内容是我们写的模板，缩进该按用户配置来，所以要纠正一次。
 */
export function indentationFix(
  effective: { tabSize?: number | string; insertSpaces?: boolean | string },
  wanted: { tabSize?: number | string; insertSpaces?: boolean | string },
): { tabSize: number; insertSpaces: boolean } | null {
  if (typeof wanted.tabSize !== "number" || typeof wanted.insertSpaces !== "boolean") return null;
  if (effective.tabSize === wanted.tabSize && effective.insertSpaces === wanted.insertSpaces) return null;
  return { tabSize: wanted.tabSize, insertSpaces: wanted.insertSpaces };
}

/** 手机号/账号脱敏，用于展示。 */
export function maskAccount(phone: string): string {
  if (phone.length < 5) return phone;
  return `${phone.slice(0, 3)}****${phone.slice(-2)}`;
}
