// 流程图包入口
export { FlowChart } from './flowchart'
export type { FlowChartOptions } from './flowchart'
// Plugin 随 FlowChartOptions.plugins 进入公共 API（第三方形状插件实现该接口）
export type { Plugin } from '@silker/core'
export { Shape } from './Shape'
export type { ShapeStyle, ShapeOptions } from './Shape'
export {
  RectShape,
  Diamond,
  EllipseShape,
  Parallelogram,
  Hexagon,
  Database,
} from './shapes'
export { FlowEdge } from './FlowEdge'
export type { PortDir, FlowEdgeHints } from './FlowEdge'
// 形状注册表：契约 + 官方形状插件（内置六形状），第三方形状按能力键扩展
export { BuiltinShapes, SHAPE_REGISTRY_CAPABILITY } from './shape-registry'
export type { ShapeRegistryCapability, ShapeDescriptor } from './shape-registry'
// 吸附能力：契约 + 官方吸附插件（对齐/等间距吸附），第三方吸附策略按能力键同名覆盖
export { BuiltinSnap, SNAP_CAPABILITY } from './snap-capability'
export type { SnapCapability, SnapInput } from './snap-capability'
export type {
  Bounds,
  SnapGuides,
  SpacingGuide,
  SnapOptions,
  SnapResult,
} from './snap'
// 边路由能力：契约 + 官方路由插件（正交折线 + 圆角 + 箭头），第三方路由策略按能力键同名覆盖
export { BuiltinEdgeRouter, EDGE_ROUTER_CAPABILITY } from './edge-router'
export type {
  EdgeRouterCapability,
  EdgeRouteInput,
  EdgeRenderStyle,
} from './edge-router'
export type {
  ShapeKind,
  BuiltinShapeKind,
  FlowNodeData,
  FlowEdgeData,
  FlowData,
  FlowChangeType,
} from './data'
