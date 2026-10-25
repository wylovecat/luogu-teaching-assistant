/**
 * 测试用的 vscode 模块替身。
 *
 * 被测模块（config/judge/compile 等）只在函数内使用 vscode API，
 * 唯一的模块级调用是 config.ts 里的 createOutputChannel —— 这里返回一个
 * 丢弃全部输出的假通道即可。
 */

const noop = (): void => {};

/** 测试可覆盖配置项；未覆盖时回落到调用方给的默认值。 */
const configOverrides = new Map<string, unknown>();
export function setConfigOverride(key: string, value: unknown): void {
  configOverrides.set(key, value);
}
export function resetConfigOverrides(): void {
  configOverrides.clear();
}

/**
 * `inspect()` 的模拟值。
 *
 * 只支持产品代码真正读的那几个字段（`config.ts` 的 `updateImageFontSize` /
 * `updateEditorFontSize` 靠它们决定「写哪一层」）。语言专属层用 `key@<languageId>`
 * 作为 map 的键来区分 —— 与真实 API 的 `languageIds` / `*LanguageValue` 语义对齐。
 */
export interface ConfigInspect {
  defaultValue?: unknown;
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
  workspaceLanguageValue?: unknown;
  workspaceFolderLanguageValue?: unknown;
  globalLanguageValue?: unknown;
  defaultLanguageValue?: unknown;
  /** 哪些语言有专属值（真实 API 里是 `inspect()` 返回的 `languageIds`） */
  languageIds?: string[];
}

const configInspects = new Map<string, ConfigInspect>();
export function setConfigInspect(key: string, insp: ConfigInspect): void {
  configInspects.set(key, insp);
}
export function resetConfigInspects(): void {
  configInspects.clear();
}

/** 记录每一次 `update()` 调用（section / key / 值 / 目标层 / 是否语言专属）。 */
export interface ConfigWrite {
  section: string;
  key: string;
  value: unknown;
  target: string;
  overrideInLanguage?: boolean;
}
const configWrites: ConfigWrite[] = [];
export function getConfigWrites(): ConfigWrite[] {
  return configWrites;
}
export function resetConfigWrites(): void {
  configWrites.length = 0;
}

/** 让某个目标层的 `update()` 抛错（模拟「单文件夹工作区写 WorkspaceFolder 会抛」）。 */
const configUpdateFailures = new Set<string>();
export function setConfigUpdateFailure(target: string): void {
  configUpdateFailures.add(target);
}
export function resetConfigUpdateFailures(): void {
  configUpdateFailures.clear();
}

/** 配置层级的名字（真实 API 里是 `ConfigurationTarget` 枚举，这里记名字便于断言）。 */
export const ConfigurationTarget = {
  Global: 1,
  Workspace: 2,
  WorkspaceFolder: 3,
} as const;

const TARGET_NAMES: Record<number, string> = {
  1: "Global",
  2: "Workspace",
  3: "WorkspaceFolder",
};

/** 当前活动编辑器（`updateEditorFontSize` 要读它的 languageId）。 */
let activeEditor: { document: { languageId: string } } | undefined;
export function setActiveTextEditor(doc: { document: { languageId: string } } | undefined): void {
  activeEditor = doc;
}

function channel(): unknown {
  return { appendLine: noop, append: noop, show: noop, hide: noop, dispose: noop, clear: noop, replace: noop };
}

/**
 * 测试可接管的 createWebviewPanel：面板类模块（题面面板等）只有在 show 时才会调用它，
 * 所以不需要默认实现 —— 没接管就抛，避免测试里悄悄拿到一个假面板还以为通过了。
 */
let panelFactory: ((viewType: string, title: string) => unknown) | undefined;
export function setWebviewPanelFactory(f: ((viewType: string, title: string) => unknown) | undefined): void {
  panelFactory = f;
}

