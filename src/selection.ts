import type { SelectionCapability } from "@silkor/core";
import { FlowEdge } from "./FlowEdge";
import { Shape } from "./Shape";
import { unionBounds } from "./geometry";
import type { Bounds } from "./snap";

// 选中集合的派生读取（纯函数）：单选形状 / 单选连线 / 选中形状列表 / 多选组合
// 包围盒。选中模型统一存放在 Selection 能力里，这里只做类型收窄与派生计算，
// 不持有状态

// 选中的形状（选中连线或无选中时为 null）
export function selShape(
  sel: SelectionCapability<Shape | FlowEdge>,
): Shape | null {
  const items = sel.items;
  return items.length === 1 && items[0] instanceof Shape
    ? (items[0] as Shape)
    : null;
}

// 选中的连线（选中形状或无选中时为 null）
export function selEdge(
  sel: SelectionCapability<Shape | FlowEdge>,
): FlowEdge | null {
  const items = sel.items;
  return items.length === 1 && items[0] instanceof FlowEdge
    ? (items[0] as FlowEdge)
    : null;
}

// 当前选中的形状列表（多选组合或单选形状；选中连线时为空）——单/多选共用一套命中与移动逻辑
export function selShapes(
  sel: SelectionCapability<Shape | FlowEdge>,
): Shape[] {
  return sel.items.filter((s): s is Shape => s instanceof Shape);
}

// 多选组合的包围盒（少于 2 个形状时视为无组合）
export function multiBounds(
  sel: SelectionCapability<Shape | FlowEdge>,
): Bounds | null {
  const shapes = selShapes(sel);
  if (shapes.length < 2) return null;
  return unionBounds(shapes);
}
