/**
 * 代码图片的字号（纯逻辑，不 import 'vscode'）：被 test/ 直接引用。
 *
 * 代码图片是「按内容算尺寸」的位图（见 exportImage.ts）：字号直接决定行高与整幅图的宽高，
 * 所以这里管的是**像素字号本身**，不是白板那种相对倍率 —— 老师在投影上要的就是「14 号看不清，
 * 调到 18 号」。默认 14px 与引入本模块之前写死的值一致，不改设置时导出的图一模一样。
 */

/** 默认字号（px）：跟本模块出现之前写死的 14px 对齐，老用户升级后导出的图尺寸不变。 */
export const DEFAULT_CODE_FONT_PX = 14;
export const MIN_CODE_FONT_PX = 8;
export const MAX_CODE_FONT_PX = 32;

/**
 * 每点一次的步长。不是 1px：8~32 用 1px 要点二十多下，投影前调字号不该这么磨人；
 * 2px 也能落在默认档 14 上（14/16/18…与 14/12/10…），两侧端点由 clamp 兜住，不会有到不了的档。
 */
export const CODE_FONT_STEP_PX = 2;

/** 行高倍数（与历史上写死的 21px 行高一致：14 × 1.5 = 21）。 */
export const CODE_LINE_HEIGHT_RATIO = 1.5;

/**
 * 等宽字体表。顺序即优先级：打包进插件的环境里第一个装上的就是它，
 * 后面的只是兜底（换机器 / 系统没装 JetBrains Mono 时别退化成衬线体）。
 */
export const CODE_FONT_FAMILY = "'JetBrains Mono','Cascadia Code','Noto Sans Mono CJK SC',Consolas,monospace";

/** 字号清洗：非有限值回落默认档，其余夹到区间并取整。 */
export function clampCodeFontPx(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_CODE_FONT_PX;
  return Math.min(MAX_CODE_FONT_PX, Math.max(MIN_CODE_FONT_PX, Math.round(px)));
}

/** 上/下一档（dir > 0 调大）。到头就停在端点上，不会越界，也不会「点了没反应还提示成功」。 */
export function stepCodeFontPx(current: number, dir: number): number {
  const from = clampCodeFontPx(current);
  return clampCodeFontPx(from + (dir > 0 ? CODE_FONT_STEP_PX : -CODE_FONT_STEP_PX));
}

/** 某字号下的行高（px）。取整：canvas 上带小数的行高会让最后一行露出半截。 */
export function codeLineHeight(px: number): number {
  return Math.round(clampCodeFontPx(px) * CODE_LINE_HEIGHT_RATIO);
}

/** canvas 的 font 简写（字号 + 字体表）。 */
export function codeFontSpec(px: number): string {
  return `${clampCodeFontPx(px)}px ${CODE_FONT_FAMILY}`;
}

/**
 * 面板脚本用的那几行字号工具，从上面的常量生成后注入进 webview 脚本。
 *
 * 为什么不把字号逻辑在 webview 里重写一遍：那样「谁能改、改到多少」就有两份事实，
 * 迟早对不上（白板那边 SHEET_RULES 的踩坑同源）。这里的注入是唯一一处字符串复制，
 * test/codeFont.test.ts 钉住它和上面的常量一致。
 */
export function codeFontRuntime(): string {
  return `const FONT_FAMILY = ${JSON.stringify(CODE_FONT_FAMILY)};
const FONT_MIN = ${MIN_CODE_FONT_PX}, FONT_MAX = ${MAX_CODE_FONT_PX}, FONT_STEP = ${CODE_FONT_STEP_PX}, FONT_RATIO = ${CODE_LINE_HEIGHT_RATIO};
function clampFontPx(px) {
  if (!isFinite(px)) return ${DEFAULT_CODE_FONT_PX};
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}
function fontSpec(px) { return px + 'px ' + FONT_FAMILY; }
function lineHeight(px) { return Math.round(px * FONT_RATIO); }`;
}
