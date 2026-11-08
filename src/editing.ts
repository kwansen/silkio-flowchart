import { App } from "@silker/core";
import type { HistoryCapability } from "@silker/core";
import type { Text } from "@silker/core";
import type { TextEditorCapability } from "@silker/core";
import { textCommand, edgeTextCommand } from "./commands";
import { Shape } from "./Shape";
import { FlowEdge } from "./FlowEdge";
import type { FlowChangeType } from "./data";

// 编辑依赖：能力经门面注入
export interface FlowEditingDeps {
  app: App;
  editor: TextEditorCapability;
  history: HistoryCapability;
  onChange?: (type: FlowChangeType) => void;
  // 激活态删除选中（Delete/Backspace 在覆盖层上被接管：命令守卫因覆盖层持焦
  // 而拦截命令分发，删除由唤醒键绑定转回门面 deleteSelected）
  onDelete?: () => void;
}

// 编辑会话目标：形状或连线（连线编辑其标签文本）
export type EditTarget = Shape | FlowEdge;

// 文本编辑会话：编辑态（正在编辑的形状/连线）与会话起点快照的唯一属主。
// 连线标签另有「激活态」（同 mindmap 打字即编辑）：选中连线即挂载空缓冲覆盖层
// （隐藏、已聚焦、常驻），打字/IME 直接落入覆盖层并唤醒为编辑态——唤醒只切换
// 显隐、不移动焦点，首字符与组合窗口均正常进入
export class FlowEditing {
  // 正在编辑的形状/连线（无编辑会话时为 null）
  editing: EditTarget | null = null;
  // 激活态连线（覆盖层常驻挂载在其标签上；多选/形状选中/无选中时为 null）
  private activated: FlowEdge | null = null;
  // 编辑会话起点快照（目标引用与原文字符串，非整图快照）：startEdit/activateLabel
  // 记录，finishEdit 对比决定是否把文本变更记入历史
  private editingOld: { target: EditTarget | null; text: string } = {
    target: null,
    text: "",
  };

  constructor(private deps: FlowEditingDeps) {
    // 覆盖层挂载即绑定唤醒键（el 每次挂载重建，无监听堆积）
    deps.editor.onEditStart = (el, text) => this.bindWakeKeys(el, text);
  }

  // 进入编辑：point 为按下时屏幕坐标，编辑器经浏览器命中测试把光标折叠到点击处
  startEdit(target: EditTarget, point?: { x: number; y: number }) {
    // 编辑会话起点：定格目标与原文，编辑结束对比决定是否把文本变更记入历史
    // （覆盖层编辑是持续同步输入，无法在单次 input 边界判定"一次变更"）
    this.editingOld = { target, text: target.text.text };
    // 先 start：其内部 stop() 会触发旧会话的 onEditEnd → finishEdit，
    // 此时 this.editing 仍是旧目标（或 null），不会被新会话误清
    this.deps.editor.start(target.text);
    this.editing = target;
    this.deps.editor.show({ fill: true, point });
  }

  finishEdit() {
    const target = this.editing;
    if (!target) return;
    this.editing = null;
    target.layout();
    // 文本相对会话起点确有变化才记历史：record 仅入栈不执行，因变更已发生
    const old = this.editingOld;
    if (old.target === target && target.text.text !== old.text) {
      this.deps.history.record(
        target instanceof Shape
          ? textCommand(target, old.text, target.text.text)
          : edgeTextCommand(target, old.text, target.text.text),
      );
    }
    // 快照刷新为编辑后文本：激活态覆盖层仍在位，后续打字唤醒的新会话
    // 以本次编辑结果为基线对比，避免把上次已入历史的变更重复记账
    this.editingOld = { target, text: target.text.text };
    this.deps.app.requestRender();
    this.deps.onChange?.("text");
  }

  // 结束指定目标的编辑态（目标被删除/顶替时调用，防止悬空编辑会话）
  cancelFor(target: EditTarget) {
    if (this.editing === target) {
      this.editing = null;
      this.deps.editor.stop();
    }
  }

  // 激活连线标签：挂载空缓冲覆盖层（隐藏态、已聚焦）常驻接收打字/IME，
  // 同 mindmap 激活态；编辑态由唤醒键进入。重复激活同一连线跳过
  activateLabel(edge: FlowEdge) {
    if (this.activated === edge) return;
    // 先 start：其内部 stop() 会触发旧会话的 onEditEnd → finishEdit，
    // 此时 editingOld 仍是旧会话快照（新快照在其后定格，不被误清）
    this.deps.editor.start(edge.label);
    this.activated = edge;
    this.editingOld = { target: edge, text: edge.label.text };
  }

  // 取消激活：移除覆盖层；编辑会话若在该标签上进行，经 stop 的 onEditEnd
  // 正确收尾（finishEdit 对比记历史）。形状编辑会话不受影响
  deactivateLabel() {
    if (!this.activated) return;
    this.activated = null;
    this.deps.editor.stop();
  }

  // 唤醒键绑定：仅边标签（形状仍走点击/双击进入编辑）。激活态（无编辑会话）：
  // Delete/Backspace 删除选中连线；可打印字符/IME 组合唤醒编辑态；
  // 编辑态按键全部交给覆盖层默认行为（方向键移光标、回车换行、删除键删字）
  private bindWakeKeys(el: HTMLDivElement, text: Text) {
    const target = this.findTarget(text);
    if (!(target instanceof FlowEdge)) return;
    const wake = () => {
      if (this.editing) return;
      this.editing = target;
      // 空缓冲显示覆盖层：键入内容经 input 同步整体替换标签文本。
      // 焦点已在覆盖层（挂载时聚焦），不拦截按键——首字符/组合正常进入
      this.deps.editor.show();
    };
    el.addEventListener("keydown", (e) => {
      if (this.editing) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.deps.onDelete?.();
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length === 1 || e.key === "Process" || e.keyCode === 229)
        wake();
    });
    // 组合开始与输入事件兜底唤醒（粘贴路径：paste 监听先行显示，此处补编辑态）
    el.addEventListener("compositionstart", () => wake());
    el.addEventListener("input", () => wake());
  }

  // 按文本节点反查编辑目标：顶层子节点中匹配形状正文或连线标签
  private findTarget(text: Text): EditTarget | null {
    for (const child of this.deps.app.children) {
      if (child instanceof Shape && child.text === text) return child;
      if (child instanceof FlowEdge && child.label === text) return child;
    }
    return null;
  }
}
