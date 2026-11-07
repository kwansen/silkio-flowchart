import { App } from "@silker/core";
import type { HistoryCapability } from "@silker/plugin-history";
import type { TextEditorCapability } from "@silker/plugin-text-editor";
import { textCommand } from "./commands";
import type { Shape } from "./Shape";
import type { FlowChangeType } from "./data";

// 编辑依赖：能力经门面注入
export interface FlowEditingDeps {
  app: App;
  editor: TextEditorCapability;
  history: HistoryCapability;
  onChange?: (type: FlowChangeType) => void;
}

// 文本编辑会话：编辑态（正在编辑的形状）与会话起点快照的唯一属主
export class FlowEditing {
  // 正在编辑的形状（无编辑会话时为 null）
  editing: Shape | null = null;
  // 编辑会话起点快照（形状引用与原文字符串，非整图快照）：startEdit 记录，
  // finishEdit 对比决定是否把文本变更记入历史
  private editingOld: { shape: Shape | null; text: string } = {
    shape: null,
    text: "",
  };

  constructor(private deps: FlowEditingDeps) {}

  // 进入编辑：point 为按下时屏幕坐标，编辑器经浏览器命中测试把光标折叠到点击处
  startEdit(shape: Shape, point?: { x: number; y: number }) {
    // 编辑会话起点：定格形状与原文，编辑结束对比决定是否把文本变更记入历史
    // （覆盖层编辑是持续同步输入，无法在单次 input 边界判定"一次变更"）
    this.editingOld = { shape, text: shape.text.text };
    // 先 start：其内部 stop() 会触发旧会话的 onEditEnd → finishEdit，
    // 此时 this.editing 仍是旧形状（或 null），不会被新会话误清
    this.deps.editor.start(shape.text);
    this.editing = shape;
    this.deps.editor.show({ fill: true, point });
  }

  finishEdit() {
    const shape = this.editing;
    if (!shape) return;
    this.editing = null;
    shape.layout();
    // 文本相对会话起点确有变化才记历史：record 仅入栈不执行，因变更已发生
    const old = this.editingOld;
    if (old.shape === shape && shape.text.text !== old.text) {
      this.deps.history.record(textCommand(shape, old.text, shape.text.text));
    }
    this.deps.app.requestRender();
    this.deps.onChange?.("text");
  }

  // 结束指定形状的编辑态（形状被删除/顶替时调用，防止悬空编辑会话）
  cancelFor(shape: Shape) {
    if (this.editing === shape) {
      this.editing = null;
      this.deps.editor.stop();
    }
  }
}
