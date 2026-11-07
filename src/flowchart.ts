import { App } from "@silker/core";
import type { Plugin } from "@silker/core";
import { Viewport, VIEWPORT_CAPABILITY } from "@silker/core-viewport";
import { TextEditor, TEXT_EDITOR_CAPABILITY } from "@silker/plugin-text-editor";
import type { TextEditorCapability } from "@silker/plugin-text-editor";
import { Exporter, EXPORT_CAPABILITY } from "@silker/plugin-exporter";
import type { ExportOptions } from "@silker/plugin-exporter";
import { History, HISTORY_CAPABILITY } from "@silker/plugin-history";
import type { HistoryCapability } from "@silker/plugin-history";
import { Selection, selectionCapabilityKey } from "@silker/plugin-selection";
import type { SelectionCapability } from "@silker/plugin-selection";
import { Command, COMMAND_CAPABILITY } from "@silker/plugin-command";
import { Pointer } from "@silker/plugin-interaction";
import { Clicker, CANVAS_CLICK_CAPABILITY } from "@silker/plugin-interaction";
import { BuiltinShapes, SHAPE_REGISTRY_CAPABILITY } from "./shape-registry";
import type { ShapeRegistryCapability } from "./shape-registry";
import { FlowEdge } from "./FlowEdge";
import type { Shape } from "./Shape";
import type { FlowChangeType, FlowData, ShapeKind } from "./data";
import type { Bounds } from "./snap";
import { BuiltinSnap, SNAP_CAPABILITY } from "./snap-capability";
import type { SnapCapability } from "./snap-capability";
import { BuiltinEdgeRouter, EDGE_ROUTER_CAPABILITY } from "./edge-router";
import type { EdgeRouterCapability } from "./edge-router";
import { SelectionOverlay } from "./overlay";
import { marqueeHits, portPos, unionBounds } from "./geometry";
import { bindFlowchartCommands } from "./commands";
import { FlowModel } from "./model";
import { FlowEditing } from "./editing";
import { HoverFeedback } from "./hover";
import { FlowInteractions } from "./interactions";
import {
  multiBounds as multiBoundsOf,
  selEdge as selEdgeOf,
  selShape as selShapeOf,
  selShapes as selShapesOf,
} from "./selection";

export interface FlowChartOptions {
  canvas: HTMLCanvasElement;
  data: FlowData;
  // 显式装配点：传入宿主自建并装配好官方外部插件（视口/指针/导出/历史/命令/
  // 编辑器/选中）的 App，本场景按能力键复用这些能力、只补齐自有插件；
  // 缺省时便捷模式自建 App 并装配同一套官方插件（开箱即用）
  app?: App;
  // 数据变化回调：新增 / 删除 / 移动 / 连线 / 文本编辑结束，当前数据用 toJSON() 导出
  onChange?: (type: FlowChangeType) => void;
  // 额外装配的插件（在官方形状/吸附插件之后、初始数据 load 之前安装）：
  // 第三方形状插件经此注册自定义形状，同名能力可覆盖官方吸附策略，
  // 使其在初始数据中即可用
  plugins?: Plugin[];
}

