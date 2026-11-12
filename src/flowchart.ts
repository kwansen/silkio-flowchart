﻿import { App, VIEWPORT_CAPABILITY, TEXT_EDITOR_CAPABILITY } from "@silker/core";
import type {
  ExportOptions,
  HistoryCapability,
  HistoryCommand,
  HistorySnapshot,
  Plugin,
} from "@silker/core";
import type { SelectionCapability, TextEditorCapability } from "@silker/core";
import { selectionCapabilityKey, HISTORY_CAPABILITY } from "@silker/core";
import { EXPORT_CAPABILITY, COMMAND_CAPABILITY, CANVAS_CLICK_CAPABILITY } from "@silker/core";
import { compose } from "@silker/core";
import { CLIPBOARD_CAPABILITY, hasTextSelection } from "@silker/core";
import type { ClipboardCapability, ClipboardEntry } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import { BuiltinShapes, SHAPE_REGISTRY_CAPABILITY } from "./shape-registry";
import type { ShapeRegistryCapability } from "./shape-registry";
import { FlowEdge } from "./FlowEdge";
import type { FlowEdgeHints, PortDir } from "./FlowEdge";
import type { Shape } from "./Shape";
import type { FlowChangeType, FlowData, FlowEdgeData, FlowNodeData, ShapeKind } from "./data";
import type { Bounds } from "./snap";
import type { RenderPayload } from "./commands";
import type {
  AIFlowEditRequest,
  AIFlowGenerate,
  AIFlowGraph,
  AIFlowRunOptions,
  AIFlowRunResult,
} from "./ai-protocol";
import { parseAIFlowResponse, toSemanticGraph } from "./ai-protocol";
import { layoutFlowGraph } from "./auto-layout";
import type { FlowLayoutOptions } from "./auto-layout";
import { FLOW_AUTO_LAYOUT_CAPABILITY } from "./flow-layout-capability";
import { BuiltinSnap, SNAP_CAPABILITY } from "./snap-capability";
import type { SnapCapability } from "./snap-capability";
import { BuiltinEdgeRouter, EDGE_ROUTER_CAPABILITY } from "./edge-router";
import type { EdgeRouterCapability } from "./edge-router";
import { SelectionOverlay } from "./overlay";
import { marqueeHits, portPos, unionBounds } from "./geometry";
import { bindFlowchartCommands, shapeData } from "./commands";
import { createFlowchartCodec } from "./history-codec";
import type { DeletePayload } from "./history-codec";
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
  // 装配（可选）：默认便捷模式由场景自建 App 并按官方预设装配全部官方插件，
  // 使用方只需依赖 @silker/flowchart，不接触 @silker/core / @silker/preset。
  // 需要替换官方实现或与其他场景共用宿主时，传入已装配好官方外部插件（视口/
  // 指针/导出/历史/命令/编辑器/选中）的 App（显式装配模式）：此时场景只按能力键
  // 复用这些能力、补齐自有插件，不改动宿主的装配
  app?: App;
  // 数据变化回调：新增 / 删除 / 移动 / 连线 / 文本编辑结束，当前数据用 toJSON() 导出
  onChange?: (type: FlowChangeType) => void;
  // 额外装配的插件（在官方形状/吸附插件之后、初始数据 load 之前安装）：
  // 第三方形状插件经此注册自定义形状，同名能力可覆盖官方吸附策略，
  // 使其在初始数据中即可用
  plugins?: Plugin[];
  // AI 生成适配器（宿主注入）：拿到用户指令 + 当前画布的语义图快照（已剥离
  // 坐标与端口方向）后调自家 LLM，返回语义图对象或其 JSON 字符串。
  // 模型只描述节点/连线语义，坐标与首尾端口方向由内置自动布局器计算。
  // 提示词模板与协议见 ai-protocol.ts（defaultAIFlowPrompt）
  ai?: AIFlowGenerate;
}

