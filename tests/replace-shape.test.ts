// 门面 replaceShape 单测：用原型桩注入最小协作对象，验证「原地替换节点形状」
// 保留 id/位置/尺寸/文字、一条可逆命令，以及无变化/找不到节点不记命令。
// Shape 用原型桩，避开 Text 的 DOM 文本测量。
import { describe, expect, it } from "vitest";
import type { HistoryCapability, HistoryCommand } from "@silker/core";
import { FlowChart } from "../src/flowchart";
import { Shape } from "../src/Shape";

function stubShape(id: string, x: number, y: number, kind = "rect"): Shape {
  const s = Object.create(Shape.prototype) as Shape;
  Object.assign(s, {
    id,
    kind,
    x,
    y,
    width: 160,
    height: 99,
    text: { text: id },
  });
  s.center = () => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
  return s;
}

function makeFlowChart(shapes: Shape[]) {
  const commands: HistoryCommand[] = [];
  const chart = Object.create(FlowChart.prototype) as FlowChart;
  const model = {
    shapes: new Map(shapes.map((s) => [s.id as string, s])),
    edges: [],
    // 按注册表语义建新形状（同 id + 同几何 + 同文字，kind 换成目标）
    createShape: (
      kind: string,
      opts: { id?: string; x: number; y: number; text: string },
    ): Shape => {
      const s = stubShape(opts.id as string, opts.x, opts.y, kind);
      s.text.text = opts.text;
      return s;
    },
    // 顶替语义的最小实现：形状表换绑（真实实现另含场景树与连线重绑）
    swapShape: (oldS: Shape, newS: Shape) => {
      model.shapes.delete(oldS.id as string);
      model.shapes.set(newS.id as string, newS);
    },
  };
  Object.assign(chart, {
    model,
    history: {
      exec: (cmd: HistoryCommand) => {
        cmd.redo();
        commands.push(cmd);
      },
    } as unknown as HistoryCapability,
    interactions: { busy: false },
    editing: { editing: null },
    app: { requestRender: () => {} },
    onChange: undefined,
  });
  return { chart, commands, model };
}

describe("门面 replaceShape（原地替换节点形状）", () => {
  it("换形状保留 id/位置/尺寸/文字；一条可逆命令 undo/redo 对称", () => {
    const a = stubShape("a", 100, 100);
    a.text.text = "校验通过？";
    const { chart, commands, model } = makeFlowChart([a]);
    expect(chart.replaceShape("a", "diamond")).toBe(true);
    const next = model.shapes.get("a")!;
    expect(next).not.toBe(a);
    expect(next.kind).toBe("diamond");
    expect(next.x).toBe(100);
    expect(next.y).toBe(100);
    expect(next.width).toBe(160);
    expect(next.height).toBe(99);
    expect(next.text.text).toBe("校验通过？");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("replace");
    commands[0]!.undo();
    expect(model.shapes.get("a")).toBe(a);
    commands[0]!.redo();
    expect(model.shapes.get("a")).toBe(next);
  });

  it("唯一文字可定位节点；同类型与找不到节点都返回 false 且不记命令", () => {
    const a = stubShape("a", 100, 100);
    a.text.text = "处理请求";
    const { chart, commands, model } = makeFlowChart([a]);
    // 同类型：视为无变化
    expect(chart.replaceShape("处理请求", "rect")).toBe(false);
    expect(commands).toHaveLength(0);
    // 唯一文字定位生效
    expect(chart.replaceShape("处理请求", "database")).toBe(true);
    expect(model.shapes.get("a")!.kind).toBe("database");
    expect(commands).toHaveLength(1);
    // 不存在的节点
    expect(chart.replaceShape("ghost", "rect")).toBe(false);
    expect(commands).toHaveLength(1);
  });
});
