// 吸附引擎回归测试：纯函数 computeSnap 的对齐吸附、等间距吸附与迟滞行为。
// snap.ts 不依赖画布/App，直接构造 Bounds 输入断言位移与参考线。
import { describe, expect, it } from "vitest";
import { computeSnap } from "../src/snap";
import type { Bounds } from "../src/snap";

const b = (x: number, y: number, width: number, height: number): Bounds => ({
  x,
  y,
  width,
  height,
});

// 默认容差：对齐/等间距均 6（世界坐标）
const OPTS = { snapTol: 6, spacingTol: 6 };

describe("computeSnap 对齐吸附", () => {
  it("无候选时不吸附、无参考线", () => {
    const r = computeSnap(b(0, 0, 80, 60), [], OPTS);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.guides).toBeNull();
    expect(r.snappedX).toBe(false);
    expect(r.snappedY).toBe(false);
  });

  it("左边缘在阈值内：吸附到候选左缘并输出竖参考线", () => {
    // 候选在远处纵向错开，隔离 Y 轴
    const r = computeSnap(b(103, 0, 80, 60), [b(100, 200, 80, 60)], OPTS);
    expect(r.dx).toBe(-3);
    expect(r.dy).toBe(0);
    expect(r.snappedX).toBe(true);
    expect(r.snappedY).toBe(false);
    expect(r.guides?.v).toContain(100);
    expect(r.guides?.h).toHaveLength(0);
  });

  it("中线对齐：吸附到候选水平中线", () => {
    // box 中心 203，候选中心 200
    const r = computeSnap(b(163, 0, 80, 60), [b(100, 300, 200, 60)], OPTS);
    expect(r.dx).toBe(-3);
    expect(r.guides?.v).toContain(200);
  });

  it("所有基准超出阈值：不吸附", () => {
    // 左/中/右与候选三基准的最小差值均为 12 > 6
    const r = computeSnap(b(112, 0, 80, 60), [b(100, 200, 80, 60)], OPTS);
    expect(r.dx).toBe(0);
    expect(r.dy).toBe(0);
    expect(r.guides).toBeNull();
    expect(r.snappedX).toBe(false);
  });

  it("迟滞：上一帧已吸附的轴用加倍释放容差维持吸附", () => {
    // 左缘差 9：未吸附态超阈值不吸；迟滞态 9 <= 6*2 吸附
    const box = b(109, 0, 80, 60);
    const candidates = [b(100, 200, 80, 60)];
    const fresh = computeSnap(box, candidates, OPTS);
    expect(fresh.snappedX).toBe(false);
    const hysteresis = computeSnap(box, candidates, {
      ...OPTS,
      prev: { x: true, y: false },
    });
    expect(hysteresis.dx).toBe(-9);
    expect(hysteresis.snappedX).toBe(true);
  });
});

describe("computeSnap 等间距吸附", () => {
  it("单侧邻居：复现既有间距（候选间距 40，当前 43 → 吸到 160）", () => {
    // 候选 C1[0,40]、C2[80,120] 间距 40；拖拽载体左缘 163（gL=43）
    const r = computeSnap(b(163, 0, 80, 60), [b(0, 0, 40, 60), b(80, 0, 40, 60)], OPTS);
    expect(r.dx).toBe(-3);
    // 等间距吸附不计入 snappedX（文档约定），但对齐吸附被跳过
    expect(r.snappedX).toBe(false);
    // 输出测量线段：LL→L 与 L→载体两段，值均为 40
    expect(r.guides?.spacing).toHaveLength(2);
    expect(r.guides?.spacing[0].value).toBe(40);
    expect(r.guides?.spacing[1].value).toBe(40);
  });

  it("两侧邻居间隙不等但差值在阈值内：平分差值", () => {
    // 候选 [0,40] 与 [160,200]，载体 x=83：gL=43、gR=37，各吸 3 收敛到 x=80
    const r = computeSnap(b(83, 0, 40, 60), [b(0, 0, 40, 60), b(160, 0, 40, 60)], OPTS);
    expect(r.dx).toBe(-3);
    // 吸附后两侧间距相等，各输出一条测量线段
    expect(r.guides?.spacing).toHaveLength(2);
    expect(r.guides?.spacing[0].value).toBe(40);
  });

  it("投影带过滤：纵向不相邻的候选不产生间距吸附", () => {
    // 候选在 y=200 行，与载体（y=0..60）纵向不重叠
    const r = computeSnap(b(163, 0, 80, 60), [b(0, 200, 40, 60), b(80, 200, 40, 60)], OPTS);
    expect(r.dx).toBe(0);
    expect(r.guides).toBeNull();
  });
});
