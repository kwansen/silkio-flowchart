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
// 形状正文与连线标签共用「激活态」（同 mindmap 打字即编辑）：选中即挂载空缓冲
// 覆盖层（隐藏、已聚焦、常驻），打字/IME 直接落入覆盖层并唤醒为编辑态——唤醒只
// 切换显隐、不移动焦点，首字符与组合窗口均正常进入
export class FlowEditing {
  // 正在编辑的形状/连线（无编辑会话时为 null）
  editing: EditTarget | null = null;
  // 激活目标（形状正文或连线标签：空缓冲覆盖层常驻挂载、隐藏已聚焦；
  // 多选/无选中时为 null）
  private activated: EditTarget | null = null;
  // 编辑会话起点快照（目标引用与原文字符串，非整图快照）：startEdit/activate
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
    // 点击路径（有点击点）：填入原文并把光标折叠到点击处；打字唤醒路径（无点击
    // 点）：空缓冲覆盖层——按键的默认插入动作落在覆盖层，经 input 整体替换文本
    this.deps.editor.show(point ? { fill: true, point } : {});
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

  // 激活目标：挂载空缓冲覆盖层（隐藏态、已聚焦）常驻接收打字/IME，
  // 同 mindmap 激活态；编辑态由唤醒键进入。重复激活同一目标跳过。
  // 覆盖层必须在 IME 组合开始前就位（选中即挂载），组合窗口内再挂载/聚焦
  // 会丢失首个组合字符
  activate(target: EditTarget) {
    if (this.activated === target) return;
    // 先 start：其内部 stop() 会触发旧会话的 onEditEnd → finishEdit，
    // 此时 editingOld 仍是旧会话快照（新快照在其后定格，不被误清）
    this.deps.editor.start(target.text);
    this.activated = target;
    this.editingOld = { target, text: target.text.text };
  }

  // 取消激活：移除覆盖层；编辑会话若在该目标上进行，经 stop 的 onEditEnd
  // 正确收尾（finishEdit 对比记历史）
  deactivate() {
    if (!this.activated) return;
    this.activated = null;
    this.deps.editor.stop();
  }

  // 唤醒键绑定：激活态（无编辑会话）按 Delete/Backspace 删除选中；可打印
  // 字符/IME 组合唤醒编辑态（空缓冲，键入经 input 整体替换文本）；编辑态
  // 按键全部交给覆盖层默认行为（方向键移光标、回车换行、删除键删字）。
  // 形状与连线标签同一套唤醒语义
  private bindWakeKeys(el: HTMLDivElement, text: Text) {
    const target = this.findTarget(text);
    if (!target) return;
    const wake = () => {
      if (this.editing) return;
      this.editing = target;
      // 空缓冲显示覆盖层：键入内容经 input 同步整体替换文本。挂载后节点/
      // 连线可能已被移动过（覆盖层按挂载时位置对齐），唤醒显形前重新对齐
      this.deps.editor.show();
      this.deps.editor.reposition();
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
