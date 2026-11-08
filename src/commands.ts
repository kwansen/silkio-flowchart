// 命令装配与可逆命令工厂：undo/redo/delete 注册为命令并绑定默认键位；
// 各类交互变更（移动/缩放/微调/重接/文本）的 HistoryCommand 在此构造——
// 只依赖调用方传入的数据快照，不触碰 FlowChart 内部状态

import type { CommandCapability } from "@silker/core";
import type { HistoryCommand, SerializedCommand } from "@silker/core";
import type { FlowEdge, PortDir } from "./FlowEdge";
import type { Shape } from "./Shape";
import type { Bounds } from "./snap";
import type { FlowNodeData } from "./data";

// 形状数据快照：id/几何/文本（与 model.toJSON 的节点条目同构，JSON 安全），
// 供命令载荷内嵌，导入端经形状注册表重建。
// 导出供 flowchart.ts / interactions.ts 的内联命令与 history-codec 共用
export function shapeData(shape: Shape): FlowNodeData {
  return {
    id: shape.id ?? undefined,
    shape: shape.kind,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    text: shape.text.text,
  };
}

// 命令载荷形状（kind 前缀 flowchart.，与 history-codec.ts 的解码一一对应）；
// 引用一律按 id（Node 运行时保证非空，类型上 string|null 以 ! 收敛），几何/文本/
// 端口方向为纯数据
export interface MovePayload {
  v: "abs" | "delta";
  // abs：before/after 各定格一份绝对位置；delta：targets + 相对位移 + before 位置
  before: Array<{ shapeId: string; x: number; y: number }>;
  after?: Array<{ shapeId: string; x: number; y: number }>;
  targets?: Array<string>;
  dx?: number;
  dy?: number;
}
// 连线创建载荷：标签文本随连线内嵌（剪贴板粘贴重建时标签不丢；
// 缺省为空标签）。文本编辑走独立的 edgeText 命令
export interface ConnectPayload {
  edgeId: string;
  fromId: string;
  toId: string;
  fromDir: PortDir;
  toDir: PortDir;
  text?: string;
}
interface ShapeRectData {
  shapeId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
export type ResizePayload =
  | { v: "single"; shapeId: string; before: Bounds; after: Bounds }
  | { v: "group"; before: ShapeRectData[]; after: ShapeRectData[] };
export interface ReconnectPayload {
  edgeId: string;
  which: "from" | "to";
  oldNodeId: string;
  oldDir: PortDir;
  newNodeId: string;
  newDir: PortDir;
}
export interface TextPayload {
  shapeId: string;
  before: string;
  after: string;
}
export interface EdgeTextPayload {
  edgeId: string;
  before: string;
  after: string;
}

// 命令回调钩子：命令分发时转发回 FlowChart 的对应入口（避免公开其私有成员）
export interface FlowchartCommandHooks {
  editing(): boolean; // 文本编辑会话进行中
  editorFocused(): boolean; // 编辑器持焦（按键属于输入）
  hasSelection(): boolean; // 当前有选中项
  canPaste(): boolean; // 剪贴板有内容可粘贴
  undo(): void;
  redo(): void;
  deleteSelected(): void;
  selectAll(): void;
  copySelected(): void;
  paste(): void;
}

// 注册流程图命令并绑定默认键位：撤销/重做/删除，document keydown 由命令
// 插件统一分发；应用层与第三方可按能力键复用命令或重绑键位。
// 分发守卫与键盘策略同款：编辑或编辑器持焦时按键属于输入，交由编辑器处理
export function bindFlowchartCommands(
  commands: CommandCapability,
  hooks: FlowchartCommandHooks,
) {
  commands.guard = (e) => !hooks.editing() && !hooks.editorFocused();
  commands.register({
    id: "flowchart.undo",
    title: "撤销",
    run: () => hooks.undo(),
  });
  commands.register({
    id: "flowchart.redo",
    title: "重做",
    run: () => hooks.redo(),
  });
  commands.register({
    id: "flowchart.delete",
    title: "删除选中",
    enabled: () => hooks.hasSelection(),
    run: () => hooks.deleteSelected(),
  });
  commands.register({
    id: "flowchart.selectAll",
    title: "全选",
    run: () => hooks.selectAll(),
  });
  commands.register({
    id: "flowchart.copy",
    title: "复制选中",
    enabled: () => hooks.hasSelection(),
    run: () => hooks.copySelected(),
  });
  commands.register({
    id: "flowchart.paste",
    title: "粘贴",
    enabled: () => hooks.canPaste(),
    run: () => hooks.paste(),
  });
  commands.bind("mod+z", "flowchart.undo");
  commands.bind("mod+shift+z", "flowchart.redo");
  commands.bind("mod+y", "flowchart.redo");
  commands.bind("mod+a", "flowchart.selectAll");
  commands.bind("mod+c", "flowchart.copy");
  commands.bind("mod+v", "flowchart.paste");
  commands.bind("delete", "flowchart.delete");
  commands.bind("backspace", "flowchart.delete");
}

// 位置快照：形状引用 + 该时刻位置（undo/redo 的恢复目标）
export interface ShapeMove {
  shape: Shape;
  x: number;
  y: number;
}

// 尺寸快照：含位置的完整 bounds（组合缩放的恢复目标）
export interface ShapeRect {
  shape: Shape;
  x: number;
  y: number;
  width: number;
  height: number;
}

// 拖拽移动命令：before/after 各定格一份位置，undo 回到按前、redo 重放拖后
export function moveCommand(
  before: ShapeMove[],
  after: ShapeMove[],
): HistoryCommand {
  return {
    type: "move",
    redo: () => {
      for (const m of after) {
        m.shape.x = m.x;
        m.shape.y = m.y;
      }
    },
    undo: () => {
      for (const m of before) {
        m.shape.x = m.x;
        m.shape.y = m.y;
      }
    },
    // 序列化载荷：形状按 id 引用 + 绝对位置快照，undo/redo 重放绝对位置
    toJSON: () => ({
      kind: "flowchart.move",
      payload: {
        v: "abs",
        before: before.map((m) => ({ shapeId: m.shape.id!, x: m.x, y: m.y })),
        after: after.map((m) => ({ shapeId: m.shape.id!, x: m.x, y: m.y })),
      } satisfies MovePayload,
    }),
  };
}

// 方向键微调命令：redo 重放同向位移，undo 回到按前位置
export function nudgeCommand(
  targets: Shape[],
  dx: number,
  dy: number,
  before: ShapeMove[],
): HistoryCommand {
  return {
    type: "move",
    redo: () => {
      for (const s of targets) {
        s.x += dx;
        s.y += dy;
      }
    },
    undo: () => {
      for (const m of before) {
        m.shape.x = m.x;
        m.shape.y = m.y;
      }
    },
    // 序列化载荷：形状按 id 引用 + 相对位移，保留微调的相对语义
    toJSON: () => ({
      kind: "flowchart.move",
      payload: {
        v: "delta",
        targets: targets.map((s) => s.id!),
        dx,
        dy,
        before: before.map((m) => ({ shapeId: m.shape.id!, x: m.x, y: m.y })),
      } satisfies MovePayload,
    }),
  };
}

// 单形状缩放命令：before/after 各定格一份 bounds
export function resizeCommand(
  shape: Shape,
  before: Bounds,
  after: Bounds,
): HistoryCommand {
  return {
    type: "resize",
    redo: () => {
      Object.assign(shape, after);
      shape.layout();
    },
    undo: () => {
      Object.assign(shape, before);
      shape.layout();
    },
    // 序列化载荷：形状按 id 引用 + 前后 bounds 快照
    toJSON: () => ({
      kind: "flowchart.resize",
      payload: {
        v: "single",
        shapeId: shape.id!,
        before,
        after,
      } satisfies ResizePayload,
    }),
  };
}

// 多选组合缩放命令：逐成员恢复位置与尺寸
export function groupResizeCommand(
  before: ShapeRect[],
  after: ShapeRect[],
): HistoryCommand {
  return {
    type: "resize",
    redo: () => {
      for (const m of after) {
        Object.assign(m.shape, {
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
        });
        m.shape.layout();
      }
    },
    undo: () => {
      for (const m of before) {
        Object.assign(m.shape, {
          x: m.x,
          y: m.y,
          width: m.width,
          height: m.height,
        });
        m.shape.layout();
      }
    },
    // 序列化载荷：逐成员按 id 引用 + 前后几何快照
    toJSON: () => ({
      kind: "flowchart.resize",
      payload: {
        v: "group",
        before: before.map((m) => ({ shapeId: m.shape.id!, x: m.x, y: m.y, width: m.width, height: m.height })),
        after: after.map((m) => ({ shapeId: m.shape.id!, x: m.x, y: m.y, width: m.width, height: m.height })),
      } satisfies ResizePayload,
    }),
  };
}

// 连线端点重接命令：undo/redo 对称重接（节点 + 端口方向）
export function reconnectCommand(
  edge: FlowEdge,
  which: "from" | "to",
  oldNode: Shape,
  oldDir: PortDir,
  newNode: Shape,
  newDir: PortDir,
): HistoryCommand {
  return {
    type: "reconnect",
    redo: () => edge.reattachEnd(which, newNode, newDir),
    undo: () => edge.reattachEnd(which, oldNode, oldDir),
    // 序列化载荷：连线与两端节点按 id 引用，前后端口方向为纯数据
    toJSON: () => ({
      kind: "flowchart.reconnect",
      payload: {
        edgeId: edge.id!,
        which,
        oldNodeId: oldNode.id!,
        oldDir,
        newNodeId: newNode.id!,
        newDir,
      } satisfies ReconnectPayload,
    }),
  };
}

// 文本编辑命令：文字相对会话起点变化时入栈，layout 重测让居中落定
export function textCommand(
  shape: Shape,
  before: string,
  after: string,
): HistoryCommand {
  return {
    type: "text",
    redo: () => {
      shape.text.text = after;
      shape.layout();
    },
    undo: () => {
      shape.text.text = before;
      shape.layout();
    },
    // 序列化载荷：形状按 id 引用 + 前后文本快照
    toJSON: () => ({
      kind: "flowchart.text",
      payload: { shapeId: shape.id!, before, after } satisfies TextPayload,
    }),
  };
}

// 连线标签编辑命令：redo/undo 对称改写标签文本并重排（重测 + 折线中点居中）
export function edgeTextCommand(
  edge: FlowEdge,
  before: string,
  after: string,
): HistoryCommand {
  return {
    type: "text",
    redo: () => {
      edge.label.text = after;
      edge.layout();
    },
    undo: () => {
      edge.label.text = before;
      edge.layout();
    },
    // 序列化载荷：连线按 id 引用 + 前后文本快照
    toJSON: () => ({
      kind: "flowchart.edgeText",
      payload: { edgeId: edge.id!, before, after } satisfies EdgeTextPayload,
    }),
  };
}