// 流程图场景门面：组装视口 / 文本编辑插件与各内聚模块（模型/编辑/悬浮/交互），
// 持有装配与选中语义，内置交互：点选、拖拽移动、单击已选中节点进入编辑
//（按点击位置聚焦光标）、端口拖拽连线、Delete 删除。
// 依赖单向：门面 → interactions/editing/hover → model → Shape/FlowEdge/core
export class FlowChart {
  app: App;
  private editor: TextEditorCapability;
  // 模型：形状表与连线表的唯一属主（建载/增删/顶替/z 序维护）
  private model!: FlowModel;
  // 选中能力（Selection 插件 install 时注册）：单选/多选模型统一存取，
  // items 为形状或连线（多选组合只含形状）；selected 高亮与置顶联动由本场景维护
  private sel: SelectionCapability<Shape | FlowEdge>;
  // 文本编辑会话（编辑态与会话起点快照）
  private editing!: FlowEditing;
  // 悬浮反馈（悬浮端口/悬浮连线状态）
  private hover!: HoverFeedback;
  // 交互会话控制器（会话/吸附/框选组合框状态属主）
  private interactions!: FlowInteractions;
  private overlay: SelectionOverlay;
  private onChange?: (type: FlowChangeType) => void;
  // 命令模式历史记录：实现在 @silker/plugin-history，构造器内安装插件后按能力键消费；
  // 各变更入口把"改模型"抽成可逆命令入栈，undo/redo 时重放/逆放
  private history!: HistoryCapability;
  // 形状注册表（BuiltinShapes 插件 install 时注册，第三方形状插件可追加/覆盖条目）：
  // 按 kind 创建形状，注册表缺失属于装配错误（require 兜底），未知 kind 数据按降级跳过
  private registry!: ShapeRegistryCapability;
  // 吸附能力（BuiltinSnap 插件 install 时注册，第三方吸附插件可同名覆盖）：
  // 拖拽对齐/等间距吸附，契约输入载体与候选 bounds + 视口缩放，输出位移与参考线
  private snapper!: SnapCapability;
  // 边路由能力（BuiltinEdgeRouter 插件 install 时注册，第三方路由插件可同名覆盖）：
  // 创建连线时注入每个 FlowEdge，路由与渲染均按契约消费
  private router!: EdgeRouterCapability;
  private cleanups: Array<() => void> = [];

