/**
 * App 与各域控制器共用的依赖与类型。
 *
 * App 本身只是一层「命令编排」的 façade（extension.ts 注册的命令都挂在它上面），
 * 真正的流程按域拆在同目录下的几个控制器里：judge（编译评测）、problems（建题与题面）、
 * board（白板）、submit（提交）、imageExport（代码图片）。
 *
 * 控制器之间**不互相 import**，跨域调用一律回到 App（见 base.ts 的 `PeerHost`），
 * 免得这些流程长出一堆环形依赖。共享的依赖与常量都放这里。
 */

import type * as vscode from "vscode";
import type { SessionManager } from "../luogu/session";
import type { ProblemLinkStore } from "../problems/link";
import type { SidebarProvider } from "../ui/sidebar";

/** 上次导出图片保存到的目录（全局记住，跨工作区也能接着往同一个讲义目录导）。 */
export const LAST_EXPORT_DIR_KEY = "lgAssist.lastExportDir";

/** 一键编译运行/提交等命令认的源文件后缀。 */
export const CPP_EXT = /\.(cpp|cc|cxx|c)$/i;

/** 构造 App 时注入的那几样东西，所有域共用同一份（别在控制器里另存一份，状态必须一致）。 */
export interface AppDeps {
  readonly context: vscode.ExtensionContext;
  readonly session: SessionManager;
  readonly links: ProblemLinkStore;
  readonly sidebar: SidebarProvider;
  readonly status: vscode.StatusBarItem;
}