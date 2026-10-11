import * as path from "node:path";
import * as vscode from "vscode";
import { looksLikeProblemId, stemOf } from "../util";
import { workspaceRoot } from "./files";

/**
 * 文件 ↔ 题目关联。
 *
 * 洛谷的题号本身就是站点主键（题面地址 `/problem/P1001`），没有第二套内部 id 要换算，
 * 所以这里只记一个字符串题号就够 —— 比「题库行 id / 班测 tkId」那套简单得多。
 */
export interface ProblemRef {
  /** 洛谷题号，如 P1001 / CF1A / AT_abc001_a */
  displayId: string;
  title: string;
  /** 洛谷难度 0~7，题面面板上当来源标记显示；没有就 null */
  difficulty?: number | null;
}

const KEY = "lgAssist.problemLinks";

export class ProblemLinkStore {
  constructor(private readonly state: vscode.Memento) {}

  private all(): Record<string, ProblemRef> {
    return this.state.get<Record<string, ProblemRef>>(KEY, {});
  }

  private keyFor(filePath: string): string {
    const root = workspaceRoot();
    const abs = path.resolve(filePath);
    return root && abs.startsWith(root) ? path.relative(root, abs) : abs;
  }

  get(filePath: string): ProblemRef | null {
    const hit = this.all()[this.keyFor(filePath)];
    if (hit) return hit;
    // 兜底：文件名看起来就是题号（如 P1001.cpp），直接当题号用，省得先建关联。
    // 这条路径拿不到题名，题面面板上的标记会空着 —— 建一次关联就有了。
    const stem = stemOf(path.basename(filePath));
    if (looksLikeProblemId(stem)) {
      return { displayId: stem, title: "", difficulty: null };
    }
    return null;
  }

  async set(filePath: string, ref: ProblemRef): Promise<void> {
    const all = this.all();
    all[this.keyFor(filePath)] = ref;
    await this.state.update(KEY, all);
  }

  async forget(filePath: string): Promise<void> {
    const all = this.all();
    delete all[this.keyFor(filePath)];
    await this.state.update(KEY, all);
  }
}