import type { BuiltinShapeKind, FlowData, ShapeKind } from "./data";
import type { FlowLayoutOptions } from "./auto-layout";

// AI 生成领域协议：语义图（LLM 输出的协议）+ 请求/结果契约 + 输出规整纯函数。
//
// 与 mindmap 的关键差异：flowchart 的画布数据 FlowData 是「拓扑 + 几何」混合格式
// （节点带绝对 x/y，边带创建时冻结的 fromDir/toDir 端口方向）。这两部分都是
// 确定性几何问题，不该交给 LLM：模型既算不准坐标，也算不准正交折线该从哪条边
// 出入。因此本模块把两者拆开——
//   1. LLM 只输出语义图 { nodes, edges }：节点文本/形状、边两端与分支标签；
//   2. 程序用 layoutFlowGraph() 把语义图编译成 FlowData（算 x/y 与端口方向）。
// 这样 AI 生成与 mindmap 的「树 → 自动布局」完全同构，只是布局器从树布局换成
// DAG 分层布局。本模块不绑定任何具体 LLM SDK：宿主经 FlowChartOptions.ai 注入
// 生成适配器（拿到上下文快照 → 调自家大模型 → 返回语义图或其 JSON 字符串）。

// ---- 语义图（LLM 输出的协议）----

// 语义节点：不含 x/y/width/height。id 缺省或冲突时由规整器补全；
// shape 只允许内置六种形状（未知值降级为 rect），role 供形状推断使用
export type AIFlowRole = "start" | "end" | "decision" | "io" | "process" | "data" | "note";

export interface AIFlowNode {
  id?: string;
  shape?: ShapeKind;
  role?: AIFlowRole;
  // 节点文本（必填，非空）
  text: string;
}

// 语义边：from/to 为节点 id（也容忍节点文本唯一匹配），text 为分支标签
// （判断节点的「是/否」「通过/驳回」等）。绝不含端口方向。
export interface AIFlowEdge {
  from: string;
  to: string;
  text?: string;
}

export interface AIFlowGraph {
  nodes: AIFlowNode[];
  edges: AIFlowEdge[];
}

// 规整后的语义图：id 唯一且必填、形状已收敛到内置 kind、悬空边已剔除。
// 布局器只消费这一形态，不必再处理模型输出的脏字段
export interface NormalizedFlowNode {
  id: string;
  shape: BuiltinShapeKind;
  text: string;
}
export interface NormalizedFlowGraph {
  nodes: NormalizedFlowNode[];
  edges: AIFlowEdge[];
}

// 对话流中的一轮（宿主消息流，按时间先后，不含本次指令）
export interface AIFlowTurn {
  role: "user" | "assistant";
  text: string;
}

// 生成适配器的输入：用户指令 + 当前画布的语义图快照（带 id，已剥离坐标/方向）
// + 多轮对话上下文。快照用于「在现有流程上改」类指令：模型保留未变节点的 id，
// 程序据此重新布局整张图。
export interface AIFlowEditRequest {
  prompt: string;
  graph: AIFlowGraph;
  history: AIFlowTurn[];
}

// 生成适配器契约：宿主实现（调自家 LLM），返回语义图对象、其 JSON 字符串，
// 或纯文本回答（提问/咨询类指令，此时不修改画布）
export type AIFlowGenerate = (
  req: AIFlowEditRequest,
) => Promise<AIFlowGraph | string>;

export interface AIFlowRunOptions {
  // 对话历史（按时间先后，不含本次指令）：缺省无历史（单轮）
  history?: AIFlowTurn[];
  // 布局参数（方向 / 间距 / 尺寸），缺省用 layoutFlowGraph 的内置默认值
  layout?: FlowLayoutOptions;
}

export interface AIFlowRunResult {
  // 本次生效的语义图（纯回答类指令为当前图，未改动）
  graph: AIFlowGraph;
  // 落到画布的数据（含程序算出的 x/y 与端口方向）
  data: FlowData;
  // AI 的自然语言回答（提问/咨询类指令，或伴随修改的说明）
  answer?: string;
}

// ---- 形状推断（纯函数，导出便于测试）----

const BUILTIN_SHAPES: BuiltinShapeKind[] = [
  "rect",
  "diamond",
  "ellipse",
  "parallelogram",
  "hexagon",
  "database",
];

const ROLE_SHAPE: Record<AIFlowRole, BuiltinShapeKind> = {
  start: "ellipse",
  end: "ellipse",
  decision: "diamond",
  io: "parallelogram",
  process: "rect",
  data: "database",
  note: "rect",
};

