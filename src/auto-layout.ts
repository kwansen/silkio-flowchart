import type { FlowData, FlowEdgeData, FlowNodeData } from "./data";
import type { PortDir } from "./FlowEdge";
import { normalizeAIFlowGraph } from "./ai-protocol";
import type { AIFlowGraph } from "./ai-protocol";

// 流程图自动布局：把「语义图」编译成画布数据 FlowData。
//
// 这是 AI 生成能落地的关键一层。FlowData 的节点要绝对 x/y、边要创建时冻结的
// fromDir/toDir（正交折线首段沿出口外法向、末段沿入口外法向锁定）；两者都是
// 确定性几何量，不应由 LLM 猜测。本模块实现一版无第三方依赖的 Sugiyama 简化版：
//   1) DFS 找环 → 回边从分层图中摘出（循环边单独走外侧绕行端口）
//   2) 最长路径拓扑分层（所有前向边严格指向下一层）
//   3) 跨层长边插虚节点占位，逐层重心法排序减少交叉
//   4) 分配坐标、按边类型确定性推断首尾端口方向
// 输出即 FlowChart.setData / FlowModel.load 可直接消费的 FlowData。

export type FlowLayoutDirection = "TB" | "LR";

export interface FlowLayoutOptions {
  // 主方向：TB 自上而下（默认，纵向下行）、LR 自左向右（横向右行）
  direction?: FlowLayoutDirection;
  nodeWidth?: number;
  nodeHeight?: number;
  // 层间距（主轴）：不小于 2×PORT_STUB + 余量，保证两端引出直段不相撞
  layerGap?: number;
  // 同层节点间距（副轴）
  nodeGap?: number;
  // 整图左上角起点（世界坐标）
  origin?: { x: number; y: number };
}

// 布局器本身是零运行时依赖的纯计算模块（便于直接单测）；能力键与契约放在
// flow-layout-capability.ts，由门面按能力键查找第三方布局实现。

// PORT_STUB = 24（FlowEdge.ts）：层间距至少要容下两端各一段引出直段
const MIN_LAYER_GAP = 56;

interface Slot {
  id: string;
  layer: number;
  real: boolean;
  // 虚节点只占位（不进 FlowData），用于跨层长边的层内排序与避让
  size: number;
  pos: number;
}

interface LayoutEdge {
  from: number;
  to: number;
  text?: string;
  // 语义边显式给出的端口方向：布局器原样落边，不再自动选边
  fromDir?: PortDir;
  toDir?: PortDir;
}

