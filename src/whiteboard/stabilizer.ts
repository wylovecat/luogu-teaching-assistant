/**
 * 笔迹稳定器（纯逻辑：不碰 DOM、不 import vscode —— 它被 `src/whiteboard/webview.ts` 与 `test/` 同时引用，
 * 混进 vscode 依赖会让单元测试整体跑不起来，同 frameLoop.ts / model.ts 的约定）。
 *
 * 干什么用：数位笔的原始事件里混着手抖与板子的量化噪声，直接喂给 perfect-freehand 就是「线条发毛、
 * 慢写时有锯齿」。这一层把它做成**输入滤波器**（思路抄 Xournal++ 的
 * `src/core/control/tools/StrokeStabilizer.h`，参数按我们的坐标系重新标），而不是去改渲染，于是：
 * ① 已经提交的笔迹不会被重新抹过（老师当时写下的形状就是最终形状，导出也不变）；
 * ② 关掉之后与「不装这一层」逐点相同。
 *
 * 三条别推翻的取舍：
 * ① **默认关**（设置项 `lgAssist.whiteboard.stabilize`）。任何平均都会让落墨滞后于笔尖约
 *   `buffer/2` 个事件；真机验证过的手感不能被用户不知道地改掉，所以只能他主动开。
 * ② **死区必须配尖角检测**（`cusp`）。笔尖一折返（顿笔、写字的拐角）就把方向翻转那一小段
 *   原样交出去，否则死区半径会把转角抹圆 —— 那正是讲题时要圈的「这里要开 long long」。
 * ③ **收笔必须补到最后那个原始事件**（`tail()`）。滤波器天然滞后，抬笔时不补这一段，
 *   每一笔的尾巴上都会留一个可见的缺口（写「1」和写「7」的最后一挑最先看出来）。
 *   补的是**二次样条**不是直线：直线甩过去会在笔尾出现一个硬折角，正好抵消了这一层的意义。
 *
 * 坐标系无关：传进来的 x/y 与 deadzone 是同一套单位。webview 侧按**屏幕像素**喂（手抖的幅度
 * 与缩放无关，放大到 4 倍再写，纸上抖动的世界坐标反而变大），所以这里一个像素都不认。
 */

/** 稳定器强度档（与设置项的 enum 一字不差） */
export type StabilizeLevel = "off" | "light" | "medium" | "strong";

export const STABILIZE_LEVELS: readonly StabilizeLevel[] = ["off", "light", "medium", "strong"];

/** 缺省档：关。见文件头取舍 ① */
export const DEFAULT_STABILIZE_LEVEL: StabilizeLevel = "off";

/** 脏值（改坏的 settings.json、别的版本写进来的字符串）一律退回缺省档，不猜 */
export function clampStabilize(v: unknown): StabilizeLevel {
  return (STABILIZE_LEVELS as readonly string[]).includes(String(v))
    ? (v as StabilizeLevel)
    : DEFAULT_STABILIZE_LEVEL;
}

export interface StabilizeParams {
  /** 参与算术平均的点数（含刚进来的这个）。1 = 不平均 */
  buffer: number;
  /** 死区半径（输入坐标系）。0 = 不判死区 */
  deadzone: number;
  /** 尖角检测：方向翻转时把拐角原样交出去 */
  cusp: boolean;
  /** 收笔补样的段数。0 = 不补 */
  tail: number;
}

/**
 * 各档参数。
 *
 * 长度单位是**屏幕像素**（light 的死区 1.8px ≈ 手写抖动的量级，再大就开始削字形）。
 * buffer 给得比直觉小：每多一点就是一个事件的滞后，`strong` 的 8 已经是「写快了能看出墨在后面」，
 * 不能再往上涨。Xournal++ 出厂把 buffer 设成 20 是因为它的死区会在手停住时把缓冲整片重填成同一点
 * （所以不滞后），照抄那个数字没有意义。
 */
const PARAMS: Record<StabilizeLevel, StabilizeParams> = {
  off: { buffer: 1, deadzone: 0, cusp: false, tail: 0 },
  light: { buffer: 3, deadzone: 1.8, cusp: true, tail: 4 },
  medium: { buffer: 5, deadzone: 3.5, cusp: true, tail: 5 },
  strong: { buffer: 8, deadzone: 6, cusp: true, tail: 6 },
};

export function stabilizeParams(level: StabilizeLevel): StabilizeParams {
  return PARAMS[level];
}