// 形状兜底：合法内置 kind 优先，其次 role，最后按文本语义推断。
// 模型即使完全省略 shape 也能得到符合流程图惯例的形状。
export function inferFlowShape(node: {
  shape?: unknown;
  role?: unknown;
  text: string;
}): BuiltinShapeKind {
  const shape = typeof node.shape === "string" ? node.shape.toLowerCase() : "";
  if (BUILTIN_SHAPES.includes(shape as BuiltinShapeKind)) {
    return shape as BuiltinShapeKind;
  }
  if (typeof node.role === "string" && node.role in ROLE_SHAPE) {
    return ROLE_SHAPE[node.role as AIFlowRole];
  }
  const t = node.text.trim();
  if (/^(开始|结束|起点|终点|start|end)$/i.test(t)) return "ellipse";
  if (/[?？]|是否|判断|校验|检查|通过|满足条件/.test(t)) return "diamond";
  if (/输入|输出|读取|打印|录入|导出|上报/.test(t)) return "parallelogram";
  if (/数据库|存储|数据表|\bdb\b/i.test(t)) return "database";
  return "rect";
}

// 当前画布 → 语义图：剥掉全部几何信息（x/y/尺寸/端口方向），只留拓扑与文本。
// 供提示词上下文与「在现有图上修改」使用。
export function toSemanticGraph(data: FlowData): AIFlowGraph {
  return {
    nodes: data.nodes.map((n) => ({
      id: n.id,
      shape: n.shape,
      text: n.text,
    })),
    edges: data.edges.map((e) => ({
      from: e.from,
      to: e.to,
      ...(e.text ? { text: e.text } : {}),
    })),
  };
}

// ---- 输出规整 ----

