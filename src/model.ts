import { App, Node } from "@silker/core";
import type { HistoryCapability, HistoryCommand } from "@silker/core";
import { FlowEdge } from "./FlowEdge";
import type { FlowEdgeHints } from "./FlowEdge";
import { Shape } from "./Shape";
import type { ShapeOptions } from "./Shape";
import type { FlowChangeType, FlowData, ShapeKind } from "./data";
import type { EdgeRouterCapability } from "./edge-router";
import type { ShapeRegistryCapability } from "./shape-registry";

// 模型依赖：能力经门面注入，场景侧副作用走钩子（模型不反向依赖交互/控制器）
export interface FlowModelDeps {
  app: App;
  registry: ShapeRegistryCapability;
  router: EdgeRouterCapability;
  // 命令历史：addEdgeBetween(notify) 把连线增删记录为可逆 connect 命令
  history: HistoryCapability;
  // 数据变化通知（连线创建）
  onChange?: (type: FlowChangeType) => void;
  // 形状脱离模型前的场景侧副作用：结束该形状的编辑态并取消选中
  // （原 removeShape/swapShape 内联的 editor.stop() 与 select(null)），
  // 由门面在构造器接线，漏接会留悬空编辑态/选中
  onDetach: (shape: Shape) => void;
  // 选中移交（原场景的 select）：removeShape 取消选中、swapShape 把选中
  // 移交给替身形状
  onSelect: (item: Shape | FlowEdge | null) => void;
}

// 删除捕获的索引运算（纯函数，自 FlowModel.captureShapeRemoval 抽出便于单测）：
// 形状 + 原 z 序索引 + 关联连线（各自的连线序与 z 序索引）。
// 撤销删除时按索引插回，恢复原 z 序（连线层在形状层之下）
export function captureRemoval(
  children: readonly Node[],
  edges: FlowEdge[],
  shape: Shape,
) {
  return {
    shape,
    childIdx: children.indexOf(shape),
    edges: edges
      .map((edge, order) => ({
        edge,
        order,
        childIdx: children.indexOf(edge),
      }))
      .filter((c) => c.edge.fromNode === shape || c.edge.toNode === shape),
  };
}

// 流程图模型：形状表与连线表的唯一属主，负责建载/增删/顶替/删除捕获恢复
// 与 z 序维护（连线层在形状层之下、选中框覆盖层在最上层），不做命中与交互
export class FlowModel {
  // 选中框覆盖层引用（门面创建后注入）：初始 load 阶段尚未赋值（undefined），
  // raiseOverlay 经 indexOf 对不在 children 中的覆盖层无操作（与拆分前一致）
  overlay!: Node;
  shapes = new Map<string, Shape>();
  edges: FlowEdge[] = [];

  constructor(private deps: FlowModelDeps) {}

  load(data: FlowData) {
    for (const n of data.nodes) {
      // 数据中的 kind 可能来自未装配的第三方形状插件（Extension 缺失允许降级）：
      // 跳过该节点，其关联连线因端点缺失在下方一并跳过
      const shape = this.deps.registry.create(n.shape, {
        id: n.id,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        text: n.text,
      });
      if (!shape) continue;
      this.registerShape(shape);
    }
    for (const e of data.edges) {
      const from = this.shapes.get(e.from);
      const to = this.shapes.get(e.to);
      if (from && to)
        this.addEdgeBetween(from, to, false, { from: e.fromDir, to: e.toDir });
    }
    this.deps.app.requestRender();
  }

  // 按注册表创建形状：编程路径（addNode/replaceSelected/快速建节点）的 kind
  // 来自类型化 API 或既有节点，未注册属于编程错误，fail fast
  createShape(kind: ShapeKind, options: ShapeOptions): Shape {
    const shape = this.deps.registry.create(kind, options);
    if (!shape) throw new Error(`Unknown shape kind: "${kind}"`);
    return shape;
  }

  registerShape(shape: Shape) {
    this.shapes.set(shape.id as string, shape);
    this.deps.app.add(shape);
    this.raiseOverlay();
  }

  // 保持选中框覆盖层在最上层（新增节点会追加到 children 末尾）
  raiseOverlay() {
    this.deps.app.reorder(this.overlay, this.deps.app.children.length);
  }

  // 新建连线：两节点间可存在多条连线，不做去重限制；
  // 插入到形状层之下保证连线画在节点下方；
  // hints 指定两端固定端口（拖拽吸附创建时传入），缺省按主导方向自动选边。
  // notify 时创建记录为可逆命令（变更已发生，record 仅入栈）
  addEdgeBetween(
    from: Shape,
    to: Shape,
    notify: boolean,
    hints?: FlowEdgeHints,
  ): FlowEdge {
    const edge = new FlowEdge(from, to, hints);
    edge.router = this.deps.router;
    this.edges.push(edge);
    this.insertEdge(edge);
    if (notify) {
      this.deps.history.record({
        type: "connect",
        ...this.edgeAddRemove(edge),
      });
      this.deps.onChange?.("connect");
    }
    return edge;
  }

