import MarkdownIt from "markdown-it";
import katex from "katex";

const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
});

/**
 * 先把公式抽成占位符、渲染 Markdown、再把 KaTeX 结果填回去。
 *
 * 不写成 markdown-it 插件是为了少一层对 markdown-it 内部 ruler/Token 的依赖：
 * 站点题面里的公式形态很有限（$...$ / $$...$$ / \(..\) / \[..\]），
 * 正则抽取 + 占位符回填足够，且出错也不会污染正文。
 */
export function renderMathAndMarkdown(source: string): string {
  const stashed: string[] = [];
  const stash = (html: string): string => {
    stashed.push(html);
    return `@@KATEX${stashed.length - 1}@@`;
  };
  const renderTex = (tex: string, displayMode: boolean): string => {
    try {
      return katex.renderToString(tex.trim(), { displayMode, throwOnError: false, output: "html" });
    } catch {
      return `<code>${escapeHtml(tex)}</code>`;
    }
  };

  let text = source;
  // 块级公式优先，避免 $$..$$ 被行内规则先吃掉
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => stash(renderTex(tex, true)));
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_m, tex: string) => stash(renderTex(tex, true)));
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_m, tex: string) => stash(renderTex(tex, false)));
  text = text.replace(/(^|[^$\\])\$([^$\n]+?)\$/g, (_m, pre: string, tex: string) => pre + stash(renderTex(tex, false)));

  const html = md.render(text);
  return html.replace(/@@KATEX(\d+)@@/g, (_m, i: string) => stashed[Number(i)] ?? "");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 只渲染 Markdown（用于创建题面面板的正文）。 */
export function renderMarkdownBody(source: string): string {
  return renderMathAndMarkdown(source);
}
