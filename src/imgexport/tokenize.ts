import hljs from "highlight.js/lib/core";
import cpp from "highlight.js/lib/languages/cpp";

hljs.registerLanguage("cpp", cpp);

export interface TokenRun {
  text: string;
  color: string;
}

export type TokenLine = TokenRun[];

/** VSCode Dark+ 配色（与 cpide imgexport.ts 同一套，便于老师之间截图风格一致）。 */
const COLORS: Array<[string, string]> = [
  ["hljs-comment", "#6A9955"],
  ["hljs-quote", "#6A9955"],
  ["hljs-keyword", "#569CD6"],
  ["hljs-selector-tag", "#569CD6"],
  ["hljs-literal", "#569CD6"],
  ["hljs-type", "#4EC9B0"],
  ["hljs-built_in", "#4EC9B0"],
  ["hljs-string", "#CE9178"],
  ["hljs-meta-string", "#CE9178"],
  ["hljs-char", "#CE9178"],
  ["hljs-number", "#B5CEA8"],
  ["hljs-title", "#DCDCAA"],
  ["hljs-function", "#DCDCAA"],
  ["hljs-variable", "#9CDCFE"],
  ["hljs-params", "#9CDCFE"],
];

const DEFAULT_COLOR = "#D4D4D4";

function colorFor(classes: string): string {
  const list = classes.split(/\s+/);
  for (const [key, color] of COLORS) {
    if (list.includes(key)) return color;
  }
  return DEFAULT_COLOR;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * 把 hljs 产出的 HTML 展平成「每行若干带颜色的片段」。
 * hljs 的输出只是嵌套的 <span class="hljs-xxx">，所以用栈跟踪 class 即可，
 * 不需要引入 HTML 解析器。
 */
export function flattenHighlightHtml(html: string): TokenLine[] {
  const lines: TokenLine[] = [[]];
  const stack: string[] = [];
  const pushText = (raw: string) => {
    if (raw === "") return;
    const color = colorFor(stack.join(" "));
    const parts = decodeEntities(raw).split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      if (parts[i] !== "") lines[lines.length - 1].push({ text: parts[i], color });
    }
  };

  const re = /<span class="([^"]*)">|<\/span>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) stack.push(m[1]);
    else if (m[0] === "</span>") stack.pop();
    else if (m[2] !== undefined) pushText(m[2]);
  }
  return lines;
}

/** 分词。空行保留（图片里要显示空行）。 */
export function tokenizeCpp(code: string): TokenLine[] {
  let html: string;
  try {
    html = hljs.highlight(code, { language: "cpp", ignoreIllegals: true }).value;
  } catch {
    html = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  const lines = flattenHighlightHtml(html);
  // 保证行数与源码一致（源码末尾换行不该多出一行）
  const want = code.replace(/\r\n?/g, "\n").split("\n").length;
  while (lines.length > want) lines.pop();
  while (lines.length < want) lines.push([]);
  return lines;
}
