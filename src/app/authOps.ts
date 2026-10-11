/**
 * 登录态与错误上报：只依赖 `AppDeps` 的操作，控制器与 App 都用同一份。
 *
 * 单独成文件是为了让「控制器 → 登录 → 控制器」不成环：登录会触发 `updateStatus`，
 * 而每个域的命令入口都要先 `requireLogin`。
 */

import * as vscode from "vscode";
import { luoguConfig, output } from "../config";
import { LuoguError } from "../luogu/client";
import type { AppDeps } from "./deps";

/** 任何异常对象取可读文案（LuoguError 的文案通常是站点返回的业务错误）。 */
export function messageOf(e: unknown): string {
  if (e instanceof LuoguError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** 状态栏显示登录状态。 */
export function updateStatus(deps: AppDeps): void {
  const s = deps.session.current;
  if (s) {
    deps.status.text = `$(account) 洛谷:${s.uname}`;
    deps.status.tooltip = `已登录洛谷 ${s.uname}（uid ${s.uid}）`;
    deps.status.command = "lgAssist.logout";
    deps.status.show();
  } else {
    deps.status.text = "$(account) 洛谷:未登录";
    deps.status.tooltip = "点击登录洛谷账号";
    deps.status.command = "lgAssist.login";
    deps.status.show();
  }
}

/**
 * 登录：洛谷登录带验证码，扩展里做不了，所以走「浏览器登录 → 粘贴 Cookie」。
 *
 * 流程刻意做成三步而不是一条输入框：用户第一次用大概率不知道 Cookie 从哪来，
 * 打开页面 + 说清复制位置，比一个光秃秃的输入框有用得多。
 */
export async function login(deps: AppDeps): Promise<void> {
  await vscode.env.openExternal(vscode.Uri.parse(`${luoguConfig().baseUrl}/auth/login`));
  const go = await vscode.window.showInformationMessage(
    "已打开洛谷登录页。请在浏览器里登录成功，然后回到这里把浏览器的 Cookie 粘贴进来。",
    { modal: true, detail: "取 Cookie：浏览器按 F12 打开开发者工具 →「网络」面板 → 刷新页面 → 点任意一条请求 →「请求标头」里的 `Cookie:` 那一行，整行复制（值，不带 `Cookie:` 这个词）。" },
    "粘贴 Cookie",
  );
  if (go !== "粘贴 Cookie") return;

  const cookie = await vscode.window.showInputBox({
    title: "登录洛谷",
    prompt: "粘贴浏览器里的整段 Cookie",
    placeHolder: "_uid=123456; csrf_token=abcdef; …",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return "Cookie 不能为空";
      if (!t.includes("=")) return "这不像一段 Cookie，应该形如 `key=value; key=value`";
      return undefined;
    },
  });
  if (!cookie) return;

  try {
    const s = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "正在校验洛谷登录态…" },
      () => deps.session.importCookie(cookie.trim()),
    );
    updateStatus(deps);
    deps.sidebar.refresh();
    void vscode.window.showInformationMessage(`已登录洛谷：${s.uname}`);
  } catch (e) {
    reportError(deps, "登录失败", e);
  }
}

export async function logout(deps: AppDeps): Promise<void> {
  const pick = await vscode.window.showWarningMessage("确定退出洛谷登录吗？", { modal: true }, "退出登录");
  if (pick !== "退出登录") return;
  await deps.session.logout();
  updateStatus(deps);
  deps.sidebar.refresh();
}

/** 命令前置检查：没登录就弹一次提示（带「登录」按钮），返回 false 让调用方直接收手。 */
export function requireLogin(deps: AppDeps): boolean {
  if (deps.session.isLoggedIn()) return true;
  void vscode.window
    .showWarningMessage("该操作需要先登录洛谷账号", "登录")
    .then((pick) => (pick === "登录" ? login(deps) : undefined));
  return false;
}

/**
 * 统一的错误上报：记输出面板，登录态过期时额外引导重新登录。
 * 洛谷 Cookie 过期（LuoguError.authExpired）是最常见的失败原因，各域的 catch 都走这里。
 */
export function reportError(deps: AppDeps, prefix: string, e: unknown): void {
  const msg = messageOf(e);
  output.appendLine(`[错误] ${prefix}：${msg}`);
  if (e instanceof LuoguError && e.authExpired) {
    updateStatus(deps);
    deps.sidebar.refresh();
    void vscode.window.showErrorMessage(`${prefix}：${msg}`, "重新登录").then((pick) => {
      if (pick === "重新登录") void login(deps);
    });
    return;
  }
  void vscode.window.showErrorMessage(`${prefix}：${msg}`);
}