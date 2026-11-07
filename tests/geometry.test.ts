// 交互几何回归测试：命中测试、缩放几何与包围盒纯函数。
// Shape 参与的函数用鸭子类型桩替代（只用到 x/y/width/height 与 layout()），
// 不触发画布文本测量。
import { describe, expect, it } from "vitest";
import {
  applyGroupResize,
  applyResize,
  cornerHit,
  edgeHit,
  marqueeHits,
  previewToDir,
  unionBounds,
} from "../src/geometry";
import type { Shape } from "../src/Shape";
import type { Bounds } from "../src/snap";

const b = (x: number, y: number, width: number, height: number): Bounds => ({
  x,
  y,
  width,
  height,
});

// 形状桩：记录 layout 调用次数
function stubShape(x: number, y: number, width: number, height: number) {
  const s = {
    x,
    y,
    width,
    height,
    layoutCalls: 0,
    layout() {
      s.layoutCalls++;
    },
  };
  return s as unknown as Shape & { layoutCalls: number };
}

describe("cornerHit 四角手柄命中", () => {
  const bounds = b(0, 0, 100, 80);

  it("四角在命中半径内返回对应方位", () => {
    expect(cornerHit(bounds, { x: 4, y: 4 }, 1)).toBe("nw");
    expect(cornerHit(bounds, { x: 96, y: 4 }, 1)).toBe("ne");
    expect(cornerHit(bounds, { x: 96, y: 76 }, 1)).toBe("se");
    expect(cornerHit(bounds, { x: 4, y: 76 }, 1)).toBe("sw");
  });

  it("超出半径或落在边中段返回 null", () => {
    expect(cornerHit(bounds, { x: 12, y: 12 }, 1)).toBeNull(); // 距角 ~17 > 8
    expect(cornerHit(bounds, { x: 30, y: 0 }, 1)).toBeNull(); // 顶边中段
    expect(cornerHit(bounds, { x: 50, y: 40 }, 1)).toBeNull(); // 内部
  });

  it("scale 越大命中半径（世界坐标）越小", () => {
    // scale=4 时半径 2：距角 4 不命中
    expect(cornerHit(bounds, { x: 4, y: 0 }, 4)).toBeNull();
    expect(cornerHit(bounds, { x: 1, y: 0 }, 4)).toBe("nw");
  });
});

describe("edgeHit 边线命中", () => {
  const bounds = b(0, 0, 100, 80);

  it("边线中段在容差内命中对应边", () => {
    expect(edgeHit(bounds, { x: 30, y: -3 }, 1)).toBe("n");
    expect(edgeHit(bounds, { x: -3, y: 20 }, 1)).toBe("w");
    expect(edgeHit(bounds, { x: 103, y: 60 }, 1)).toBe("e");
  });

  it("角部让位角手柄、中点让位端口", () => {
    expect(edgeHit(bounds, { x: 6, y: -3 }, 1)).toBeNull(); // along=6 < nearCorner(10)
    expect(edgeHit(bounds, { x: 45, y: -3 }, 1)).toBeNull(); // 距边中点 5 < PORT_HIT_RADIUS(10)
    expect(edgeHit(bounds, { x: -3, y: 40 }, 1)).toBeNull(); // 左边中点即端口位
  });

  it("远离边线不命中", () => {
    expect(edgeHit(bounds, { x: 200, y: 40 }, 1)).toBeNull();
    expect(edgeHit(bounds, { x: 50, y: 40 }, 1)).toBeNull();
  });
});

describe("unionBounds / marqueeHits", () => {
  it("并集包围盒覆盖全部输入", () => {
    expect(unionBounds([b(0, 0, 10, 10), b(20, 30, 5, 5)])).toEqual(
      b(0, 0, 25, 35),
    );
  });

  it("框选相交即命中，相离不命中", () => {
    const rect = b(5, 5, 10, 10);
    const inside = stubShape(8, 8, 2, 2);
    const overlap = stubShape(14, 14, 3, 3); // 角部与选框相交
    const outside = stubShape(20, 20, 2, 2);
    const hits = marqueeHits([inside, overlap, outside], rect);
    expect(hits).toHaveLength(2);
    expect(hits).toContain(inside);
    expect(hits).toContain(overlap);
  });
});