  constructor(private options: FlowChartOptions) {
    this.onChange = options.onChange;
    if (options.app) {
      // 显式装配模式：宿主自建 App 并装配官方外部插件（视口/指针/导出/历史/
      // 命令/编辑器/选中），本场景按能力键复用这些能力，只补齐自有插件
      this.app = options.app;
    } else {
      // 便捷模式：自建 App 并装配官方外部插件（开箱即用，与显式装配同一套）
      this.app = new App(options.canvas);
      // 安装历史记录插件：命令模式 undo/redo 双栈（默认容量 100），install 时自注册
      // 历史能力，各变更入口按能力键消费（只认能力名与契约，不认插件实例）
      this.app.use(new History());
      // 安装命令与键位插件：install 时自注册命令能力，此后仅按能力键消费
      this.app.use(new Command());
      // 安装视口插件：视口状态唯一属主为 App 的 Camera
      this.app.use(new Viewport());
      // 安装指针交互插件：统一事件绑定/撤销与坐标换算（机制层），交互策略由本场景声明
      this.app.use(new Pointer());
      // 安装点击分发插件：拖拽阈值判定、命中测试与节点/空白点击分发（机制层）
      this.app.use(new Clicker());
      // 安装导出插件：install 时自注册导出能力，toImage 按能力键消费
      this.app.use(new Exporter());
    }
    this.history = this.app.require(HISTORY_CAPABILITY);
    // 安装官方形状/吸附/边路由插件（自注册各自能力），再装配应用层传入的第三方
    // 插件（可注册/覆盖形状、同名覆盖吸附策略与边路由，初始数据 load 前生效）；
    // 此后仅按能力键消费
    this.app.use(new BuiltinShapes());
    this.app.use(new BuiltinSnap());
    this.app.use(new BuiltinEdgeRouter());
    for (const p of options.plugins ?? []) this.app.use(p);
    this.registry = this.app.require(SHAPE_REGISTRY_CAPABILITY);
    this.snapper = this.app.require(SNAP_CAPABILITY);
    this.router = this.app.require(EDGE_ROUTER_CAPABILITY);
    // 显式声明对视口能力的依赖：命中换算与覆盖层绘制都按视口缩放反算
    this.app.require(VIEWPORT_CAPABILITY);
    // 显式声明对点击分发能力的依赖：节点 onClick 与空白点击均由其分发
    // （显式装配模式下由宿主负责安装 Clicker）
    this.app.require(CANVAS_CLICK_CAPABILITY);
    // 撤销/重做/删除注册为命令并绑定默认键位，document keydown 由命令插件
    // 统一分发；应用层与第三方可按能力键复用命令或重绑键位
    bindFlowchartCommands(this.app.require(COMMAND_CAPABILITY), {
      editing: () => this.editing.editing !== null,
      editorFocused: () => this.editor.hasFocus(),
      hasSelection: () => this.sel.items.length > 0,
      undo: () => this.undo(),
      redo: () => this.redo(),
      deleteSelected: () => this.deleteSelected(),
    });
    this.editor = this.setupEditor();
    this.editing = new FlowEditing({
      app: this.app,
      editor: this.editor,
      history: this.history,
      onChange: this.onChange,
    });
    this.model = new FlowModel({
      app: this.app,
      registry: this.registry,
      router: this.router,
      history: this.history,
      onChange: this.onChange,
      // 形状脱离模型（删除/顶替）时：结束其编辑态并取消选中，防止悬空
      // 编辑会话与悬空选中（原 removeShape/swapShape 内联副作用，集中在此接线）
      onDetach: (shape) => {
        this.editing.cancelFor(shape);
        this.interactions.select(null);
      },
      onSelect: (item) => this.interactions.select(item),
    });
    this.sel = this.setupSelection();
    this.hover = new HoverFeedback({
      app: this.app,
      canvas: options.canvas,
      edges: () => this.model.edges,
      sel: this.sel,
      onRaiseEdgeTop: (edge) => this.model.raiseEdgeTop(edge),
    });
    this.interactions = new FlowInteractions({
      app: this.app,
      canvas: options.canvas,
      model: this.model,
      sel: this.sel,
      editing: this.editing,
      hover: this.hover,
      snapper: this.snapper,
      router: this.router,
      editor: this.editor,
      history: this.history,
      onChange: this.onChange,
    });
    this.model.load(options.data);
    // 选中框覆盖层置于最上层（registerShape 追加新节点后需 raiseOverlay 保持）
    this.overlay = new SelectionOverlay(() => {
      const scale = this.app.camera.viewport.scale;
      const dirs = ["top", "right", "bottom", "left"] as const;
      const selShape = this.selShape;
      const selEdge = this.selEdge;
      return {
        shape: selShape,
        scale,
        ports: selShape
          ? dirs.map((dir) => portPos(selShape, dir, scale))
          : [],
        hoverPort: this.hover.port,
        // 激活连线的首尾端点手柄（端点拖拽期间隐藏）
        edgeHandles:
          selEdge && !selEdge.dragWhich && selEdge.points.length >= 2
            ? [selEdge.points[0], selEdge.points[selEdge.points.length - 1]]
            : [],
        link: this.interactions.linkTarget
          ? {
              // 对接手柄位于节点边缘的实际连接点（与连线端口/预览吸附一致）
              ports: dirs.map((dir) => this.interactions.linkTarget!.portAt(dir)),
              active: this.interactions.linkSnap
                ? this.interactions.linkTarget.portAt(this.interactions.linkSnap)
                : null,
            }
          : null,
        guides: this.interactions.guides,
        // 框选拖拽中：实时显示已框中节点的整体选框（随拖拽更新，未框中节点时
        // 不显示），橡皮筋矩形由选中插件绘制；落定后为多选组合 bounds
        marquee: this.interactions.marqueeCombo ?? this.multiBounds,
      };
    });
    this.model.overlay = this.overlay;
    this.app.add(this.overlay);
    this.cleanups.push(this.interactions.bind(options.canvas));
  }