// 流程图场景门面：组装视口 / 文本编辑插件与各内聚模块（模型/编辑/悬浮/交互），
// 持有装配与选中语义，内置交互：点选、拖拽移动、单击已选中节点进入编辑
//（按点击位置聚焦光标）、端口拖拽连线、Delete 删除。
// 依赖单向：门面 → interactions/editing/hover → model → Shape/FlowEdge/core
export class FlowChart {
  // 装配与渲染属主：私有——外部经门面语义 API（screenToWorld/fit/toImage…）消费。
  // 默认由场景自建（便捷模式），显式装配时经 FlowChartOptions.app 传入；
  // 外部不深入内部状态（如 camera.viewport）
  private app: App;
  // 便捷模式下场景自建宿主并安装的官方预设插件：destroy 时对称卸载；
  // 显式装配下为空（宿主插件属宿主所有，保持在线可复用）
  private hostPlugins: Plugin[] = [];
  private ownsApp = false;
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
  // 选中框覆盖层（常驻顶层，App.addOverlay 注册）
  private overlay: SelectionOverlay;
  // 构造期安装的插件（官方形状/吸附/边路由 + 应用层第三方）：destroy 时对称卸载
  private scenePlugins: Plugin[] = [];
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
  // 已拆卸标志：构造器排入的初始 fit 帧回调在 destroy 后不再执行
  private disposed = false;
  // 剪贴板能力（Clipboard 插件 install 时注册，未装配时为 null——复制/粘贴降级为
  // 无操作）：场景以 consumer 身份参与原生 copy/paste 事件分发
  private clipboard: ClipboardCapability | null;
  // 连续粘贴错开计数（复制时归零）：多次粘贴逐次偏移，避免完全重叠
  private pasteCount = 0;

