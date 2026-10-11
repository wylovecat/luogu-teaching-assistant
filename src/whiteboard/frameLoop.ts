/**
 * 重绘节流器（纯逻辑，不碰 DOM，便于测试）。
 *
 * 它把「每帧至多画一次」和「回调被丢掉也要能恢复」这两件事放在一起。
 *
 * 为什么必须有兜底：webview 被挂起/冻结时（切走标签页、窗口被遮挡、页面被 Page Lifecycle
 * 冻结），Chromium **可能直接丢弃排队中的 rAF 回调**。如果只用 `pending` 当闩，回调没回来闩就
 * 永远合不上，之后每次重绘都被挡掉 —— 画布冻在最后一帧，新笔迹再也不出现，而 DOM 里的题面
 * 一切正常，看起来正是「笔迹偶发不显示」。这里让「正常帧」和「兜底超时」两条路都能开闩，
 * 任一条走到就恢复。
 */

/** 兜底等待时间：正常帧早就该画完了，超过这个时间说明回调被丢了 */
export const WATCHDOG_MS = 500;

export interface FrameScheduler {
  request(cb: () => void): number;
  cancel(id: number): void;
  timeout(cb: () => void, ms: number): number;
  clear(id: number): void;
}

export class FrameLoop {
  private requestId: number | null = null;
  private watchdogId: number | null = null;
  private stalled = false;

  constructor(
    private readonly draw: () => void,
    private readonly scheduler: FrameScheduler,
    /** 第一次走到兜底时回调一次（用来上报「丢过帧」，方便排查） */
    private readonly onStall: (() => void) | undefined,
  ) {}

  /** 排队一次重绘；已经排了就什么都不做（合并成每帧一次） */
  schedule(): void {
    if (this.requestId !== null) return;
    this.requestId = this.scheduler.request(() => this.runFrame());
    this.watchdogId = this.scheduler.timeout(() => this.runWatchdog(), WATCHDOG_MS);
  }

  /** 立刻画（丢掉排队中的那一帧）：用在「一笔画完」这类提交点，不依赖动画帧还活着 */
  flush(): void {
    if (this.requestId !== null) {
      this.scheduler.cancel(this.requestId);
      this.requestId = null;
    }
    this.clearWatchdog();
    this.draw();
  }

  private runFrame(): void {
    this.requestId = null;
    this.clearWatchdog();
    this.draw();
  }

  private runWatchdog(): void {
    this.watchdogId = null;
    if (this.requestId === null) return; // 正常帧画过了
    this.scheduler.cancel(this.requestId);
    this.requestId = null;
    this.draw();
    if (!this.stalled) {
      this.stalled = true;
      this.onStall?.();
    }
  }

  private clearWatchdog(): void {
    if (this.watchdogId === null) return;
    this.scheduler.clear(this.watchdogId);
    this.watchdogId = null;
  }
}
