/**
 * 面板共用的基础样式。
 *
 * 单独放一个模块（不 import 'vscode'）是为了让白板的 webview 脚本也能复用它：
 * 白板导出时要把同一份样式内联进 SVG，样式不一致就会「屏幕上和导出的图长得不一样」。
 * 白板脚本跑在浏览器环境里，一旦它经 html.ts 间接引到 vscode，esbuild 的浏览器那次打包
 * 就会因为解析不到 vscode 而失败。
 */

/** 所有面板共用的基础样式（跟随 VSCode 主题变量，深浅色都能用）。 */
export const BASE_STYLE = `
:root {
  color-scheme: light dark;
  /*
   * 判定色：色相定死，明度随主题走。
   *
   * 做法是往「主题前景色」里混一点 —— 深色主题前景近白，混完得到亮色；浅色主题前景近黑，
   * 混完得到深色。于是同一份声明在两套主题下都成立，不用维护两套值，也不依赖
   * prefers-color-scheme（webview 里那取决于宿主怎么设 color-scheme，不如靠变量可靠）。
   * 每一对的两行里第一行是兜底：老版本 webview 不认 color-mix 时用固定色，不至于整条失效。
   *
   * RE 特意用紫而不是棕：原来的 TLE(#bf8700) 与 RE(#a0410d) 在小色块上几乎分不清。
   */
  --oi-ac: #2f9e4f;
  --oi-ac: color-mix(in srgb, #3fb950 88%, var(--vscode-editor-foreground));
  --oi-wa: #d64545;
  --oi-wa: color-mix(in srgb, #f85149 88%, var(--vscode-editor-foreground));
  --oi-tle: #b58600;
  --oi-tle: color-mix(in srgb, #d29922 88%, var(--vscode-editor-foreground));
  --oi-re: #8b5cf6;
  --oi-re: color-mix(in srgb, #a371f7 88%, var(--vscode-editor-foreground));
  /* 「当前色的极淡一层」：底纹、标签底色都从这里取，换主题自动跟着变 */
  --oi-tint: color-mix(in srgb, currentColor 9%, transparent);
  /* 数据字体：题号、样例号、耗时、通过数一律走等宽 + tabular，竖着才能对齐 */
  --oi-num: var(--vscode-editor-font-family, ui-monospace, monospace);
}
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-editor-foreground);
  background: var(--vscode-editor-background);
  margin: 0; padding: 0 22px 44px;
  line-height: 1.75;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3 { line-height: 1.35; font-weight: 600; letter-spacing: -.01em; }
/* 标题不再拉通栏底线：记分牌靠「分段」表达结构，不靠框。短横线由各面板按需用 .oi-rule 补。 */
h1 { font-size: 1.45em; margin: 1.7em 0 .1em; }
h2 { font-size: 1.1em; margin: 1.9em 0 .5em; }
h3 { font-size: 1em; margin: 1.3em 0 .3em; }
p { margin: .7em 0; }
code {
  font-family: var(--oi-num);
  background: var(--vscode-textCodeBlock-background);
  padding: .12em .4em; border-radius: 3px;
}
/*
 * pre 不设 font-size / line-height：面板里它该跟正文（--vscode-font-size）走，
 * 白板纸面上该跟纸张（16px）走，两边都由各自的规则说了算，在这儿写死就会两头不讨好。
 * 同理不在这儿加装饰性的边框 —— 导出 SVG 里没有主题变量，那类声明容易整条失效。
 */
pre {
  background: var(--vscode-textCodeBlock-background);
  padding: 11px 14px; border-radius: 4px; overflow-x: auto;
}
pre code { background: transparent; padding: 0; }
blockquote {
  margin: .8em 0; padding: .2em 0 .2em 1em;
  border-left: 2px solid var(--vscode-textBlockQuote-border);
  color: var(--vscode-descriptionForeground);
}
ul, ol { padding-left: 1.4em; }
li { margin: .25em 0; }
table { border-collapse: collapse; font-size: .96em; }
th, td { border: 1px solid var(--vscode-panel-border); padding: 5px 12px; text-align: left; }
th { background: var(--oi-tint); font-weight: 600; }
img { max-width: 100%; }
a { color: var(--vscode-textLink-foreground); }
.muted { color: var(--vscode-descriptionForeground); }
/* 等宽数字：耗时、通过数、题号这类需要竖向对齐的数据 */
.mono { font-family: var(--oi-num); font-variant-numeric: tabular-nums; }
/* 工具栏里的弹性留白 */
.oi-grow { flex: 1 1 auto; }
/* 32px 短横线，代替通栏分隔线 */
.oi-rule { width: 32px; height: 2px; background: var(--vscode-editor-foreground); opacity: .55; margin: .55em 0 .9em; }
.toolbar {
  position: sticky; top: 0; z-index: 5;
  display: flex; align-items: center; gap: 7px; flex-wrap: wrap;
  padding: 10px 0; margin: 0 0 18px;
  background: var(--vscode-editor-background);
  border-bottom: 1px solid var(--vscode-panel-border);
}
button {
  font-family: inherit; font-size: .9em; font-weight: 500;
  color: var(--vscode-button-foreground);
  background: var(--vscode-button-background);
  border: 1px solid transparent; padding: 3px 10px; border-radius: 3px; cursor: pointer;
  transition: background .12s ease;
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
button:disabled { opacity: .55; cursor: default; }
button:disabled:hover { background: var(--vscode-button-background); }
/* 次要操作改成描边：工具栏里通常只有一个主动作，实心色块不该五六个并排 */
button.secondary {
  color: var(--vscode-button-secondaryForeground);
  background: transparent;
  border-color: color-mix(in srgb, var(--vscode-editor-foreground) 24%, transparent);
}
button.secondary:hover {
  background: var(--vscode-button-secondaryBackground);
  border-color: color-mix(in srgb, var(--vscode-editor-foreground) 40%, transparent);
}
`;
