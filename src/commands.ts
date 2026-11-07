// 命令装配与可逆命令工厂：undo/redo/delete 注册为命令并绑定默认键位；
// 各类交互变更（移动/缩放/微调/重接/文本）的 HistoryCommand 在此构造——
// 只依赖调用方传入的数据快照，不触碰 FlowChart 内部状态

import type { CommandCapability } from "@silker/plugin-command";
import type { HistoryCommand } from "@silker/plugin-history";
import type { FlowEdge, PortDir } from "./FlowEdge";
import type { Shape } from "./Shape";
import type { Bounds } from "./snap";

// 命令回调钩子：命令分发时转发回 FlowChart 的对应入口（避免公开其私有成员）
export interface FlowchartCommandHooks {
  editing(): boolean; // 文本编辑会话进行中
  editorFocused(): boolean; // 编辑器持焦（按键属于输入）
  hasSelection(): boolean; // 当前有选中项
  undo(): void;
  redo(): void;
  deleteSelected(): void;
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
  commands.bind("mod+z", "flowchart.undo");
  commands.bind("mod+shift+z", "flowchart.redo");
  commands.bind("mod+y", "flowchart.redo");
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
  };
}
