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
};

export const workspace = {
  // get(key, defaultValue)：测试覆盖优先，否则用调用方默认值（即插件默认档）
  getConfiguration: () => ({
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      configOverrides.has(key) ? (configOverrides.get(key) as T) : defaultValue,
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
