import { describe, expect, it } from "vitest";
import type { App, Node } from "@silkor/core";
import { FlowEdge } from "../src/FlowEdge";
import { Shape } from "../src/Shape";
import type { FlowModelDeps } from "../src/model";
import { captureRemoval, FlowModel } from "../src/model";

// 构造绕过构造器的 Shape/FlowEdge 桩（prototype 链保证 instanceof 成立），
// 手工补上 capture/apply/restore 索引运算读取的字段
function fakeShape(id: string, x = 0, y = 0): Shape {
  const s = Object.create(Shape.prototype) as Shape;
  s.id = id;
  s.x = x;
  s.y = y;
  s.width = 100;
  s.height = 60;
  return s;
}

function fakeEdge(from: Shape, to: Shape): FlowEdge {
  const e = Object.create(FlowEdge.prototype) as FlowEdge;
  e.fromNode = from;
  e.toNode = to;
  return e;
}

// 模型桩：app 仅提供 children（z 序数组）及对其的 add/remove/insert/reorder 语义
// （与 core App 一致：索引越界钳制、reorder 先摘后插），能力钩子为空实现/记录器
function makeModel(
  children: Node[],
  onDetach: (shape: Shape) => void = () => {},
): FlowModel {
  const clamp = (idx: number) => Math.max(0, Math.min(idx, children.length));
  return new FlowModel({
    app: {
      children,
      add: (n: Node) => {
        children.push(n);
      },
      remove: (n: Node) => {
        const i = children.indexOf(n);
        if (i !== -1) children.splice(i, 1);
      },
      insert: (n: Node, idx: number) => {
        children.splice(clamp(idx), 0, n);
      },
      reorder: (n: Node, idx: number) => {
        const i = children.indexOf(n);
        if (i === -1) return;
        children.splice(i, 1);
        children.splice(clamp(idx), 0, n);
      },
      requestRender: () => {},
    } as unknown as App,
    registry: {} as FlowModelDeps["registry"],
    router: {} as FlowModelDeps["router"],
    history: {} as FlowModelDeps["history"],
    onDetach,
    onSelect: () => {},
  });
}

// 场景：连线层 [eAB, eAC, eBC] 在形状层 [A, B, C] 之下（children z 序），
// A 关联 eAB（出边）与 eAC（入边），eBC 与 A 无关
function buildScene() {
  const a = fakeShape("a", 0, 0);
  const b = fakeShape("b", 200, 0);
  const c = fakeShape("c", 400, 0);
  const eAB = fakeEdge(a, b);
  const eAC = fakeEdge(a, c);
  const eBC = fakeEdge(b, c);
  const children: Node[] = [eAB, eAC, a, eBC, b, c];
  const edges = [eAB, eAC, eBC];
  return { a, b, c, eAB, eAC, eBC, children, edges };
}

describe("captureRemoval（索引捕获）", () => {
  it("记录形状的 z 序索引与关联连线（连线序 + z 序索引），无关连线不捕获", () => {
    const { a, eAB, eAC, eBC, children, edges } = buildScene();
    const captured = captureRemoval(children, edges, a);
    expect(captured.childIdx).toBe(2);
    expect(captured.edges).toEqual([
      { edge: eAB, order: 0, childIdx: 0 },
      { edge: eAC, order: 1, childIdx: 1 },
    ]);
    // eBC 与 A 无关，不在捕获内
    expect(captured.edges.map((entry) => entry.edge)).not.toContain(eBC);
  });
});

describe("FlowModel 删除捕获/应用/恢复（索引往返）", () => {
  it("apply 摘除形状与关联连线；restore 按原索引插回，z 序与连线序完全复原", () => {
    const { a, b, c, eBC, children, edges } = buildScene();
    const detached: Shape[] = [];
    const model = makeModel(children, (s) => detached.push(s));
    model.shapes.set("a", a);
    model.shapes.set("b", b);
    model.shapes.set("c", c);
    model.edges = edges;

    const captured = model.captureShapeRemoval(a);
    model.applyShapeRemoval(captured);
    // A 及其关联连线（eAB/eAC）被摘除，无关的 eBC 与 B、C 保留
    expect(model.edges).toEqual([eBC]);
    expect([...children]).toEqual([eBC, b, c]);
    expect(model.shapes.has("a")).toBe(false);
    expect(model.shapes.has("b")).toBe(true);
    expect(model.shapes.has("c")).toBe(true);
    // removeShape 经 onDetach 通知场景侧（清编辑态/取消选中）
    expect(detached).toEqual([a]);

    model.restoreShapeRemoval(captured);
    // 撤销删除：z 序与连线表按原索引完全复原
    expect(model.edges).toEqual(edges);
    expect([...children]).toEqual([edges[0], edges[1], a, eBC, b, c]);
    expect(model.shapes.get("a")).toBe(a);
  });

  it("关联连线与无关连线交错分布时按连线序与各自 z 序索引恢复", () => {
    const a = fakeShape("a");
    const b = fakeShape("b");
    const c = fakeShape("c");
    const other = fakeShape("o");
    const eAB = fakeEdge(a, b);
    const eXX = fakeEdge(b, other); // 与 A 无关的连线
    const eAC = fakeEdge(a, c);
    // 连线层在前、形状层在后（insertEdge 的不变式），A 的关联连线被无关连线隔开
    const children: Node[] = [eAB, eXX, eAC, a, b, c, other];
    const model = makeModel(children);
    for (const s of [a, b, c, other]) model.shapes.set(s.id as string, s);
    model.edges = [eAB, eXX, eAC];

    const captured = model.captureShapeRemoval(a);
    expect(captured.childIdx).toBe(3);
    expect(captured.edges).toEqual([
      { edge: eAB, order: 0, childIdx: 0 },
      { edge: eAC, order: 2, childIdx: 2 },
    ]);
    model.applyShapeRemoval(captured);
    expect(model.edges).toEqual([eXX]);
    expect([...children]).toEqual([eXX, b, c, other]);

    model.restoreShapeRemoval(captured);
    expect(model.edges).toEqual([eAB, eXX, eAC]);
    expect([...children]).toEqual([eAB, eXX, eAC, a, b, c, other]);
    expect(model.shapes.get("a")).toBe(a);
  });
});
