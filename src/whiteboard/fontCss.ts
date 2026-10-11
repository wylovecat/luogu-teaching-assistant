/**
 * KaTeX 样式的字体内联（纯字符串处理，无 vscode/fs 依赖，便于测试）。
 *
 * 为什么需要：白板导出要把题面 DOM 塞进 SVG 的 foreignObject，再当 <img> 加载 ——
 * 这种加载方式**不允许引用外部资源**，而 katex.min.css 里的 @font-face 引的是
 * 相对路径的字体文件。不内联的话公式会掉字形（退回系统字体，KaTeX 的排版靠字体度量，
 * 观感会很差）。所以把 woff2 读成 base64 data URI 顶掉 src。
 */

/** 收集 CSS 里 url(...) 引用的资源（去重、保持出现顺序，跳过 data: URI）。 */
export function collectFontUrls(css: string): string[] {
  const out: string[] = [];
  const re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const url = m[2];
    if (url.startsWith("data:")) continue;
    if (!out.includes(url)) out.push(url);
  }
  return out;
}

/**
 * 把每条 @font-face 的 src 换成单个内联 woff2。
 * 提供不了 data URI 的那条保持原样（宁可回落到相对 url 失败，也不要整条 src 掉空）。
 */
export function inlineFontSources(css: string, dataUris: Map<string, string>): string {
  return css.replace(/src\s*:\s*([^;}]*)/g, (whole, decl: string) => {
    const m = /url\(\s*(['"]?)([^'")]+)\1\s*\)/.exec(decl as string);
    if (!m) return whole;
    const data = dataUris.get(m[2]);
    return data ? `src: url(${data}) format('woff2')` : whole;
  });
}
