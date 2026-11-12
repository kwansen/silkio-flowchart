// 门面 updateEdge 单测：用原型桩注入最小协作对象，验证「一次更新边的首尾」
// 的端口方向、端点节点、语义定位与一条原子命令（一次 undo 整体回退）。
// Shape/FlowEdge 用原型桩，避开 Text 的 DOM 文本测量。
import { describe, expect, it } from "vitest";
import type { HistoryCapability, HistoryCommand } from "@silker/core";
import { FlowChart } from "../src/flowchart";
import { FlowEdge } from "../src/FlowEdge";
import type { PortDir } from "../src/FlowEdge";
import { Shape } from "../src/Shape";

function stubShape(id: string, x: number, y: number): Shape {
  const s = Object.create(Shape.prototype) as Shape;
  Object.assign(s, {
    id,
    x,
    y,
    width: 160,
    height: 99,
    text: { text: id },
  });
  s.center = () => ({ x: s.x + s.width / 2, y: s.y + s.height / 2 });
  return s;
}

function stubEdge(from: Shape, to: Shape, fromDir: PortDir, toDir: PortDir, text = "") {
  const e = Object.create(FlowEdge.prototype) as FlowEdge;
  Object.assign(e, { id: "e1", fromNode: from, toNode: to, fromDir, toDir, label: { text } });
  return e;
}

function makeFlowChart(edges: FlowEdge[], shapes: Shape[]) {
  const commands: HistoryCommand[] = [];
  const chart = Object.create(FlowChart.prototype) as FlowChart;
  Object.assign(chart, {
    model: {
      shapes: new Map(shapes.map((s) => [s.id as string, s])),
      edges,
    },
    history: { record: (cmd: HistoryCommand) => commands.push(cmd) } as unknown as HistoryCapability,
    interactions: { busy: false },
    editing: { editing: null },
    app: { requestRender: () => {} },
    onChange: undefined,
  });
  return { chart, commands };
}

const a = () => stubShape("a", 100, 100);
const b = () => stubShape("b", 400, 100);

describe("门面 updateEdge（更新一条边的首尾）", () => {
  it("把 a.bottom → b.top 改成 a.right → b.left：两端一次变更、一次 undo 整体回退", () => {
    const from = a();
    const to = b();
    const edge = stubEdge(from, to, "bottom", "top");
    const { chart, commands } = makeFlowChart([edge], [from, to]);
    const ok = chart.updateEdge(
      { from: "a", to: "b" },
      { fromDir: "right", toDir: "left" },
    );
    expect(ok).toBe(true);
    expect(edge.fromNode).toBe(from);
    expect(edge.toNode).toBe(to);
    expect(edge.fromDir).toBe("right");
    expect(edge.toDir).toBe("left");
    // 两端合成一条组合命令
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("reconnect");
    commands[0]!.undo();
    expect(edge.fromDir).toBe("bottom");
    expect(edge.toDir).toBe("top");
    commands[0]!.redo();
    expect(edge.fromDir).toBe("right");
    expect(edge.toDir).toBe("left");
  });

  it("只改一端时另一端保持原方向；省略方向时按最终拓扑自动选边", () => {
    const from = a();
    const to = b();
    const edge = stubEdge(from, to, "bottom", "top");
    const { chart } = makeFlowChart([edge], [from, to]);
    expect(chart.updateEdge("e1", { fromDir: "right" })).toBe(true);
    expect(edge.fromDir).toBe("right");
    expect(edge.toDir).toBe("top");

    const c = stubShape("c", 700, 100); // 在 a 右侧
    const { chart: chart2 } = makeFlowChart([edge], [from, to, c]);
    expect(chart2.updateEdge("e1", { to: "c" })).toBe(true);
    expect(edge.toNode).toBe(c);
    expect(edge.toDir).toBe("left");
  });

  it("按分支标签定位同对节点的多条边；找不到边 / 无变化都不记命令", () => {
    const from = a();
    const to = b();
    const yes = stubEdge(from, to, "bottom", "top", "是");
    const no = stubEdge(from, to, "bottom", "top", "否");
    const { chart, commands } = makeFlowChart([yes, no], [from, to]);
    expect(
      chart.updateEdge({ from: "a", to: "b", text: "是" }, { fromDir: "right" }),
    ).toBe(true);
    expect(yes.fromDir).toBe("right");
    expect(no.fromDir).toBe("bottom");
    expect(commands).toHaveLength(1);

    expect(chart.updateEdge({ from: "a", to: "ghost" }, { fromDir: "right" })).toBe(false);
    // 无变化：不记新命令
    expect(chart.updateEdge("e1", { fromDir: "right" })).toBe(true);
    expect(commands).toHaveLength(1);
  });

  it("只改分支标签：text 给出即改（空串清除）；与首尾变更合成一条原子命令", () => {
    const from = a();
    const to = b();
    const yes = stubEdge(from, to, "bottom", "top", "是");
    // 真实 layout 依赖 DOM 文本测量：桩环境覆写为空操作
    yes.layout = () => {};
    const { chart, commands } = makeFlowChart([yes], [from, to]);
    // 只改标签：端口不动
    expect(
      chart.updateEdge({ from: "a", to: "b", text: "是" }, { text: "通过" }),
    ).toBe(true);
    expect(yes.label.text).toBe("通过");
    expect(yes.fromDir).toBe("bottom");
    expect(commands).toHaveLength(1);
    expect(commands[0]!.type).toBe("text");
    commands[0]!.undo();
    expect(yes.label.text).toBe("是");
    commands[0]!.redo();
    expect(yes.label.text).toBe("通过");

    // 与旧值相同：无变化不记命令
    expect(chart.updateEdge({ from: "a", to: "b" }, { text: "通过" })).toBe(true);
    expect(commands).toHaveLength(1);

    // 空字符串清除标签
    expect(chart.updateEdge("e1", { text: "" })).toBe(true);
    expect(yes.label.text).toBe("");
    expect(commands).toHaveLength(2);

    // 标签 + 端口一起改：一条原子命令，undo 整体回退
    const other = stubEdge(from, to, "bottom", "top", "否");
    other.layout = () => {};
    const { chart: chart2, commands: cmds2 } = makeFlowChart([other], [from, to]);
    expect(
      chart2.updateEdge({ from: "a", to: "b" }, { fromDir: "right", text: "通过" }),
    ).toBe(true);
    expect(other.fromDir).toBe("right");
    expect(other.label.text).toBe("通过");
    expect(cmds2).toHaveLength(1);
    cmds2[0]!.undo();
    expect(other.fromDir).toBe("bottom");
    expect(other.label.text).toBe("否");
  });
});