export function layoutFlowGraph(
  graph: AIFlowGraph,
  options: FlowLayoutOptions = {},
): FlowData {
  const g = normalizeAIFlowGraph(graph);
  const direction = options.direction ?? "TB";
  const nodeWidth = Math.max(40, options.nodeWidth ?? 160);
  const nodeHeight = Math.max(30, options.nodeHeight ?? 99);
  const layerGap = Math.max(MIN_LAYER_GAP, options.layerGap ?? 120);
  const nodeGap = Math.max(8, options.nodeGap ?? 72);
  const origin = options.origin ?? { x: 80, y: 80 };
  const mainSize = direction === "TB" ? nodeHeight : nodeWidth;
  const crossSize = direction === "TB" ? nodeWidth : nodeHeight;
  const dummySize = Math.min(crossSize, 24);

  const n = g.nodes.length;
  const idToIdx = new Map(g.nodes.map((node, i) => [node.id, i]));
  const edges: LayoutEdge[] = [];
  for (const e of g.edges) {
    const from = idToIdx.get(e.from);
    const to = idToIdx.get(e.to);
    if (from === undefined || to === undefined) continue;
    edges.push({
      from,
      to,
      ...(e.text ? { text: e.text } : {}),
      ...(e.fromDir ? { fromDir: e.fromDir } : {}),
      ...(e.toDir ? { toDir: e.toDir } : {}),
    });
  }
  const out: number[][] = g.nodes.map(() => []);
  edges.forEach((e, i) => out[e.from]!.push(i));

  // ---- 1) 环检测：DFS 中指向「仍在栈上」的节点的边记为回边 ----
  // 迭代 DFS 避免深图递归爆栈；回边不参与分层/排序，最后单独分配绕行端口
  const state = new Uint8Array(n);
  const back = new Set<number>();
  for (let start = 0; start < n; start++) {
    if (state[start] !== 0) continue;
    state[start] = 1;
    const stack: Array<{ u: number; k: number }> = [{ u: start, k: 0 }];
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      if (top.k >= out[top.u]!.length) {
        state[top.u] = 2;
        stack.pop();
        continue;
      }
      const ei = out[top.u]![top.k++]!;
      const v = edges[ei]!.to;
      if (state[v] === 1) back.add(ei);
      else if (state[v] === 0) {
        state[v] = 1;
        stack.push({ u: v, k: 0 });
      }
    }
  }

  // ---- 2) 最长路径分层（Kahn 拓扑序）----
  const indeg = new Array<number>(n).fill(0);
  edges.forEach((e, i) => {
    if (!back.has(i)) indeg[e.to]!++;
  });
  const layer = new Array<number>(n).fill(0);
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  let head = 0;
  while (head < queue.length) {
    const u = queue[head++]!;
    for (const ei of out[u]!) {
      if (back.has(ei)) continue;
      const v = edges[ei]!.to;
      layer[v] = Math.max(layer[v]!, layer[u]! + 1);
      indeg[v] = indeg[v]! - 1;
      if (indeg[v] === 0) queue.push(v);
    }
  }
  const maxLayer = n ? Math.max(...layer) : 0;

  // ---- 3) 层内槽位 + 跨层长边的虚节点链 ----
  const slots: Slot[][] = Array.from({ length: maxLayer + 1 }, () => []);
  const slotById = new Map<string, Slot>();
  for (let i = 0; i < n; i++) {
    const s: Slot = {
      id: g.nodes[i]!.id,
      layer: layer[i]!,
      real: true,
      size: crossSize,
      pos: 0,
    };
    slots[s.layer]!.push(s);
    slotById.set(s.id, s);
  }
  // 无向邻接（虚节点链 + 真实端点），供重心排序查找相邻层邻居
  const adjacency = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  };
  let dummySeq = 0;
  edges.forEach((e, i) => {
    if (back.has(i)) return;
    const lu = layer[e.from]!;
    const lv = layer[e.to]!;
    if (lv <= lu) return;
    let prev = g.nodes[e.from]!.id;
    for (let l = lu + 1; l < lv; l++) {
      let id: string;
      do {
        id = `__layout_dummy_${++dummySeq}`;
      } while (slotById.has(id));
      const dummy: Slot = { id, layer: l, real: false, size: dummySize, pos: 0 };
      slots[l]!.push(dummy);
      slotById.set(id, dummy);
      link(prev, id);
      prev = id;
    }
    link(prev, g.nodes[e.to]!.id);
  });

  // ---- 4) 重心法层内排序（上下交替若干轮，稳定排序保持模型给出的语义顺序）----
  const position = new Map<string, number>();
  const refreshLayer = (l: number) => {
    slots[l]!.forEach((s, i) => position.set(s.id, i));
  };
  for (let l = 0; l <= maxLayer; l++) refreshLayer(l);
  const reorder = (l: number, neighborLayer: number) => {
    const list = slots[l]!;
    if (list.length < 2) return;
    const before = new Map(list.map((s, i) => [s.id, i]));
    const scores = new Map<string, number>();
    for (const s of list) {
      const neighbors = [...(adjacency.get(s.id) ?? [])].filter(
        (id) => slotById.get(id)?.layer === neighborLayer,
      );
      scores.set(
        s.id,
        neighbors.length
          ? neighbors.reduce((acc, id) => acc + (position.get(id) ?? 0), 0) /
              neighbors.length
          : before.get(s.id)!,
      );
    }
    list.sort((a, b) => {
      const d = scores.get(a.id)! - scores.get(b.id)!;
      return Math.abs(d) < 1e-9 ? before.get(a.id)! - before.get(b.id)! : d;
    });
    refreshLayer(l);
  };
  for (let pass = 0; pass < 6; pass++) {
    for (let l = 1; l <= maxLayer; l++) reorder(l, l - 1);
    for (let l = maxLayer - 1; l >= 0; l--) reorder(l, l + 1);
  }

  // ---- 5) 坐标分配：各层按自身总宽在全局宽度内居中 ----
  const layerWidths = slots.map(
    (list) =>
      list.reduce((sum, s) => sum + s.size, 0) +
      Math.max(0, list.length - 1) * nodeGap,
  );
  const maxWidth = Math.max(0, ...layerWidths);
  const mainOrigin = direction === "TB" ? origin.y : origin.x;
  const crossOrigin = direction === "TB" ? origin.x : origin.y;
  for (let l = 0; l <= maxLayer; l++) {
    let cursor = crossOrigin + (maxWidth - layerWidths[l]!) / 2;
    for (const s of slots[l]!) {
      s.pos = cursor + s.size / 2;
      cursor += s.size + nodeGap;
    }
  }
  const nodes: FlowNodeData[] = g.nodes.map((node, i) => {
    const s = slotById.get(node.id)!;
    const main = mainOrigin + s.layer * (mainSize + layerGap);
    return {
      id: node.id,
      shape: node.shape,
      // TB：y 为层起点、x 由副轴中心回退半宽；LR 反之
      x: Math.round(direction === "TB" ? s.pos - nodeWidth / 2 : main),
      y: Math.round(direction === "TB" ? main : s.pos - nodeHeight / 2),
      width: nodeWidth,
      height: nodeHeight,
      text: node.text,
    };
  });

  // ---- 6) 端口方向：全部显式给出（FlowEdge 创建时冻结，事后移动不会重选边）----
  // 前向边沿主方向出入；多分支按目标副轴位置散开到左/右（LR 为上/下）出口，
  // 避免菱形多条边共用一个底部端口；回边统一走外侧同侧出入，由正交路由绕行。
  // 语义边显式给出的方向优先：原样落边，不参与自动散开（同节点其余自动分支
  // 避开已被占用的方向再分配，避免端口相撞）。
  const branchFrom = new Map<number, PortDir>();
  const forwardOut = new Map<number, number[]>();
  edges.forEach((e, i) => {
    if (back.has(i) || layer[e.to]! <= layer[e.from]!) return;
    forwardOut.set(e.from, [...(forwardOut.get(e.from) ?? []), i]);
  });
  const sideDirs: Record<FlowLayoutDirection, { first: PortDir; mid: PortDir; last: PortDir }> = {
    TB: { first: "left", mid: "bottom", last: "right" },
    LR: { first: "top", mid: "right", last: "bottom" },
  };
  for (const list of forwardOut.values()) {
    if (list.length < 2) continue;
    const auto = list.filter((ei) => !edges[ei]!.fromDir);
    if (auto.length < 2) continue;
    // 已被显式方向占用的出口从候选序列中剔除；全被占满时退回主方向
    const used = new Set(
      list.map((ei) => edges[ei]!.fromDir).filter((d): d is PortDir => !!d),
    );
    const dirs = sideDirs[direction];
    const order: PortDir[] = [dirs.first, dirs.mid, dirs.last].filter((d) => !used.has(d));
    if (!order.length) order.push(dirs.mid);
    auto.sort(
      (a, b) =>
        slotById.get(g.nodes[edges[a]!.to]!.id)!.pos -
        slotById.get(g.nodes[edges[b]!.to]!.id)!.pos,
    );
    auto.forEach((ei, k) => {
      branchFrom.set(
        ei,
        k === 0
          ? order[0]!
          : k === auto.length - 1
            ? order[order.length - 1]!
            : (order[1] ?? order[0]!),
      );
    });
  }
  const edgeData: FlowEdgeData[] = edges.map((e, i) => {
    const backward = back.has(i) || layer[e.to]! <= layer[e.from]!;
    const fromDir: PortDir = e.fromDir ??
      (backward
        ? direction === "TB" ? "right" : "bottom"
        : branchFrom.get(i) ?? (direction === "TB" ? "bottom" : "right"));
    const toDir: PortDir = e.toDir ??
      (backward
        ? direction === "TB" ? "right" : "bottom"
        : direction === "TB" ? "top" : "left");
    return {
      from: g.nodes[e.from]!.id,
      to: g.nodes[e.to]!.id,
      fromDir,
      toDir,
      ...(e.text ? { text: e.text } : {}),
    };
  });

  return { nodes, edges: edgeData };
}