  // 装配文本编辑器：显式模式按能力键取回宿主装配的实例，便捷模式自建并安装；
  // 业务回调统一写到实例的公开回调字段上（两种模式共用同一套回调）
  private setupEditor(): TextEditorCapability {
    let editor: TextEditor;
    if (this.options.app) {
      editor = this.app.require(TEXT_EDITOR_CAPABILITY) as TextEditor;
    } else {
      editor = new TextEditor();
      this.app.use(editor);
    }
    // 输入实时同步：文本重测后重新居中（不改形状尺寸），覆盖层跟随新位置
    editor.onInput = () => {
      const shape = this.editing.editing;
      if (!shape) return;
      shape.layout();
      this.app.requestRender();
      this.editor.reposition();
    };
    // 编辑结束（失焦）：文字居中落定并通知外部
    editor.onEditEnd = () => this.editing.finishEdit();
    return editor;
  }

  // 装配选中插件：单选/多选模型与框选会话（机制），选中语义（selected 高亮、
  // 连线置顶等）由本场景定义；显式模式按能力键取回宿主装配的实例，
  // 便捷模式自建并安装。框选命中规则 = 与矩形相交的形状
  private setupSelection(): SelectionCapability<Shape | FlowEdge> {
    let selection: Selection<Shape | FlowEdge>;
    if (this.options.app) {
      selection = this.app.require(
        selectionCapabilityKey<Shape | FlowEdge>(),
      ) as Selection<Shape | FlowEdge>;
    } else {
      selection = new Selection<Shape | FlowEdge>();
      this.app.use(selection);
    }
    selection.hitRect = (rect) => marqueeHits(this.model.shapes.values(), rect);
    // 拖框中实时显示已框中节点的整体选框（随拖拽更新，未框中节点时不显示）
    selection.onMarqueeMove = (_rect, hits) => {
      this.interactions.marqueeCombo = hits.length ? unionBounds(hits) : null;
    };
    // 框选落定：单个退化为普通单选，多个进入组合选中，落空保持无选中
    selection.onMarqueeEnd = (_rect, hits) => {
      this.interactions.marqueeCombo = null;
      if (hits.length === 1) this.interactions.select(hits[0]);
      else if (hits.length > 1) {
        selection.set(hits);
        this.app.requestRender();
      }
    };
    return selection;
  }

  //#region 公开 API
  // 新增节点（默认居中样式），返回节点 id
  addNode(input: {
    shape: ShapeKind;
    text?: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }) {
    const shape = this.model.createShape(input.shape, {
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      text: input.text,
    });
    // 注册动作本身作为可逆命令：redo 完成注册，undo 摘除节点及其关联连线
    this.history.exec({
      type: "add",
      redo: () => this.model.registerShape(shape),
      undo: () => this.model.removeShape(shape),
    });
    this.app.requestRender();
    this.onChange?.("add");
    return shape.id as string;
  }

  // 删除当前选中（形状连同其关联连线，或单条连线；多选时删除全部成员）。
  // 删除记录为可逆命令：undo 按原 z 序索引插回，redo 重放摘除
  deleteSelected() {
    if (this.sel.items.length > 1) {
      const list = [...this.selShapes];
      const captured = list.map((s) => this.model.captureShapeRemoval(s));
      this.sel.clear();
      list.forEach((s) => this.model.removeShape(s));
      this.app.requestRender();
      this.history.exec({
        type: "delete",
        redo: () => {
          for (const c of captured) this.model.applyShapeRemoval(c);
        },
        undo: () => {
          for (const c of [...captured].reverse())
            this.model.restoreShapeRemoval(c);
        },
      });
      this.onChange?.("delete");
      return;
    }
    const sel = this.sel.items[0];
    if (!sel) return;
    if (sel instanceof FlowEdge) {
      const captured = {
        edge: sel,
        childIdx: this.app.children.indexOf(sel),
        listIdx: this.model.edges.indexOf(sel),
      };
      this.interactions.select(null);
      this.model.removeTop(sel);
      this.model.edges = this.model.edges.filter((e) => e !== sel);
      this.app.requestRender();
      this.history.exec({
        type: "delete",
        redo: () => {
          this.model.removeTop(captured.edge);
          this.model.edges = this.model.edges.filter(
            (e) => e !== captured.edge,
          );
        },
        undo: () => {
          this.model.edges.splice(
            Math.min(captured.listIdx, this.model.edges.length),
            0,
            captured.edge,
          );
          this.model.insertAt(captured.edge, captured.childIdx);
        },
      });
    } else {
      const captured = this.model.captureShapeRemoval(sel);
      this.model.removeShape(sel);
      this.app.requestRender();
      this.history.exec({
        type: "delete",
        redo: () => this.model.applyShapeRemoval(captured),
        undo: () => this.model.restoreShapeRemoval(captured),
      });
    }
    this.onChange?.("delete");
  }