/** 这一档到底要不要挂滤波器（off 档 webview 干脆不创建实例，一条 pointermove 都不多跑） */
export function stabilizeEnabled(level: StabilizeLevel): boolean {
  return level !== "off";
}

/** 一个输入/输出点：x、y、压力（压力跟着一起滤，否则抖动的压感会把线条画成毛毛虫） */
export type StabilizedPoint = [number, number, number];

/** 二次 Bézier 在 t 处的坐标（收笔补尾用） */
function quadBezier(a: number, q: number, c: number, t: number): number {
  const u = 1 - t;
  return u * u * a + 2 * u * t * q + t * t * c;
}

function samePoint(a: StabilizedPoint, b: StabilizedPoint): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * 一条笔画一个实例（`startStroke` 时 new、`finishStroke` 时丢弃）。
 *
 * 不做成长期对象是因为状态必须逐笔清零：上一笔的滞后不能带进这一笔的开头。
 */
export class StrokeStabilizer {
  /** 参与平均的最近若干点，最新在前 */
  private buf: StabilizedPoint[];
  /** 上一次交出去的点（死区的圆心） */
  private painted: StabilizedPoint;
  /** 再上上一次交出去的点：收笔补样要拿它当切线方向 */
  private prev: StabilizedPoint | null = null;
  /** 死区外最近的一个**原始**点 —— 尖角的顶点 */
  private live: StabilizedPoint;
  /** 死区外最近一次的移动方向（判方向翻转用） */
  private dir: [number, number] = [0, 0];
  /** 最后一个原始事件（收笔要补到它，不然笔尾缺一段） */
  private raw: StabilizedPoint;

  constructor(private readonly params: StabilizeParams, first: StabilizedPoint) {
    this.painted = first;
    this.live = first;
    this.raw = first;
    // 缓冲整片填成落点（Xournal++ 的 CircularBuffer::assign）：开头几个事件的平均不会把笔尖
    // 一下子拽到远处，而是从落点平滑起步。
    this.buf = this.fill(first);
  }

  /**
   * 喂一个原始事件，返回**这一拍要追加到笔画上的点**（0 / 1 / 2 个）。
   *
   * 返回空数组就是「这一拍什么都不画」：事件落在死区里（手抖），或者被平均吃掉了。
   * 返回两个只发生在尖角那一支：先把拐角顶点交出去，再退回死区边缘。
   */
  next(ev: StabilizedPoint): StabilizedPoint[] {
    this.raw = ev;
    const { buffer, deadzone, cusp } = this.params;

    // off 档（buffer 1 且不判死区）：原样交出，与不挂这一层逐点相同
    if (buffer <= 1 && deadzone <= 0) return [ev];

    const mv: [number, number] = [ev[0] - this.painted[0], ev[1] - this.painted[1]];
    const moved = Math.hypot(mv[0], mv[1]);

    if (deadzone > 0 && moved <= deadzone) {
      // 还在死区里：这一拍不画。缓冲整片重填成圆心，所以手一停住滞后立刻清零
      //（不然停在原地的手会把笔尖慢慢「追」过来，画出一个多余的小钩）。
      this.reset(this.painted);
      return [];
    }

    if (cusp && this.dir[0] * mv[0] + this.dir[1] * mv[1] < 0) {
      // 方向一翻转 = 尖角。把顶点原样交出去，再退回离当前事件 deadzone 的那一点继续画。
      const tip = this.live;
      // 折返后的前进方向：顶点 → 当前事件（**不是**反过来 —— 反了的话下一拍必然又被判成尖角，
      // 于是一个拐角连吐好几个顶点，比抹圆还糟）
      const ahead: [number, number] = [ev[0] - tip[0], ev[1] - tip[1]];
      const d = Math.hypot(ahead[0], ahead[1]);
      const k = d > 1e-9 ? Math.min(1, deadzone / d) : 1;
      const back: StabilizedPoint = [ev[0] - ahead[0] * k, ev[1] - ahead[1] * k, ev[2] * (1 - k) + tip[2] * k];
      this.dir = ahead;
      this.live = ev;
      const out: StabilizedPoint[] = [];
      if (!samePoint(tip, this.painted)) out.push(tip);
      // 缓冲整片重填：不重填的话，跨在拐角两侧的点一平均，角就被削圆了 —— 那正是这一支要避免的
      this.reset(back);
      this.emit(back, out);
      return out;
    }

    // 正常一支：把事件沿「圆心 → 事件」这条线拉回死区边缘，再和最近几个点一起平均
    const ratio = deadzone > 0 ? deadzone / moved : 0;
    const pulled: StabilizedPoint = [ev[0] - mv[0] * ratio, ev[1] - mv[1] * ratio, ev[2]];
    // `live` 是**沿当前方向最远**那个原始点（不是「最近一个」）：滤波器有滞后，笔尖已经开始折返的
    // 头一两个事件相对滞后的圆心还是「向前」的，照 Xournal++ 那样无条件覆盖就会把真正的顶点丢掉
    // —— 等到下一拍判出尖角时，交出去的是已经退回半途的那个点，拐角照样被啃掉一截。
    if (this.furthestAlong(ev)) this.live = ev;
    this.dir = mv;
    const out: StabilizedPoint[] = [];
    this.emit(pulled, out);
    return out;
  }