  constructor(private options: FlowChartOptions) {
    this.onChange = options.onChange;
    if (options.app) {
      // 显式装配（高级用法）：复用宿主自建并装配好官方插件的 App，
      // 本场景只按能力键复用能力、补齐自有插件，装配缺口由 require 兜底报错
      this.app = options.app;
    } else {
      // 便捷模式（默认）：场景自建 App 并按官方预设装配，使用方无需接触
      // @silker/core / @silker/preset；场景只拥有自己创建的插件与宿主
      this.app = new App(options.canvas);
      this.ownsApp = true;
      this.hostPlugins = officialPlugins();
      for (const p of this.hostPlugins) this.app.use(p);
    }
    this.history = this.app.require(HISTORY_CAPABILITY);
    // 安装官方形状/吸附/边路由插件（自注册各自能力），再装配应用层传入的第三方
    // 插件（可注册/覆盖形状、同名覆盖吸附策略与边路由，初始数据 load 前生效）；
    // 此后仅按能力键消费。安装清单留存，destroy 时对称卸载
    this.scenePlugins = [
      new BuiltinShapes(),
      new BuiltinSnap(),
      new BuiltinEdgeRouter(),
      ...(options.plugins ?? []),
    ];
    for (const p of this.scenePlugins) this.app.use(p);
    this.registry = this.app.require(SHAPE_REGISTRY_CAPABILITY);
    this.snapper = this.app.require(SNAP_CAPABILITY);
    this.router = this.app.require(EDGE_ROUTER_CAPABILITY);
    // 显式声明对视口能力的依赖：命中换算与覆盖层绘制都按视口缩放反算
    this.app.require(VIEWPORT_CAPABILITY);
    // 显式声明对点击分发能力的依赖：节点 onClick 与空白点击均由其分发
    // （显式装配模式下由宿主负责安装 Clicker）
    this.app.require(CANVAS_CLICK_CAPABILITY);
    // 撤销/重做/删除/复制/粘贴注册为命令：撤销/删除经 document keydown 由命令
    // 插件统一分发；复制/粘贴走原生剪贴板事件（键位不绑定，命令供工具栏等
    // 程序化入口复用）；应用层与第三方可按能力键复用命令或重绑键位
    bindFlowchartCommands(this.app.require(COMMAND_CAPABILITY), {
      editing: () => this.editing.editing !== null,
      editorFocused: () => this.editor.hasFocus(),
      hasSelection: () => this.sel.items.length > 0,
      undo: () => this.undo(),
      redo: () => this.redo(),
      deleteSelected: () => this.deleteSelected(),
      selectAll: () => this.selectAll(),
      copySelected: () => this.copySelected(),
      paste: () => this.paste(),
    });
    // 剪贴板接线：场景以 consumer 身份注册到 Clipboard 插件（原生 copy/paste 事件
    // 分发；未装配插件时 clipboard 为 null，复制/粘贴降级为无操作）
    this.clipboard = this.app.capability(CLIPBOARD_CAPABILITY) ?? null;
    if (this.clipboard) {
      this.cleanups.push(
        this.clipboard.register({
          kind: "flowchart",
          // copy 全权决策（场景 UX，机制层不窥探选区/编辑状态）：编辑会话中有
          // 文字选区 → 原生复制文字；其余 → 序列化选中形状
          onCopy: ({ target }) => {
            if (this.editing.editing && target?.isContentEditable && hasTextSelection(target)) {
              return "native";
            }
            return this.serializeSelection();
          },
          deserialize: (entry) => this.pasteFromEntry(entry),
          // 纯文本粘贴全权决策：编辑会话/交互进行中放行（编辑覆盖层的粘贴归
          // TextEditor 元素级处理），其余在视口中心新建带文本矩形
          onPasteText: ({ text }) => {
            if (!text || this.editing.editing || this.interactions.busy) return "native";
            this.pasteText(text);
            return "handled";
          },
        }),
      );
    }
    this.editor = this.setupEditor();
    this.editing = new FlowEditing({
      app: this.app,
      editor: this.editor,
      history: this.history,
      onChange: this.onChange,
      // 激活态连线标签上按 Delete/Backspace：覆盖层接管按键后转回门面删除
      onDelete: () => this.deleteSelected(),
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
        // 激活连线的标签激活框（空白标签不可见时不画）：标签为子节点且连线
        // 变换恒为单位阵，本地坐标即世界坐标
        edgeLabel:
          selEdge && !selEdge.dragWhich && selEdge.label.visible
            ? {
                x: selEdge.label.x,
                y: selEdge.label.y,
                width: selEdge.label.width,
                height: selEdge.label.height,
                radius: edgeLabelRadius(selEdge.label.boxStyle.radius),
              }
            : null,
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
    // 选中框覆盖层注册为常驻顶层：新增形状/连线等结构变更由 App 自动保持其置顶
    this.app.addOverlay(this.overlay);
    this.cleanups.push(this.interactions.bind(options.canvas));
    // 初始数据载入后自动居中（只平移不改缩放，节点视觉大小不变；对齐 mindmap
    // 的居中观感）。延迟到下一帧执行：等 canvas 完成首次布局，getBoundingClientRect
    // 才有真实尺寸；空数据（无形状）时 center 内部跳过
    requestAnimationFrame(() => {
      if (!this.disposed) this.center();
    });
  }

  // 装配文本编辑器：按能力键取回宿主装配（通常为官方预设）的实例并接线场景回调
  private setupEditor(): TextEditorCapability {
    const editor = this.app.require(TEXT_EDITOR_CAPABILITY);
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
  // 连线置顶等）由本场景定义。按能力键取回官方预设（或宿主显式装配）的实例。
  // 框选命中规则 = 与矩形相交的形状
  private setupSelection(): SelectionCapability<Shape | FlowEdge> {
    const selection = this.app.require(selectionCapabilityKey<Shape | FlowEdge>());
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
        // 框选结果为形状组合：摘除可能常驻的连线标签激活覆盖层
        this.editing.deactivate();
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
    // 注册动作本身作为可逆命令：redo 完成注册，undo 摘除节点及其关联连线。
    // 序列化载荷：内嵌形状数据快照，导入端经形状注册表重建
    this.history.exec({
      type: "add",
      redo: () => this.model.registerShape(shape),
      undo: () => this.model.removeShape(shape),
      toJSON: () => ({
        kind: "flowchart.add-shape",
        payload: { data: shapeData(shape) },
      }),
    });
    this.app.requestRender();
    this.onChange?.("add");
    return shape.id as string;
  }

  // 全选：全部形状进入多选组合态（整体移动/批量删除/批量替换可用）；多选组合
  // 只含形状（与框选语义一致，关联连线随形状删除，无需单独选中）。
  // 编辑中不响应（mod+a 属输入框原生全选，守卫已放行）
  selectAll() {
    if (this.editing.editing) return;
    const shapes = [...this.model.shapes.values()];
    if (!shapes.length) return;
    for (const it of this.sel.items) it.selected = false;
    this.sel.set(shapes);
    this.hover.clearPort();
    // 全选为形状组合：摘除可能常驻的连线标签激活覆盖层
    this.editing.deactivate();
    this.app.requestRender();
  }

  // 复制当前选中的形状（命令/程序化入口）：载荷经 Clipboard 插件写入系统剪贴板
  copySelected() {
    const entry = this.serializeSelection();
    if (entry) void this.clipboard?.write(entry);
  }

  // 选中形状序列化为剪贴板载荷（多选整组入档）：组内连线（两端都在复制集内）
  // 一并快照——粘贴时按组重建，连线随两端节点恢复。选中连线时忽略（连线随
  // 两端节点重建，单独复制无意义）；无选中返回 null（copy 事件不拦截）
  private serializeSelection(): ClipboardEntry | null {
    const shapes = this.selShapes;
    if (!shapes.length) return null;
    this.pasteCount = 0;
    const set = new Set(shapes);
    return {
      kind: "flowchart",
      payload: {
        nodes: shapes.map((s) => shapeData(s)),
        edges: this.model.edges
          .filter((e) => set.has(e.fromNode) && set.has(e.toNode))
          .map((e) => ({
            from: shapes.indexOf(e.fromNode),
            to: shapes.indexOf(e.toNode),
            fromDir: e.fromDir,
            toDir: e.toDir,
            text: e.label.text || undefined,
          })),
      },
      text: shapes.map((s) => s.text.text).filter(Boolean).join("\n"),
    };
  }

  // 粘贴：从剪贴板能力读取 flowchart 载荷（原生 paste 事件优先，程序化读取
  // 兜底）后还原图组
  paste() {
    void this.clipboard?.read("flowchart").then((entry) => {
      if (entry) this.pasteFromEntry(entry);
    });
  }

  // 还原剪贴板载荷：组内形状按相对排布整体复制到视口中心（连续粘贴逐次错开避免
  // 完全重叠），粘贴出的节点分配全新 id，组内连线按快照的端口方向重建。
  // 整次粘贴为一条原子组合命令——子命令复用 add-shape/connect 的可逆对与
  // 序列化载荷（既有 kind，编解码器无需新分支），undo/redo 整组回退/重放；
  // 粘贴后整组进入多选态，可整体拖动或直接再次复制
  pasteFromEntry(entry: ClipboardEntry) {
    const clip = entry.payload as {
      nodes: FlowNodeData[];
      edges: Array<{ from: number; to: number; fromDir: PortDir; toDir: PortDir; text?: string }>;
    } | null;
    if (!clip?.nodes.length || this.editing.editing || this.interactions.busy)
      return;
    // 锚点 = 视口中心（世界坐标），组包围盒中心对齐锚点；错开量随连续粘贴递增
    const rect = this.options.canvas.getBoundingClientRect();
    const anchor = this.app.camera.toWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const n of clip.nodes) {
      minX = Math.min(minX, n.x);
      minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + (n.width ?? 0));
      maxY = Math.max(maxY, n.y + (n.height ?? 0));
    }
    const drift = this.pasteCount++ * 24;
    const dx = anchor.x - (minX + maxX) / 2 + drift;
    const dy = anchor.y - (minY + maxY) / 2 + drift;
    // 粘贴实例（不传 id，Node 自动生成全新 id）：先建形状再建组内连线（注入
    // 边路由能力，与在位连线同一路由行为）
    const shapes = clip.nodes.map((n) =>
      this.model.createShape(n.shape, {
        x: n.x + dx,
        y: n.y + dy,
        width: n.width,
        height: n.height,
        text: n.text,
      }),
    );
    const edges = clip.edges.map(({ from, to, fromDir, toDir, text }) => {
      const edge = new FlowEdge(shapes[from], shapes[to], {
        from: fromDir,
        to: toDir,
      });
      edge.router = this.router;
      if (text) edge.label.text = text;
      return edge;
    });
    this.history.exec(
      compose(
        "add",
        ...shapes.map(
          (s): HistoryCommand => ({
            type: "add",
            redo: () => this.model.registerShape(s),
            undo: () => this.model.removeShape(s),
            toJSON: () => ({
              kind: "flowchart.add-shape",
              payload: { data: shapeData(s) },
            }),
          }),
        ),
        ...edges.map((e) => this.model.edgeAddRemove(e)),
      ),
    );
    // 整组进入多选态（与框选落定同一入口，整体移动/批量删除/再复制可用）
    for (const it of this.sel.items) it.selected = false;
    this.sel.set(shapes);
    this.hover.clearPort();
    this.editing.deactivate();
    this.app.requestRender();
    this.onChange?.("add");
  }

  // 粘贴外部纯文本：视口中心新建带文本矩形承载（对齐 Figma/Miro 的跨应用粘贴
  // 行为），复用 addNode 的可逆命令路径，新建后进入选中态。编辑会话/交互进行中
  // 与空文本忽略
  pasteText(text: string) {
    if (!text || this.editing.editing || this.interactions.busy) return;
    const rect = this.options.canvas.getBoundingClientRect();
    const anchor = this.app.camera.toWorld(
      rect.left + rect.width / 2,
      rect.top + rect.height / 2,
    );
    // 默认形状尺寸 160×99：锚定视口中心（左上角回退半宽半高）
    const id = this.addNode({
      shape: "rect",
      text,
      x: anchor.x - 80,
      y: anchor.y - 50,
    });
    const shape = this.model.shapes.get(id);
    if (shape) {
      for (const it of this.sel.items) it.selected = false;
      this.sel.set([shape]);
      this.app.requestRender();
    }
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
        // 序列化载荷：被删形状内嵌数据快照（脱离树后无从按 id 解析），关联连线
        // 内嵌连线数据；order=连线表序、childIdx=z 序，两个索引都要定格
        toJSON: () => ({
          kind: "flowchart.delete",
          payload: {
            v: "shapes",
            items: captured.map((c) => ({
              data: shapeData(c.shape),
              childIdx: c.childIdx,
              edges: c.edges.map(({ edge, order, childIdx }) => ({
                id: edge.id!,
                fromId: edge.fromNode.id as string,
                toId: edge.toNode.id as string,
                fromDir: edge.fromDir,
                toDir: edge.toDir,
                text: edge.label.text || undefined,
                order,
                childIdx,
              })),
            })),
          } satisfies DeletePayload,
        }),
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
        // 序列化载荷：单边删除——内嵌连线两端 id 与端口方向（脱离连线表后
        // 无从按 id 解析，须可完整重建）+ 两个插入索引
        toJSON: () => ({
          kind: "flowchart.delete",
          payload: {
            v: "edge",
            edge: {
              edgeId: captured.edge.id!,
              fromId: captured.edge.fromNode.id as string,
              toId: captured.edge.toNode.id as string,
              fromDir: captured.edge.fromDir,
              toDir: captured.edge.toDir,
              text: captured.edge.label.text || undefined,
            },
            childIdx: captured.childIdx,
            listIdx: captured.listIdx,
          } satisfies DeletePayload,
        }),
      });
    } else {
      const captured = this.model.captureShapeRemoval(sel);
      this.model.removeShape(sel);
      this.app.requestRender();
      this.history.exec({
        type: "delete",
        redo: () => this.model.applyShapeRemoval(captured),
        undo: () => this.model.restoreShapeRemoval(captured),
        // 序列化载荷：与多形状删除同构（单条目）
        toJSON: () => ({
          kind: "flowchart.delete",
          payload: {
            v: "shapes",
            items: [
              {
                data: shapeData(captured.shape),
                childIdx: captured.childIdx,
                edges: captured.edges.map(({ edge, order, childIdx }) => ({
                  id: edge.id!,
                  fromId: edge.fromNode.id as string,
                  toId: edge.toNode.id as string,
                  fromDir: edge.fromDir,
                  toDir: edge.toDir,
                  text: edge.label.text || undefined,
                  order,
                  childIdx,
                })),
              },
            ],
          } satisfies DeletePayload,
        }),
      });
    }
    this.onChange?.("delete");
  }

  // 替换当前选中形状的类型：保留位置、尺寸、文本、id 与全部连线
  // （连线两端引用直接重绑到新形状，端口方向维持创建时冻结的值不重选边），
  // 新形状占据原形状的 z 序位置。单选/多选均生效——类型相同的成员跳过，
  // 多个替换组合为一条原子命令（一次 undo 撤销整批）
  replaceSelected(kind: ShapeKind) {
    const targets = this.selShapes.filter((s) => s.kind !== kind);
    if (!targets.length) return;
    const pairs = targets.map((old) => ({
      old,
      shape: this.model.createShape(kind, {
        id: old.id as string,
        x: old.x,
        y: old.y,
        width: old.width,
        height: old.height,
        text: old.text.text,
      }),
    }));
    // 替换记录为可逆命令：undo/redo 对称地把旧/新形状顶替回去。
    // 序列化载荷：新旧形状都内嵌数据——旧形状脱离树后不在任何表里，
    // 导入端经会话注册表按 id 保证 undo/redo 顶替的是同一实例
    if (pairs.length === 1) {
      const p = pairs[0];
      this.history.exec({
        type: "replace",
        redo: () => this.model.swapShape(p.old, p.shape),
        undo: () => this.model.swapShape(p.shape, p.old),
        toJSON: () => ({
          kind: "flowchart.replace",
          payload: { oldData: shapeData(p.old), newData: shapeData(p.shape) },
        }),
      });
    } else {
      // 多选批量替换：序列化为组合命令（子命令与单选 replace 载荷同构，
      // 编解码器复用现有分支）；swapShape 内逐个 onSelect 会把选中塌缩成
      // 单选，redo 收尾恢复整组选中（undo/redo 按钮路径会另行清空选中）
      this.history.exec({
        type: "replace",
        redo: () => {
          for (const p of pairs) this.model.swapShape(p.old, p.shape);
          for (const it of this.sel.items) it.selected = false;
          this.sel.set(pairs.map((p) => p.shape));
        },
        undo: () => {
          for (const p of [...pairs].reverse())
            this.model.swapShape(p.shape, p.old);
        },
        toJSON: () => ({
          kind: "composite",
          payload: {
            type: "replace",
            children: pairs.map((p) => ({
              kind: "flowchart.replace",
              payload: {
                oldData: shapeData(p.old),
                newData: shapeData(p.shape),
              },
            })),
          },
        }),
      });
    }
    this.app.requestRender();
    this.onChange?.("replace");
  }

  // AI 生成：宿主适配器 → 语义图 → 程序布局 → 整图原子替换。
  // 模型绝不接触 x/y 与端口方向（这两项是确定性几何问题）；一次生成为
  // 一条可整体撤销的命令，提问/咨询类指令只返回回答、不改画布。
  // 提示词用 defaultAIFlowPrompt(req) 渲染即可，宿主可自行定制。
  async generate(
    prompt: string,
    options: AIFlowRunOptions = {},
  ): Promise<AIFlowRunResult> {
    const generate = this.options.ai;
    if (!generate) {
      throw new Error("未配置 AI 生成适配器（FlowChartOptions.ai）");
    }
    if (this.interactions.busy) {
      throw new Error("画布交互进行中，请稍后重试");
    }
    const graph = toSemanticGraph(this.model.toJSON());
    const req: AIFlowEditRequest = {
      prompt,
      graph,
      history: options.history ?? [],
    };
    const parsed = parseAIFlowResponse(await generate(req));
    // 纯回答：不触发布局，画布保持原样
    if (!parsed.graph) {
      return { graph, data: this.model.toJSON(), answer: parsed.answer };
    }
    const data = this.renderAIGraph(parsed.graph, options.layout);
    return { graph: parsed.graph, data, answer: parsed.answer };
  }

  // 语义图 → 画布数据：按能力键允许第三方布局器覆盖官方 DAG 分层布局，
  // 落定后自动适应视口。也可直接用于「把一张语义图渲染出来」的非 AI 场景。
  renderAIGraph(graph: AIFlowGraph, options?: FlowLayoutOptions): FlowData {
    const custom = this.app.capability(FLOW_AUTO_LAYOUT_CAPABILITY);
    const data = custom
      ? custom.layout(graph, options ?? {})
      : layoutFlowGraph(graph, options);
    this.setData(data);
    this.fit();
    return data;
  }

  // 整图替换（原子撤销）：先按数据建好新形状/连线实例（端口方向在创建时
  // 冻结，故必须显式传入），再以一条 flowchart.render 命令整体顶替。
  // 旧实例留在 undo 闭包内，撤销后此前历史命令引用的对象仍然有效。
  setData(data: FlowData) {
    if (this.interactions.busy) return;
    const before = this.model.toJSON();
    const beforeEdgeIds = this.model.edges.map((e) => e.id as string);
    const oldShapes = [...this.model.shapes.values()];
    const oldEdges = [...this.model.edges];
    const shapes = data.nodes.map((n) =>
      this.model.createShape(n.shape, {
        id: n.id,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        text: n.text,
      }),
    );
    const byId = new Map(shapes.map((s) => [s.id as string, s]));
    const edges: FlowEdge[] = [];
    const afterEdges: FlowEdgeData[] = [];
    for (const e of data.edges) {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      if (!from || !to) continue;
      const edge = new FlowEdge(from, to, { from: e.fromDir, to: e.toDir });
      edge.router = this.router;
      if (e.text) edge.label.text = e.text;
      edges.push(edge);
      afterEdges.push({
        from: e.from,
        to: e.to,
        fromDir: edge.fromDir,
        toDir: edge.toDir,
        ...(e.text ? { text: e.text } : {}),
      });
    }
    const payload: RenderPayload = {
      before: { data: before, edgeIds: beforeEdgeIds },
      after: {
        data: { nodes: shapes.map((s) => shapeData(s)), edges: afterEdges },
        edgeIds: edges.map((e) => e.id as string),
      },
    };
    // 清掉选中框/端口/编辑覆盖层，避免它们指向被换出的旧实例
    this.interactions.select(null);
    this.editing.deactivate();
    if (this.editing.editing) this.editing.cancelFor(this.editing.editing);
    this.hover.clearPort();
    this.history.exec({
      type: "ai",
      redo: () => this.model.replaceAll(shapes, edges),
      undo: () => this.model.replaceAll(oldShapes, oldEdges),
      toJSON: () => ({ kind: "flowchart.render", payload }),
    });
    this.app.requestRender();
    this.onChange?.("ai");
  }

  // 导出当前数据（位置为最新拖拽结果）
  toJSON(): FlowData {
    return this.model.toJSON();
  }

  // 导出历史栈为可序列化快照（撤销栈在先、重做栈在后）：栈内含不可序列化命令
  // （如三方闭包命令）时返回 null，拒绝部分导出
  exportHistory(): HistorySnapshot | null {
    return this.history.exportJSON?.() ?? null;
  }

  // 导入历史快照替换当前撤销/重做栈：命令按 kind 经领域编解码器重建，形状/连线
  // 引用按 id 解析——数据 id 须与导出时同源（用带 id 的 toJSON() 往返），任一
  // 命令重建失败返回 false 且原栈不变
  importHistory(data: HistorySnapshot): boolean {
    const codec = createFlowchartCodec({
      model: this.model,
      app: this.app,
      router: this.router,
    });
    return this.history.importJSON?.(data, (s) => codec.decode(s)) ?? false;
  }

  // 屏幕坐标 → 世界坐标：clientX/Y 为浏览器事件坐标口径（与指针事件一致，
  // 画布页面偏移由相机自行扣除）；新增节点落在视口某屏幕位置等场景使用
  screenToWorld(clientX: number, clientY: number) {
    return this.app.camera.toWorld(clientX, clientY);
  }

  // 当前缩放比例（只读），写入经 setZoom
  get zoom(): number {
    return this.app.camera.viewport.scale;
  }

  // 订阅视口变化（滚轮缩放 / 拖拽平移 / setZoom 等）：回调收到最新缩放比例，
  // 返回解绑函数，页面销毁时应撤销以免宿主闭包被相机长期持有
  onViewportChange(listener: (scale: number) => void): () => void {
    return this.app.camera.onViewportChange(() => listener(this.app.camera.viewport.scale));
  }

  // 以画布中心为锚点设置缩放：缩放前后中心对应的世界坐标保持不动。
  // 工具栏滑块的语义入口，外部无需接触 camera.viewport 与渲染请求
  setZoom(scale: number) {
    const rect = this.options.canvas.getBoundingClientRect();
    const vp = this.app.camera.viewport;
    const wx = (rect.width / 2 - vp.x) / vp.scale;
    const wy = (rect.height / 2 - vp.y) / vp.scale;
    this.app.camera.setViewport({
      x: rect.width / 2 - wx * scale,
      y: rect.height / 2 - wy * scale,
      scale,
    });
    // setViewport 只更新相机状态，需显式触发相机-only 重渲染
    this.app.requestCameraRender();
  }

  // 清空撤销/重做栈：切换或新建文档时避免一次 Ctrl+Z 退回上一份文档
  clearHistory() {
    this.history.clear?.();
  }

  // 适应视图：按全部形状包围盒拟合视口（视口能力的语义化入口，不暴露内部状态）
  fit() {
    const shapes = [...this.model.shapes.values()];
    if (!shapes.length) return;
    const b = unionBounds(shapes);
    this.app
      .require(VIEWPORT_CAPABILITY)
      .fit({ minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height });
    this.app.requestRender();
  }

  // 居中视图：保持当前缩放不变，仅平移视口使全部形状包围盒中心对齐画布中心
  //（节点视觉大小不变；初始化时调用，避免 fit 的缩放改变节点观感）
  center() {
    const shapes = [...this.model.shapes.values()];
    if (!shapes.length) return;
    const b = unionBounds(shapes);
    this.app
      .require(VIEWPORT_CAPABILITY)
      .center({ minX: b.x, minY: b.y, maxX: b.x + b.width, maxY: b.y + b.height });
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

  // 完整拆卸（幂等，页面级销毁或显式装配下重建场景用）：
  // 1) 撤销交互监听；2) 复位接线在宿主插件上的场景回调（编辑器/选中可能为
  //    显式装配的宿主所有，避免已销毁门面被插件回调持有）；
  // 3) 注销场景命令（键位随命令一并移除）并复位分发守卫；
  // 4) 移除覆盖层节点（常驻置顶注册随之注销）；
  // 5) 卸载构造期安装的插件（能力注册表沿 previous 链撤销/恢复）。
  // 便捷模式下自建宿主上的预设插件随场景卸载（宿主随门面一起废弃）；
  // 显式装配下宿主 App 与官方插件不受影响，可继续复用
  destroy() {
    this.disposed = true;
    // 历史栈随场景废弃：栈内命令闭包引用本场景形状/模型，场景销毁后命令失效
    this.history.clear?.();
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
    this.editor.onInput = undefined;
    this.editor.onEditEnd = undefined;
    // 结束进行中的编辑会话（回调已复位，stop 触发的 onEditEnd 无副作用）
    this.editor.stop();
    this.sel.hitRect = () => [];
    this.sel.onMarqueeMove = null;
    this.sel.onMarqueeEnd = null;
    const commands = this.app.require(COMMAND_CAPABILITY);
    for (const id of ["flowchart.undo", "flowchart.redo", "flowchart.delete", "flowchart.selectAll", "flowchart.copy", "flowchart.paste"]) {
      commands.unregister(id);
    }
    commands.guard = null;
    this.app.remove(this.overlay);
    for (const p of this.scenePlugins) this.app.uninstall(p);
    this.scenePlugins = [];
    // 便捷模式：自建宿主上的官方预设插件也随场景卸载（撤销 DOM 事件监听、
    // 编辑器元素等）；显式装配下的宿主插件属宿主所有，保持在线可复用
    if (this.ownsApp) {
      for (const p of this.hostPlugins) this.app.uninstall(p);
      this.hostPlugins = [];
    }
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

// 标签盒圆角归一化：radius 支持单值或四角数组，激活框描边取单值圆角
//（连线标签固定用单值圆角，四角数组走首角兜底）
function edgeLabelRadius(radius: number | [number, number, number, number] | undefined): number {
  if (radius === undefined) return 0;
  return typeof radius === "number" ? radius : radius[0];
}
