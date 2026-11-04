import type { PortDir } from './FlowEdge'

// 流程图数据模型：节点（形状 + 位置 + 文本）与连线（两端节点 id），
// 与渲染模型（Shape / FlowEdge）解耦，toJSON 从活模型导出最新位置
export type ShapeKind = 'rect' | 'diamond' | 'ellipse'

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
}

export interface FlowData {
  nodes: FlowNodeData[]
  edges: FlowEdgeData[]
}

// 数据变化类型：新增节点 / 删除节点 / 拖拽移动 / 拖拽缩放 / 新建连线 / 重接连线端 / 文本编辑结束
export type FlowChangeType = 'add' | 'delete' | 'move' | 'resize' | 'connect' | 'reconnect' | 'text'
