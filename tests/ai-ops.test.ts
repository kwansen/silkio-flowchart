import { describe, expect, it } from "vitest";
import {
  defaultAIFlowPrompt,
  normalizeAIFlowOps,
  parseAIFlowOps,
  parseAIFlowResponse,
  toSemanticGraph,
} from "../src/ai-protocol";
import { describeHistoryCommand } from "../src/ai-report";

const graph = {
  nodes: [
    { id: "start", shape: "ellipse", text: "开始" },
    { id: "check", shape: "diamond", text: "校验通过？" },
  ],
  edges: [{ from: "start", to: "check" }],
};

// 历史文案只需形状表按 id 解析文本：用最小桩模型替代真实 FlowModel
const stubModel = {
  shapes: new Map([["start", { text: { text: "开始" } }]]),
} as unknown as Parameters<typeof describeHistoryCommand>[1];

describe("AI 操作协议", () => {
  it("裸语义图 / graph 包装等价于一条 render 操作", () => {
    for (const raw of [JSON.stringify(graph), `{"graph":${JSON.stringify(graph)}}`]) {
      const { ops } = parseAIFlowOps(raw);
      expect(ops).toHaveLength(1);
      expect(ops[0]?.op).toBe("render");
      if (ops[0]?.op === "render") expect(ops[0].graph.nodes).toHaveLength(2);
    }
  });

  it("解析 ops 数组 / 单个操作对象 / 控制类操作", () => {
    const { ops, answer } = parseAIFlowOps(
      '{"ops":[{"op":"undo"},{"op":"redo"},{"op":"history"}],"answer":"已按顺序执行"}',
    );
    expect(ops.map((o) => o.op)).toEqual(["undo", "redo", "history"]);
    expect(answer).toBe("已按顺序执行");
    // 模型常省略外层数组：单个操作对象也应识别
    expect(parseAIFlowOps('{"op":"undo"}').ops).toEqual([{ op: "undo" }]);
    // render 允许省略 graph 包装（节点/边直接挂在操作上）
    const inline = parseAIFlowOps(`{"op":"render","nodes":${JSON.stringify(graph.nodes)},"edges":${JSON.stringify(graph.edges)}}`);
    expect(inline.ops[0]?.op).toBe("render");
  });

  it("answer 操作提取为回答，纯文本整体作为回答", () => {
    expect(parseAIFlowOps('{"ops":[{"op":"answer","text":"当前选中 1 个节点"}]}')).toEqual({
      ops: [],
      answer: "当前选中 1 个节点",
    });
    expect(parseAIFlowOps("画布上没有开始节点")).toEqual({
      ops: [],
      answer: "画布上没有开始节点",
    });
  });

  it("非法操作整体拒绝：未知类型 / render 缺图 / answer 缺文本", () => {
    expect(() => normalizeAIFlowOps([{ op: "delete" }])).toThrow(/未知操作类型/);
    expect(() => normalizeAIFlowOps([{ op: "render" }])).toThrow(/缺少 graph/);
    expect(() => normalizeAIFlowOps([{ op: "answer" }])).toThrow(/缺少 text/);
    expect(() => parseAIFlowOps('{"foo":1}')).toThrow(/缺少 graph 或 answer/);
  });

  it("兼容入口 parseAIFlowResponse 仍按最后一条 render 取图", () => {
    const raw = `{"ops":[{"op":"history"},{"op":"render","graph":${JSON.stringify(graph)}}]}`;
    expect(parseAIFlowResponse(raw).graph?.nodes).toHaveLength(2);
    expect(parseAIFlowResponse('{"ops":[{"op":"undo"}]}')).toEqual({ graph: undefined, answer: undefined });
  });
});

describe("AI 提示词上下文", () => {
  const base = {
    prompt: "撤销一步",
    graph: toSemanticGraph({ nodes: [], edges: [] }),
    history: [],
  };

  it("注入选中与历史状态，并限定对话类操作的输出形式", () => {
    const prompt = defaultAIFlowPrompt({
      ...base,
      selection: { nodes: [{ id: "a", shape: "rect", text: "处理" }], edges: [] },
      historyState: { canUndo: true, canRedo: false, undoCount: 2, redoCount: 0 },
    });
    expect(prompt).toContain("可撤销 2 条，可重做 0 条");
    expect(prompt).toContain('"text":"处理"');
    expect(prompt).toContain('"op":"undo"');
    expect(prompt).toContain('"op":"history"');
  });

  it("无选中时明确告知为空，避免模型编造选中节点", () => {
    const prompt = defaultAIFlowPrompt({
      ...base,
      prompt: "我选中了什么",
      selection: { nodes: [], edges: [] },
      historyState: { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 },
    });
    expect(prompt).toContain("当前选中：无");
  });
});

describe("历史命令可读描述", () => {
  it("按 kind 还原成文案，节点文本经模型解析", () => {
    expect(
      describeHistoryCommand(
        { kind: "flowchart.move", payload: { v: "abs", before: [{ shapeId: "start", x: 0, y: 0 }] } },
        stubModel,
      ),
    ).toBe("移动「开始」");
    expect(
      describeHistoryCommand(
        { kind: "flowchart.text", payload: { shapeId: "start", before: "开始", after: "入口" } },
        stubModel,
      ),
    ).toBe("将「开始」改为「入口」");
    expect(
      describeHistoryCommand(
        { kind: "flowchart.add-shape", payload: { data: { shape: "diamond", text: "通过？" } } },
        stubModel,
      ),
    ).toBe("添加判断节点「通过？」");
  });

  it("组合命令递归描述；未知 kind 退化为 kind 原文", () => {
    const text = describeHistoryCommand(
      {
        kind: "composite",
        payload: {
          children: [
            { kind: "flowchart.add-shape", payload: { data: { shape: "rect", text: "A" } } },
            { kind: "flowchart.connect", payload: { fromId: "start", toId: "x" } },
          ],
        },
      },
      stubModel,
    );
    expect(text).toBe("添加矩形节点「A」；连接「开始」→「（已不存在的节点）」");
    expect(describeHistoryCommand({ kind: "vendor.custom", payload: null }, stubModel)).toBe(
      "vendor.custom",
    );
  });
});
