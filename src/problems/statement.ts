/**
 * 题面字段抽取：把洛谷 `/problem/<pid>`（配 `x-lentille-request: content-only`）的
 * `data.problem` 统一成同一个结构。
 *
 * 纯函数，无 vscode 依赖，便于测试（test/statement.test.ts 直接引用本文件）。
 *
 * ⚠️ 字段名与单位以真机实测为准，别凭直觉改（2026-10-12 对着 P1000 的真实返回核过一遍）：
 *
 *  **新形态（Lentille，当前站点）** —— 字段散在 `content` 子对象与 `limits` 里，
 *  顶层并没有 `title` / `description` / `memoryLimit` 这些平铺字段：
 *  - 标题是 `name`（顶层 `title` 存在但是**空串**，只认 title 会得到空标题）；
 *  - 正文在 `content`：`background` / `description` / `formatI` / `formatO` / `hint`
 *    （注意是 `formatI`/`formatO`，不是 `inputFormat`/`outputFormat`）；
 *  - 时空限制在 `limits`：`time` 是**毫秒**、`memory` 是 **KB**（都是数组，取最大值）。
 *    128MB 的题给 `memory: [131072]` —— 按字节算会变成 0.1MB，差三个数量级。
 *  - 样例是 `[[输入, 输出], …]` 的**元组数组**，不是 `{input, output}` 对象。
 *
 *  **旧形态**（站点迁移前的平铺字段）仍一并收着：老测试用例、老缓存都还是它，
 *  别把兼容分支删了。
 *
 *  - 旧形态的 `memoryLimit` 是**字节**、`timeLimit` 是**毫秒**。
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

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * 时空限制给的是**数组**（每个数据点一份），界面上要显示一个数，取最大值。
 */
function maxOf(v: unknown): number | null {
  const list = Array.isArray(v) ? v : [v];
  let best: number | null = null;
  for (const item of list) {
    const n = num(item);
    if (n !== null && (best === null || n > best)) best = n;
  }
  return best;
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
    // 新形态是 `[输入, 输出]` 的元组：元组直接按位置取
    if (Array.isArray(item)) {
      const input = str(item[0]);
      const output = str(item[1]);
      if (input === "" && output === "") continue;
      out.push({ input, output });
      continue;
    }
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
 * 由 `GET /problem/<pid>` 的 `data.problem` 组装（新旧两种字段形态都收）。
 *
 * 洛谷没有「整篇 markdown」这个字段，rawMarkdown 一律留空 ——
 * 题面渲染与白板那张纸都会退回按结构化字段拼（statementToMarkdown / statementToSource）。
 */
export function statementFromLuogu(
  problem: Record<string, unknown>,
  fallback: { displayId: string; title: string },
): Statement {
  const content = rec(problem.content);
  const limits = rec(problem.limits);
  // 难度既可能是数字也可能是字符串（站点版本差异）
  const rawDifficulty = problem.difficulty;
  const difficulty = typeof rawDifficulty === "number" ? rawDifficulty : num(rawDifficulty);

  // 新形态 limits.memory 是 **KB**、limits.time 是毫秒；旧形态 timeLimit/memoryLimit
  // 是平铺的毫秒/字节。两个来源的量纲不同，所以分开换算，别合并成一条路径。
  const limitsTime = maxOf(limits.time);
  const limitsMemoryKb = maxOf(limits.memory);
  const legacyTime = num(problem.timeLimit ?? problem.time_limit);
  const legacyMemoryBytes = num(problem.memoryLimit ?? problem.memory_limit);

  return {
    displayId: str(problem.pid) || fallback.displayId,
    // 标题在新接口里叫 `name`；顶层 `title` 存在但是空串，所以 name 在前
    title: str(problem.name) || str(problem.title) || fallback.title,
    description: str(content.description) || str(problem.description),
    inputDescription:
      str(content.formatI) || str(problem.inputFormat) || str(problem.input_format),
    outputDescription:
      str(content.formatO) || str(problem.outputFormat) || str(problem.output_format),
    samples: pickSamples(problem.samples),
    hint: str(content.hint) || str(problem.hint),
    prompt:
      str(content.background) ||
      str(problem.background) ||
      str(problem.prompt ?? problem.conclusion),
    timeLimitMs: limitsTime ?? legacyTime,
    memoryLimitMb:
      limitsMemoryKb !== null
        ? Math.round(limitsMemoryKb / 1024)
        : legacyMemoryBytes === null
          ? null
          : Math.round(legacyMemoryBytes / 1024 / 1024),
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