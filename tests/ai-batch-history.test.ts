// AI 批量历史单测：一次 AI run（无论多少条增量 op）只产生一条历史记录——
// 全部增量命令合并为一条 "ai" 组合命令入栈，一次 undo 整体回退（与 mindmap
// ai-controller 同一语义）。用原型桩注入最小协作对象，避开 DOM 依赖。
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
  // layout() 依赖 text.measure 重排居中：桩实现直接写回形状尺寸
  (s.text as unknown as { measure: () => void }).measure = () => {
    (s.text as unknown as { width: number }).width = s.width;
    (s.text as unknown as { height: number }).height = s.height;
  };
  return s;
}

function stubEdge(id: string, from: Shape, to: Shape): FlowEdge {
  const e = Object.create(FlowEdge.prototype) as FlowEdge;
  Object.assign(e, {
    id,
    fromNode: from,
    toNode: to,
    fromDir: "right" as PortDir,
    toDir: "left" as PortDir,
    label: { text: "" },
  });
  return e;
}

// 桩历史：双栈语义与 plugin-history 一致（record 清空重做分支）
function stubHistory() {
  const undoStack: HistoryCommand[] = [];
  const redoStack: HistoryCommand[] = [];
  return {
    undoStack,
    impl: {
      exec: (cmd: HistoryCommand) => {
        cmd.redo();
        undoStack.push(cmd);
      },
      record: (cmd: HistoryCommand) => {
        undoStack.push(cmd);
        redoStack.length = 0;
      },
      undo: () => {
        const cmd = undoStack.pop();
        cmd?.undo();
        if (cmd) redoStack.push(cmd);
        return cmd;
      },
      redo: () => {
        const cmd = redoStack.pop();
        cmd?.redo();
        if (cmd) undoStack.push(cmd);
        return cmd;
      },
      get canUndo() {
        return undoStack.length > 0;
      },
      get canRedo() {
        return redoStack.length > 0;
      },
    } as unknown as HistoryCapability,
  };
}

function makeChart(
  shapes: Shape[],
  edges: FlowEdge[],
  ops: unknown[],
  answer?: string,
) {
  const { impl, undoStack } = stubHistory();
  const chart = Object.create(FlowChart.prototype) as FlowChart;
  const model = {
    shapes: new Map(shapes.map((s) => [s.id as string, s])),
    edges: [...edges],
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
    applyShapeRemoval: (c: {
      shape: Shape;
      edges: { edge: FlowEdge }[];
    }) => {
      model.shapes.delete(c.shape.id as string);
      model.edges = model.edges.filter(
        (e) => e.fromNode !== c.shape && e.toNode !== c.shape,
      );
    },
    restoreShapeRemoval: (c: {
      shape: Shape;
      edges: { edge: FlowEdge }[];
    }) => {
      model.shapes.set(c.shape.id as string, c.shape);
      for (const x of c.edges) {
        if (!model.edges.includes(x.edge)) model.edges.push(x.edge);
      }
    },
    // FlowData：toSemanticGraph 只消费 nodes/edges 两个字段
    toJSON: () => ({
      nodes: [...model.shapes.values()].map((s) => ({
        id: s.id,
        shape: s.kind,
        text: s.text.text,
      })),
      edges: model.edges.map((e) => ({
        id: e.id,
        from: e.fromNode.id,
        to: e.toNode.id,
        fromDir: e.fromDir,
        toDir: e.toDir,
        text: e.label.text || undefined,
      })),
    }),
  };
  Object.assign(chart, {
    model,
    history: impl,
    options: {
      ai: async () => JSON.stringify(answer ? { ops, answer } : { ops }),
    },
    interactions: { busy: false, select: () => {} },
    editing: { editing: null },
    sel: { items: [] as (Shape | FlowEdge)[] },
    app: { requestRender: () => {}, capability: () => null },
    onChange: undefined,
    getSelection: () => ({ nodes: [], edges: [] }),
  });
  return { chart, undoStack, model };
}

describe("AI 批量历史（一次 run 只产生一条记录）", () => {
  it("多条 removeNode op 合并为一条 'ai' 组合命令，一次 undo 整体回退", async () => {
    const na = stubShape("a", 100, 100);
    const nb = stubShape("b", 400, 100);
    const nc = stubShape("c", 700, 100);
    const e1 = stubEdge("e1", na, nb);
    const e2 = stubEdge("e2", nb, nc);
    const { chart, undoStack, model } = makeChart(
      [na, nb, nc],
      [e1, e2],
      [
        { op: "removeNode", ref: "a" },
        { op: "removeNode", ref: "b" },
        { op: "removeNode", ref: "c" },
      ],
    );
    const result = await chart.generate("删除所有节点");
    expect(result.applied).toBe(3);
    expect(model.shapes.size).toBe(0);
    // 三步删除只入栈一条记录，且为 "ai" 组合命令
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0]!.type).toBe("ai");
    // 一次 undo 整体回退：三个节点与两条连线全部恢复
    const ok = chart.undo();
    expect(ok).toBe(true);
    expect([...model.shapes.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(model.edges.map((e) => e.id).sort()).toEqual(["e1", "e2"]);
  });

  it("单条增量 op 直接入栈不包壳；answer 类 run 不产生记录", async () => {
    const na = stubShape("a", 100, 100);
    const { chart, undoStack } = makeChart([na], [], [
      { op: "removeNode", ref: "a" },
    ]);
    await chart.generate("删除节点 a");
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0]!.type).toBe("delete");

    const { chart: chart2, undoStack: undoStack2 } = makeChart(
      [stubShape("a", 100, 100)],
      [],
      [],
      "画布上只有一个节点",
    );
    await chart2.generate("描述画布");
    expect(undoStack2).toHaveLength(0);
  });

  it("多条 setNodeText op 同样合并为一条记录，一次 undo 整体回退", async () => {
    const na = stubShape("a", 100, 100);
    const nb = stubShape("b", 400, 100);
    const { chart, undoStack, model } = makeChart(
      [na, nb],
      [],
      [
        { op: "setNodeText", ref: "a", text: "开始" },
        { op: "setNodeText", ref: "b", text: "结束" },
      ],
    );
    const result = await chart.generate("改两个节点的文字");
    expect(result.applied).toBe(2);
    expect(model.shapes.get("a")!.text.text).toBe("开始");
    expect(model.shapes.get("b")!.text.text).toBe("结束");
    expect(undoStack).toHaveLength(1);
    expect(undoStack[0]!.type).toBe("ai");
    expect(chart.undo()).toBe(true);
    expect(model.shapes.get("a")!.text.text).toBe("a");
    expect(model.shapes.get("b")!.text.text).toBe("b");
  });

  it("批量可整体 redo：undo 后一次 redo 重放全部子命令", async () => {
    const na = stubShape("a", 100, 100);
    const nb = stubShape("b", 400, 100);
    const { chart, model } = makeChart(
      [na, nb],
      [],
      [
        { op: "removeNode", ref: "a" },
        { op: "removeNode", ref: "b" },
      ],
    );
    await chart.generate("清空画布");
    expect(model.shapes.size).toBe(0);
    expect(chart.undo()).toBe(true);
    expect(model.shapes.size).toBe(2);
    expect(chart.redo()).toBe(true);
    expect(model.shapes.size).toBe(0);
  });
});