// 校验并规整 LLM 返回的语义图：补齐/去重 id、推断形状、丢弃悬空边、去重重复边。
// 与 mindmap 的 normalizeAIOps 同策略——脏字段直接抛错（不做部分应用），
// 但引用不存在的边属于常见模型失误，静默丢弃更符合「能生成就先出图」的体验。
export function normalizeAIFlowGraph(raw: unknown): NormalizedFlowGraph {
  const data = raw as { nodes?: unknown; edges?: unknown } | null;
  if (!data || !Array.isArray(data.nodes)) {
    throw new Error("AI 返回格式错误：缺少 nodes 数组");
  }
  const used = new Set<string>();
  let seq = 0;
  const nextId = (): string => {
    let id: string;
    do {
      id = `n${++seq}`;
    } while (used.has(id));
    used.add(id);
    return id;
  };
  const nodes: NormalizedFlowNode[] = [];
  for (let i = 0; i < data.nodes.length; i++) {
    const n = data.nodes[i] as AIFlowNode | null;
    if (!n || typeof n.text !== "string" || !n.text.trim()) {
      throw new Error(`AI 返回的 nodes[${i}] 缺少非空 text`);
    }
    const given = typeof n.id === "string" && n.id.trim() ? n.id.trim() : "";
    // 重复 id / 缺失 id 一律重新分配，避免语义图中两个节点互相覆盖
    const id = given && !used.has(given) ? given : nextId();
    used.add(id);
    nodes.push({ id, shape: inferFlowShape(n), text: n.text.trim() });
  }

  // 引用解析：id 优先，其次按唯一文本匹配（模型常用节点文本当 from/to）
  const byId = new Set(nodes.map((n) => n.id));
  const textHits = new Map<string, string[]>();
  for (const n of nodes) {
    const key = n.text.trim();
    textHits.set(key, [...(textHits.get(key) ?? []), n.id]);
  }
  const resolveRef = (ref: unknown): string | null => {
    if (typeof ref !== "string" || !ref.trim()) return null;
    const r = ref.trim();
    if (byId.has(r)) return r;
    const hits = textHits.get(r);
    return hits?.length === 1 ? hits[0]! : null;
  };

  const edges: AIFlowEdge[] = [];
  const seen = new Set<string>();
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];
  for (const e of rawEdges as Array<AIFlowEdge | null>) {
    const from = resolveRef(e?.from);
    const to = resolveRef(e?.to);
    if (!from || !to) continue;
    const text = typeof e?.text === "string" && e.text.trim() ? e.text.trim() : undefined;
    const key = `${from}→${to}:${text ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ from, to, ...(text ? { text } : {}) });
  }
  return { nodes, edges };
}

// 解析 AI 响应为「语义图 + 回答」。容错与 mindmap 的 parseAIResponse 对齐：
// 1. ```json 代码块 / 前后空白自动剥离
// 2. 裸语义图 {nodes,edges} / {graph:{...}} / {ops:[{op:"render",graph}]}
// 3. {answer:"..."} 或 {ops:[],answer:"..."}：纯回答，不修改画布
// 4. 非 JSON 纯文本：整体视为回答（模型输出坏 JSON 时也能看到它说了什么）
export function parseAIFlowResponse(
  raw: AIFlowGraph | string,
): { graph?: AIFlowGraph; answer?: string } {
  let data: unknown = raw;
  if (typeof raw === "string") {
    const text = raw
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/```\s*$/, "")
      .trim();
    try {
      data = JSON.parse(text);
    } catch {
      if (!text) throw new Error("AI 返回内容为空");
      return { answer: text };
    }
  }
  const obj = data as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") {
    throw new Error("AI 返回格式错误：应为语义图 JSON 对象");
  }
  const answer = typeof obj.answer === "string" && obj.answer.trim()
    ? obj.answer.trim()
    : undefined;
  let graphSource: unknown = obj.graph ?? (Array.isArray(obj.nodes) ? obj : undefined);
  // 操作数组形式：取最后一条 render 操作（增量操作暂不在本场景支持）
  if (graphSource === undefined && Array.isArray(obj.ops)) {
    for (const op of obj.ops as Array<Record<string, unknown>>) {
      if (op?.op === "render" && op.graph) graphSource = op.graph;
    }
  }
  if (graphSource === undefined) {
    if (answer !== undefined) return { answer };
    throw new Error("AI 返回格式错误：缺少 graph 或 answer");
  }
  return { graph: normalizeAIFlowGraph(graphSource), answer };
}

// ---- 默认提示词 ----

// AI 生成提示词模板：把请求渲染为大模型可直接使用的指令。核心约束是
// 「禁止输出任何几何字段」——坐标与端口方向由程序布局器计算，模型只需描述
// 流程语义。宿主可自行替换提示词，只需遵守上面的语义图协议。
export function defaultAIFlowPrompt(req: AIFlowEditRequest): string {
  return [
    "你是流程图生成助手。需要生成或修改流程图时，只输出一个 JSON 对象，不要输出解释文字，不要用代码块包裹。",
    "输出格式：",
    '{"nodes":[{"id":"n1","shape":"ellipse","text":"开始"},{"id":"n2","shape":"diamond","text":"校验通过？"}],"edges":[{"from":"n1","to":"n2"},{"from":"n2","to":"n3","text":"是"}]}',
    "字段说明：",
    "- nodes[].id：节点唯一标识，字符串；新节点可以给新 id 或省略（程序自动补全）。",
    "- nodes[].shape：只允许 rect（步骤）、diamond（判断）、ellipse（开始/结束）、parallelogram（输入/输出）、hexagon（准备）、database（存储）。也可以用 role 字段代替（start/end/decision/io/process/data），程序会自动推断形状。",
    "- nodes[].text：节点文字，简短；判断节点写成问句。",
    "- edges[].from / edges[].to：必须是 nodes 中存在的 id。edges[].text 只写分支短标签（是/否、通过/驳回、超时等），普通连线省略。",
    "严格禁止输出 x、y、width、height、坐标、位置、fromDir、toDir、端口方向、连线出入边等几何字段：布局和连线方向由程序自动计算，输出这些字段会导致生成失败。",
    "绘图规则：",
    "- 有且仅有一个开始节点；判断节点的每条出边都要写分支标签；流程要能走到结束节点。",
    "- 循环/回退用一条指回已有节点的边表示，不要复制出重复节点；不要出现没有连线的孤立节点。",
    "- 修改现有流程图时，保留未改动节点的 id 与文字，只增删需要变化的节点和边，输出完整的最终图（不是补丁）。",
    "- 仅提问、咨询、无需改图时输出 {\"answer\":\"回答文本\"} 或纯文本，不要输出 nodes/edges。",
    "",
    // 对话历史：多轮上下文，取最近若干轮防止提示词膨胀
    ...(req.history.length
      ? [
          "对话历史（按时间先后，仅供理解上下文）：",
          ...req.history
            .slice(-10)
            .map((t) => `${t.role === "user" ? "用户" : "助手"}：${t.text}`),
          "",
        ]
      : []),
    "当前流程图（语义图，已剥离全部坐标与方向信息）：",
    JSON.stringify(req.graph),
    "",
    `用户指令：${req.prompt}`,
  ].join("\n");
}