  // 替换当前选中形状的类型：保留位置、尺寸、文本、id 与全部连线
  // （连线两端引用直接重绑到新形状，端口方向维持创建时冻结的值不重选边），
  // 新形状占据原形状的 z 序位置并进入选中态；多选或类型相同时不操作
  replaceSelected(kind: ShapeKind) {
    const old = this.selShape;
    if (!old || old.kind === kind) return;
    const shape = this.model.createShape(kind, {
      id: old.id as string,
      x: old.x,
      y: old.y,
      width: old.width,
      height: old.height,
      text: old.text.text,
    });
    // 替换记录为可逆命令：undo/redo 对称地把旧/新形状顶替回去
    this.history.exec({
      type: "replace",
      redo: () => this.model.swapShape(old, shape),
      undo: () => this.model.swapShape(shape, old),
    });
    this.app.requestRender();
    this.onChange?.("replace");
  }

  // 导出当前数据（位置为最新拖拽结果）
  toJSON(): FlowData {
    return this.model.toJSON();
  }

  // 导出全部形状与连线为图片（返回 Blob）：委托导出能力离屏渲染，与当前视口无关；
  // 显式传入形状与连线（不含选中框等覆盖层），绕行连线按路由折线并入包围盒
  async toImage(options?: ExportOptions): Promise<Blob> {
    return this.app.require(EXPORT_CAPABILITY).export(
      [...this.model.shapes.values(), ...this.model.edges],
      options,
    );
  }

  // 撤销：编辑与拖拽会话中不响应（避免与进行中的变更互踩）；回退前先清空选中，
  // 防止悬空引用（选中框/端口/编辑态指向已摘除的形状或连线）
  undo() {
    if (this.editing.editing || this.interactions.busy) return;
    const cmd = this.history.undo();
    if (!cmd) return;
    this.interactions.select(null);
    this.app.requestRender();
    // undo/redo 不产生新变更，仅通知宿主数据已回退（type 为产生该变更的命令类型）
    this.onChange?.(cmd.type as FlowChangeType);
  }

  // 重做：流程与 undo 对称，方向相反
  redo() {
    if (this.editing.editing || this.interactions.busy) return;
    const cmd = this.history.redo();
    if (!cmd) return;
    this.interactions.select(null);
    this.app.requestRender();
    this.onChange?.(cmd.type as FlowChangeType);
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  // 卸载事件监听（页面级销毁用）
  destroy() {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
  }
  //#endregion

  // 选中的形状（选中连线或无选中时为 null）
  private get selShape(): Shape | null {
    return selShapeOf(this.sel);
  }

  // 选中的连线（选中形状或无选中时为 null）
  private get selEdge(): FlowEdge | null {
    return selEdgeOf(this.sel);
  }

  // 当前选中的形状列表（多选组合或单选形状；选中连线时为空）
  private get selShapes(): Shape[] {
    return selShapesOf(this.sel);
  }

  // 多选组合的包围盒（少于 2 个形状时视为无组合）
  private get multiBounds(): Bounds | null {
    return multiBoundsOf(this.sel);
  }
}
