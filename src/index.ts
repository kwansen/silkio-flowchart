// 流程图包入口：默认开箱即用——new FlowChart({ canvas, data }) 由场景自建 App
// 并装配官方插件预设；需要替换官方实现或共用宿主时经 FlowChartOptions.app 显式装配。
export { FlowChart } from './flowchart'
export type { FlowChartOptions } from './flowchart'
// Plugin 随 FlowChartOptions.plugins 进入公共 API（第三方形状插件实现该接口）
export type { Plugin } from '@silkor/core'
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
// AI 生成：语义图协议（LLM 只输出拓扑语义）/ 操作序列（改图 / 撤销 / 重做 /
// 查历史 / 回答）/ 选中与历史上下文 / 默认提示词 / 容错解析 /
// 确定性 DAG 自动布局（把语义图编译成带 x/y 与端口方向的 FlowData）
export {
  defaultAIFlowPrompt,
  normalizeAIFlowGraph,
  normalizeAIFlowOps,
  parseAIFlowOps,
  parseAIFlowResponse,
  inferFlowShape,
  toSemanticGraph,
} from './ai-protocol'
export type {
  AIFlowRole,
  AIFlowNode,
  AIFlowEdge,
  AIFlowGraph,
  NormalizedFlowNode,
  NormalizedFlowGraph,
  AIFlowOp,
  AIFlowRenderOp,
  AIFlowCreateNodeOp,
  AIFlowUpdateEdgeOp,
  AIFlowUndoOp,
  AIFlowRedoOp,
  AIFlowHistoryOp,
  AIFlowAnswerOp,
  AIFlowSelection,
  AIFlowHistoryState,
  AIFlowStep,
  AIFlowTurn,
  AIFlowEditRequest,
  AIFlowGenerate,
  AIFlowRunOptions,
  AIFlowRunResult,
} from './ai-protocol'
export { layoutFlowGraph } from './auto-layout'
export type { FlowLayoutDirection, FlowLayoutOptions } from './auto-layout'
export { FLOW_AUTO_LAYOUT_CAPABILITY } from './flow-layout-capability'
export type { FlowAutoLayoutCapability } from './flow-layout-capability'
