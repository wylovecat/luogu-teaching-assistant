/**
 * 白板纸张上放的题面内容（纯逻辑，无 vscode/DOM 依赖，便于测试）。
 *
 * 白板是拿来当讲义批注的，只要讲课用得上的几段，其余一律不进纸张：
 * 保留 题号+题名标题、题目描述、输入格式、输出格式、**一组**样例、提示；
 * 不留 时间/内存限制、多组样例、说明（站点 hint 字段，多是背景介绍）。
 *
 * 样例固定取 `samples[0]` 而不是去裁原始 markdown：样例的字段解析有 pickSamples 兜底，
 * 比按标题切 markdown 可靠。
 */

import type { Statement } from "../problems/statement";

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

  // 白名单里一段正文都没攒出来（站点偶发只给 rawMarkdown）时，退回站点原始 markdown，
  // 免得白板上是一张白纸。
  if (parts.length <= (head.length > 1 ? 1 : 0)) {
    const raw = s.rawMarkdown.trim();
    if (raw) return raw;
    return head.length > 1 ? head : "";
  }
  return parts.join("\n").trim();
}
