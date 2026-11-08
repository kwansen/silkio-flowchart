// 历史命令编解码器：把 flowchart 各命令的序列化载荷（kind + 纯数据）重建为可执行的
// HistoryCommand。只依赖 core 契约与自有模型，不依赖 plugin-*（check-deps 分层约束）。
//
// 引用解析规则（与各命令的 toJSON 载荷一一对应）：
// - 形状按 id 解析：先查模型形状表（model.shapes），再查会话注册表；查不到且
//   载荷内嵌了数据快照（delete/replace/add-shape 的 data 字段）时经形状注册表
//   重建并登记——脱离树/连线表的形状（被删、被顶替的旧形状）由此恢复。
// - 连线按 id 解析：先查模型连线表，再查会话注册表；查不到时按内嵌的端点 id
//   与端口方向重建（FlowEdge 构造后回写原 id）。重建发生在 revive 阶段而非
//   redo 执行时，同一连线的 redo/undo 共用同一对象，重放不会重复创建。
//
// 复合命令（core 的 composite kind）在此解码为 compose(...)，子命令递归走本解码器。
// 解码失败的命令返回 null：importJSON 收到 null 即整体放弃导入且不改动栈。
import { compose } from "@silker/core";
import type { App, HistoryCommand, SerializedCommand } from "@silker/core";
import { FlowEdge } from "./FlowEdge";
import type { PortDir } from "./FlowEdge";
import type { Shape } from "./Shape";
import type { FlowNodeData } from "./data";
import type { EdgeRouterCapability } from "./edge-router";
import type { FlowModel } from "./model";
import type { MovePayload, ResizePayload, ReconnectPayload, TextPayload } from "./commands";

export interface FlowchartCodecDeps {
  model: FlowModel;
  app: App;
  // 连线路由能力：重建的连线与在位连线保持同一路由行为（第三方路由插件语义不丢）
  router: EdgeRouterCapability | null;
}

// 命令载荷形状（与 flowchart.ts 内联命令的 toJSON 一一对应）
export interface AddShapePayload {
  data: FlowNodeData;
}
export interface ConnectPayload {
  edgeId: string;
  fromId: string;
  toId: string;
  fromDir: PortDir;
  toDir: PortDir;
}
export interface DeletePayload {
  v: "shapes" | "edge";
  // shapes：被删形状内嵌数据快照 + 关联连线内嵌端点/方向 + 两个插入索引
  //（order=连线表序、childIdx=z 序）
  items?: Array<{
    data: FlowNodeData;
    childIdx: number;
    edges: Array<{
      id: string;
      fromId: string;
      toId: string;
      fromDir: PortDir;
      toDir: PortDir;
      order: number;
      childIdx: number;
    }>;
  }>;
  // edge：单边删除（脱离连线表后无从按 id 解析，端点与方向内嵌以完整重建）
  edge?: {
    edgeId: string;
    fromId: string;
    toId: string;
    fromDir: PortDir;
    toDir: PortDir;
  };
  childIdx?: number;
  listIdx?: number;
}
export interface ReplacePayload {
  oldData: FlowNodeData;
  newData: FlowNodeData;
}

