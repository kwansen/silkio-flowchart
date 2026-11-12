import { describe, expect, it } from "vitest";
import {
  defaultAIFlowPrompt,
  inferFlowShape,
  normalizeAIFlowGraph,
  parseAIFlowResponse,
  mergeFlowGeometry,
  toSemanticGraph,
} from "../src/ai-protocol";
import { layoutFlowGraph } from "../src/auto-layout";
import type { FlowData } from "../src/data";
import { placeNodeInDirection } from "../src/geometry";

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

  it("几何部分合并：已有节点沿用几何，新增节点复用端口手柄快速创建几何", () => {
    // 手动排的「左右」版式（AI 布局器会重排成上下分层）
    const current: FlowData = {
      nodes: [
        { id: "a", shape: "rect", x: 60, y: 220, width: 160, height: 99, text: "处理" },
        { id: "b", shape: "rect", x: 400, y: 220, width: 160, height: 99, text: "校验" },
      ],
      edges: [{ from: "a", to: "b", fromDir: "right", toDir: "left" }],
    };
    // 布局器输出：TB 分层（a 上、b 下），且 b 改为菱形、文字更新
    const laid: FlowData = {
      nodes: [
        { id: "a", shape: "rect", x: 80, y: 80, width: 160, height: 99, text: "处理" },
        { id: "b", shape: "diamond", x: 80, y: 279, width: 160, height: 99, text: "校验通过？" },
      ],
      edges: [{ from: "a", to: "b", fromDir: "bottom", toDir: "top" }],
    };
    // 拓扑不变（改 b 的形状+文字）：保留当前 x/y/尺寸与连线方向，仅套用语义变更
    const merged = mergeFlowGeometry(current, laid);
    expect(merged.nodes).toEqual([
      { id: "a", shape: "rect", x: 60, y: 220, width: 160, height: 99, text: "处理" },
      { id: "b", shape: "diamond", x: 400, y: 220, width: 160, height: 99, text: "校验通过？" },
    ]);
    expect(merged.edges).toEqual(current.edges);

    // 拓扑有变（在 b 下新增节点 c，b→c 连线）：既有节点几何不动；新增节点
    // 复用与「点击 b 下方手柄」完全相同的几何（CLICK_CREATE_GAP = 80）
    const added = mergeFlowGeometry(current, {
      nodes: [
        ...laid.nodes,
        { id: "c", shape: "rect", x: 80, y: 478, width: 160, height: 99, text: "新步骤" },
      ],
      edges: [...laid.edges, { from: "b", to: "c" }],
    });
    expect(added.nodes.map((n) => n.id)).toEqual(["a", "b", "c"]);
    expect(added.nodes[2]).toMatchObject({
      id: "c",
      ...placeNodeInDirection(
        { x: 400, y: 220, width: 160, height: 99 },
        "bottom",
        { width: 160, height: 99 },
      ),
    });
    expect(added.nodes[0]).toMatchObject({ x: 60, y: 220 });
    expect(added.nodes[1]).toMatchObject({ x: 400, y: 220, shape: "diamond" });
    // 既有连线沿用冻结方向；新增连线（b → c）省略端口方向，由 FlowEdge 自动选边
    expect(added.edges[0]).toEqual(current.edges[0]);
    expect(added.edges[1]).toEqual({ from: "b", to: "c" });

    // 孤立新增节点（无任何连线）：退回全局平均位移
    // = a:(-20, +140) 与 b:(+320, -59) 的平均 = (+150, +40.5) → c 落在 (230, 519)
    const isolated = mergeFlowGeometry(current, {
      nodes: [
        ...laid.nodes,
        { id: "c", shape: "rect", x: 80, y: 478, width: 160, height: 99, text: "便签" },
      ],
      edges: laid.edges,
    });
    expect(isolated.nodes[2]).toMatchObject({ id: "c", x: 230, y: 519 });

    // 链式新增（b→c→d）：d 以刚落位的 c 为锚，继续沿手柄方向排布
    const chain = mergeFlowGeometry(current, {
      nodes: [
        ...laid.nodes,
        { id: "c", shape: "rect", x: 80, y: 478, width: 160, height: 99, text: "新步骤" },
        { id: "d", shape: "rect", x: 80, y: 677, width: 160, height: 99, text: "再一步" },
      ],
      edges: [...laid.edges, { from: "b", to: "c" }, { from: "c", to: "d" }],
    });
    expect(chain.nodes[3]).toMatchObject({
      id: "d",
      ...placeNodeInDirection(
        { x: chain.nodes[2]!.x, y: chain.nodes[2]!.y, width: 160, height: 99 },
        "bottom",
        { width: 160, height: 99 },
      ),
    });

    // 同父两个新增节点会重叠时：第二个退回锚点平移，不与第一个压在一起
    const siblings = mergeFlowGeometry(current, {
      nodes: [
        ...laid.nodes,
        { id: "c", shape: "rect", x: 80, y: 478, width: 160, height: 99, text: "分支一" },
        { id: "d", shape: "rect", x: 80, y: 478, width: 160, height: 99, text: "分支二" },
      ],
      edges: [...laid.edges, { from: "b", to: "c" }, { from: "b", to: "d" }],
    });
    expect(siblings.nodes[3]!.y).not.toBe(siblings.nodes[2]!.y);

    // 删除节点（b 不在语义图中）：被移除，其余几何保留
    const removed = mergeFlowGeometry(
      current,
      laid.nodes.length
        ? { nodes: [laid.nodes[0]!], edges: [] }
        : { nodes: [], edges: [] },
    );
    expect(removed.nodes).toHaveLength(1);
    expect(removed.nodes[0]).toMatchObject({ id: "a", x: 60, y: 220 });
    expect(removed.edges).toEqual([]);

    // 全新画布（无共有节点）：无锚点平移，布局结果原样落地
    const fresh = mergeFlowGeometry({ nodes: [], edges: [] }, laid);
    expect(fresh.nodes).toEqual(laid.nodes);
    expect(fresh.edges).toEqual(laid.edges);
  });

  it("语义边可选 fromDir/toDir：合法值保留、非法值丢弃、坐标仍被剥离", () => {
    const g = normalizeAIFlowGraph({
      nodes: [
        { id: "a", text: "校验通过？" },
        { id: "b", text: "返回成功" },
        { id: "c", text: "返回错误" },
      ],
      edges: [
        { from: "a", to: "b", text: "是", fromDir: "RIGHT", toDir: "top" },
        { from: "a", to: "c", text: "否", fromDir: "below", toDir: 3 },
      ],
    });
    expect(g.edges[0]).toEqual({ from: "a", to: "b", text: "是", fromDir: "right", toDir: "top" });
    // 非法方向静默丢弃（退回自动选边），不让整次 render 失败
    expect(g.edges[1]).toEqual({ from: "a", to: "c", text: "否" });
    expect(JSON.stringify(g)).not.toMatch(/"(x|y|width|height)":/);
  });

  it("形状推断与当前图 → 语义图（剥离坐标尺寸，保留边端口方向）", () => {
    expect(inferFlowShape({ text: "开始" })).toBe("ellipse");
    expect(inferFlowShape({ text: "校验通过？" })).toBe("diamond");
    expect(inferFlowShape({ text: "读取输入" })).toBe("parallelogram");
    expect(inferFlowShape({ shape: "unknown-kind", text: "普通步骤" })).toBe("rect");
    const semantic = toSemanticGraph({
      nodes: [{ id: "a", shape: "rect", x: 10, y: 20, width: 160, height: 99, text: "步骤" }],
      edges: [{ from: "a", to: "a", fromDir: "right", toDir: "top", text: "重试" }],
    });
    // 坐标尺寸剥离；fromDir/toDir 是当前实际出入端口，必须保留供模型改图时带回
    expect(JSON.stringify(semantic)).not.toMatch(/"(x|y|width|height)":/);
    expect(semantic.edges[0]).toEqual({
      from: "a",
      to: "a",
      text: "重试",
      fromDir: "right",
      toDir: "top",
    });
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

  it("语义边显式 fromDir/toDir 覆盖自动选边；自动分支避开被占用出口", () => {
    const data = layoutFlowGraph({
      nodes: [
        { id: "start", text: "开始" },
        { id: "check", text: "校验通过？" },
        { id: "ok", text: "返回成功" },
        { id: "retry", text: "返回错误" },
      ],
      edges: [
        { from: "start", to: "check" },
        // 模型固定「是」从右出、「否」从下出
        { from: "check", to: "ok", text: "是", fromDir: "right" },
        { from: "check", to: "retry", text: "否", fromDir: "bottom" },
      ],
    });
    const byPair = new Map(data.edges.map((e) => [`${e.from}→${e.to}`, e]));
    expect(byPair.get("check→ok")).toMatchObject({ fromDir: "right", toDir: "top" });
    expect(byPair.get("check→retry")).toMatchObject({ fromDir: "bottom", toDir: "top" });
    // toDir 也可覆盖（回边显式指定走左侧绕行）
    const loop = layoutFlowGraph({
      nodes: [
        { id: "a", text: "开始" },
        { id: "b", text: "处理" },
      ],
      edges: [{ from: "b", to: "a", text: "重试", fromDir: "top", toDir: "left" }],
    });
    expect(loop.edges[0]).toMatchObject({ fromDir: "top", toDir: "left" });
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