  /** 这个事件沿当前方向比 `live` 走得更远吗（方向还没建立起来时一律算更远） */
  private furthestAlong(ev: StabilizedPoint): boolean {
    const [dx, dy] = this.dir;
    const n = Math.hypot(dx, dy);
    if (n < 1e-9) return true;
    const ux = dx / n;
    const uy = dy / n;
    return (
      (ev[0] - this.painted[0]) * ux + (ev[1] - this.painted[1]) * uy >=
      (this.live[0] - this.painted[0]) * ux + (this.live[1] - this.painted[1]) * uy
    );
  }

  /**
   * 收笔：把最后一段滞后补上（二次样条，段数 = `params.tail`）。
   *
   * 切线方向用**最后两个已交出的点**，所以补出来的这一段是顺着笔迹自己的走向弯到原始终点的，
   * 不是硬连过去（硬连会在笔尾留一个硬折角）。压力做线性过渡，不去改动已经交出去的那些点。
   * 调过一次就把「要补的位置」清空，重复调用安全。
   */
  tail(): StabilizedPoint[] {
    const { tail } = this.params;
    const c = this.raw;
    const b = this.painted;
    if (tail <= 0) return [];
    const bc: [number, number] = [c[0] - b[0], c[1] - b[1]];
    const lenBC = Math.hypot(bc[0], bc[1]);
    this.raw = this.painted; // 一次性：第二次调用不再补
    if (lenBC < 1e-6) return [];
    const a = this.prev;
    if (!a) return [c]; // 只有一个点（点一下就抬笔）：直接交出终点，没有切线可谈
    const ab: [number, number] = [b[0] - a[0], b[1] - a[1]];
    const lenAB = Math.hypot(ab[0], ab[1]);
    if (lenAB < 1e-6) return [c];
    const dot = ab[0] * bc[0] + ab[1] * bc[1];
    // 控制臂长度：对称二次样条要的是 |BC|²·|AB| / (2·AB·BC)，再夹到不超过 |BC|
    //（dot 为 0 时那个除法是 Infinity，min 正好落在 lenBC 上，不用特判）
    const arm = Math.min(Math.abs((lenBC * lenBC * lenAB) / (2 * dot)), lenBC);
    const qx = b[0] + (ab[0] / lenAB) * arm;
    const qy = b[1] + (ab[1] / lenAB) * arm;
    const out: StabilizedPoint[] = [];
    for (let i = 1; i <= tail; i++) {
      const t = i / tail;
      out.push([quadBezier(b[0], qx, c[0], t), quadBezier(b[1], qy, c[1], t), b[2] + (c[2] - b[2]) * t]);
    }
    out[out.length - 1] = c; // 末点必须正好落在原始事件上（补的就是这一段滞后）
    return out;
  }

  /** 平均 + 更新内部状态，把结果塞进 out */
  private emit(pulled: StabilizedPoint, out: StabilizedPoint[]): void {
    this.buf.unshift(pulled);
    if (this.buf.length > this.params.buffer) this.buf.length = this.params.buffer;
    const n = this.buf.length;
    let sx = 0;
    let sy = 0;
    let sp = 0;
    for (const p of this.buf) {
      sx += p[0];
      sy += p[1];
      sp += p[2];
    }
    const avg: StabilizedPoint = [sx / n, sy / n, sp / n];
    this.prev = this.painted;
    this.painted = avg;
    out.push(avg);
  }

  /** 缓冲整片填成同一个点（手停住 / 过尖角之后都要清一次） */
  private fill(p: StabilizedPoint): StabilizedPoint[] {
    return Array.from({ length: Math.max(1, this.params.buffer) }, () => p);
  }

  private reset(p: StabilizedPoint): void {
    if (this.buf.length && samePoint(this.buf[this.buf.length - 1], p)) return;
    this.buf = this.fill(p);
  }
}
