import { capabilityKey } from "@silker/core";
import type { AIFlowGraph } from "./ai-protocol";
import type { FlowData } from "./data";
import type { FlowLayoutOptions } from "./auto-layout";

// 自动布局能力：契约由 flowchart（Domain Core）定义，官方实现是纯函数
// layoutFlowGraph，第三方可按同名能力键注册覆盖（例如接入 ELK/dagre 的绕障
// 布局），与 mindmap.auto-layout 同构。单独成文件让布局器保持零运行时依赖。
export interface FlowAutoLayoutCapability {
  layout(graph: AIFlowGraph, options: FlowLayoutOptions): FlowData;
}

export const FLOW_AUTO_LAYOUT_CAPABILITY =
  capabilityKey<FlowAutoLayoutCapability>("flowchart.auto-layout");
