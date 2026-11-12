// 门面 setNodeText 单测：用原型桩注入最小协作对象，验证「原地改节点文字」
// 复用双击编辑同一条 textCommand 历史路径、无变化/找不到节点不记命令。
// Shape 用原型桩（layout 覆写为空操作，避开 Text 的 DOM 文本测量）。
import { describe, expect, it } from "vitest";
import type { HistoryCapability, HistoryCommand } from "@silker/core";
import { FlowChart } from "../src/flowchart";
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
  // 真实 layout 依赖 DOM 文本测量：桩环境覆写为空操作
  s.layout = () => {};
  return s;
}

function makeFlowChart(shapes: Shape[]) {
  const commands: HistoryCommand[] = [];
  const chart = Object.create(FlowChart.prototype) as FlowChart;
  const model = {
    shapes: new Map(shapes.map((s) => [s.id as string, s])),
    edges: [] as unknown[],
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

describe("门面 setNodeText（原地改节点文字）", () => {
  it("改文字后 layout 落定、一条可逆命令 undo/redo 对称", () => {
    const a = stubShape("a", 100, 100);
    a.text.text = "处理请求";
    const { chart, commands } = makeFlowChart([a]);
    let laid = 0;
    a.layout = () => laid++;
    expect(chart.setNodeText("a", "校验通过？")).toBe(true);
    expect(a.text.text).toBe("校验通过？");
    expect(laid).toBe(1);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("text");
    commands[0]!.undo();
    expect(a.text.text).toBe("处理请求");
    commands[0]!.redo();
    expect(a.text.text).toBe("校验通过？");
  });

  it("唯一文字（改前文字）可定位节点；同文字与找不到节点都不记命令", () => {
    const a = stubShape("a", 100, 100);
    a.text.text = "处理请求";
    const { chart, commands } = makeFlowChart([a]);
    // 同文字：视为无变化
    expect(chart.setNodeText("处理请求", "处理请求")).toBe(false);
    expect(commands).toHaveLength(0);
    // 按改前唯一文字定位生效
    expect(chart.setNodeText("处理请求", "校验通过？")).toBe(true);
    expect(a.text.text).toBe("校验通过？");
    expect(commands).toHaveLength(1);
    // 不存在的节点
    expect(chart.setNodeText("ghost", "x")).toBe(false);
    expect(commands).toHaveLength(1);
  });

  it("允许改成空文字（画布允许无文字节点）", () => {
    const a = stubShape("a", 100, 100);
    a.text.text = "处理请求";
    const { chart } = makeFlowChart([a]);
    expect(chart.setNodeText("a", "")).toBe(true);
    expect(a.text.text).toBe("");
  });
});
