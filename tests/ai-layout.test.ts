import { describe, expect, it } from "vitest";
import {
  defaultAIFlowPrompt,
  inferFlowShape,
  normalizeAIFlowGraph,
  parseAIFlowResponse,
  toSemanticGraph,
} from "../src/ai-protocol";
import { layoutFlowGraph } from "../src/auto-layout";
import type { FlowData } from "../src/data";

const reviewGraph = {
  nodes: [
    { id: "start", shape: "ellipse", text: "开始" },
    { id: "handle", shape: "rect", text: "处理请求" },
    { id: "check", shape: "diamond", text: "校验通过？" },
    { id: "ok", shape: "ellipse", text: "返回成功" },
    { id: "retry", shape: "rect", text: "返回错误" },
  ],
  edges: [
    { from: "start", to: "handle" },
    { from: "handle", to: "check" },
    { from: "check", to: "ok", text: "是" },
    { from: "check", to: "retry", text: "否" },
  ],
};

function overlaps(a: FlowData["nodes"][number], b: FlowData["nodes"][number]) {
  const w = (n: typeof a) => n.width ?? 160;
  const h = (n: typeof a) => n.height ?? 99;
  return a.x < b.x + w(b) && b.x < a.x + w(a) && a.y < b.y + h(b) && b.y < a.y + h(a);
}

describe("AI 语义图协议", () => {
  it("解析裸语义图 / graph 包装 / markdown 代码块 / render 操作", () => {
    const raw = JSON.stringify(reviewGraph);
    expect(parseAIFlowResponse(raw).graph?.nodes).toHaveLength(5);
    expect(parseAIFlowResponse(`{"graph":${raw}}`).graph?.edges).toHaveLength(4);
    expect(parseAIFlowResponse("```json\n" + raw + "\n```").graph?.nodes[0]?.id).toBe("start");
    expect(
      parseAIFlowResponse(`{"ops":[{"op":"render","graph":${raw}}]}`).graph?.nodes,
    ).toHaveLength(5);
  });

  it("纯回答不修改画布；坏 JSON 文本整体作为回答", () => {
    expect(parseAIFlowResponse('{"answer":"这张图缺少结束节点"}')).toEqual({
      answer: "这张图缺少结束节点",
    });
    expect(parseAIFlowResponse("我不是 JSON")).toEqual({ answer: "我不是 JSON" });
    expect(() => parseAIFlowResponse('{"foo":1}')).toThrow(/缺少 graph 或 answer/);
  });

  it("脏字段整体拒绝；悬空边丢弃；文本引用与重复 id 规整", () => {
    // text 非字符串才是脏字段；空字符串合法（画布允许无文字节点，原样回显）
    expect(() =>
      normalizeAIFlowGraph({ nodes: [{ text: 42 }], edges: [] }),
    ).toThrow(/缺少非空 text/);
    const emptyText = normalizeAIFlowGraph({ nodes: [{ text: "" }], edges: [] });
    expect(emptyText.nodes[0]).toMatchObject({ id: "n1", shape: "rect", text: "" });
    const g = normalizeAIFlowGraph({
      nodes: [
        { id: "a", text: "开始" },
        { id: "a", text: "校验通过？" },
        { text: "结束" },
      ],
      edges: [
        { from: "a", to: "结束" },
        { from: "a", to: "不存在" },
        { from: "开始", to: "ghost" },
      ],
    });
    expect(new Set(g.nodes.map((n) => n.id)).size).toBe(3);
    // 悬空边被丢弃，唯一文本引用被解析成节点 id
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]?.to).toBe(g.nodes[2]?.id);
    expect(g.nodes.every((n) => typeof n.shape === "string")).toBe(true);
  });

  it("形状推断与当前图 → 语义图（剥离全部几何字段）", () => {
    expect(inferFlowShape({ text: "开始" })).toBe("ellipse");
    expect(inferFlowShape({ text: "校验通过？" })).toBe("diamond");
    expect(inferFlowShape({ text: "读取输入" })).toBe("parallelogram");
    expect(inferFlowShape({ shape: "unknown-kind", text: "普通步骤" })).toBe("rect");
    const semantic = toSemanticGraph({
      nodes: [{ id: "a", shape: "rect", x: 10, y: 20, width: 160, height: 99, text: "步骤" }],
      edges: [{ from: "a", to: "a", fromDir: "right", toDir: "top", text: "重试" }],
    });
    expect(JSON.stringify(semantic)).not.toMatch(/"(x|y|width|height|fromDir|toDir)":/);
    expect(semantic.edges[0]).toEqual({ from: "a", to: "a", text: "重试" });
  });

  it("默认提示词明确禁止模型输出坐标与端口方向", () => {
    const prompt = defaultAIFlowPrompt({
      prompt: "画一个审批流程",
      graph: toSemanticGraph({ nodes: [], edges: [] }),
      selection: { nodes: [], edges: [] },
      historyState: { canUndo: false, canRedo: false, undoCount: 0, redoCount: 0 },
      history: [],
    });
    expect(prompt).toContain("严格禁止输出 x、y");
    expect(prompt).toContain("fromDir");
    expect(prompt).toContain("画一个审批流程");
  });
});

