import { compose } from "@silkor/core";
import type { HistoryCapability } from "@silkor/core";
import { FlowEdge, OPPOSITE_DIR } from "./FlowEdge";
import type { PortDir } from "./FlowEdge";
import { shapeData } from "./commands";
import type { ShapeKind } from "./data";
import type { EdgeRouterCapability } from "./edge-router";
import { placeNodeInDirection } from "./geometry";
import type { FlowModel } from "./model";
import type { Shape } from "./Shape";

// 端口方向快速创建的唯一实现：传入参考节点、方向、新建节点类型（可省略，
// 默认与参考节点同类型）与文字，返回新节点。几何与点击端口手柄完全一致
// （同尺寸、CLICK_CREATE_GAP 间距、中轴对齐、from: dir / to: 反向端口），
// 「注册节点 + 创建连线」组合为一条原子命令（一次 Ctrl+Z 整体撤销）。
// 交互入口（interactions 点击手柄）、门面程序化入口（FlowChart.createNodeFrom）
// 与 AI 的 createNode 操作都调用这里，避免各自重算几何。
export interface QuickCreateDeps {
  model: FlowModel;
  router: EdgeRouterCapability;
  history: HistoryCapability;
}

export function createNodeInDirection(
  deps: QuickCreateDeps,
  source: Shape,
  dir: PortDir,
  kind: ShapeKind = source.kind,
  text = "",
): Shape {
  const shape = deps.model.createShape(kind, {
    width: source.width,
    height: source.height,
    text,
  });
  const pos = placeNodeInDirection(source, dir, shape);
  shape.x = pos.x;
  shape.y = pos.y;
  const edge = new FlowEdge(source, shape, {
    from: dir,
    to: OPPOSITE_DIR[dir],
  });
  edge.router = deps.router;
  // 不预先注册，避免 exec 重放时重复入列；undo 逆序先摘连线再摘节点
  deps.history.exec(
    compose(
      "add",
      {
        redo: () => deps.model.registerShape(shape),
        undo: () => deps.model.removeShape(shape),
        toJSON: () => ({
          kind: "flowchart.add-shape",
          payload: { data: shapeData(shape) },
        }),
      },
      deps.model.edgeAddRemove(edge),
    ),
  );
  return shape;
}
