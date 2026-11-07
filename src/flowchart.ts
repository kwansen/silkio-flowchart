import { App, Node } from "@silker/core";
import type { Plugin } from "@silker/core";
import { Viewport, VIEWPORT_CAPABILITY } from "@silker/core-viewport";
import { TextEditor, TEXT_EDITOR_CAPABILITY } from "@silker/plugin-text-editor";
import type { TextEditorCapability } from "@silker/plugin-text-editor";
import { Exporter, EXPORT_CAPABILITY } from "@silker/plugin-exporter";
import type { ExportOptions } from "@silker/plugin-exporter";
import { History, HISTORY_CAPABILITY } from "@silker/plugin-history";
import type { HistoryCapability, HistoryCommand } from "@silker/plugin-history";
import { compose } from "@silker/plugin-history";
import { Selection, selectionCapabilityKey } from "@silker/plugin-selection";
import type { SelectionCapability } from "@silker/plugin-selection";
import { Command, COMMAND_CAPABILITY } from "@silker/plugin-command";
import { Pointer, POINTER_CAPABILITY } from "@silker/plugin-interaction";
import { BuiltinShapes, SHAPE_REGISTRY_CAPABILITY } from "./shape-registry";
import type { ShapeRegistryCapability } from "./shape-registry";
import { Shape } from "./Shape";
import type { ShapeOptions } from "./Shape";
import { FlowEdge, OPPOSITE_DIR, PORT_STUB } from "./FlowEdge";
import type { FlowEdgeHints, PortDir } from "./FlowEdge";
import type { FlowChangeType, FlowData, ShapeKind } from "./data";
import type { Bounds, SnapGuides } from "./snap";
import { BuiltinSnap, SNAP_CAPABILITY } from "./snap-capability";
import type { SnapCapability } from "./snap-capability";
import { BuiltinEdgeRouter, EDGE_ROUTER_CAPABILITY } from "./edge-router";
import type { EdgeRouterCapability } from "./edge-router";
import { LinkPreview, SelectionOverlay } from "./overlay";
import {
  applyGroupResize,
  applyResize,
  cornerHit,
  edgeHandleHit,
  edgeHit,
  findLinkTarget,
  hitEdge,
  hitShape,
  hoverCursor,
  marqueeHits,
  portHit,
  portPos,
  previewToDir,
  unionBounds,
} from "./geometry";
import type { ResizeHandle } from "./geometry";
import {
  bindFlowchartCommands,
  groupResizeCommand,
  moveCommand,
  nudgeCommand,
  reconnectCommand,
  resizeCommand,
  textCommand,
} from "./commands";

// 端口点击快速创建：点击（非拖拽）端口时沿该方向自动新建节点并连线；
// 拖拽仍是手动连线，以按下后的位移区分两种意图
const CLICK_MOVE_TOLERANCE = 4; // 判定点击的最大位移（屏幕像素）
const CLICK_CREATE_GAP = 80; // 新节点与源节点边缘的间距（世界坐标）

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

