// 门面 removeNode / removeEdge 单测：用原型桩注入最小协作对象，验证「删除节点
// 连带关联连线」「只删一条连线」的捕获/恢复语义与可逆命令。Shape/FlowEdge 用
// 原型桩，避开 Text 的 DOM 文本测量。
import { describe, expect, it } from "vitest";
import type { HistoryCapability, HistoryCommand } from "@silkor/core";
import { FlowChart } from "../src/flowchart";
import { FlowEdge } from "../src/FlowEdge";
import type { PortDir } from "../src/FlowEdge";
import { Shape } from "../src/Shape";

function stubShape(id: string, x: number, y: number): Shape {
  const s = Object.create(Shape.prototype) as Shape;
  Object.assign(s, {
    id,
    kind: "rect",
    x,
    y,
    width: 160,
    height: 99,
    text: { text: id },
  });
  s.center = () => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
  return s;
}

function stubEdge(
  id: string,
  from: Shape,
  to: Shape,
  fromDir: PortDir,
  toDir: PortDir,
  text = "",
): FlowEdge {
  const e = Object.create(FlowEdge.prototype) as FlowEdge;
  Object.assign(e, {
    id,
    fromNode: from,
    toNode: to,
    fromDir,
    toDir,
    label: { text },
  });
  return e;
}

function makeFlowChart(shapes: Shape[], edges: FlowEdge[]) {
  const commands: HistoryCommand[] = [];
  const chart = Object.create(FlowChart.prototype) as FlowChart;
  const children: unknown[] = [...edges];
  const model = {
    shapes: new Map(shapes.map((s) => [s.id as string, s])),
    edges,
    // 捕获：形状 + z 序索引 + 关联连线（连线表序）
    captureShapeRemoval: (shape: Shape) => ({
      shape,
      childIdx: 0,
      edges: model.edges
        .map((edge, order) => ({ edge, order, childIdx: 0 }))
        .filter((c) => c.edge.fromNode === shape || c.edge.toNode === shape),
    }),
    removeShape: (shape: Shape) => {
      model.shapes.delete(shape.id as string);
      model.edges = model.edges.filter(
        (e) => e.fromNode !== shape && e.toNode !== shape,
      );
    },
    // redo：重放摘除
    applyShapeRemoval: (c: {
      shape: Shape;
      edges: { edge: FlowEdge }[];
    }) => {
      model.shapes.delete(c.shape.id as string);
      model.edges = model.edges.filter(
        (e) => e.fromNode !== c.shape && e.toNode !== c.shape,
      );
      for (const x of c.edges) {
        children.splice(children.indexOf(x.edge), 1);
      }
    },
    // undo：按捕获插回
    restoreShapeRemoval: (c: {
      shape: Shape;
      edges: { edge: FlowEdge }[];
    }) => {
      model.shapes.set(c.shape.id as string, c.shape);
      for (const x of c.edges) {
        if (!model.edges.includes(x.edge)) model.edges.push(x.edge);
        if (!children.includes(x.edge)) children.push(x.edge);
      }
    },
    removeTop: (edge: FlowEdge) => {
      const i = children.indexOf(edge);
      if (i >= 0) children.splice(i, 1);
    },
    insertAt: (edge: FlowEdge, childIdx: number) => {
      children.splice(childIdx, 0, edge);
    },
  };
  const app = { children, requestRender: () => {} };
  Object.assign(chart, {
    model,
    history: {
      exec: (cmd: HistoryCommand) => {
        cmd.redo();
        commands.push(cmd);
      },
    } as unknown as HistoryCapability,
    interactions: { busy: false },
    sel: { items: [] as (Shape | FlowEdge)[] },
    editing: { editing: null },
    app,
    onChange: undefined,
  });
  return { chart, commands, model, children };
}

const a = () => stubShape("a", 100, 100);
const b = () => stubShape("b", 400, 100);
const c = () => stubShape("c", 700, 100);

describe("门面 removeNode（删除节点及其关联连线）", () => {
  it("删节点连带删关联连线；undo 整体恢复，redo 重放摘除", () => {
    const na = a();
    const nb = b();
    const e1 = stubEdge("e1", na, nb, "right", "left");
    const e2 = stubEdge("e2", nb, na, "left", "right");
    const nc = c();
    const e3 = stubEdge("e3", nb, nc, "right", "left");
    const { chart, commands, model } = makeFlowChart([na, nb, nc], [e1, e2, e3]);
    expect(chart.removeNode("a")).toBe(true);
    expect(model.shapes.has("a")).toBe(false);
    expect(model.edges).toEqual([e3]);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("delete");
    commands[0]!.undo();
    expect(model.shapes.get("a")).toBe(na);
    // undo 按捕获追回（不保序）：只验证三条连线都回来了
    expect([...model.edges].map((e) => e.id).sort()).toEqual(["e1", "e2", "e3"]);
    commands[0]!.redo();
    expect(model.shapes.has("a")).toBe(false);
    expect(model.edges).toEqual([e3]);
  });

  it("唯一文字可定位；不存在的节点返回 false 不记命令", () => {
    const na = a();
    na.text.text = "处理请求";
    const { chart, commands, model } = makeFlowChart([na], []);
    expect(chart.removeNode("处理请求")).toBe(true);
    expect(model.shapes.has("a")).toBe(false);
    expect(commands).toHaveLength(1);
    expect(chart.removeNode("ghost")).toBe(false);
    expect(commands).toHaveLength(1);
  });
});

describe("门面 removeEdge（删除单条连线）", () => {
  it("按语义定位删一条分支边；两端节点与其它连线不动；undo 按原序插回", () => {
    const na = a();
    const nb = b();
    const yes = stubEdge("e1", na, nb, "right", "left", "是");
    const no = stubEdge("e2", na, nb, "right", "left", "否");
    const { chart, commands, model, children } = makeFlowChart(
      [na, nb],
      [yes, no],
    );
    expect(chart.removeEdge({ from: "a", to: "b", text: "是" })).toBe(true);
    expect(model.edges).toEqual([no]);
    expect(children).toEqual([no]);
    expect(model.shapes.get("a")).toBe(na);
    expect(model.shapes.get("b")).toBe(nb);
    expect(commands).toHaveLength(1);
    commands[0]!.undo();
    expect(model.edges).toEqual([yes, no]);
    expect(children).toEqual([yes, no]);
  });

  it("连线 id 可定位；找不到连线返回 false 不记命令", () => {
    const na = a();
    const nb = b();
    const e1 = stubEdge("e1", na, nb, "right", "left");
    const { chart, commands, model } = makeFlowChart([na, nb], [e1]);
    expect(chart.removeEdge("e1")).toBe(true);
    expect(model.edges).toEqual([]);
    expect(chart.removeEdge({ from: "a", to: "b" })).toBe(false);
    expect(chart.removeEdge("ghost")).toBe(false);
    expect(commands).toHaveLength(1);
  });
});
