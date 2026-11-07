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
export type {
  ShapeKind,
  BuiltinShapeKind,
  FlowNodeData,
  FlowEdgeData,
  FlowData,
  FlowChangeType,
} from './data'
