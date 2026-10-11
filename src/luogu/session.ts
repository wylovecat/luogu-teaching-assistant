import * as vscode from "vscode";
import { output } from "../config";
import { csrfFromCookie, isLoggedInCookie, parseCookieInput } from "./contract";
import { LuoguClient, LuoguError, type LuoguSession } from "./client";

/**
 * 会话管理。
 *
 * 洛谷登录带验证码/滑块，扩展里没法自动完成，所以**不做账号密码登录，也没有静默重登**：
 * 用户在浏览器里登录后，把请求头里的整段 Cookie 粘进来（`Cookie: ...` 那一行）。
 * 扩展只做一件事：拿这段 Cookie 去探一次用户信息，确认真的能用。
 *
 * **安全约束**：Cookie 就是会话凭据，只进 VSCode `SecretStorage`，绝不写 globalState /
 * workspaceState / 任何文件。`restore()` 启动时把它读回来探活，探不通就删掉并要求重粘。
 */
const COOKIE_KEY = "lgAssist.cookie";

export class SessionManager {
  readonly client: LuoguClient;
  private session: LuoguSession | null = null;
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly secrets: vscode.SecretStorage) {
    this.client = new LuoguClient({
      onAuthExpired: () => this.onAuthExpired(),
      // 站点原文诊断走输出面板：`/record/<rid>` 只能靠一次真机提交核对，
      // 打出来是核对它的唯一凭据
      onDebug: (msg) => output.appendLine(msg),
    });
  }

  get current(): LuoguSession | null {
    return this.session;
  }

  isLoggedIn(): boolean {
    return this.session !== null;
  }

  /** 已登录的洛谷用户名（侧边栏显示用）。 */
  savedAccount(): string {
    return this.session?.uname ?? "";
  }

  /** 启动时恢复登录态：拿存的 Cookie 探一次活。探不通就清掉，等用户重粘。 */
  async restore(): Promise<boolean> {
    const cookie = await this.secrets.get(COOKIE_KEY);
    if (!cookie) return false;
    const tentative = this.sessionOf(cookie);
    if (!tentative) {
      output.appendLine("[登录] 存的 Cookie 里没有 _uid / __client_id，已丢弃，请重新登录");
      await this.secrets.delete(COOKIE_KEY);
      return false;
    }
    this.client.setSession(tentative);
    try {
      const session = await this.confirm(tentative);
      this.session = session;
      this.client.setSession(session);
      output.appendLine(`[登录] 已恢复 ${session.uname} 的登录态`);
      this.emitter.fire();
      return true;
    } catch (e) {
      this.session = null;
      this.client.setSession(null);
      await this.secrets.delete(COOKIE_KEY);
      output.appendLine(`[登录] 保存的 Cookie 已失效：${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** 导入用户在浏览器里复制的 Cookie；先探活，通不过就把原文错误抛给调用方显示。 */
  async importCookie(cookie: string): Promise<LuoguSession> {
    const tentative = this.sessionOf(cookie);
    if (!tentative) {
      throw new LuoguError(
        "这段 Cookie 里没找到 `_uid` 或 `__client_id`，不像洛谷的登录态。\n" +
          "取法：浏览器登录洛谷后按 F12 →「网络」面板 → 点任意一条 luogu.com.cn 的请求 → " +
          "「请求标头」里的 `Cookie:`。整段复制过来即可，**分段粘、换行、多个 Cookie 堆在一起都能认**。",
      );
    }
    // 先探活再落盘：探不通的 Cookie 不该留在密钥库里
    this.client.setSession(tentative);
    let session: LuoguSession;
    try {
      session = await this.confirm(tentative);
    } catch (e) {
      this.client.setSession(null);
      throw e;
    }
    this.session = session;
    this.client.setSession(session);
    await this.secrets.store(COOKIE_KEY, cookie);
    output.appendLine(`[登录] 成功：${session.uname}（uid ${session.uid}）`);
    this.emitter.fire();
    return session;
  }

  async logout(): Promise<void> {
    this.session = null;
    this.client.setSession(null);
    await this.secrets.delete(COOKIE_KEY);
    output.appendLine("[登录] 已退出登录（本地 Cookie 已清除）");
    this.emitter.fire();
  }

  /** 从 Cookie 串拼一个待验证的会话（uid/uname 先空着，探活后补）。 */
  private sessionOf(cookie: string): LuoguSession | null {
    // 用户粘来的 Cookie 形状五花八门（整条请求头 / 一段一段 / 带折行），
    // 先归一化再往下走，别在「格式对不对」上把人挡在门外。
    const { header } = parseCookieInput(cookie);
    if (!isLoggedInCookie(header)) return null;
    return { cookie: header, csrfToken: csrfFromCookie(header), uid: 0, uname: "" };
  }

  private async confirm(session: LuoguSession): Promise<LuoguSession> {
    const user = await this.client.probe();
    return { ...session, uid: user.uid, uname: user.uname };
  }

  /**
   * 站点说登录态没了：就地清干净并通知界面。
   * 客户端是在请求里同步回调进来的，这里只做「清状态 + 通知」，不做重新登录 ——
   * 洛谷这套装不下静默重登（见文件头注释）。
   */
  private onAuthExpired(): void {
    if (!this.session) return;
    this.session = null;
    this.client.setSession(null);
    void this.secrets.delete(COOKIE_KEY);
    output.appendLine("[登录] 洛谷 Cookie 已过期，请重新登录并粘贴新的 Cookie");
    this.emitter.fire();
  }
}