import * as vscode from "vscode";
import { escapeHtml } from "./markdown";
import { BASE_STYLE } from "./theme";

export { BASE_STYLE };

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export interface WebviewDocOptions {
  webview: vscode.Webview;
  title: string;
  /** 额外 <style> 内容（不含 <style> 标签） */
  style?: string;
  /** 额外 <link rel=stylesheet> 的 URI 列表 */
  stylesheets?: string[];
  body: string;
  /** 内联脚本（会带 nonce，需用 nonce 变量） */
  script?: string;
  /** KaTeX 字体/样式来自 webview 资源目录，需要 cspSource */
  allowImages?: boolean;
}

/** 生成一个带严格 CSP 的 webview 文档；script 用 nonce 放行。 */
export function buildWebviewHtml(opts: WebviewDocOptions): string {
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `style-src ${opts.webview.cspSource} 'unsafe-inline'`,
    `font-src ${opts.webview.cspSource}`,
    opts.allowImages !== false ? `img-src ${opts.webview.cspSource} data: https:` : `img-src ${opts.webview.cspSource} data:`,
    opts.script ? `script-src 'nonce-${n}'` : "",
  ]
    .filter(Boolean)
    .join("; ");

  const links = (opts.stylesheets ?? [])
    .map((href) => `<link rel="stylesheet" href="${href}">`)
    .join("\n    ");

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(opts.title)}</title>
  ${links}
  <style>${BASE_STYLE}${opts.style ?? ""}</style>
</head>
<body>
${opts.body}
${opts.script ? `<script nonce="${n}">\n${opts.script}\n</script>` : ""}
</body>
</html>`;
}