  // 连线增删的可逆对：redo 压回连线表并插入形状层之下，undo 摘除。
  // 供 connect 命令直接入栈，也供组合命令复用
  edgeAddRemove(edge: FlowEdge): HistoryCommand {
    return {
      redo: () => {
        this.edges.push(edge);
        this.insertEdge(edge);
      },
      undo: () => {
        this.edges = this.edges.filter((e) => e !== edge);
        this.removeTop(edge);
      },
    };
  }

  // 连线插入到形状层之下（首个 Shape 之前），保证画在节点下方
  insertEdge(edge: FlowEdge) {
    const idx = this.deps.app.children.findIndex((n) => n instanceof Shape);
    this.deps.app.insert(edge, idx === -1 ? this.deps.app.children.length : idx);
  }

  removeShape(shape: Shape) {
    this.deps.onDetach(shape);
    const related = this.edges.filter(
      (e) => e.fromNode === shape || e.toNode === shape,
    );
    this.edges = this.edges.filter((e) => !related.includes(e));
    related.forEach((e) => this.removeTop(e));
    this.removeTop(shape);
    this.shapes.delete(shape.id as string);
  }

  removeTop(node: Node) {
    this.deps.app.remove(node);
  }

  // 按 z 序索引插回画布（undo/redo 重放同一索引，不依赖恢复时的树状态）
  insertAt(node: Node, idx: number) {
    this.deps.app.insert(node, idx);
  }

  // 删除捕获：形状 + 原 z 序索引 + 关联连线（各自的连线序与 z 序索引）。
  // 撤销删除时按索引插回，恢复原 z 序（连线层在形状层之下）
  captureShapeRemoval(shape: Shape) {
    return captureRemoval(this.deps.app.children, this.edges, shape);
  }

  // 应用删除：先摘关联连线再摘形状（removeShape 内含编辑态清理与取消选中）
  applyShapeRemoval(c: ReturnType<FlowModel["captureShapeRemoval"]>) {
    for (const { edge } of c.edges) {
      this.edges = this.edges.filter((e) => e !== edge);
      this.removeTop(edge);
    }
    this.removeShape(c.shape);
  }

  // 恢复删除：按记录的连线序与 z 序索引插回连线与形状
  restoreShapeRemoval(c: ReturnType<FlowModel["captureShapeRemoval"]>) {
    for (const { edge, order, childIdx } of c.edges) {
      this.edges.splice(Math.min(order, this.edges.length), 0, edge);
      this.insertAt(edge, childIdx);
    }
    this.insertAt(c.shape, c.childIdx);
    this.shapes.set(c.shape.id as string, c.shape);
  }

  // 把 b 顶替 a：重绑全部连线两端引用、占据 a 的 z 序位置并更新形状表；
  // b 为替身形状（预先创建），replaceSelected 的 undo/redo 共用
  swapShape(a: Shape, b: Shape) {
    this.deps.onDetach(a);
    for (const e of this.edges) {
      if (e.fromNode === a) e.fromNode = b;
      if (e.toNode === a) e.toNode = b;
    }
    const idx = this.deps.app.children.indexOf(a);
    this.removeTop(a);
    this.shapes.delete(a.id as string);
    if (idx !== -1) {
      this.deps.app.insert(b, idx);
    } else {
      this.deps.app.add(b);
    }
    this.shapes.set(b.id as string, b);
    this.raiseOverlay();
    this.deps.onSelect(b);
  }

  // 把连线移到连线层最上（保持在形状层/覆盖层之下）
  raiseEdgeTop(edge: FlowEdge) {
    const children = this.deps.app.children;
    const from = children.indexOf(edge);
    if (from === -1) return;
    let to = from;
    for (let j = from + 1; j < children.length; j++) {
      const c = children[j];
      if (c instanceof Shape || c === this.overlay) break;
      to = j;
    }
    if (to !== from) this.deps.app.reorder(edge, to);
  }

  // 导出当前数据（位置为最新拖拽结果）
  toJSON(): FlowData {
    return {
      nodes: [...this.shapes.values()].map((s) => ({
        id: s.id ?? undefined,
        shape: s.kind,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        text: s.text.text,
      })),
      edges: this.edges.map((e) => ({
        from: e.fromNode.id as string,
        to: e.toNode.id as string,
        fromDir: e.fromDir,
        toDir: e.toDir,
      })),
    };
  }
}
