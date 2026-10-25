/**
 * 笔迹稳定器 + 压感兜底的纯逻辑测试。
 *
 * 这一层管的是「手感」，而手感没法在 CI 里摸，所以断言全部对着**人造事件序列**打：
 * 手抖序列要被抹平、匀速直线不许画断、折返的尖角必须原样留下、抬笔时欠下的最后一段必须补齐。
 * 四条各自对应一种「用户会立刻看出来」的坏情况，缺任何一条都不如不开这层。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MOUSE_PRESSURE, clampPressure, penPressure } from "../src/whiteboard/model";
import {
  DEFAULT_STABILIZE_LEVEL,
  STABILIZE_LEVELS,
  StrokeStabilizer,
  clampStabilize,
  stabilizeEnabled,
  stabilizeParams,
  type StabilizedPoint,
} from "../src/whiteboard/stabilizer";

/** 跑一条序列：first 建实例，其余逐个喂；返回交出去的点（不含落点本身）与收笔补出来的尾巴 */
function run(level: (typeof STABILIZE_LEVELS)[number], first: StabilizedPoint, events: StabilizedPoint[]) {
  const st = new StrokeStabilizer(stabilizeParams(level), first);
  const out: StabilizedPoint[] = [];
  for (const ev of events) out.push(...st.next(ev));
  const tail = st.tail();
  return { out, tail, all: out.concat(tail) };
}

test("档位清洗：认不出的值一律算「关」", () => {
  for (const level of STABILIZE_LEVELS) assert.equal(clampStabilize(level), level);
  // 手改 settings.json 写错词、别的版本写进来的数字、载荷里干脆没这个键 —— 都落回缺省档。
  // 这一层会让落墨滞后于笔尖，所以「猜一个开着的档」是不能犯的错。
  for (const bad of [undefined, null, "", "FAST", "ON", 0, 3, {}, [], true]) {
    assert.equal(clampStabilize(bad), DEFAULT_STABILIZE_LEVEL, `${String(bad)} 应退回缺省档`);
  }
  assert.equal(DEFAULT_STABILIZE_LEVEL, "off", "缺省档必须是关");
});

test("off 档逐点原样交出，与不挂这一层完全相同", () => {
  assert.equal(stabilizeEnabled("off"), false);
  const events: StabilizedPoint[] = [
    [4, 1, 0.4],
    [8, 1, 0.6],
    [9, 1, 0], // 一次读不出压力的事件：滤波器不管压力，交给 pressureOf 那条路处理
  ];
  const { out, tail, all } = run("off", [0, 0, 0.5], events);
  assert.deepEqual(all, events, "off 档不许改动任何一个点");
  assert.equal(tail.length, 0, "off 档不补尾（没欠滞后）");
  assert.equal(out.length, events.length);
});

test("开了档位以后，越强的档缓冲与死区都更大", () => {
  const light = stabilizeParams("light");
  const medium = stabilizeParams("medium");
  const strong = stabilizeParams("strong");
  assert.ok(light.buffer < medium.buffer && medium.buffer < strong.buffer, "缓冲强度要单调");
  assert.ok(light.deadzone < medium.deadzone && medium.deadzone < strong.deadzone, "死区半径要单调");
  for (const p of [light, medium, strong]) {
    assert.ok(stabilizeEnabled(p === light ? "light" : p === medium ? "medium" : "strong"));
    assert.equal(p.cusp, true, "开启的档位一律带尖角检测：顿笔不能被抹圆");
    assert.ok(p.tail > 0, "开启的档位一律要补齐笔尾");
  }
});

test("手抖被抹平：原地抖一个点都不多交，慢写时抖动不落到笔迹上", () => {
  // ① 手撑在板子上抖（笔没有移动）：死区把整段吞掉，笔迹一个字都不该多
  const shake: StabilizedPoint[] = [];
  for (let i = 0; i < 30; i++) shake.push([0, i % 2 === 0 ? 1.2 : -1.2, 0.5]);
  const still = run("light", [0, 0, 0.5], shake);
  assert.equal(still.out.length, 0, "原地抖动不该画出任何东西");

  // ② 慢速前进 + 同样的抖动：线要画出来，但 y 上看不抖
  const crawl: StabilizedPoint[] = [];
  for (let i = 0; i < 30; i++) crawl.push([0.5 + i * 0.5, i % 2 === 0 ? 1.2 : -1.2, 0.5]);
  const moved = run("light", [0, 0, 0.5], crawl);
  assert.ok(moved.out.length > 0, "笔在走就要画出来，不能一概当成抖动吃掉");
  assert.ok(moved.out.length < crawl.length, `重复的点该被吃掉（交出 ${moved.out.length} / 输入 ${crawl.length}）`);
  const worstY = Math.max(...moved.out.map((p) => Math.abs(p[1])));
  assert.ok(worstY < 0.5, `y 上的抖要压住（最大偏离 ${worstY.toFixed(2)}，输入抖 ±1.2）`);
  // x 必须单调向前：滤波器不能把笔往回拽出毛刺
  for (let i = 1; i < moved.out.length; i++) {
    assert.ok(moved.out[i][0] > moved.out[i - 1][0], `第 ${i} 个点往回走了`);
  }
});

test("匀速直线不许画断：每个事件都走得比死区远时，逐拍都有输出", () => {
  const step = stabilizeParams("medium").deadzone * 2; // 明显超出死区，不该被判成抖动
  const events: StabilizedPoint[] = [];
  for (let i = 1; i <= 20; i++) events.push([i * step, 0, 0.5]);
  const { out } = run("medium", [0, 0, 0.5], events);
  assert.equal(out.length, events.length, "超出死区的匀速移动一个都不该丢");
});

