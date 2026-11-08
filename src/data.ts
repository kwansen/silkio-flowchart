import type { PortDir } from './FlowEdge'

// 流程图数据模型：节点（形状 + 位置 + 文本）与连线（两端节点 id），
// 与渲染模型（Shape / FlowEdge）解耦，toJSON 从活模型导出最新位置

// 内置形状类型：官方实现（BuiltinShapes 插件）注册的 kind
export type BuiltinShapeKind =
  | 'rect'
  | 'diamond'
  | 'ellipse'
  | 'parallelogram'
  | 'hexagon'
  | 'database'

// 形状类型：开放字符串（与形状注册表能力配套，第三方可注册任意 kind 扩展），
// 内置 kind 保留字面量自动补全
export type ShapeKind = BuiltinShapeKind | (string & {})

export interface FlowNodeData {
  id?: string
  shape: ShapeKind
  x: number
  y: number
  width?: number
  height?: number
  text: string
}

export interface FlowEdgeData {
  from: string
  to: string
  // 固定的出边/入边端口（四向边中点），创建时冻结；缺省时按创建时的主导方向自动选边
  fromDir?: PortDir
  toDir?: PortDir
  // 连线标签文本（双击连线编辑）；缺省为空（不显示标签）
  text?: string
}

export interface FlowData {
  nodes: FlowNodeData[]
  edges: FlowEdgeData[]
}

// 数据变化类型：新增节点 / 删除节点 / 拖拽移动 / 拖拽缩放 / 新建连线 / 重接连线端 / 文本编辑结束 / 替换形状
export type FlowChangeType = 'add' | 'delete' | 'move' | 'resize' | 'connect' | 'reconnect' | 'text' | 'replace'
