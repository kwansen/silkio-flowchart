import type {
  BuiltinShapeKind,
  FlowData,
  FlowEdgeData,
  FlowNodeData,
  ShapeKind,
} from "./data";
import type { FlowLayoutOptions } from "./auto-layout";
import type { PortDir } from "./FlowEdge";
import { dominantPortDir, placeNodeInDirection } from "./geometry";

// createNode 操作允许的四个相对方向（与端口手柄方向一一对应）
const PORT_DIRS: readonly PortDir[] = ["top", "right", "bottom", "left"];

// AI 生成领域协议：语义图（LLM 输出的协议）+ 请求/结果契约 + 输出规整纯函数。
//
// 与 mindmap 的关键差异：flowchart 的画布数据 FlowData 是「拓扑 + 几何」混合格式
// （节点带绝对 x/y，边带创建时冻结的 fromDir/toDir 端口方向）。这两部分都是
// 确定性几何问题，不该交给 LLM：模型既算不准坐标，也算不准正交折线该从哪条边
// 出入。因此本模块把两者拆开——
//   1. LLM 只输出语义图 { nodes, edges }：节点文本/形状、边两端与分支标签；
//   2. 程序用 layoutFlowGraph() 把语义图编译成 FlowData（算 x/y 与端口方向）；
//      方向性的「在 X 旁边新建节点」则走 createNode 操作，直接复用端口手柄
//      快速创建函数（参考节点 + 方向 + 类型），不触碰其他节点的几何。
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
// （判断节点的「是/否」「通过/驳回」等）。fromDir/toDir 可选：模型需要固定
// 某条边「从起点哪侧出、进终点哪侧」（如判断分支「是」右出、「否」下出）时
// 给出；省略则由布局器按拓扑与相对位置自动选边。仍禁止坐标类几何字段。
export interface AIFlowEdge {
  from: string;
  to: string;
  text?: string;
  fromDir?: PortDir;
  toDir?: PortDir;
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

// ---- AI 操作（LLM 输出的协议）----
//
// 改图仍只有一条 render（整图语义替换 + 程序布局），但对话类能力补齐为操作序列：
// 撤销/重做驱动既有历史链（与手动 Ctrl+Z 同源）、history 只读历史供模型复述。
// 与 mindmap 的 ops 协议同构：宿主只需按 op 逐条消费，无需理解画布几何。

// 整图渲染：语义图整体替换当前画布（程序算坐标与端口方向），一条操作即一次原子变更
export interface AIFlowRenderOp {
  op: "render";
  graph: AIFlowGraph;
}

// 在参考节点的指定方向新建节点并自动连边：直接复用端口手柄快速创建函数
// （参考节点 + 方向 + 类型），不重排整张图、不动已有节点几何与视口。
// ref 为节点 id（也容忍唯一文字匹配）；shape 省略时与参考节点同类型
export interface AIFlowCreateNodeOp {
  op: "createNode";
  ref: string;
  dir: PortDir;
  shape?: BuiltinShapeKind;
  text?: string;
}

// 更新一条边的首尾/端口/分支标签：ref 定位当前连线（两端节点 id + 可选分支
// 标签），from/to 为重接后的端点节点（省略保持），fromDir/toDir 为重接后的
// 端口方向（省略按最终拓扑自动选边），text 为新的分支标签（空字符串清除，
// 省略保持）。复用门面 updateEdge，不重排整张图
export interface AIFlowUpdateEdgeOp {
  op: "updateEdge";
  ref: { from: string; to: string; text?: string };
  from?: string;
  to?: string;
  fromDir?: PortDir;
  toDir?: PortDir;
  text?: string;
}

// 原地替换节点形状：复用门面 replaceShape（与工具条 replaceSelected 同一
// swapShape 路径）——保留位置、尺寸、文本、id 与全部连线（两端重绑、端口
// 方向维持冻结值），不重排整张图、不动其他节点。ref 为节点 id（也容忍
// 唯一文字匹配）；shape 为目标内置形状。与 render 混用被整体拒绝
export interface AIFlowReplaceShapeOp {
  op: "replaceShape";
  ref: string;
  shape: BuiltinShapeKind;
}

// 修改节点文字：复用门面 setNodeText（与双击编辑结束同一 textCommand 历史
// 路径）——只改这一个节点的文字并重排居中，位置/尺寸/连线全部不动。ref 为
// 节点 id（也容忍唯一文字匹配，可按改前文字定位）；text 为新文字，允许空
// 字符串（画布允许无文字节点）。与 render 混用被整体拒绝
export interface AIFlowSetNodeTextOp {
  op: "setNodeText";
  ref: string;
  text: string;
}

// 删除一个节点：复用门面 removeNode（与手动 Delete 同一删除命令）——节点
// 连同其关联连线一起删除，undo 按原 z 序索引整体恢复，不重排整张图。
// ref 为节点 id（也容忍唯一文字匹配）。与 render 混用被整体拒绝
export interface AIFlowRemoveNodeOp {
  op: "removeNode";
  ref: string;
}

// 删除一条连线：复用门面 removeEdge（与手动 Delete 同一删除命令）——只摘除
// 这一条连线，两端节点与其它连线不动，undo 按原序插回。ref 为连线 id 或
// 语义定位 { from, to, text? }（同对节点多条分支边用标签区分）。
// 与 render 混用被整体拒绝
export interface AIFlowRemoveEdgeOp {
  op: "removeEdge";
  ref: string | { from: string; to: string; text?: string };
}

// 撤销最近一次变更：直接驱动既有历史链（与手动 Ctrl+Z 完全同源），可连用多次；
// 不能与 render 混用（避免"先撤销再在同一批里改图"的时序歧义）
export interface AIFlowUndoOp {
  op: "undo";
}

// 重做最近一次被撤销的变更：语义与 undo 对称
export interface AIFlowRedoOp {
  op: "redo";
}

// 读取历史：返回撤销/重做栈中各条变更的可读描述（只读，不修改画布），
// 描述并入本次 run 的 answer。用户问"刚才改了什么/做过哪些操作"时使用
export interface AIFlowHistoryOp {
  op: "history";
}

// 回答类回复：AI 对提问/咨询的自然语言回答（不修改画布）。
// LLM 输出 {"op":"answer","text":"..."} 或 {"answer":"..."} 或纯文本均可
export interface AIFlowAnswerOp {
  op: "answer";
  text: string;
}

export type AIFlowOp =
  | AIFlowRenderOp
  | AIFlowCreateNodeOp
  | AIFlowUpdateEdgeOp
  | AIFlowReplaceShapeOp
  | AIFlowSetNodeTextOp
  | AIFlowRemoveNodeOp
  | AIFlowRemoveEdgeOp
  | AIFlowUndoOp
  | AIFlowRedoOp
  | AIFlowHistoryOp
  | AIFlowAnswerOp;

// ---- 上下文：选中与历史状态 ----

// 当前选中：节点来自语义图（shape 已收敛），连线以两端节点 id + 分支标签表达。
// 供"选中的是什么/把选中的节点…"类指令使用；空数组表示画布上无选中
export interface AIFlowSelection {
  nodes: AIFlowNode[];
  edges: AIFlowEdge[];
}

// 历史栈状态：让模型知道能否撤销/重做、还有多少条，避免凭空猜测或试图
// 用"重新生成整图"模拟撤销
export interface AIFlowHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoCount: number;
  redoCount: number;
}

