/**
 * 「代码源文件」的字号 —— 纯逻辑模块，被 `test/` 直接引用（所以不许 import 'vscode'）。
 *
 * **别和 `imgexport/codeFont.ts` 搞混**：那个管**导出 PNG** 里的字号，这个管你正在看、
 * 正在改的那个 VS Code 编辑器（写的是 VS Code 自己的 `editor.fontSize`）。
 * 两者的档位、上下限互不相干，不要为了「统一」把它们合并 —— 一张图能接受 8px 的小字，
 * 屏幕上没人愿意这么看。
 */

/** VS Code 自己 `editor.fontSize` 的默认值（没写过这个设置时按它起身）。 */
export const DEFAULT_EDITOR_FONT_PX = 14;
/** 下限：再小就不是看不清的问题了，是看不清。 */
export const MIN_EDITOR_FONT_PX = 8;
/** 上限：投影用得上，但再大一行就放不下几个字符了。 */
export const MAX_EDITOR_FONT_PX = 40;
/** 一次 A＋/A− 走几 px。1px 太肉（14 调到 40 要按 26 下），2px 一档更跟手。 */
export const EDITOR_FONT_STEP_PX = 2;

/** 清洗：非有限值回落默认值，其余取整并夹到区间（设置项里手写 60 也不会把窗口撑爆）。 */
export function clampEditorFontPx(px: unknown): number {
  const n = typeof px === "number" ? px : Number(px);
  if (!Number.isFinite(n)) return DEFAULT_EDITOR_FONT_PX;
  return Math.min(MAX_EDITOR_FONT_PX, Math.max(MIN_EDITOR_FONT_PX, Math.round(n)));
}

/**
 * 上/下一档（`dir > 0` 调大）。
 *
 * 从**当前实际值**起身（老师可能自己在设置里写过 13px 或 18px），按步长走一步再夹回来；
 * 已经贴着端点就停在端点 —— 调用方用 `next === current` 判断「到头了」并给一句提示。
 */
export function stepEditorFontPx(current: unknown, dir: number): number {
  const now = clampEditorFontPx(current);
  if (dir > 0) return Math.min(MAX_EDITOR_FONT_PX, now + EDITOR_FONT_STEP_PX);
  if (dir < 0) return Math.max(MIN_EDITOR_FONT_PX, now - EDITOR_FONT_STEP_PX);
  return now;
}

/** 状态栏一闪而过的提示（`setStatusBarMessage` 用，不进通知中心）。 */
export function editorFontHint(px: number): string {
  return `代码字号 ${clampEditorFontPx(px)}px（Ctrl+Alt+= 放大 / Ctrl+Alt+- 缩小）`;
}