test("尖角：笔尖折返时顶点原样交出去，拐角不被抹圆", () => {
  // 向上画四段，然后折回来 —— 「7」「1」的最后一挑、方框的转角都是这种动作
  const up: StabilizedPoint[] = [[0, 6, 0.5], [0, 12, 0.5], [0, 18, 0.5], [0, 24, 0.5]];
  const back: StabilizedPoint[] = [[0, 21, 0.5], [0, 16, 0.5], [0, 10, 0.5]];
  const { all } = run("light", [0, 0, 0.5], up.concat(back));
  const at = all.findIndex((p) => p[1] === 24);
  assert.ok(at >= 0, `折返顶点 y=24 必须出现在笔迹里（实际最到 ${Math.max(...all.map((p) => p[1]))}）`);
  const after = all.slice(at + 1);
  assert.ok(after.length >= 2, "过顶点之后还要接着往回画");
  // 顶点之后必须**单调往回**：判出尖角时若把方向记反（记成「回到顶点」而不是「离开顶点」），
  // 下一拍又会立刻误判一次尖角，同一个拐角连吐出好几个顶点，比抹圆更难看的多。
  for (let i = 0; i < Math.min(2, after.length); i++) {
    assert.ok(after[i][1] < 24, `过顶点后第 ${i + 1} 个点还停在顶点上（方向记反了）`);
    if (i > 0) assert.ok(after[i][1] <= after[i - 1][1], `过顶点后第 ${i + 1} 个点又朝顶点走回去了`);
  }
});

test("收笔补齐：尾巴正好落在最后一个原始事件上", () => {
  const events: StabilizedPoint[] = [];
  for (let i = 1; i <= 12; i++) events.push([i * 5, i * 2, 0.5]);
  const last = events[events.length - 1];
  const { out, tail } = run("light", [0, 0, 0.5], events);
  const painted = out[out.length - 1];
  assert.ok(painted[0] < last[0], "滤波器一定是有滞后的（不然不需要补齐这一步）");
  assert.equal(tail.length, stabilizeParams("light").tail, "补样段数由档位决定");
  assert.deepEqual(tail[tail.length - 1], last, "末点必须正好是原始终点，差一点都算没补上");
  const gap = Math.hypot(painted[0] - last[0], painted[1] - last[1]);
  assert.ok(gap > 0.5, "补的是一段看得见的滞后，不是一个点");
  // 补出来的段要一段比一段长一点或差不多，不能来回抖
  for (let i = 1; i < tail.length; i++) {
    assert.ok(tail[i][0] > tail[i - 1][0] - 1e-9, `补样第 ${i} 段往回走了`);
  }
  // 数值健康：NaN 会把整条轮廓废掉（buildPath 那边按「轮廓不足三个点」丢掉这一笔）
  for (const p of tail.concat(out)) {
    assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]), `出现非有限值 ${p}`);
  }
});

test("收笔补齐只生效一次（finishStroke 可能被重复调用）", () => {
  const st = new StrokeStabilizer(stabilizeParams("medium"), [0, 0, 0.5]);
  st.next([20, 0, 0.5]);
  assert.ok(st.tail().length > 0, "第一次要补出东西");
  assert.deepEqual(st.tail(), [], "第二次不能再补一遍（重复收尾会画出双份笔尾）");
});

test("点一下就抬笔：只有一个落点时不补出任何多余的东西", () => {
  const { out, tail, all } = run("strong", [7, 9, 0.6], []);
  assert.equal(out.length, 0);
  assert.equal(tail.length, 0, "没有滞后可补");
  assert.equal(all.length, 0, "落点由 startStroke 自己写进笔画，这里不该重复交出");
});

test("压力跟着一起滤，但不出现在输入范围之外", () => {
  const events: StabilizedPoint[] = [];
  for (let i = 1; i <= 10; i++) {
    events.push([i * 6, 0, i % 2 === 0 ? 0.9 : 0.2]); // 压感锯齿（板子量化噪声）
  }
  const { all } = run("medium", [0, 0, 0.5], events);
  for (const p of all) assert.ok(p[2] >= 0.2 && p[2] <= 0.9, `压力越界：${p[2]}`);
  const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
  const raw = spread(events.map((p) => p[2]));
  const filtered = spread(all.map((p) => p[2]));
  assert.ok(filtered < raw, `压力波动该被抹小（${filtered.toFixed(2)} vs ${raw.toFixed(2)}）`);
});

// ── 压感兜底 ──────────────────────────────────────────────────────────────

test("压感兜底：能读出来就照原样用（含清洗）", () => {
  assert.equal(penPressure(0.62, MOUSE_PRESSURE), 0.62);
  assert.equal(penPressure(1, 0.3), 1, "上限照 clampPressure 收");
  assert.equal(penPressure(0.01, 0.5), clampPressure(0.01), "过小也走 clamp");
});

test("压感兜底：读不出来时沿用这一笔上一个有效读数", () => {
  // 数位板偶尔在笔仍压着纸时送来一次 0 —— 跟着它画就是线条上凭空凹进去一个细点
  for (const bad of [0, -1, NaN, undefined, null, "x"]) {
    assert.equal(penPressure(bad, 0.71), 0.71, `${String(bad)} 该退回上一个有效读数`);
  }
  // 一笔开头就没有有效读数：退回等宽的 MOUSE_PRESSURE，而不是猜一个偏细的值
  assert.equal(penPressure(0, MOUSE_PRESSURE), MOUSE_PRESSURE);
  assert.equal(penPressure(0, 0), MOUSE_PRESSURE, "兜底值本身被写坏也不能崩到 0.05");
  assert.equal(penPressure(0, NaN), MOUSE_PRESSURE);
});