// 创建编解码器：decode 把 SerializedCommand 重建为 HistoryCommand（失败返回 null）
export function createFlowchartCodec(deps: FlowchartCodecDeps) {
  const { model, app, router } = deps;
  // 会话注册表：模型形状表/连线表查不到的对象在此登记，跨命令按 id 去重
  const shapes = new Map<string, Shape>();
  const edges = new Map<string, FlowEdge>();

  // 形状解析：模型形状表 → 注册表；都没有且提供内嵌数据则经形状注册表重建。
  // id 允许缺省（内嵌数据理论可无 id）：缺省时只走重建路径，不登记注册表
  function resolveShape(id: string | undefined, data?: FlowNodeData): Shape | null {
    if (id) {
      const live = model.shapes.get(id);
      if (live) return live;
      const cached = shapes.get(id);
      if (cached) return cached;
    }
    if (!data) return null;
    try {
      const shape = model.createShape(data.shape, {
        id: data.id,
        x: data.x,
        y: data.y,
        width: data.width,
        height: data.height,
        text: data.text,
      });
      if (data.id) shapes.set(data.id, shape);
      return shape;
    } catch {
      // 未知形状 kind（如导入方缺少对应形状插件）：放弃该命令，整体导入失败
      return null;
    }
  }

  // 连线解析：模型连线表 → 注册表；都没有则按端点与端口方向重建并回写原 id
  function resolveEdge(
    id: string,
    fromId: string,
    toId: string,
    fromDir: PortDir,
    toDir: PortDir,
  ): FlowEdge | null {
    const live = model.edges.find((e) => e.id === id);
    if (live) return live;
    const cached = edges.get(id);
    if (cached) return cached;
    const from = resolveShape(fromId);
    const to = resolveShape(toId);
    if (!from || !to) return null;
    const edge = new FlowEdge(from, to, { from: fromDir, to: toDir });
    edge.id = id;
    edge.router = router;
    edges.set(id, edge);
    return edge;
  }

  // decode：按 kind 分发到各重建器，未知 kind 返回 null
  function decode(s: SerializedCommand): HistoryCommand | null {
    switch (s.kind) {
      case "composite": {
        const p = s.payload as { type?: string; children: SerializedCommand[] };
        const children = p.children.map(decode);
        if (children.some((c) => !c)) return null;
        return compose(p.type, ...children as HistoryCommand[]);
      }
      case "flowchart.move":
        return decodeMove(s.payload as MovePayload);
      case "flowchart.resize":
        return decodeResize(s.payload as ResizePayload);
      case "flowchart.reconnect":
        return decodeReconnect(s.payload as ReconnectPayload);
      case "flowchart.text":
        return decodeText(s.payload as TextPayload);
      case "flowchart.add-shape":
        return decodeAddShape(s.payload as AddShapePayload);
      case "flowchart.connect":
        return decodeConnect(s.payload as ConnectPayload);
      case "flowchart.delete":
        return decodeDelete(s.payload as DeletePayload);
      case "flowchart.replace":
        return decodeReplace(s.payload as ReplacePayload);
      default:
        return null;
    }
  }

  function decodeMove(p: MovePayload): HistoryCommand | null {
    if (p.v === "delta") {
      const targets: Shape[] = [];
      for (const id of p.targets ?? []) {
        const shape = resolveShape(id);
        if (!shape) return null;
        targets.push(shape);
      }
      const before: Array<{ shape: Shape; x: number; y: number }> = [];
      for (const b of p.before) {
        const shape = resolveShape(b.shapeId);
        if (!shape) return null;
        before.push({ shape, x: b.x, y: b.y });
      }
      const dx = p.dx ?? 0;
      const dy = p.dy ?? 0;
      return {
        type: "move",
        redo: () => {
          for (const s of targets) {
            s.x += dx;
            s.y += dy;
          }
        },
        undo: () => {
          for (const m of before) {
            m.shape.x = m.x;
            m.shape.y = m.y;
          }
        },
        toJSON: () => ({ kind: "flowchart.move", payload: p }),
      };
    }
    // abs：拖拽移动，前后绝对位置快照
    const before: Array<{ shape: Shape; x: number; y: number }> = [];
    const after: Array<{ shape: Shape; x: number; y: number }> = [];
    for (const b of p.before) {
      const shape = resolveShape(b.shapeId);
      if (!shape) return null;
      before.push({ shape, x: b.x, y: b.y });
    }
    for (const a of p.after ?? []) {
      const shape = resolveShape(a.shapeId);
      if (!shape) return null;
      after.push({ shape, x: a.x, y: a.y });
    }
    return {
      type: "move",
      redo: () => {
        for (const m of after) {
          m.shape.x = m.x;
          m.shape.y = m.y;
        }
      },
      undo: () => {
        for (const m of before) {
          m.shape.x = m.x;
          m.shape.y = m.y;
        }
      },
      toJSON: () => ({ kind: "flowchart.move", payload: p }),
    };
  }

  function decodeResize(p: ResizePayload): HistoryCommand | null {
    if (p.v === "single") {
      const shape = resolveShape(p.shapeId);
      if (!shape) return null;
      return {
        type: "resize",
        redo: () => {
          Object.assign(shape, p.after);
          shape.layout();
        },
        undo: () => {
          Object.assign(shape, p.before);
          shape.layout();
        },
        toJSON: () => ({ kind: "flowchart.resize", payload: p }),
      };
    }
    // group：逐成员恢复位置与尺寸
    const before: Array<{ shape: Shape; x: number; y: number; width: number; height: number }> = [];
    const after: Array<{ shape: Shape; x: number; y: number; width: number; height: number }> = [];
    for (const b of p.before) {
      const shape = resolveShape(b.shapeId);
      if (!shape) return null;
      before.push({ shape, x: b.x, y: b.y, width: b.width, height: b.height });
    }
    for (const a of p.after) {
      const shape = resolveShape(a.shapeId);
      if (!shape) return null;
      after.push({ shape, x: a.x, y: a.y, width: a.width, height: a.height });
    }
    return {
      type: "resize",
      redo: () => {
        for (const m of after) {
          Object.assign(m.shape, { x: m.x, y: m.y, width: m.width, height: m.height });
          m.shape.layout();
        }
      },
      undo: () => {
        for (const m of before) {
          Object.assign(m.shape, { x: m.x, y: m.y, width: m.width, height: m.height });
          m.shape.layout();
        }
      },
      toJSON: () => ({ kind: "flowchart.resize", payload: p }),
    };
  }

  function decodeReconnect(p: ReconnectPayload): HistoryCommand | null {
    // 重接不摘除连线，连线必在模型连线表中（或本会话已重建）
    const edge = model.edges.find((e) => e.id === p.edgeId) ?? edges.get(p.edgeId);
    if (!edge) return null;
    const oldNode = resolveShape(p.oldNodeId);
    const newNode = resolveShape(p.newNodeId);
    if (!oldNode || !newNode) return null;
    return {
      type: "reconnect",
      redo: () => edge.reattachEnd(p.which, newNode, p.newDir),
      undo: () => edge.reattachEnd(p.which, oldNode, p.oldDir),
      toJSON: () => ({ kind: "flowchart.reconnect", payload: p }),
    };
  }

  function decodeText(p: TextPayload): HistoryCommand | null {
    const shape = resolveShape(p.shapeId);
    if (!shape) return null;
    return {
      type: "text",
      redo: () => {
        shape.text.text = p.after;
        shape.layout();
      },
      undo: () => {
        shape.text.text = p.before;
        shape.layout();
      },
      toJSON: () => ({ kind: "flowchart.text", payload: p }),
    };
  }

  function decodeAddShape(p: AddShapePayload): HistoryCommand | null {
    const shape = resolveShape(p.data.id, p.data);
    if (!shape) return null;
    return {
      type: "add",
      redo: () => model.registerShape(shape),
      undo: () => model.removeShape(shape),
      toJSON: () => ({ kind: "flowchart.add-shape", payload: p }),
    };
  }

  function decodeConnect(p: ConnectPayload): HistoryCommand | null {
    const edge = resolveEdge(p.edgeId, p.fromId, p.toId, p.fromDir, p.toDir);
    if (!edge) return null;
    return {
      type: "connect",
      redo: () => {
        model.edges.push(edge);
        model.insertEdge(edge);
      },
      undo: () => {
        model.edges = model.edges.filter((e) => e !== edge);
        model.removeTop(edge);
      },
      toJSON: () => ({ kind: "flowchart.connect", payload: p }),
    };
  }

  function decodeDelete(p: DeletePayload): HistoryCommand | null {
    if (p.v === "edge") {
      const e = p.edge!;
      const edge = resolveEdge(e.edgeId, e.fromId, e.toId, e.fromDir, e.toDir);
      if (!edge) return null;
      return {
        type: "delete",
        redo: () => {
          model.removeTop(edge);
          model.edges = model.edges.filter((x) => x !== edge);
        },
        undo: () => {
          model.edges.splice(Math.min(p.listIdx ?? 0, model.edges.length), 0, edge);
          model.insertAt(edge, p.childIdx ?? 0);
        },
        toJSON: () => ({ kind: "flowchart.delete", payload: p }),
      };
    }
    // shapes：重建删除捕获（被删形状脱离树，一律走内嵌数据重建）。
    // 两段式：先重建全部形状（跨条目的连线端点可能指向后一条目的形状），
    // 再解析各条目的关联连线
    const revives: Array<{
      data: FlowNodeData;
      childIdx: number;
      edges: Array<{ id: string; fromId: string; toId: string; fromDir: PortDir; toDir: PortDir; order: number; childIdx: number }>;
    }> = [];
    for (const item of p.items ?? []) {
      const shape = resolveShape(item.data.id, item.data);
      if (!shape) return null;
      revives.push({ data: item.data, childIdx: item.childIdx, edges: item.edges });
    }
    const captures: Array<{
      shape: Shape;
      childIdx: number;
      edges: Array<{ edge: FlowEdge; order: number; childIdx: number }>;
    }> = [];
    for (const r of revives) {
      const shape = resolveShape(r.data.id, r.data);
      if (!shape) return null;
      const itemEdges: Array<{ edge: FlowEdge; order: number; childIdx: number }> = [];
      for (const e of r.edges) {
        const edge = resolveEdge(e.id, e.fromId, e.toId, e.fromDir, e.toDir);
        if (!edge) return null;
        itemEdges.push({ edge, order: e.order, childIdx: e.childIdx });
      }
      captures.push({ shape, childIdx: r.childIdx, edges: itemEdges });
    }
    return {
      type: "delete",
      redo: () => {
        for (const c of captures) model.applyShapeRemoval(c);
      },
      undo: () => {
        for (const c of [...captures].reverse()) model.restoreShapeRemoval(c);
      },
      toJSON: () => ({ kind: "flowchart.delete", payload: p }),
    };
  }

  function decodeReplace(p: ReplacePayload): HistoryCommand | null {
    // 旧形状已脱离树且不在形状表，须经内嵌数据重建；新形状在最终态数据里，
    // 优先按 id 命中在位实例（会话注册表兜底）
    const old = resolveShape(p.oldData.id, p.oldData);
    const shape = resolveShape(p.newData.id, p.newData);
    if (!old || !shape) return null;
    return {
      type: "replace",
      redo: () => model.swapShape(old, shape),
      undo: () => model.swapShape(shape, old),
      toJSON: () => ({ kind: "flowchart.replace", payload: p }),
    };
  }

  return { decode };
}