// 交互会话：节点拖拽移动（多选时为组合移动）/ 拖拽缩放 / 框选组合缩放
// / 端口拖拽连线 / 连线端点重接（空白按下由选中插件的框选会话接管，不经会话）
type Session =
  | {
      kind: "move";
      shape: Shape;
      start: { x: number; y: number };
      origin: { x: number; y: number };
      moved: boolean;
      group: Array<{ shape: Shape; x: number; y: number }> | null;
      keepMulti?: boolean;
      // 按下在已选中节点上的屏幕坐标：抬起未拖动时视为点击进入编辑
      press?: { x: number; y: number };
    }
  | {
      kind: "resize";
      shape: Shape;
      handle: ResizeHandle;
      start: { x: number; y: number };
      origin: Bounds;
    }
  | {
      kind: "group-resize";
      handle: ResizeHandle;
      start: { x: number; y: number };
      origin: Bounds;
      origins: Array<{
        shape: Shape;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    }
  | {
      kind: "link";
      source: Shape;
      sourceDir: PortDir;
      preview: LinkPreview;
      start: { x: number; y: number }; // 按下位置：抬起时未进入拖拽态视为点击（快速建节点）
      armed?: boolean; // 位移超过点击阈值、确认是拖拽连线后为 true（此时才显示预览边）
    }
  | { kind: "edge-move"; edge: FlowEdge; which: "from" | "to" };

// 流程图场景门面：组装视口 / 文本编辑插件，持有形状与连线模型，
// 内置交互：点选、拖拽移动、单击已选中节点进入编辑（按点击位置聚焦光标）、
// 端口拖拽连线、Delete 删除
export class FlowChart {
  app: App;
  private editor: TextEditorCapability;
  private shapes = new Map<string, Shape>();
  private edges: FlowEdge[] = [];
  // 选中能力（Selection 插件 install 时注册）：单选/多选模型统一存取，
  // items 为形状或连线（多选组合只含形状）；selected 高亮与置顶联动由本场景维护
  private sel: SelectionCapability<Shape | FlowEdge>;
  // 框选拖拽中的实时组合框（已框中节点的并集 bounds，供覆盖层绘制；松手后清空）
  private marqueeCombo: Bounds | null = null;
  private editing: Shape | null = null;
  private session: Session | null = null;
  private overlay: SelectionOverlay;
  // 连线拖拽吸附状态：接近中的目标节点与吸附中的端口方向
  private linkTarget: Shape | null = null;
  private linkSnap: PortDir | null = null;
  // 悬浮中的端口方向（单选形状的四向端口）：覆盖层放大该圆点并绘制方向箭头
  private hoverPort: PortDir | null = null;
  // 悬浮中的连线：浅蓝色高亮（类似 hoverPort，状态变化时重绘）
  private hoverEdge: FlowEdge | null = null;
  // 节点拖拽对齐参考线（applySnap/applySpacingSnap 更新，拖拽结束清除）
  private guides: SnapGuides | null = null;
  // 吸附迟滞状态：上一帧两轴是否处于对齐吸附态（拖拽会话内逐帧回传给
  // computeSnap，会话结束清零），已吸附的轴用加倍的释放容差维持吸附，
  // 光标在阈值边界抖动时吸附不反复进出
  private snapPrev = { x: false, y: false };
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
  // 编辑会话起点快照（形状引用与原文字符串，非整图快照）：startEdit 记录，
  // finishEdit 对比决定是否把文本变更记入历史
  private editingOld: { shape: Shape | null; text: string } = {
    shape: null,
    text: "",
  };
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
    // 撤销/重做/删除注册为命令并绑定默认键位，document keydown 由命令插件
    // 统一分发；应用层与第三方可按能力键复用命令或重绑键位
    bindFlowchartCommands(this.app.require(COMMAND_CAPABILITY), {
      editing: () => this.editing !== null,
      editorFocused: () => this.editor.hasFocus(),
      hasSelection: () => this.sel.items.length > 0,
      undo: () => this.undo(),
      redo: () => this.redo(),
      deleteSelected: () => this.deleteSelected(),
    });
    this.editor = this.setupEditor();
    this.sel = this.setupSelection();
    this.load(options.data);
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
        hoverPort: this.hoverPort,
        // 激活连线的首尾端点手柄（端点拖拽期间隐藏）
        edgeHandles:
          selEdge && !selEdge.dragWhich && selEdge.points.length >= 2
            ? [selEdge.points[0], selEdge.points[selEdge.points.length - 1]]
            : [],
        link: this.linkTarget
          ? {
              // 对接手柄位于节点边缘的实际连接点（与连线端口/预览吸附一致）
              ports: dirs.map((dir) => this.linkTarget!.portAt(dir)),
              active: this.linkSnap
                ? this.linkTarget.portAt(this.linkSnap)
                : null,
            }
          : null,
        guides: this.guides,
        // 框选拖拽中：实时显示已框中节点的整体选框（随拖拽更新，未框中节点时
        // 不显示），橡皮筋矩形由选中插件绘制；落定后为多选组合 bounds
        marquee: this.marqueeCombo ?? this.multiBounds,
      };
    });
    this.app.add(this.overlay);
    this.bindEvents(options.canvas);
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
      const shape = this.editing;
      if (!shape) return;
      shape.layout();
      this.app.requestRender();
      this.editor.reposition();
    };
    // 编辑结束（失焦）：文字居中落定并通知外部
    editor.onEditEnd = () => this.finishEdit();
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
    selection.hitRect = (rect) => marqueeHits(this.shapes.values(), rect);
    // 拖框中实时显示已框中节点的整体选框（随拖拽更新，未框中节点时不显示）
    selection.onMarqueeMove = (_rect, hits) => {
      this.marqueeCombo = hits.length ? unionBounds(hits) : null;
    };
    // 框选落定：单个退化为普通单选，多个进入组合选中，落空保持无选中
    selection.onMarqueeEnd = (_rect, hits) => {
      this.marqueeCombo = null;
      if (hits.length === 1) this.select(hits[0]);
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
    const shape = this.createShape(input.shape, {
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      text: input.text,
    });
    // 注册动作本身作为可逆命令：redo 完成注册，undo 摘除节点及其关联连线
    this.history.exec({
      type: "add",
      redo: () => this.registerShape(shape),
      undo: () => this.removeShape(shape),
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
      const captured = list.map((s) => this.captureShapeRemoval(s));
      this.sel.clear();
      list.forEach((s) => this.removeShape(s));
      this.app.requestRender();
      this.history.exec({
        type: "delete",
        redo: () => {
          for (const c of captured) this.applyShapeRemoval(c);
        },
        undo: () => {
          for (const c of [...captured].reverse()) this.restoreShapeRemoval(c);
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
        listIdx: this.edges.indexOf(sel),
      };
      this.select(null);
      this.removeTop(sel);
      this.edges = this.edges.filter((e) => e !== sel);
      this.app.requestRender();
      this.history.exec({
        type: "delete",
        redo: () => {
          this.removeTop(captured.edge);
          this.edges = this.edges.filter((e) => e !== captured.edge);
        },
        undo: () => {
          this.edges.splice(
            Math.min(captured.listIdx, this.edges.length),
            0,
            captured.edge,
          );
          this.insertAt(captured.edge, captured.childIdx);
        },
      });
    } else {
      const captured = this.captureShapeRemoval(sel);
      this.removeShape(sel);
      this.app.requestRender();
      this.history.exec({
        type: "delete",
        redo: () => this.applyShapeRemoval(captured),
        undo: () => this.restoreShapeRemoval(captured),
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
    const shape = this.createShape(kind, {
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
      redo: () => this.swapShape(old, shape),
      undo: () => this.swapShape(shape, old),
    });
    this.app.requestRender();
    this.onChange?.("replace");
  }

  // 把 b 顶替 a：重绑全部连线两端引用、占据 a 的 z 序位置并更新形状表；
  // b 为替身形状（预先创建），replaceSelected 的 undo/redo 共用
  private swapShape(a: Shape, b: Shape) {
    if (this.editing === a) {
      this.editing = null;
      this.editor.stop();
    }
    for (const e of this.edges) {
      if (e.fromNode === a) e.fromNode = b;
      if (e.toNode === a) e.toNode = b;
    }
    const idx = this.app.children.indexOf(a);
    this.removeTop(a);
    this.shapes.delete(a.id as string);
    if (idx !== -1) {
      b.parent = null;
      this.app.children.splice(idx, 0, b);
    } else {
      this.app.add(b);
    }
    this.shapes.set(b.id as string, b);
    this.raiseOverlay();
    this.select(b);
  }

  // 导出当前数据（位置为最新拖拽结果）
  toJSON(): FlowData {
    return {
      nodes: [...this.shapes.values()].map((s) => ({
        id: s.id ?? undefined,
        shape: s.kind,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        text: s.text.text,
      })),
      edges: this.edges.map((e) => ({
        from: e.fromNode.id as string,
        to: e.toNode.id as string,
        fromDir: e.fromDir,
        toDir: e.toDir,
      })),
    };
  }

  // 导出全部形状与连线为图片（返回 Blob）：委托导出能力离屏渲染，与当前视口无关；
  // 显式传入形状与连线（不含选中框等覆盖层），绕行连线按路由折线并入包围盒
  async toImage(options?: ExportOptions): Promise<Blob> {
    return this.app.require(EXPORT_CAPABILITY).export(
      [...this.shapes.values(), ...this.edges],
      options,
    );
  }

  // 撤销：编辑与拖拽会话中不响应（避免与进行中的变更互踩）；回退前先清空选中，
  // 防止悬空引用（选中框/端口/编辑态指向已摘除的形状或连线）
  undo() {
    if (this.editing || this.session) return;
    const cmd = this.history.undo();
    if (!cmd) return;
    this.select(null);
    this.app.requestRender();
    // undo/redo 不产生新变更，仅通知宿主数据已回退（type 为产生该变更的命令类型）
    this.onChange?.(cmd.type as FlowChangeType);
  }

  // 重做：流程与 undo 对称，方向相反
  redo() {
    if (this.editing || this.session) return;
    const cmd = this.history.redo();
    if (!cmd) return;
    this.select(null);
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

  //#region 模型维护
  private load(data: FlowData) {
    for (const n of data.nodes) {
      // 数据中的 kind 可能来自未装配的第三方形状插件（Extension 缺失允许降级）：
      // 跳过该节点，其关联连线因端点缺失在下方一并跳过
      const shape = this.registry.create(n.shape, {
        id: n.id,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        text: n.text,
      });
      if (!shape) continue;
      this.registerShape(shape);
    }
    for (const e of data.edges) {
      const from = this.shapes.get(e.from);
      const to = this.shapes.get(e.to);
      if (from && to)
        this.addEdgeBetween(from, to, false, { from: e.fromDir, to: e.toDir });
    }
    this.app.requestRender();
  }

  // 按注册表创建形状：编程路径（addNode/replaceSelected/快速建节点）的 kind
  // 来自类型化 API 或既有节点，未注册属于编程错误，fail fast
  private createShape(kind: ShapeKind, options: ShapeOptions): Shape {
    const shape = this.registry.create(kind, options);
    if (!shape) throw new Error(`Unknown shape kind: "${kind}"`);
    return shape;
  }

  private registerShape(shape: Shape) {
    this.shapes.set(shape.id as string, shape);
    this.app.add(shape);
    this.raiseOverlay();
  }

  // 保持选中框覆盖层在最上层（新增节点会追加到 children 末尾）
  private raiseOverlay() {
    const c = this.app.children;
    const i = c.indexOf(this.overlay);
    if (i !== -1 && i !== c.length - 1) {
      c.splice(i, 1);
      c.push(this.overlay);
    }
  }

  // 新建连线：两节点间可存在多条连线，不做去重限制；
  // 插入到形状层之下保证连线画在节点下方；
  // hints 指定两端固定端口（拖拽吸附创建时传入），缺省按主导方向自动选边。
  // notify 时创建记录为可逆命令（变更已发生，record 仅入栈）
  private addEdgeBetween(
    from: Shape,
    to: Shape,
    notify: boolean,
    hints?: FlowEdgeHints,
  ): FlowEdge {
    const edge = new FlowEdge(from, to, hints);
    edge.router = this.router;
    this.edges.push(edge);
    this.insertEdge(edge);
    if (notify) {
      this.history.record({
        type: "connect",
        ...this.edgeAddRemove(edge),
      });
      this.onChange?.("connect");
    }
    return edge;
  }

  // 连线增删的可逆对：redo 压回连线表并插入形状层之下，undo 摘除。
  // 供 connect 命令直接入栈，也供组合命令复用
  private edgeAddRemove(edge: FlowEdge): HistoryCommand {
    return {
      redo: () => {
        this.edges.push(edge);
        this.insertEdge(edge);
      },
      undo: () => {
        this.edges = this.edges.filter((e) => e !== edge);
        this.removeTop(edge);
      },
    };
  }

  // 连线插入到形状层之下（首个 Shape 之前），保证画在节点下方
  private insertEdge(edge: FlowEdge) {
    const idx = this.app.children.findIndex((n) => n instanceof Shape);
    if (idx === -1) this.app.children.push(edge);
    else this.app.children.splice(idx, 0, edge);
  }

  private removeShape(shape: Shape) {
    if (this.editing === shape) {
      this.editing = null;
      this.editor.stop();
    }
    this.select(null);
    const related = this.edges.filter(
      (e) => e.fromNode === shape || e.toNode === shape,
    );
    this.edges = this.edges.filter((e) => !related.includes(e));
    related.forEach((e) => this.removeTop(e));
    this.removeTop(shape);
    this.shapes.delete(shape.id as string);
  }

  private removeTop(node: Node) {
    const i = this.app.children.indexOf(node);
    if (i !== -1) this.app.children.splice(i, 1);
  }

  // 按 z 序索引插回画布（undo/redo 重放同一索引，不依赖恢复时的树状态）
  private insertAt(node: Node, idx: number) {
    node.parent = null;
    this.app.children.splice(
      Math.max(0, Math.min(idx, this.app.children.length)),
      0,
      node,
    );
  }

  // 删除捕获：形状 + 原 z 序索引 + 关联连线（各自的连线序与 z 序索引）。
  // 撤销删除时按索引插回，恢复原 z 序（连线层在形状层之下）
  private captureShapeRemoval(shape: Shape) {
    return {
      shape,
      childIdx: this.app.children.indexOf(shape),
      edges: this.edges
        .map((edge, order) => ({
          edge,
          order,
          childIdx: this.app.children.indexOf(edge),
        }))
        .filter((c) => c.edge.fromNode === shape || c.edge.toNode === shape),
    };
  }

  // 应用删除：先摘关联连线再摘形状（removeShape 内含编辑态清理与取消选中）
  private applyShapeRemoval(c: ReturnType<FlowChart["captureShapeRemoval"]>) {
    for (const { edge } of c.edges) {
      this.edges = this.edges.filter((e) => e !== edge);
      this.removeTop(edge);
    }
    this.removeShape(c.shape);
  }

  // 恢复删除：按记录的连线序与 z 序索引插回连线与形状
  private restoreShapeRemoval(c: ReturnType<FlowChart["captureShapeRemoval"]>) {
    for (const { edge, order, childIdx } of c.edges) {
      this.edges.splice(Math.min(order, this.edges.length), 0, edge);
      this.insertAt(edge, childIdx);
    }
    this.insertAt(c.shape, c.childIdx);
    this.shapes.set(c.shape.id as string, c.shape);
  }

  private select(sel: Shape | FlowEdge | null) {
    // 多选与单选互斥：选中集合整体替换，天然互斥
    // 选中变化后悬浮端口不再有效（可能指向新选中形状的错误方向）
    this.hoverPort = null;
    if (sel) {
      if (this.sel.items.length === 1 && this.sel.items[0] === sel) return;
      for (const it of this.sel.items) it.selected = false;
      this.sel.set([sel]);
      sel.selected = true;
      // 激活的连线提到连线层最上再渲染，避免激活样式被其他连线覆盖
      if (sel instanceof FlowEdge) this.raiseEdgeTop(sel);
    } else {
      if (!this.sel.items.length) return;
      for (const it of this.sel.items) it.selected = false;
      this.sel.clear();
    }
    this.app.requestRender();
  }

  // 多选组合的包围盒（少于 2 个形状时视为无组合）
  private get multiBounds(): Bounds | null {
    const shapes = this.selShapes;
    if (shapes.length < 2) return null;
    return unionBounds(shapes);
  }

  // 把连线移到连线层最上（保持在形状层/覆盖层之下）
  private raiseEdgeTop(edge: FlowEdge) {
    const children = this.app.children;
    const from = children.indexOf(edge);
    if (from === -1) return;
    let to = from;
    for (let j = from + 1; j < children.length; j++) {
      const c = children[j];
      if (c instanceof Shape || c === this.overlay) break;
      to = j;
    }
    if (to !== from) {
      children.splice(from, 1);
      children.splice(to, 0, edge);
    }
  }

  // 选中的形状（选中连线或无选中时为 null）
  private get selShape(): Shape | null {
    const items = this.sel.items;
    return items.length === 1 && items[0] instanceof Shape
      ? (items[0] as Shape)
      : null;
  }

  // 选中的连线（选中形状或无选中时为 null）
  private get selEdge(): FlowEdge | null {
    const items = this.sel.items;
    return items.length === 1 && items[0] instanceof FlowEdge
      ? (items[0] as FlowEdge)
      : null;
  }

  // 当前选中的形状列表（多选组合或单选形状；选中连线时为空）——单/多选共用一套命中与移动逻辑
  private get selShapes(): Shape[] {
    return this.sel.items.filter((s): s is Shape => s instanceof Shape);
  }
  //#endregion

  //#region 编辑
  // 进入编辑：point 为按下时屏幕坐标，编辑器经浏览器命中测试把光标折叠到点击处
  private startEdit(shape: Shape, point?: { x: number; y: number }) {
    // 编辑会话起点：定格形状与原文，编辑结束对比决定是否把文本变更记入历史
    // （覆盖层编辑是持续同步输入，无法在单次 input 边界判定"一次变更"）
    this.editingOld = { shape, text: shape.text.text };
    // 先 start：其内部 stop() 会触发旧会话的 onEditEnd → finishEdit，
    // 此时 this.editing 仍是旧形状（或 null），不会被新会话误清
    this.editor.start(shape.text);
    this.editing = shape;
    this.editor.show({ fill: true, point });
  }

  private finishEdit() {
    const shape = this.editing;
    if (!shape) return;
    this.editing = null;
    shape.layout();
    // 文本相对会话起点确有变化才记历史：record 仅入栈不执行，因变更已发生
    const old = this.editingOld;
    if (old.shape === shape && shape.text.text !== old.text) {
      this.history.record(textCommand(shape, old.text, shape.text.text));
    }
    this.app.requestRender();
    this.onChange?.("text");
  }
  //#endregion

  //#region 交互
  private bindEvents(canvas: HTMLCanvasElement) {
    // 统一指针监听：绑定/撤销与屏幕→世界坐标换算由指针能力承担（机制层），
    // 本场景只声明各事件的交互策略；返回的撤销函数并入 cleanups 统一管理
    const pointer = this.app.require(POINTER_CAPABILITY);
    this.cleanups.push(
      pointer.bind(canvas, {
        onDown: (e) => this.onDown(e),
        onWindowMove: (e) => this.onMove(e),
        onWindowUp: (e) => this.onUp(e),
        onKeydown: (e) => this.onKeyDown(e),
      }),
    );
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const p = this.app.camera.toWorld(e.clientX, e.clientY);
    const scale = this.app.camera.viewport.scale;
    // 按下后进入交互会话，悬浮端口提示不再显示
    this.hoverPort = null;
    if (this.hoverEdge) {
      this.hoverEdge.hovered = false;
      this.hoverEdge = null;
    }
    // 选中态下按优先级命中：角手柄缩放 → 端口连线 → 边线缩放 → 形状体移动
    const sel = this.selShape;
    if (sel) {
      const corner = cornerHit(sel, p, scale);
      if (corner) {
        this.session = {
          kind: "resize",
          shape: sel,
          handle: corner,
          start: p,
          origin: { x: sel.x, y: sel.y, width: sel.width, height: sel.height },
        };
        return;
      }
      const dir = portHit(sel, p, scale);
      if (dir) {
        // 按下时不创建预览边（此刻无法区分点击/拖拽）：位移超过点击阈值
        // 进入拖拽连线时才插入预览并取消选中（见 onMove 的 armed 逻辑）
        const preview = new LinkPreview();
        preview.router = this.router;
        preview.from = sel.portAt(dir);
        preview.fromDir = dir;
        preview.fromStub = sel.portStub(dir);
        preview.to = p;
        preview.toDir = previewToDir(dir, preview.from, p);
        this.session = {
          kind: "link",
          source: sel,
          sourceDir: dir,
          preview,
          start: p,
        };
        this.app.requestRender();
        return;
      }
      const side = edgeHit(sel, p, scale);
      if (side) {
        this.session = {
          kind: "resize",
          shape: sel,
          handle: side,
          start: p,
          origin: { x: sel.x, y: sel.y, width: sel.width, height: sel.height },
        };
        return;
      }
    }
    // 激活连线的首尾手柄：拖拽重接该端（优先于命中其他形状）
    const selEdgeDown = this.selEdge;
    if (selEdgeDown) {
      const edge = selEdgeDown;
      const which = edgeHandleHit(edge, p, scale);
      if (which) {
        // 直接拖拽原连线：被拖端进入拖拽态，路由以光标为虚拟端口
        const fixedDir = which === "from" ? edge.toDir : edge.fromDir;
        const fixedPort =
          which === "from"
            ? edge.toNode.portAt(edge.toDir)
            : edge.fromNode.portAt(edge.fromDir);
        edge.dragWhich = which;
        edge.dragPoint = p;
        edge.dragDir = previewToDir(fixedDir, fixedPort, p);
        this.session = { kind: "edge-move", edge, which };
        this.options.canvas.style.cursor = "crosshair";
        this.app.requestRender();
        return;
      }
    }
    // 多选组合框的手柄/边线：整体缩放（优先于命中形状）
    const mb = this.multiBounds;
    if (mb) {
      const handle = cornerHit(mb, p, scale) ?? edgeHit(mb, p, scale);
      if (handle) {
        this.session = {
          kind: "group-resize",
          handle,
          start: p,
          origin: mb,
          origins: this.selShapes.map((s) => ({
            shape: s,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
          })),
        };
        return;
      }
    }
    const hit = hitShape(this.app.children, p);
    if (hit) {
      if (this.sel.items.includes(hit)) {
        // 组内形状：整体移动，保持多选（单击不动则抬起时塌缩为单选）
        this.session = {
          kind: "move",
          shape: hit,
          start: p,
          origin: { x: hit.x, y: hit.y },
          moved: false,
          group: this.selShapes
            .filter((s) => s !== hit)
            .map((s) => ({ shape: s, x: s.x, y: s.y })),
        };
      } else {
        // 按下在已选中节点上：记录屏幕坐标，抬起未拖动时进入编辑（拖拽仍优先）
        const press = hit === this.selShape ? { x: e.clientX, y: e.clientY } : undefined;
        this.select(hit);
        this.session = {
          kind: "move",
          shape: hit,
          start: p,
          origin: { x: hit.x, y: hit.y },
          moved: false,
          group: null,
          press,
        };
      }
      return;
    }
    // 形状未命中时尝试命中连线（形状层在上，优先选中形状）
    const hitLine = hitEdge(this.edges, p, scale);
    if (hitLine) {
      this.select(hitLine);
      this.app.requestRender();
      return;
    }
    // 选中形状（单/多选通用）：选框并集内任意位置按下即整体移动（无需按在
    // 节点上，菱形/椭圆空白角落也可拖拽）；未拖动时保持原选中态不塌缩
    const selList = this.selShapes;
    if (selList.length) {
      const b = unionBounds(selList);
      if (
        p.x >= b.x &&
        p.x <= b.x + b.width &&
        p.y >= b.y &&
        p.y <= b.y + b.height
      ) {
        const [first, ...rest] = selList;
        this.session = {
          kind: "move",
          shape: first,
          start: p,
          origin: { x: first.x, y: first.y },
          moved: false,
          group: rest.length
            ? rest.map((s) => ({ shape: s, x: s.x, y: s.y }))
            : null,
          keepMulti: true,
        };
        return;
      }
    }
    // 空白按下：立即取消选中，框选会话由选中插件接管（橡皮筋 + 松手落定多选）
    this.select(null);
    this.sel.beginMarquee(e);
  }

  private onMove(e: MouseEvent) {
    const s = this.session;
    // 无会话时做悬停反馈：缩放手柄/边线/端口/形状体/连线分别给对应光标
    if (!s) {
      // 右键拖拽视口时跳过：viewport 已设置 grabbing，不要覆盖
      if (e.buttons & 2) return;
      const p = this.app.camera.toWorld(e.clientX, e.clientY);
      const scale = this.app.camera.viewport.scale;
      // 光标反馈先行：手柄/边线给缩放光标、连线端点手柄给移动光标
      let cursor: string | null = null;
      // 多选组合框的手柄/边线优先给缩放光标
      const mb = this.multiBounds;
      if (mb) {
        const corner = cornerHit(mb, p, scale);
        if (corner)
          cursor =
            corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
        else {
          const side = edgeHit(mb, p, scale);
          if (side)
            cursor = side === "n" || side === "s" ? "ns-resize" : "ew-resize";
        }
      }
      if (cursor === null)
        cursor = this.selShape
          ? hoverCursor(this.selShape, p, scale)
          : null;
      const selEdgeHover = this.selEdge;
      if (
        cursor === null &&
        selEdgeHover &&
        edgeHandleHit(selEdgeHover, p, scale)
      )
        cursor = "move";
      // 悬浮端口跟踪：单选形状的端口上悬浮时覆盖层放大该圆点并绘制方向箭头
      const hp = this.selShape ? portHit(this.selShape, p, scale) : null;
      if (hp !== this.hoverPort) {
        this.hoverPort = hp;
        this.app.requestRender();
      }
      // 悬浮连线跟踪：只有鼠标不压在任何形状或覆盖层手柄/端口上才考虑 edge 悬浮
      //（形状层在上、edge 层在下，被形状遮住的 edge 不该响应；覆盖层手柄不参与
      // 场景命中，但端点手柄压在连线上、端口浮在连线经过处，悬浮时不应穿透
      // 高亮下层连线——光标反馈已表达交互意图）
      const onHandle = cursor !== null || hp !== null;
      const shapeHit = hitShape(this.app.children, p);
      const he = onHandle || shapeHit ? null : hitEdge(this.edges, p, scale);
      if (he !== this.hoverEdge) {
        const prev = this.hoverEdge;
        if (prev) prev.hovered = false;
        this.hoverEdge = he;
        // 悬浮离开（含移向另一条连线）时把激活连线重新置顶，不再被刚才的
        // 悬浮连线遮盖；随后提升新悬浮的连线，保证悬浮中的连线始终在最顶层
        const selEdgeHover2 = this.selEdge;
        if (prev && selEdgeHover2 && selEdgeHover2 !== he)
          this.raiseEdgeTop(selEdgeHover2);
        if (he) {
          he.hovered = true;
          this.raiseEdgeTop(he);
        }
        this.app.requestRender();
      }
      // 连线、节点、空白区域统一 default 光标，悬浮反馈由视觉（浅蓝色）而非光标表达
      this.options.canvas.style.cursor = cursor ?? "";
      return;
    }
    const p = this.app.camera.toWorld(e.clientX, e.clientY);
    if (s.kind === "move") {
      s.moved = true;
      if (s.group) {
        // 组合移动：以整体框（成员并集 bounds）的四边/中线与外部节点对齐吸附，
        // 全部组内成员（含被按住的主节点）不作为参考目标，避免内部基线；
        // 全量拖拽位移 + 吸附修正统一应用到全部成员。
        // 吸附基准框必须由各成员"按下时原始位置 + 本帧原始位移"构成——若混入
        // 已被上一帧吸附修正过的当前位置，上一帧的修正量会泄漏进本帧的吸附
        // 计算，吸附会在开/关之间震荡（参考线闪烁、整体位置抖动）
        const exclude = new Set([s.shape, ...s.group.map((g) => g.shape)]);
        const b0 = unionBounds([
          {
            x: s.origin.x,
            y: s.origin.y,
            width: s.shape.width,
            height: s.shape.height,
          },
          ...s.group.map((g) => ({
            x: g.x,
            y: g.y,
            width: g.shape.width,
            height: g.shape.height,
          })),
        ]);
        b0.x += p.x - s.start.x;
        b0.y += p.y - s.start.y;
        const box: Bounds = { ...b0 };
        this.applySnap(box, exclude);
        const mx = p.x - s.start.x + (box.x - b0.x);
        const my = p.y - s.start.y + (box.y - b0.y);
        s.shape.x = s.origin.x + mx;
        s.shape.y = s.origin.y + my;
        for (const g of s.group) {
          g.shape.x = g.x + mx;
          g.shape.y = g.y + my;
        }
      } else {
        s.shape.x = s.origin.x + (p.x - s.start.x);
        s.shape.y = s.origin.y + (p.y - s.start.y);
        this.applySnap(s.shape);
      }
      this.app.requestRender();
    } else if (s.kind === "resize") {
      applyResize(s.shape, s.handle, s.origin, p.x - s.start.x, p.y - s.start.y);
      this.app.requestRender();
    } else if (s.kind === "group-resize") {
      applyGroupResize(s.handle, s.origin, s.origins, p.x - s.start.x, p.y - s.start.y);
      this.app.requestRender();
    } else if (s.kind === "link") {
      const scale = this.app.camera.viewport.scale;
      // 位移超过点击阈值才确认是拖拽连线：此时才插入预览边并取消选中
      if (!s.armed) {
        if (
          Math.hypot(p.x - s.start.x, p.y - s.start.y) <=
          CLICK_MOVE_TOLERANCE / scale
        )
          return;
        s.armed = true;
        const idx = this.app.children.findIndex((n) => n instanceof Shape);
        if (idx === -1) this.app.children.push(s.preview);
        else this.app.children.splice(idx, 0, s.preview);
        this.options.canvas.style.cursor = "crosshair";
        this.select(null);
      }
      this.updateLinkTarget(p);
      // 吸附时预览以手柄的具体位置与端口方向渲染；自由拖拽时按光标相对
      // 出口端口的位置确定虚拟进入方向
      if (this.linkTarget && this.linkSnap) {
        s.preview.to = this.linkTarget.portAt(this.linkSnap);
        s.preview.toDir = this.linkSnap;
        s.preview.toStub = this.linkTarget.portStub(this.linkSnap);
      } else {
        s.preview.to = p;
        s.preview.toStub = PORT_STUB;
        s.preview.toDir = previewToDir(s.sourceDir, s.preview.from, p);
      }
      this.app.requestRender();
    } else if (s.kind === "edge-move") {
      // 原连线被拖端跟随光标：吸附时落在目标手柄上，自由拖拽时按出口方向
      // 与光标位置确定虚拟进入方向。任意节点均可吸附（含本连线两端节点，
      // 可调整接入边或形成自环）
      this.updateLinkTarget(p);
      if (this.linkTarget && this.linkSnap) {
        s.edge.dragPoint = this.linkTarget.portAt(this.linkSnap);
        s.edge.dragDir = this.linkSnap;
      } else {
        const fixedDir = s.which === "from" ? s.edge.toDir : s.edge.fromDir;
        const fixedPort =
          s.which === "from"
            ? s.edge.toNode.portAt(s.edge.toDir)
            : s.edge.fromNode.portAt(s.edge.fromDir);
        s.edge.dragPoint = p;
        s.edge.dragDir = previewToDir(fixedDir, fixedPort, p);
      }
      this.app.requestRender();
    }
  }

  // 连线拖拽中更新吸附目标：光标进入某节点包围盒外扩 LINK_SNAP_MARGIN 范围时，
  // 该节点成为目标（浮出对接手柄），并吸附到距光标最近的端口（任意节点均可，
  // 包括连线/预览自身的节点——支持改接边与自环）
  private updateLinkTarget(p: { x: number; y: number }) {
    const r = findLinkTarget(
      this.shapes.values(),
      p,
      this.app.camera.viewport.scale,
    );
    this.linkTarget = r ? r.target : null;
    this.linkSnap = r ? r.snap : null;
  }

  // 节点拖拽吸附：候选参考目标 = 除被拖载体（单形状）与组内成员（组合拖拽）
  // 之外的全部形状；吸附算法按能力键消费（BuiltinSnap 官方实现，第三方可覆盖），
  // 这里只负责筛选候选、回传迟滞状态、把位移写回载体
  private applySnap(shape: Bounds, exclude: Set<Shape> | null = null) {
    const scale = this.app.camera.viewport.scale;
    const candidates = [...this.shapes.values()].filter(
      (o) => o !== shape && !(exclude && exclude.has(o)),
    );
    const r = this.snapper.snap({
      box: shape,
      candidates,
      scale,
      prev: this.snapPrev,
    });
    this.snapPrev = { x: r.snappedX, y: r.snappedY };
    shape.x += r.dx;
    shape.y += r.dy;
    this.guides = r.guides;
  }

  private onUp(e: MouseEvent) {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.options.canvas.style.cursor = "";
    if (s.kind === "move") {
      this.guides = null;
      this.snapPrev = { x: false, y: false };
      this.app.requestRender(); // 清除参考线后立即重绘，否则画面残留拖拽时最后一帧
      if (s.moved) {
        // 拖拽移动记录为可逆命令（变更已发生）：主节点与组内成员合并为一条，
        // undo 一次全回退；位置全部未变（吸附归位）时不记录
        const before = [
          { shape: s.shape, x: s.origin.x, y: s.origin.y },
          ...(s.group ?? []).map((g) => ({ shape: g.shape, x: g.x, y: g.y })),
        ];
        const after = before.map((m) => ({
          shape: m.shape,
          x: m.shape.x,
          y: m.shape.y,
        }));
        if (before.some((m) => m.shape.x !== m.x || m.shape.y !== m.y)) {
          this.history.record(moveCommand(before, after));
        }
        this.onChange?.("move");
      } else if (s.press && Math.hypot(e.clientX - s.press.x, e.clientY - s.press.y) <= CLICK_MOVE_TOLERANCE)
        // 未拖动的点击落在已选中节点上：进入编辑（光标聚焦到点击处）
        this.startEdit(s.shape, s.press);
      else if (s.group && !s.keepMulti) this.select(s.shape); // 组内单击未拖动：塌缩为单选该形状
    } else if (s.kind === "resize") {
      const o = s.origin;
      if (
        s.shape.x !== o.x ||
        s.shape.y !== o.y ||
        s.shape.width !== o.width ||
        s.shape.height !== o.height
      ) {
        // 缩放记录为可逆命令（变更已发生）：before/after 各定格一份 bounds
        this.history.record(
          resizeCommand(
            s.shape,
            { x: o.x, y: o.y, width: o.width, height: o.height },
            {
              x: s.shape.x,
              y: s.shape.y,
              width: s.shape.width,
              height: s.shape.height,
            },
          ),
        );
        this.onChange?.("resize");
      }
    } else if (s.kind === "group-resize") {
      // 有成员相对初始状态发生变化时通知，并记录为可逆命令（变更已发生）
      if (
        s.origins.some(
          (g) =>
            g.shape.x !== g.x ||
            g.shape.y !== g.y ||
            g.shape.width !== g.width ||
            g.shape.height !== g.height,
        )
      ) {
        const before = s.origins.map((g) => ({
          shape: g.shape,
          x: g.x,
          y: g.y,
          width: g.width,
          height: g.height,
        }));
        const after = s.origins.map((g) => ({
          shape: g.shape,
          x: g.shape.x,
          y: g.shape.y,
          width: g.shape.width,
          height: g.shape.height,
        }));
        this.history.record(groupResizeCommand(before, after));
        this.onChange?.("resize");
      }
    } else if (s.kind === "edge-move") {
      // 端点重接结束：退出拖拽态；吸附目标按其端口重接（任意节点，含本连线
      // 两端节点）；未吸附时按落点命中节点重接（主导方向自动选边），纯点击
      // 落回被拖端原节点时视为无操作，连线保持原状
      s.edge.dragWhich = null;
      const target = this.linkTarget;
      const snap = this.linkSnap;
      this.linkTarget = null;
      this.linkSnap = null;
      const hit =
        target ?? hitShape(this.app.children, this.app.camera.toWorld(e.clientX, e.clientY));
      const cur = s.which === "from" ? s.edge.fromNode : s.edge.toNode;
      if (hit && !(hit === cur && !target)) {
        // 重接前定格原端（节点 + 端口方向），undo/redo 对称重接
        const oldNode = cur;
        const oldDir = s.which === "from" ? s.edge.fromDir : s.edge.toDir;
        s.edge.reattachEnd(s.which, hit, target && snap ? snap : undefined);
        const newNode = s.which === "from" ? s.edge.fromNode : s.edge.toNode;
        const newDir = s.which === "from" ? s.edge.fromDir : s.edge.toDir;
        this.history.record(
          reconnectCommand(s.edge, s.which, oldNode, oldDir, newNode, newDir),
        );
        this.onChange?.("reconnect");
      }
      this.app.requestRender();
    } else {
      // 连线交互结束：移除预览。（源形状在按下时已取消激活）
      // 纯点击端口（位移在阈值内）：沿端口方向自动新建节点并连线；
      // 拖拽时吸附中的目标按其端口固定创建连线，否则按落点命中建边
      this.removeTop(s.preview);
      const target = this.linkTarget;
      const snap = this.linkSnap;
      this.linkTarget = null;
      this.linkSnap = null;
      const p = this.app.camera.toWorld(e.clientX, e.clientY);
      // 未进入拖拽态（armed）即为纯点击端口：沿端口方向自动新建节点并连线
      if (!s.armed) {
        this.createNodeInDirection(s.source, s.sourceDir);
      } else if (target && snap) {
        this.addEdgeBetween(s.source, target, true, {
          from: s.sourceDir,
          to: snap,
        });
      } else {
        const hit = hitShape(this.app.children, p);
        if (hit && hit !== s.source) this.addEdgeBetween(s.source, hit, true);
      }
      this.app.requestRender();
    }
  }

  // 端口点击快速创建：沿端口方向新建与源节点同类型、同尺寸的节点并连线
  //（边缘间距 CLICK_CREATE_GAP，垂直于方向的轴线与源节点中心对齐），
  // 新节点进入选中态
  private createNodeInDirection(source: Shape, dir: PortDir) {
    const shape = this.createShape(source.kind, {
      width: source.width,
      height: source.height,
    });
    if (dir === "right") {
      shape.x = source.x + source.width + CLICK_CREATE_GAP;
      shape.y = source.y + (source.height - shape.height) / 2;
    } else if (dir === "left") {
      shape.x = source.x - CLICK_CREATE_GAP - shape.width;
      shape.y = source.y + (source.height - shape.height) / 2;
    } else if (dir === "bottom") {
      shape.x = source.x + (source.width - shape.width) / 2;
      shape.y = source.y + source.height + CLICK_CREATE_GAP;
    } else {
      shape.x = source.x + (source.width - shape.width) / 2;
      shape.y = source.y - CLICK_CREATE_GAP - shape.height;
    }
    // 节点注册与连线创建组合为一条原子命令（不预先注册，避免 exec 重放时重复入列）：
    // undo 逆序回退——先摘连线再摘节点，整体回到创建前；redo 顺序重建
    const edge = new FlowEdge(source, shape, {
      from: dir,
      to: OPPOSITE_DIR[dir],
    });
    edge.router = this.router;
    this.history.exec(
      compose(
        "add",
        {
          redo: () => this.registerShape(shape),
          undo: () => this.removeShape(shape),
        },
        this.edgeAddRemove(edge),
      ),
    );
    this.select(shape);
    this.onChange?.("add");
  }

  private onKeyDown(e: KeyboardEvent) {
    // 覆盖层持有焦点时按键属于输入，交由编辑器处理
    if (this.editing || this.editor.hasFocus()) return;
    // 撤销/重做/删除已注册为命令并绑定键位（构造器），由命令插件统一分发；
    // 此处只处理领域语义按键（方向键微移选中节点）
    // 方向键：微移选中节点（Shift 加速），连线不参与移动
    const dir = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[e.key];
    if (!dir) return;
    const step = e.shiftKey ? 10 : 1;
    const dx = dir[0] * step;
    const dy = dir[1] * step;
    const targets = this.selShapes;
    if (!targets.length) return;
    e.preventDefault();
    // 微移记录为可逆命令（变更已发生）：undo 回到按前位置，redo 重放同向位移
    const before = targets.map((s) => ({ shape: s, x: s.x, y: s.y }));
    for (const s of targets) {
      s.x += dx;
      s.y += dy;
    }
    this.history.record(nudgeCommand(targets, dx, dy, before));
    this.app.requestRender();
    this.onChange?.("move");
  }
  //#endregion
}