describe("语义图 → FlowData 自动布局", () => {
  it("TB：主链逐层下行，端口方向与分支标签由程序计算", () => {
    const data = layoutFlowGraph(reviewGraph);
    expect(data.nodes).toHaveLength(5);
    expect(data.edges).toHaveLength(4);
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    expect(byId.get("handle")!.y).toBeGreaterThan(byId.get("start")!.y);
    expect(byId.get("check")!.y).toBeGreaterThan(byId.get("handle")!.y);
    expect(byId.get("ok")!.y).toBe(byId.get("retry")!.y);
    // 所有边都有显式首尾方向（FlowEdge 创建时冻结，不能留给模型或运行时猜）
    expect(data.edges.every((e) => e.fromDir && e.toDir)).toBe(true);
    const main = data.edges.find((e) => e.from === "start" && e.to === "handle");
    expect(main).toMatchObject({ fromDir: "bottom", toDir: "top" });
    const branches = data.edges.filter((e) => e.from === "check");
    expect(new Set(branches.map((e) => e.fromDir)).size).toBe(2);
    expect(branches.map((e) => e.text).sort()).toEqual(["否", "是"]);
    expect(branches.every((e) => e.toDir === "top")).toBe(true);
  });

  it("LR：主方向改为横向，节点 x 递增、端口换到左右", () => {
    const data = layoutFlowGraph(reviewGraph, { direction: "LR" });
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    expect(byId.get("handle")!.x).toBeGreaterThan(byId.get("start")!.x);
    const main = data.edges.find((e) => e.from === "start" && e.to === "handle");
    expect(main).toMatchObject({ fromDir: "right", toDir: "left" });
  });

  it("循环图：回边单独走外侧绕行端口，分层不死循环", () => {
    const data = layoutFlowGraph({
      nodes: [
        { id: "a", text: "开始" },
        { id: "b", text: "处理" },
        { id: "c", text: "重试？" },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
        { from: "c", to: "a", text: "否" },
      ],
    });
    expect(data.nodes).toHaveLength(3);
    expect(new Set(data.nodes.map((n) => n.y)).size).toBe(3);
    const back = data.edges.find((e) => e.from === "c" && e.to === "a");
    expect(back).toMatchObject({ fromDir: "right", toDir: "right", text: "否" });
    expect(data.edges.filter((e) => e !== back).every((e) => e.fromDir === "bottom")).toBe(true);
  });

  it("节点互不重叠、层间距容得下两端引出直段；空图不抛错", () => {
    const data = layoutFlowGraph(reviewGraph);
    for (let i = 0; i < data.nodes.length; i++) {
      for (let j = i + 1; j < data.nodes.length; j++) {
        expect(overlaps(data.nodes[i]!, data.nodes[j]!)).toBe(false);
      }
    }
    const layers = [...new Set(data.nodes.map((n) => n.y))].sort((a, b) => a - b);
    expect(layers[1]! - layers[0]!).toBeGreaterThanOrEqual(56);
    expect(layoutFlowGraph({ nodes: [], edges: [] })).toEqual({ nodes: [], edges: [] });
  });
});
