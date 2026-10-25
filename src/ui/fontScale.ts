/**
 * 题面预览面板的**正文字号缩放**：常量与清洗。
 *
 * 纯逻辑模块，**不许 import 'vscode'**（同 src/ui/layout.ts、src/ui/theme.ts 的约定）：
 * 它被 test/ 直接引用，混进 vscode 依赖会让单元测试整体跑不起来。
 *
 * 这个缩放**只作用于题面预览面板**（src/ui/statementPanel.ts）。白板与题解 PDF 有各自
 * 固定的字号（`SHEET_RULES` / `banshuconf.typ`），不受这里影响 —— 别把缩放"顺手"传导到导出。
 */

/** 字号缩放落盘的 globalState 键。全局偏好（跨工作区/跨重启），不是设置项。 */
export const FONT_SCALE_KEY = "lgAssist.statement.fontScale";

/** 默认档：1 = 跟今天完全一致（不改变开箱行为，用户不点就一切照旧）。 */
export const DEFAULT_FONT_SCALE = 1;
/** 下限：投影仪上偶尔想缩小、一屏塞更多。base ≈ 13px → ≈ 9px。 */
export const FONT_SCALE_MIN = 0.7;
/** 上限：base ≈ 13px → ≈ 26px，投影够读。 */
export const FONT_SCALE_MAX = 2;
/** 每次点 +/- 的步进。 */
export const FONT_SCALE_STEP = 0.1;

/**
 * 字号缩放清洗：非有限值（NaN/Infinity，含 globalState 里的脏值）回落默认档，
 * 其余夹到合法区间并规整到一位小数 —— 免得 0.1 累加出 1.3000000000000003 这种尾数。
 * （范式抄 src/whiteboard/model.ts 的 clampExportDpi。）
 */
export function clampFontScale(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_FONT_SCALE;
  return Math.min(FONT_SCALE_MAX, Math.max(FONT_SCALE_MIN, Math.round(n * 10) / 10));
}