export const window = {
  createOutputChannel: channel,
  createWebviewPanel: (viewType: string, title: string): unknown => {
    if (!panelFactory) throw new Error("测试里没有接管 createWebviewPanel（setWebviewPanelFactory）");
    return panelFactory(viewType, title);
  },
  showErrorMessage: noop,
  showWarningMessage: noop,
  showInformationMessage: noop,
  showInputBox: noop,
  showQuickPick: noop,
  showSaveDialog: noop,
  withProgress: noop,
  createTerminal: () => ({ show: noop, sendText: noop, dispose: noop }),
  onDidChangeActiveTextEditor: () => ({ dispose: noop }),
  get activeTextEditor(): { document: { languageId: string } } | undefined {
    return activeEditor;
  },
};

/**
 * `getConfiguration(section, scope)`。
 *
 * 注意 `get` 的键**不带 section 前缀**（历史如此：`cfg()` 是 `getConfiguration("lgAssist")`，
 * 但覆盖时用的是 `"whiteboard.stabilize"` 这样的短键）。`inspect` 与 `get` 保持同一套键。
 * 第二参 `scope` 只用来分辨「语言专属层」（`{ languageId }`）。
 */
export const workspace = {
  getConfiguration: (section?: string, scope?: unknown) => ({
    // get(key, defaultValue)：测试覆盖优先，否则用调用方默认值（即插件默认档）
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      configOverrides.has(key) ? (configOverrides.get(key) as T) : defaultValue,
    inspect: <T>(key: string) => {
      const languageId =
        scope && typeof scope === "object" && "languageId" in scope
          ? String((scope as { languageId: unknown }).languageId)
          : undefined;
      const base = configInspects.get(key) ?? {};
      const lang = languageId ? configInspects.get(`${key}@${languageId}`) : undefined;
      return {
        key,
        defaultValue: base.defaultValue as T | undefined,
        // 分层给值：语言专属的字段与通用字段**不混**（真实 API 也是分开的，
        // `workspaceValue` 永远是工作区层的值，语言专属另走 `*LanguageValue`）。
        globalValue: base.globalValue as T | undefined,
        workspaceValue: base.workspaceValue as T | undefined,
        workspaceFolderValue: base.workspaceFolderValue as T | undefined,
        workspaceLanguageValue: (lang?.workspaceLanguageValue ?? base.workspaceLanguageValue) as
          | T
          | undefined,
        workspaceFolderLanguageValue: (lang?.workspaceFolderLanguageValue ??
          base.workspaceFolderLanguageValue) as T | undefined,
        globalLanguageValue: (lang?.globalLanguageValue ?? base.globalLanguageValue) as T | undefined,
        defaultLanguageValue: lang?.defaultLanguageValue as T | undefined,
        languageIds: base.languageIds ?? [],
      };
    },
    update: async (
      key: string,
      value: unknown,
      target: number,
      overrideInLanguage?: boolean,
    ): Promise<void> => {
      const name = TARGET_NAMES[target] ?? String(target);
      if (configUpdateFailures.has(name)) throw new Error(`模拟写入失败：${name}`);
      configWrites.push({ section: section ?? "", key, value, target: name, overrideInLanguage });
    },
  }),
  workspaceFolders: undefined as unknown,
  getWorkspaceFolder: () => undefined,
  onDidChangeConfiguration: () => ({ dispose: noop }),
};

export const commands = { registerCommand: () => ({ dispose: noop }), executeCommand: noop };

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  readonly event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: noop };
  };
  fire(value: T): void {
    for (const l of this.listeners) l(value);
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class TreeItem {
  constructor(
    public label: string,
    public collapsibleState?: number,
  ) {}
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export class ThemeIcon {
  constructor(public id: string) {}
}

export class StatusBarAlignment {
  static Left = 1;
  static Right = 2;
}

export class Uri {
  constructor(public fsPath: string) {}
  static file(p: string): Uri {
    return new Uri(p);
  }
  static parse(p: string): Uri {
    return new Uri(p);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    return new Uri([base.fsPath, ...parts].join("/"));
  }
}

export const ViewColumn = { Active: -1, Beside: -2, One: 1 };
export const ProgressLocation = { Notification: 15, Window: 10 };
export const env = { clipboard: { writeText: noop }, openExternal: noop };
export const extensions = { getExtension: () => undefined };
export class CancellationTokenSource {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: noop }) };
  cancel(): void {
    this.token.isCancellationRequested = true;
  }
  dispose(): void {}
}
export const Disposable = { from: () => ({ dispose: noop }) };