describe("previewToDir 虚拟进入方向", () => {
  it("光标在出口外法向一侧：顺势进入对侧", () => {
    // 出口 top（法向 0,-1），光标在上方（proj>0）→ 从 bottom 进入
    expect(previewToDir("top", { x: 0, y: 0 }, { x: 0, y: -10 })).toBe("bottom");
    expect(previewToDir("right", { x: 0, y: 0 }, { x: 10, y: 0 })).toBe("left");
  });

  it("光标在出口内侧或未越过：保持出口方向", () => {
    expect(previewToDir("top", { x: 0, y: 0 }, { x: 0, y: 10 })).toBe("top");
    expect(previewToDir("top", { x: 0, y: 0 }, { x: 10, y: 0 })).toBe("top"); // 垂直分量 proj=0
    expect(previewToDir("right", { x: 0, y: 0 }, { x: -5, y: 0 })).toBe("right");
  });
});

describe("applyResize 单形状缩放", () => {
  it("边手柄拖小到最小尺寸：钳制 MIN_SIZE 且锚点不动", () => {
    const s = stubShape(0, 0, 100, 80);
    applyResize(s, "e", b(0, 0, 100, 80), -95, 0);
    expect(s.width).toBe(20); // MIN_SIZE
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
    expect(s.height).toBe(80);
    expect(s.layoutCalls).toBe(1);
  });

  it("w 手柄：宽度变化反映在 x（右缘锚定）", () => {
    const s = stubShape(0, 0, 100, 80);
    applyResize(s, "w", b(0, 0, 100, 80), 30, 0);
    expect(s.width).toBe(70);
    expect(s.x).toBe(30);
    expect(s.y).toBe(0);
  });

  it("角手柄锁定比例：取相对变化更大的轴作为统一缩放比", () => {
    const s = stubShape(0, 0, 100, 80);
    // dx=-80（w→20，比率 0.2）、dy=+80（h→160，比率 2）→ 统一取 2
    applyResize(s, "se", b(0, 0, 100, 80), -80, 80);
    expect(s.width).toBe(200);
    expect(s.height).toBe(160);
    expect(s.x).toBe(0); // se 锚定左上角
    expect(s.y).toBe(0);
  });
});

describe("applyGroupResize 组合缩放", () => {
  // 每个用例独立建桩，避免用例间共享可变状态
  const makeOrigins = () => [
    { shape: stubShape(0, 0, 100, 100), x: 0, y: 0, width: 100, height: 100 },
    { shape: stubShape(200, 0, 50, 50), x: 200, y: 0, width: 50, height: 50 },
  ];
  const groupBounds = b(0, 0, 250, 100);

  it("se 放大一倍：全体成员按同比例等比变换，锚定组合左上角", () => {
    const origins = makeOrigins();
    applyGroupResize("se", groupBounds, origins, 250, 100);
    const [m1, m2] = origins;
    expect(m1.shape.x).toBe(0);
    expect(m1.shape.y).toBe(0);
    expect(m1.shape.width).toBe(200);
    expect(m1.shape.height).toBe(200);
    expect(m2.shape.x).toBe(400);
    expect(m2.shape.y).toBe(0);
    expect(m2.shape.width).toBe(100);
    expect(m2.shape.height).toBe(100);
  });

  it("缩放比受组内最小成员钳制：任何成员不低于 MIN_SIZE", () => {
    // sx=0.1（dx=-225）、sy=0.2（dy=-80）→ 等比取 0.2，仍低于最小成员钳制
    // 0.4（MIN_SIZE 20 / 最小宽 50）→ 整体比钳到 0.4
    const origins = makeOrigins();
    applyGroupResize("se", groupBounds, origins, -225, -80);
    const [m1, m2] = origins;
    expect(m2.shape.width).toBe(20); // 50 * 0.4
    expect(m2.shape.height).toBe(20); // 50 * 0.4
    // m1 同比例
    expect(m1.shape.width).toBe(40);
    expect(m1.shape.x).toBe(0); // 锚点在左上
    expect(m2.shape.x).toBe(80); // 0 + 200 * 0.4
  });
});