// 对话流中的一轮（宿主消息流，按时间先后，不含本次指令）
export interface AIFlowTurn {
  role: "user" | "assistant";
  text: string;
}

// 生成适配器的输入：用户指令 + 当前画布的语义图快照（带 id 与边的当前端口
// 方向，已剥离坐标尺寸）
// + 选中上下文 + 历史栈状态 + 多轮对话上下文。快照用于「在现有流程上改」类指令：
// 模型保留未变节点的 id，程序据此重新布局整张图。
export interface AIFlowEditRequest {
  prompt: string;
  graph: AIFlowGraph;
  // 当前选中的节点/连线（可能为空）：只读上下文，模型不应修改未出现在其中的对象
  selection: AIFlowSelection;
  // 撤销/重做栈状态（只读）
  historyState: AIFlowHistoryState;
  history: AIFlowTurn[];
}

// 生成适配器契约：宿主实现（调自家 LLM），返回操作数组、语义图对象、其 JSON
// 字符串，或纯文本回答（提问/咨询类指令，此时不修改画布）
export type AIFlowGenerate = (
  req: AIFlowEditRequest,
) => Promise<AIFlowOp[] | AIFlowGraph | string>;

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
  // AI 的自然语言回答（提问/咨询类指令、history 的历史描述，或伴随修改的说明）
  answer?: string;
  // 实际生效的变更条数：render 记 1，undo/redo 为成功驱动历史链的次数，
  // 纯回答/被跳过的操作记 0
  applied: number;
  // 逐步执行反馈链：每条操作做了什么、是否被跳过，宿主可直接展示
  steps: AIFlowStep[];
}

