// 端口方向快速创建的共享函数单测：真实 Shape/FlowEdge 构造依赖 DOM 文本测量，
// 这里用鸭子类型形状桩 + 轻量 FlowEdge 桩（保留真实方向常量），只验证
// 几何、端口方向、类型/文字传递与「节点 + 连线」一条原子命令。
import { describe, expect, it, vi } from "vitest";
import type { HistoryCapability, HistoryCommand } from "@silker/core";
import { placeNodeInDirection } from "../src/geometry";
import type { FlowModel } from "../src/model";
import { createNodeInDirection } from "../src/quick-create";
import type { QuickCreateDeps } from "../src/quick-create";
import { Shape } from "../src/Shape";
import type { ShapeOptions } from "../src/Shape";
import type { ShapeKind } from "../src/data";

vi.mock("../src/FlowEdge", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  class FakeFlowEdge {
    fromNode: unknown;
    toNode: unknown;
    fromDir: string;
    toDir: string;
    router: unknown;
    label = { text: "" };
    constructor(
      from: unknown,
      to: unknown,
      hints: { from?: string; to?: string } = {},
    ) {
      this.fromNode = from;
      this.toNode = to;
      this.fromDir = hints.from ?? "right";
      this.toDir = hints.to ?? "left";
    }
  }
  return { ...actual, FlowEdge: FakeFlowEdge };
});

// 形状桩：Object.create 保持 instanceof Shape 语义，避开 Text 的画布测量
function fakeShape(kind: ShapeKind, options: ShapeOptions = {}): Shape {
  const s = Object.create(Shape.prototype) as Shape;
  Object.assign(s, {
    id: options.id ?? `n${Math.random()}`,
    kind,
    x: options.x ?? 0,
    y: options.y ?? 0,
    width: options.width ?? 160,
    height: options.height ?? 99,
    text: { text: options.text ?? "" },
  });
  return s;
}

function makeDeps() {
  const shapes = new Map<string, Shape>();
  const edges: unknown[] = [];
  const commands: HistoryCommand[] = [];
  let edge: { fromDir: string; toDir: string } | null = null;
  const model = {
    createShape: (kind: ShapeKind, options: ShapeOptions) => fakeShape(kind, options),
    registerShape: (s: Shape) => void shapes.set(s.id as string, s),
    removeShape: (s: Shape) => void shapes.delete(s.id as string),
    edgeAddRemove: (e: { fromDir: string; toDir: string }) => {
      edge = e;
      return {
        redo: () => void edges.push(e),
        undo: () => void edges.splice(edges.indexOf(e), 1),
        toJSON: () => ({ kind: "flowchart.connect", payload: {} }),
      };
    },
  } as unknown as FlowModel;
  const history = {
    exec: (cmd: HistoryCommand) => {
      commands.push(cmd);
      cmd.redo();
    },
  } as unknown as HistoryCapability;
  return {
    deps: { model, history, router: {} } as QuickCreateDeps,
    shapes,
    edges,
    commands,
    edge: () => edge!,
  };
}

describe("端口方向快速创建（参考节点 + 方向 + 类型）", () => {
  it("沿下方新建菱形：几何与点击手柄一致、端口方向对齐、一条原子命令", () => {
    const ctx = makeDeps();
    const source = fakeShape("rect", { id: "a", x: 100, y: 200, text: "处理" });
    const shape = createNodeInDirection(ctx.deps, source, "bottom", "diamond", "新步骤");
    const pos = placeNodeInDirection(source, "bottom", { width: 160, height: 99 });
    expect(shape.kind).toBe("diamond");
    expect(shape.text.text).toBe("新步骤");
    expect({ x: shape.x, y: shape.y }).toEqual(pos);
    expect(ctx.edge().fromDir).toBe("bottom");
    expect(ctx.edge().toDir).toBe("top");
    // 一次 exec = 一条组合命令；redo 后节点与连线同时在位
    expect(ctx.commands).toHaveLength(1);
    expect(ctx.shapes.has(shape.id as string)).toBe(true);
    expect(ctx.edges).toHaveLength(1);
    // 一次 undo 整体回退
    ctx.commands[0]!.undo();
    expect(ctx.shapes.size).toBe(0);
    expect(ctx.edges).toHaveLength(0);
  });

  it("省略类型时与参考节点同类型；四个方向分别落在对应侧", () => {
    const dirs = [
      { dir: "right" as const, from: "right", to: "left" },
      { dir: "left" as const, from: "left", to: "right" },
      { dir: "bottom" as const, from: "bottom", to: "top" },
      { dir: "top" as const, from: "top", to: "bottom" },
    ];
    for (const { dir, from, to } of dirs) {
      const ctx = makeDeps();
      const source = fakeShape("rect", { id: "a", x: 100, y: 200 });
      const shape = createNodeInDirection(ctx.deps, source, dir);
      expect(shape instanceof Shape).toBe(true);
      expect(shape.kind).toBe("rect");
      expect(shape.text.text).toBe("");
      expect({ x: shape.x, y: shape.y }).toEqual(
        placeNodeInDirection(source, dir, { width: 160, height: 99 }),
      );
      expect(ctx.edge().fromDir).toBe(from);
      expect(ctx.edge().toDir).toBe(to);
    }
  });
});
