/**
 * 上传到班级文件时的图片命名（纯逻辑，不 import 'vscode'）。
 *
 * 这里被 test/ 下的 node:test 直接引用，所以函数内不能碰任何 vscode API。
 */

/**
 * 题名开头的赛事/时间信息，整段带括号去掉：
 * `【2024年CSP-J第一轮】最大子段和` → `最大子段和`，`[NOIP2018] 铺设道路` → `铺设道路`。
 * 半角与全角方括号都认。
 */
const BRACKET_PREFIX = /^\s*(?:【[^】]*】|\[[^\]]*\]|［[^］]*］)\s*/;

/** 反复剥离开头的括号段；剥完只剩空白就返回空串（调用方负责兜底）。 */
export function stripEventPrefix(title: string): string {
  let text = title.trim();
  for (;;) {
    const next = text.replace(BRACKET_PREFIX, "").trim();
    if (next === text) return text;
    text = next;
  }
}

/**
 * 文件名里不能出现的字符（路径分隔符、Windows 保留符、控制字符）换成下划线。
 *
 * 名字会原样变成对象存储的对象键与站点列表里的文件名，出现 `/` 会被当成目录层级、
 * 出现 `?` 会把下载直链截断，所以这里必须收敛掉。
 */
export function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim();
}

/**
 * 上传时的默认图片文件名：`<题号>_<题名>_code.png`。
 *
 * 题名用剥掉前缀括号信息后的部分；剥完为空（题名整个就是 `【2024年CSP-J】`）时退回
 * 原题名，仍为空就只留题号——这一步就是「提取不对也能用」的兜底，用户还能在弹窗里手改。
 */
export function uploadImageName(displayId: string, title: string): string {
  const raw = sanitizeName(title);
  const stripped = sanitizeName(stripEventPrefix(title));
  const name = stripped || raw;
  const id = sanitizeName(displayId) || "题目";
  return `${id}${name ? `_${name}` : ""}_code.png`;
}