// 单条操作的执行反馈：便于定位"说了撤销却没反应"类问题（无可撤销变更、
// 与改图操作混用被拒等）
export interface AIFlowStep {
  op: AIFlowOp;
  // 可读描述："撤销最近一次变更" / "按语义图重绘（5 个节点、4 条连线）"
  label: string;
  // applied = 已执行；skipped = 无实际变化（如没有可撤销的变更）
  status: "applied" | "skipped";
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

// 当前画布 → 语义图：剥掉坐标与尺寸（x/y/width/height），但保留每条边当前
// 实际的出入端口方向（fromDir/toDir）——模型改图时据此原样带回未变更边的
// 走向，只有需要改走向的边才调整方向，避免整图重绘把连线接错侧。
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
      ...(e.fromDir ? { fromDir: e.fromDir } : {}),
      ...(e.toDir ? { toDir: e.toDir } : {}),
    })),
  };
}

// 几何保留合并：把布局器算出的绝对数据（laid）与当前画布数据（current）按 id
// 对位——已有节点沿用当前坐标/尺寸/端口方向，仅套用形状与文字变更（效果等同
// 工具条 replaceSelected 的「原地改形状」）；新增节点复用端口手柄快速创建的同一
// 份几何 placeNodeInDirection：由布局里的相对方位推断手柄方向，沿该方向在相邻
// 已落位节点外侧以 CLICK_CREATE_GAP 落位（「在 a 下面加节点」= 点击 a 下方手柄），
// 链式新增依次沿前序新节点继续落位。多父/孤立/会重叠等复杂拓扑退回锚点平移
// （相邻共有节点位移均值，无则全局均值）。新增连线保留语义边显式给出的
// 端口方向（没有则由 FlowEdge 按实际位置自动选边）。用户手动排好的版式
// 不再被程序分层布局整体打回。
export function mergeFlowGeometry(current: FlowData, laid: FlowData): FlowData {
  type Geom = { x: number; y: number; width: number; height: number };
  const geomOf = (n: FlowNodeData): Geom => ({
    x: n.x,
    y: n.y,
    width: n.width ?? 160,
    height: n.height ?? 99,
  });
  const overlaps = (p: { x: number; y: number }, size: Geom, other: Geom) =>
    p.x < other.x + other.width &&
    p.x + size.width > other.x &&
    p.y < other.y + other.height &&
    p.y + size.height > other.y;

  const curById = new Map<string, FlowNodeData>();
  for (const n of current.nodes) if (n.id) curById.set(n.id, n);
  const laidById = new Map<string, FlowNodeData>();
  for (const n of laid.nodes) if (n.id) laidById.set(n.id, n);

  // 已落位节点的几何与最终节点数据：初始为所有已有节点（当前几何）
  const placed = new Map<string, Geom>();
  const resultById = new Map<string, FlowNodeData>();
  const deltaById = new Map<string, { dx: number; dy: number }>();
  let sumDx = 0;
  let sumDy = 0;
  for (const n of laid.nodes) {
    if (!n.id) continue;
    const cur = curById.get(n.id);
    if (!cur) continue;
    const merged: FlowNodeData = {
      ...cur,
      shape: n.shape,
      text: n.text,
      width: cur.width ?? n.width,
      height: cur.height ?? n.height,
    };
    resultById.set(n.id, merged);
    placed.set(n.id, geomOf(merged));
    const delta = { dx: cur.x - n.x, dy: cur.y - n.y };
    deltaById.set(n.id, delta);
    sumDx += delta.dx;
    sumDy += delta.dy;
  }
  const count = deltaById.size;
  const avgDx = count ? sumDx / count : 0;
  const avgDy = count ? sumDy / count : 0;

  // 语义图邻接表（无向）：找新增节点的相邻已落位节点
  const neighbors = new Map<string, string[]>();
  for (const e of laid.edges) {
    for (const [a, b] of [
      [e.from, e.to],
      [e.to, e.from],
    ] as const) {
      const list = neighbors.get(a) ?? [];
      list.push(b);
      neighbors.set(a, list);
    }
  }
  // 兜底锚点：相邻共有节点位移均值；无则全局均值（全新画布为 0）
  const anchorDelta = (id: string): { dx: number; dy: number } => {
    const deltas: { dx: number; dy: number }[] = [];
    for (const nid of neighbors.get(id) ?? []) {
      const d = deltaById.get(nid);
      if (d) deltas.push(d);
    }
    if (!deltas.length) return { dx: avgDx, dy: avgDy };
    return {
      dx: deltas.reduce((s, d) => s + d.dx, 0) / deltas.length,
      dy: deltas.reduce((s, d) => s + d.dy, 0) / deltas.length,
    };
  };

  // 逐个落位新增节点：恰好一个已落位邻居时走手柄几何；否则锚点平移
  for (const n of laid.nodes) {
    if (!n.id || resultById.has(n.id)) continue;
    const geom = geomOf(n);
    const adjacent = (neighbors.get(n.id) ?? []).filter((id) => placed.has(id));
    let pos: { x: number; y: number } | null = null;
    // 全新画布（无任何共有节点）没有「保留既有版式」的前提，整图交给布局器，
    // 不套用手柄间距覆盖布局器的层间距
    if (deltaById.size > 0 && adjacent.length === 1) {
      const src = adjacent[0]!;
      const srcLaid = laidById.get(src);
      if (srcLaid) {
        const dir = dominantPortDir(geomOf(srcLaid), geom);
        const candidate = placeNodeInDirection(placed.get(src)!, dir, geom);
        // 与任何已落位节点重叠（多父汇聚/同父多子）时不用手柄几何，退回兜底
        if (![...placed.values()].some((g) => overlaps(candidate, geom, g))) {
          pos = candidate;
        }
      }
    }
    if (!pos) {
      const { dx, dy } = anchorDelta(n.id);
      pos = { x: n.x + dx, y: n.y + dy };
    }
    const merged: FlowNodeData = { ...n, x: Math.round(pos.x), y: Math.round(pos.y) };
    resultById.set(n.id, merged);
    placed.set(n.id, geomOf(merged));
  }

  // 连线按「两端 + 标签」建多重集索引：同对节点多条带标签分支边也能区分
  const edgeKey = (e: { from: string; to: string; text?: string }) =>
    `${e.from}\u0000${e.to}\u0000${e.text ?? ""}`;
  const dirByKey = new Map<string, FlowEdgeData[]>();
  for (const e of current.edges) {
    const list = dirByKey.get(edgeKey(e)) ?? [];
    list.push(e);
    dirByKey.set(edgeKey(e), list);
  }
  return {
    nodes: laid.nodes.map((n) => resultById.get(n.id ?? "") ?? n),
    edges: laid.edges.map((e) => {
      // 既有连线沿用冻结的端口方向；新连线保留语义边显式方向，没有则由
      // FlowEdge 按实际位置选边
      const cur = dirByKey.get(edgeKey(e))?.shift();
      return cur ? { ...e, fromDir: cur.fromDir, toDir: cur.toDir } : e;
    }),
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
    // text 允许空串或缺省（画布本身允许无文字节点，原样回显不得判脏）；
    // 仅非字符串才算脏字段整体抛错
    if (!n || (n.text !== undefined && typeof n.text !== "string")) {
      throw new Error(`AI 返回的 nodes[${i}] 缺少非空 text`);
    }
    const given = typeof n.id === "string" && n.id.trim() ? n.id.trim() : "";
    // 重复 id / 缺失 id 一律重新分配，避免语义图中两个节点互相覆盖
    const id = given && !used.has(given) ? given : nextId();
    used.add(id);
    nodes.push({ id, shape: inferFlowShape(n), text: (n.text ?? "").trim() });
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
  // 出入端口方向：合法值保留（布局器按显式方向落边），非法值静默丢弃——
  // 模型写错方向不应让整次 render 失败，退回自动选边即可
  const dirOf = (v: unknown): PortDir | undefined => {
    const d = typeof v === "string" ? v.trim().toLowerCase() : "";
    return PORT_DIRS.includes(d as PortDir) ? (d as PortDir) : undefined;
  };
  const rawEdges = Array.isArray(data.edges) ? data.edges : [];
  for (const e of rawEdges as Array<AIFlowEdge | null>) {
    const from = resolveRef(e?.from);
    const to = resolveRef(e?.to);
    if (!from || !to) continue;
    const text = typeof e?.text === "string" && e.text.trim() ? e.text.trim() : undefined;
    const fromDir = dirOf(e?.fromDir);
    const toDir = dirOf(e?.toDir);
    const key = `${from}→${to}:${text ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      from,
      to,
      ...(text ? { text } : {}),
      ...(fromDir ? { fromDir } : {}),
      ...(toDir ? { toDir } : {}),
    });
  }
  return { nodes, edges };
}

// 校验并规整 LLM 返回的操作序列：render 的语义图当场规整（脏字段整体抛错），
// undo/redo/history 无载荷，answer 需非空 text，未知 op 抛错
export function normalizeAIFlowOps(raw: unknown): AIFlowOp[] {
  if (!Array.isArray(raw)) throw new Error("AI 返回格式错误：应为操作数组");
  return raw.map((item, i) => {
    const op = item as Record<string, unknown> | null;
    const no = `（第 ${i + 1} 项）`;
    if (op?.op === "undo" || op?.op === "redo" || op?.op === "history") {
      return { op: op.op } as AIFlowOp;
    }
    if (op?.op === "answer") {
      if (typeof op.text !== "string" || !op.text.trim())
        throw new Error(`AI answer 操作缺少 text${no}`);
      return { op: "answer", text: op.text.trim() };
    }
    if (op?.op === "render") {
      // graph 允许省略外层包装：{"op":"render","nodes":[...],"edges":[...]}
      const source = op.graph ?? (Array.isArray(op.nodes) ? op : undefined);
      if (!source) throw new Error(`AI render 操作缺少 graph${no}`);
      return { op: "render", graph: normalizeAIFlowGraph(source) };
    }
    if (op?.op === "createNode") {
      const ref = typeof op.ref === "string" ? op.ref.trim() : "";
      const dir = typeof op.dir === "string" ? op.dir.toLowerCase() : "";
      if (!ref) throw new Error(`AI createNode 操作缺少 ref${no}`);
      if (!PORT_DIRS.includes(dir as PortDir)) {
        throw new Error(`AI createNode 操作的 dir 非法${no}: ${dir}`);
      }
      // 文字可为空（画布允许无文字节点）；非字符串视为脏字段
      if (op.text !== undefined && typeof op.text !== "string") {
        throw new Error(`AI createNode 操作的 text 不是字符串${no}`);
      }
      const text = typeof op.text === "string" ? op.text.trim() : "";
      // shape 省略 → 门面默认与参考节点同类型；给出时经内置形状推断收敛
      const shape =
        op.shape === undefined
          ? undefined
          : inferFlowShape({ shape: op.shape, role: op.role, text });
      return {
        op: "createNode",
        ref,
        dir: dir as PortDir,
        ...(shape ? { shape } : {}),
        text,
      };
    }
    if (op?.op === "replaceShape") {
      // shape 必须是内置形状（这里就是要精确换成的目标，不能像 nodes[].shape
      // 那样静默降级为 rect，否则模型笔误会被无声替换成矩形）
      const ref = typeof op.ref === "string" ? op.ref.trim() : "";
      if (!ref) throw new Error(`AI replaceShape 操作缺少 ref${no}`);
      const shape = typeof op.shape === "string" ? op.shape.toLowerCase() : "";
      if (!BUILTIN_SHAPES.includes(shape as BuiltinShapeKind)) {
        throw new Error(`AI replaceShape 操作的 shape 非法${no}: ${String(op.shape)}`);
      }
      return { op: "replaceShape", ref, shape: shape as BuiltinShapeKind };
    }
    if (op?.op === "setNodeText") {
      // ref 必填；text 必须是字符串（可为空串，画布允许无文字节点）
      const ref = typeof op.ref === "string" ? op.ref.trim() : "";
      if (!ref) throw new Error(`AI setNodeText 操作缺少 ref${no}`);
      if (typeof op.text !== "string") {
        throw new Error(`AI setNodeText 操作的 text 不是字符串${no}`);
      }
      return { op: "setNodeText", ref, text: op.text };
    }
    if (op?.op === "removeNode") {
      const ref = typeof op.ref === "string" ? op.ref.trim() : "";
      if (!ref) throw new Error(`AI removeNode 操作缺少 ref${no}`);
      return { op: "removeNode", ref };
    }
    if (op?.op === "removeEdge") {
      // ref 为连线 id，或 { from, to, text? } 语义定位（复用 updateEdge 的
      // ref 校验语义：from/to 必填非空字符串，text 可选）
      const r = op.ref;
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;
      if (typeof r === "string") {
        if (!r.trim()) throw new Error(`AI removeEdge 操作缺少 ref${no}`);
        return { op: "removeEdge", ref: r.trim() };
      }
      const rec = r as Record<string, unknown> | null;
      const from = str(rec?.from);
      const to = str(rec?.to);
      if (!from || !to) {
        throw new Error(`AI removeEdge 操作缺少 ref.from / ref.to${no}`);
      }
      const text = str(rec?.text);
      return {
        op: "removeEdge",
        ref: { from, to, ...(text ? { text } : {}) },
      };
    }
    if (op?.op === "updateEdge") {
      const r = op.ref as Record<string, unknown> | null;
      const str = (v: unknown): string | undefined =>
        typeof v === "string" && v.trim() ? v.trim() : undefined;
      const refFrom = str(r?.from);
      const refTo = str(r?.to);
      if (!refFrom || !refTo) {
        throw new Error(`AI updateEdge 操作缺少 ref.from / ref.to${no}`);
      }
      const dirOf = (v: unknown, field: string): PortDir | undefined => {
        if (v === undefined) return undefined;
        const d = typeof v === "string" ? v.toLowerCase() : "";
        if (!PORT_DIRS.includes(d as PortDir)) {
          throw new Error(`AI updateEdge 操作的 ${field} 非法${no}: ${String(v)}`);
        }
        return d as PortDir;
      };
      const refText = str(r?.text);
      const nextFrom = str(op.from);
      const nextTo = str(op.to);
      const nextFromDir = dirOf(op.fromDir, "fromDir");
      const nextToDir = dirOf(op.toDir, "toDir");
      // 分支标签：省略保持不变；空字符串表示清除（须与「不改」显式区分），
      // 非字符串视为脏字段
      let nextText: string | undefined;
      if (op.text !== undefined) {
        if (typeof op.text !== "string") {
          throw new Error(`AI updateEdge 操作的 text 不是字符串${no}`);
        }
        nextText = op.text.trim();
      }
      return {
        op: "updateEdge",
        ref: { from: refFrom, to: refTo, ...(refText ? { text: refText } : {}) },
        ...(nextFrom ? { from: nextFrom } : {}),
        ...(nextTo ? { to: nextTo } : {}),
        ...(nextFromDir ? { fromDir: nextFromDir } : {}),
        ...(nextToDir ? { toDir: nextToDir } : {}),
        ...(nextText !== undefined ? { text: nextText } : {}),
      };
    }
    throw new Error(`AI 返回了未知操作类型${no}: ${String(op?.op)}`);
  });
}

// 解析 AI 响应为「操作 + 回答」。容错与 mindmap 的 parseAIResponse 对齐：
// 1. ```json 代码块 / 前后空白自动剥离
// 2. 操作数组 / {ops:[...]} / 单个操作对象 {op:"undo"}
// 3. 裸语义图 {nodes,edges} / {graph:{...}}：等价于一条 render 操作
// 4. {answer:"..."} 或 {ops:[...],answer:"..."}：回答可独立或伴随操作
// 5. 非 JSON 纯文本：整体视为回答（模型输出坏 JSON 时也能看到它说了什么）
export function parseAIFlowOps(
  raw: AIFlowOp[] | AIFlowGraph | string,
): { ops: AIFlowOp[]; answer?: string } {
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
      return { ops: [], answer: text };
    }
  }
  // 数组：操作序列，其中 answer 操作提取为回答文本
  if (Array.isArray(data)) return splitAnswer(normalizeAIFlowOps(data));
  const obj = data as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") {
    throw new Error("AI 返回格式错误：应为操作数组或语义图 JSON 对象");
  }
  const answer =
    typeof obj.answer === "string" && obj.answer.trim() ? obj.answer.trim() : undefined;
  // 单个操作对象（模型常省略外层数组）/ {ops:[...]}
  if (typeof obj.op === "string") {
    const inner = splitAnswer(normalizeAIFlowOps([obj]));
    return { ops: inner.ops, answer: joinAnswer(answer, inner.answer) };
  }
  if (Array.isArray(obj.ops)) {
    const inner = splitAnswer(normalizeAIFlowOps(obj.ops));
    return { ops: inner.ops, answer: joinAnswer(answer, inner.answer) };
  }
  // 裸语义图 / {graph:{...}}：等价于一条 render 操作
  const graphSource = obj.graph ?? (Array.isArray(obj.nodes) ? obj : undefined);
  if (graphSource !== undefined) {
    return {
      ops: [{ op: "render", graph: normalizeAIFlowGraph(graphSource) }],
      answer,
    };
  }
  if (answer !== undefined) return { ops: [], answer };
  throw new Error("AI 返回格式错误：缺少 graph 或 answer");
}

