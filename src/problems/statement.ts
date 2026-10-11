/**
 * 题面字段抽取：把洛谷 `/problem/<pid>?_contentOnly=1` 的返回统一成同一个结构。
 *
 * 纯函数，无 vscode 依赖，便于测试（test/statement.test.ts 直接引用本文件）。
 *
 * ⚠️ 字段名与单位以真机实测为准，别凭直觉改：
 *  - `memoryLimit` 是**字节**（125MB = 131072000），不是 MB —— 直接显示会差三个数量级。
 *  - `timeLimit` 是**毫秒**，可直接用。
 *  - `difficulty` 洛谷在不同版本里给过数字（0~7）与字符串两种，这里都收，
 *    数字按洛谷的「入门/普及-/普及/提高+/省选- …」序列取标签。
 */

export interface Sample {
  input: string;
  output: string;
}

export interface Statement {
  displayId: string;
  title: string;
  description: string;
  inputDescription: string;
  outputDescription: string;
  samples: Sample[];
  hint: string;
  prompt: string;
  timeLimitMs: number | null;
  memoryLimitMb: number | null;
  /** 洛谷难度（0~7），没有就 null */
  difficulty: number | null;
  /** 站点的完整 markdown 题面；洛谷不给整篇，留空由 statementToMarkdown 拼 */
  rawMarkdown: string;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return "";
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * 洛谷难度标签。0~7 的序列是洛谷站点的约定（题单筛选栏按它分档）。
 * 站点若改成给字符串，就直接用它的字符串。
 */
const DIFFICULTY_LABELS = [
  "暂无",
  "入门",
  "普及-",
  "普及/提高-",
  "普及+/提高",
  "提高+/省选-",
  "省选/NOI-",
  "NOI/NOI+/CTSC",
];

export function difficultyLabel(d: number | null): string {
  if (d === null || !Number.isInteger(d) || d < 0 || d >= DIFFICULTY_LABELS.length) return "";
  return DIFFICULTY_LABELS[d];
}

/** 从各种可能的样例字段形状里取出 {input,output} 数组。 */
export function pickSamples(raw: unknown): Sample[] {
  if (!Array.isArray(raw)) return [];
  const out: Sample[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const input = str(o.input);
    const output = str(o.output);
    // 样例两侧都为空时丢弃（站点偶尔给占位空对象）
    if (input === "" && output === "") continue;
    out.push({ input, output });
  }
  return out;
}

/**
 * 由 `GET /problem/<pid>?_contentOnly=1` 的 `currentData.problem` 组装。
 *
 * 洛谷没有「整篇 markdown」这个字段，rawMarkdown 一律留空 ——
 * 题面渲染与白板那张纸都会退回按结构化字段拼（statementToMarkdown / statementToSource）。
 */
export function statementFromLuogu(
  problem: Record<string, unknown>,
  fallback: { displayId: string; title: string },
): Statement {
  // 洛谷的 memoryLimit 是字节，统一换算成 MB
  const memoryBytes = num(problem.memoryLimit ?? problem.memory_limit);
  // 难度既可能是数字也可能是字符串（站点版本差异）
  const rawDifficulty = problem.difficulty;
  const difficulty = typeof rawDifficulty === "number" ? rawDifficulty : num(rawDifficulty);

  return {
    displayId: str(problem.pid) || fallback.displayId,
    title: str(problem.title) || fallback.title,
    description: str(problem.description),
    inputDescription: str(problem.inputFormat ?? problem.input_format),
    outputDescription: str(problem.outputFormat ?? problem.output_format),
    samples: pickSamples(problem.samples),
    hint: str(problem.hint),
    prompt: str(problem.prompt ?? problem.background ?? problem.conclusion),
    timeLimitMs: num(problem.timeLimit ?? problem.time_limit),
    memoryLimitMb: memoryBytes === null ? null : Math.round(memoryBytes / 1024 / 1024),
    difficulty,
    rawMarkdown: "",
  };
}

/** 把 Statement 渲染成一份可保存的 Markdown 题面。 */
export function statementToMarkdown(s: Statement): string {
  const lines: string[] = [];
  lines.push(`# ${s.displayId} ${s.title}`.trim());
  const limits: string[] = [];
  const label = difficultyLabel(s.difficulty);
  if (label) limits.push(`难度 ${label}`);
  if (s.timeLimitMs !== null) limits.push(`时间限制 ${s.timeLimitMs} ms`);
  if (s.memoryLimitMb !== null) limits.push(`内存限制 ${s.memoryLimitMb} MB`);
  if (limits.length) lines.push("", `> ${limits.join(" · ")}`);

  const push = (title: string, body: string) => {
    if (body.trim() === "") return;
    lines.push("", `## ${title}`, "", body.trim());
  };
  push("题目描述", s.description);
  push("输入格式", s.inputDescription);
  push("输出格式", s.outputDescription);
  if (s.samples.length) {
    lines.push("", "## 样例");
    s.samples.forEach((sample, i) => {
      lines.push("", `### 样例 ${i + 1}`, "", "**输入**", "", "```", sample.input.replace(/\s+$/, ""), "```");
      lines.push("", "**输出**", "", "```", sample.output.replace(/\s+$/, ""), "```");
    });
  }
  push("提示", s.prompt);
  push("说明", s.hint);
  return lines.join("\n") + "\n";
}