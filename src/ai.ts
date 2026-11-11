// AI 生成模块转发出口：语义图协议（提示词/解析/规整）与确定性自动布局。
// 领域包不绑定任何 LLM SDK，宿主经 FlowChartOptions.ai 注入生成适配器，
// 由 FlowChart.generate() 串起「语义图 → FlowData → 原子整图替换」。
export {
  defaultAIFlowPrompt,
  normalizeAIFlowGraph,
  parseAIFlowResponse,
  inferFlowShape,
  toSemanticGraph,
} from "./ai-protocol";
export type {
  AIFlowRole,
  AIFlowNode,
  AIFlowEdge,
  AIFlowGraph,
  NormalizedFlowNode,
  NormalizedFlowGraph,
  AIFlowTurn,
  AIFlowEditRequest,
  AIFlowGenerate,
  AIFlowRunOptions,
  AIFlowRunResult,
} from "./ai-protocol";
export { layoutFlowGraph } from "./auto-layout";
export type { FlowLayoutDirection, FlowLayoutOptions } from "./auto-layout";
export { FLOW_AUTO_LAYOUT_CAPABILITY } from "./flow-layout-capability";
export type { FlowAutoLayoutCapability } from "./flow-layout-capability";