// answer 操作与顶层 answer 字段合并为一段回答文本
function joinAnswer(a: string | undefined, b: string | undefined): string | undefined {
  return [a, b].filter((t): t is string => !!t).join("\n\n") || undefined;
}

function splitAnswer(ops: AIFlowOp[]): { ops: AIFlowOp[]; answer?: string } {
  const rest: AIFlowOp[] = [];
  const answers: string[] = [];
  for (const op of ops) {
    if (op.op === "answer") answers.push(op.text);
    else rest.push(op);
  }
  return { ops: rest, answer: answers.join("\n\n") || undefined };
}

// 「语义图 + 回答」的简化视图（兼容入口）：多次 render 取最后一条，
// 控制类操作（undo/redo/history）在此视图中被忽略
export function parseAIFlowResponse(
  raw: AIFlowGraph | string,
): { graph?: AIFlowGraph; answer?: string } {
  const { ops, answer } = parseAIFlowOps(raw);
  let graph: AIFlowGraph | undefined;
  for (const op of ops) if (op.op === "render") graph = op.graph;
  return { graph, answer };
}

// ---- 默认提示词 ----

// AI 生成提示词模板：把请求渲染为大模型可直接使用的指令。核心约束是
// 「禁止输出任何几何字段」——坐标与端口方向由程序布局器计算，模型只需描述
// 流程语义；对话类能力（撤销/重做/查历史/看选中）以操作形式表达，由程序执行。
// 宿主可自行替换提示词，只需遵守上面的语义图与操作协议。
export function defaultAIFlowPrompt(req: AIFlowEditRequest): string {
  const { selection, historyState } = req;
  const selEmpty = !selection.nodes.length && !selection.edges.length;
  return [
    "你是流程图助手。需要生成或修改流程图、撤销/重做、查看历史时，只输出一个 JSON 对象，不要输出解释文字，不要用代码块包裹。",
    "输出格式（按指令选择一种）：",
    '1. 改图：{"ops":[{"op":"render","graph":{"nodes":[{"id":"n1","shape":"ellipse","text":"开始"},{"id":"n2","shape":"diamond","text":"校验通过？"}],"edges":[{"from":"n1","to":"n2"},{"from":"n2","to":"n3","text":"是","fromDir":"right"}]}}]}',
    '   也可以直接输出语义图 {"nodes":[...],"edges":[...]}（等价于一条 render 操作）。',
    '2. 撤销 / 重做：{"ops":[{"op":"undo"}]} 或 {"ops":[{"op":"redo"}]}；可连写多次表示连续撤销/重做，但不能与改图操作写在同一批。',
    '3. 查看历史：{"ops":[{"op":"history"}]}（只读，程序会把可撤销/可重做的变更列表并入回答）。',
    '4. 回答提问：{"ops":[{"op":"answer","text":"回答文本"}]} 或 {"answer":"回答文本"} 或纯文本。',
    '5. 在指定节点旁新建：{"ops":[{"op":"createNode","ref":"n2","dir":"bottom","shape":"rect","text":"新步骤"}]}；可连写多条。',
    '6. 修改某条连线（首尾/出入端口/分支标签）：{"ops":[{"op":"updateEdge","ref":{"from":"a","to":"b"},"fromDir":"right","toDir":"left","text":"是"}]}；可连写多条。',
    '7. 替换某节点的形状：{"ops":[{"op":"replaceShape","ref":"n2","shape":"diamond"}]}；可连写多条。',
    '8. 修改某节点的文字：{"ops":[{"op":"setNodeText","ref":"n2","text":"新文字"}]}；可连写多条。',
    '9. 删除某节点：{"ops":[{"op":"removeNode","ref":"n2"}]}（节点连同其关联连线一起删除）；可连写多条。',
    '10. 删除某条连线：{"ops":[{"op":"removeEdge","ref":{"from":"a","to":"b"}}]} 或 {"ops":[{"op":"removeEdge","ref":"边id"}]}；可连写多条。',
    "字段说明（updateEdge）：",
    "- ref：定位当前连线，from/to 为这条边现在的起点与终点节点 id；同对节点有多条分支边时加 text 填分支标签。",
    "- fromDir / toDir：重接后的出入端口，只能是 top / bottom / left / right（如「从 a 的右边出、进 b 的左边」填 right / left）；省略时程序按节点相对位置自动选边。",
    "- from / to：把该端重接到别的节点（填节点 id 或唯一文字）；省略表示端点节点不变，只改方向或标签。",
    "- text：新的分支标签（是/否、通过/驳回等），空字符串表示清除标签；省略表示标签不变。只改标签时 from/to/fromDir/toDir 全部省略即可。",
    "字段说明（createNode）：",
    "- ref：参考节点的 id，取下方「当前流程图」里的 nodes[].id；也可用该节点唯一文字。",
    "- dir：新节点相对参考节点的方向，只能是 top / bottom / left / right（上 / 下 / 左 / 右）。",
    "- shape：新节点形状，取值同 nodes[].shape；省略时与参考节点同类型。text 为节点文字，可为空字符串。",
    "字段说明（replaceShape）：",
    "- ref：目标节点的 id 或唯一文字。",
    "- shape：目标形状，只允许 rect / diamond / ellipse / parallelogram / hexagon / database。节点位置、尺寸、文字与全部连线保持不变，只换形状。",
    "字段说明（setNodeText）：",
    "- ref：目标节点的 id 或唯一文字（可按改前文字定位）。",
    "- text：新文字，可为空字符串（画布允许无文字节点）。节点位置、尺寸、形状与全部连线保持不变，只改文字。",
    "字段说明（removeNode / removeEdge）：",
    "- removeNode.ref：待删节点的 id 或唯一文字；其关联连线随之删除，一次 Ctrl+Z 可整体恢复。",
    "- removeEdge.ref：连线 id，或 { from, to } 加可选 text（同对节点有多条分支边时用标签区分）。",
    "- 删除判断节点前先确认其分支已另行处理；删除后不要让其它节点变成没有连线的孤岛。",
    "字段说明（render）：",
    "- nodes[].id：节点唯一标识，字符串；新节点可以给新 id 或省略（程序自动补全）。",
    "- nodes[].shape：只允许 rect（步骤）、diamond（判断）、ellipse（开始/结束）、parallelogram（输入/输出）、hexagon（准备）、database（存储）。也可以用 role 字段代替（start/end/decision/io/process/data），程序会自动推断形状。",
    "- nodes[].text：节点文字，简短；判断节点写成问句。允许 text 为空字符串（画布上存在无文字的节点，原样保留即可，不要替它虚构文字）。",
    "- edges[].from / edges[].to：必须是 nodes 中存在的 id。edges[].text 只写分支短标签（是/否、通过/驳回、超时等），普通连线省略。",
    "- edges[].fromDir / edges[].toDir（可选）：固定这条线从起点哪一侧出（fromDir）与进入终点哪一侧（toDir），取值 top / bottom / left / right。判断节点想固定分支走向（如「是」从右出、「否」从下出）、或用户明确说了出入方向时给出；省略则由程序按布局自动选边。修改现有图时，下方「当前流程图」的边上带有 fromDir/toDir（即当前实际走向）：未变更的边必须原样带上这两个字段，只有走向需要变化的边才修改它们。",
    "严格禁止输出 x、y、width、height、坐标、位置等几何字段：布局与坐标由程序自动计算，输出这些字段会导致生成失败。端口方向只允许出现在 edges[].fromDir/toDir 与 updateEdge 操作中，其余位置一律不要输出。",
    "绘图规则：",
    "- 有且仅有一个开始节点；判断节点的每条出边都要写分支标签；流程要能走到结束节点。",
    "- 循环/回退用一条指回已有节点的边表示，不要复制出重复节点；不要出现没有连线的孤立节点。",
    "- 修改现有流程图时，保留未改动节点的 id 与文字，只增删需要变化的节点和边，输出完整的最终图（不是补丁）。",
    "- 用户说「在 X 下面 / 上面 / 左边 / 右边新建节点」「给某个节点加一个分支节点」时，用 createNode 操作（方向按用户说的映射到 dir），不要重新输出整张图；这类操作不会改动其他节点的位置与整图结构。createNode 不能与 render 写在同一批。",
    "- 用户说「把 a→b 改成从右边出、左边进」「某条边改连到 c」「调整连线的出入方向」「把 a→b 的分支标签改成 X / 去掉某条边的标签」时，用 updateEdge 操作，不要重新输出整张图；它只改这一条边的首尾、端口与标签，不动任何节点位置。updateEdge 不能与 render 写在同一批。",
    "- 用户说「把某节点改成菱形/数据库/椭圆」等只换形状的要求时，用 replaceShape 操作，不要重新输出整张图；它保留节点位置、文字与全部连线。replaceShape 不能与 render 写在同一批。",
    "- 用户说「把某节点的文字改成 X」「重命名某节点」等只改文字的要求时，用 setNodeText 操作，不要重新输出整张图；它保留节点位置、形状与全部连线。setNodeText 不能与 render 写在同一批。",
    "- 用户说「删除某节点」「去掉某条连线」「移除某个步骤」时，用 removeNode / removeEdge 操作，不要重新输出整张图；删除动作可撤销，且不会打乱其它节点的位置。removeNode / removeEdge 不能与 render 写在同一批。",
    "对话规则：",
    "- 用户问「选中了什么」「这个节点是什么」时，只依据下方「当前选中」回答，不要改图；当前选中为空就直说没有选中任何节点或连线，不要编造。",
    "- 用户说「撤销」「重做」时输出对应的 undo / redo 操作，不要试图通过重新生成整张图来模拟；下方「历史状态」为 0 条时应如实说明没有可撤销/可重做的变更。",
    "- 用户问「刚才改了什么」「做过哪些操作」时输出 history 操作，由程序给出历史列表，不要凭空描述。",
    "- 仅提问、咨询、无需改图时不要输出 nodes/edges。",
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
    `历史状态：可撤销 ${historyState.undoCount} 条，可重做 ${historyState.redoCount} 条。`,
    "",
    selEmpty
      ? "当前选中：无（画布上没有选中的节点或连线）。"
      : `当前选中（只读上下文，共 ${selection.nodes.length} 个节点、${selection.edges.length} 条连线）：`,
    ...(selEmpty ? [] : [JSON.stringify(selection)]),
    "",
    "当前流程图（语义图，已剥离坐标；edges[].fromDir/toDir 为该连线当前实际的出入端口）：",
    JSON.stringify(req.graph),
    "",
    `用户指令：${req.prompt}`,
  ].join("\n");
}
