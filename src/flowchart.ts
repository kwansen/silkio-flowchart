import { App, Node } from "@silker/core";
import { Viewport } from "@silker/core-viewport";
import { TextEditor } from "@silker/plugin-text-editor";
import type { TextEditorCapability } from "@silker/plugin-text-editor";
import { Exporter, EXPORT_CAPABILITY } from "@silker/plugin-exporter";
import type { ExportOptions } from "@silker/plugin-exporter";
import { Selection, selectionCapabilityKey } from "@silker/plugin-selection";
import type { SelectionCapability } from "@silker/plugin-selection";
import { createShape } from "./shapes";
import { Shape } from "./Shape";
import {
  FlowEdge,
  OPPOSITE_DIR,
  PORT_DIR_VEC,
  PORT_STUB,
  renderEdgePreview,
} from "./FlowEdge";
import type { FlowEdgeHints, PortDir } from "./FlowEdge";
import type { FlowChangeType, FlowData, ShapeKind } from "./data";
import { computeSnap } from "./snap";
import type { Bounds, SnapGuides } from "./snap";

// 端口命中半径（世界坐标）
const PORT_HIT_RADIUS = 10;

// 选中框（bounds）外观与命中参数：尺寸用屏幕像素，除以视口缩放换算成世界坐标
const SELECT_COLOR = "#3b82f6";
const HANDLE_SIZE = 9; // 四角手柄边长（屏幕像素）
const HANDLE_HIT = 8; // 手柄命中半径（屏幕像素）
const EDGE_TOLERANCE = 5; // 边线命中容差（屏幕像素）
const EDGE_HANDLE_HIT = 8; // 连线端点手柄命中半径（屏幕像素）
const MIN_SIZE = 20; // 缩放最小尺寸（世界坐标）

// 连线端口圆点外观：沿边中点外法向浮在形状外侧，不遮挡边线与箭头
const PORT_RADIUS = 5; // 端口圆点半径（屏幕像素）
const PORT_OFFSET = 24; // 端口圆点圆心相对边中点向外的偏移（屏幕像素）
const PORT_HOVER_SCALE = 2.4; // 端口悬浮放大倍数，命中范围与放大后的视觉半径一致

// 连线拖拽吸附：光标进入目标节点包围盒外扩该范围时，目标节点浮出对接手柄
const LINK_SNAP_MARGIN = 16; // 吸附感应范围（屏幕像素）

// 端口点击快速创建：点击（非拖拽）端口时沿该方向自动新建节点并连线；
// 拖拽仍是手动连线，以按下后的位移区分两种意图
const CLICK_MOVE_TOLERANCE = 4; // 判定点击的最大位移（屏幕像素）
const CLICK_CREATE_GAP = 80; // 新节点与源节点边缘的间距（世界坐标）

// 节点拖拽对齐：左/中/右与上/中/下接近其他节点的对应边时吸附，并绘制对齐参考线
const SNAP_TOLERANCE = 6; // 对齐吸附阈值（屏幕像素），过大会产生粘滞感
const ALIGN_COLOR = "#eea5ffff"; // 对齐参考线颜色
const SPACING_TOLERANCE = 4; // 等间距吸附阈值（屏幕像素）

// 缩放手柄方位：四角 + 四边
type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// 连线拖拽预览：与正式连线同款式的正交折线 + 箭头（from 为固定端端口及其方向，
// to 为光标或吸附端端口；toDir 随光标相对出口端口的位置实时变化）
class LinkPreview extends Node {
  from = { x: 0, y: 0 };
  to = { x: 0, y: 0 };
  fromDir: PortDir = "right";
  toDir: PortDir = "left";
  // 两端直段长度：源端在创建时按其 portStub 设置，目标端吸附时跟随目标节点
  fromStub = PORT_STUB;
  toStub = PORT_STUB;

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    renderEdgePreview(
      ctx,
      FlowEdge.routeBetween(
        this.from,
        this.fromDir,
        this.to,
        this.toDir,
        this.fromStub,
        this.toStub,
      ),
    );
    ctx.restore();
  }

  hitTest() {
    return false;
  }
}

// 选中框覆盖层：为选中形状绘制 bounds 边框、四角缩放手柄与外浮的连线端口圆点，
// 连线拖拽时为目标节点绘制对接手柄并高亮吸附端口，
// 尺寸按视口缩放反算，保证任何缩放级别下都是恒定屏幕像素大小
class SelectionOverlay extends Node {
  constructor(
    private getState: () => {
      shape: Shape | null;
      scale: number;
      ports: Array<{ x: number; y: number }>;
      // 悬浮中的端口方向：该端口圆点放大并显示方向箭头（点击快速建节点提示）
      hoverPort: PortDir | null;
      // 激活连线的首尾端点手柄（世界坐标）
      edgeHandles: Array<{ x: number; y: number }>;
      // 连线拖拽中的目标节点：ports 为其四个对接手柄，active 为吸附中的手柄
      link: {
        ports: Array<{ x: number; y: number }>;
        active: { x: number; y: number } | null;
      } | null;
      // 节点拖拽对齐参考线：v 为竖线 x 坐标、h 为横线 y 坐标（世界坐标），
      // spacing 为等间距测量线段
      guides: SnapGuides | null;
      // 框选拖拽中（插件橡皮筋之外的）实时组合框或多选组合 bounds，样式与单选框一致
      marquee: Bounds | null;
    },
  ) {
    super();
  }

  render(ctx: CanvasRenderingContext2D) {
    const {
      shape,
      scale,
      ports,
      hoverPort,
      edgeHandles,
      link,
      guides,
      marquee,
    } = this.getState();
    const k = 1 / scale;
    ctx.save();
    // 框选框 / 多选组合框：与单选框同样式（边框 + 四角手柄），无连线端口
    if (marquee) {
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
      const s = HANDLE_SIZE * k;
      const { x, y, width: w, height: h } = marquee;
      for (const [cx, cy] of [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]) {
        ctx.beginPath();
        ctx.rect(cx - s / 2, cy - s / 2, s, s);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
    }
    if (shape) {
      const { x, y, width: w, height: h } = shape;
      // bounds 边框
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(x, y, w, h);
      // 四角手柄（白底蓝边方块）
      const s = HANDLE_SIZE * k;
      for (const [cx, cy] of [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]) {
        ctx.beginPath();
        ctx.rect(cx - s / 2, cy - s / 2, s, s);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
      // 四向连线端口圆点（浮在形状外侧），悬浮端口放大并显示方向箭头
      const dirs = ["top", "right", "bottom", "left"] as const;
      this.drawPorts(
        ctx,
        ports,
        k,
        null,
        hoverPort ? dirs.indexOf(hoverPort) : -1,
        hoverPort,
      );
    }
    // 激活连线的首尾端点手柄（白底蓝边圆形）
    if (edgeHandles.length) {
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5 * k;
      const r = (HANDLE_SIZE / 2) * k;
      for (const h of edgeHandles) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
    }
    // 连线拖拽目标：浮出对接手柄，吸附中的手柄实心高亮
    if (link) this.drawPorts(ctx, link.ports, k, link.active);
    // 对齐参考线：贯穿画布的虚线
    if (guides && (guides.v.length || guides.h.length)) {
      ctx.strokeStyle = ALIGN_COLOR;
      ctx.lineWidth = 1 * k;
      ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath();
      for (const x of guides.v) {
        ctx.moveTo(x, -10000);
        ctx.lineTo(x, 10000);
      }
      for (const y of guides.h) {
        ctx.moveTo(-10000, y);
        ctx.lineTo(10000, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 等间距测量线：虚线段 + 两端刻度 + 间距数值标签
    if (guides && guides.spacing.length) {
      ctx.strokeStyle = ALIGN_COLOR;
      ctx.lineWidth = 1 * k;
      ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath();
      for (const g of guides.spacing) {
        ctx.moveTo(g.x1, g.y1);
        ctx.lineTo(g.x2, g.y2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // 两端垂直于线段的刻度
      const t = 3 * k;
      ctx.beginPath();
      for (const g of guides.spacing) {
        if (g.y1 === g.y2) {
          ctx.moveTo(g.x1, g.y1 - t);
          ctx.lineTo(g.x1, g.y1 + t);
          ctx.moveTo(g.x2, g.y2 - t);
          ctx.lineTo(g.x2, g.y2 + t);
        } else {
          ctx.moveTo(g.x1 - t, g.y1);
          ctx.lineTo(g.x1 + t, g.y1);
          ctx.moveTo(g.x2 - t, g.y2);
          ctx.lineTo(g.x2 + t, g.y2);
        }
      }
      ctx.stroke();
      // 数值标签（圆角底 + 白字），缩放级别恒定屏幕像素大小
      ctx.font = `${10 * k}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const padX = 3 * k;
      const h = 14 * k;
      for (const g of guides.spacing) {
        const label = String(Math.round(g.value));
        const w = ctx.measureText(label).width;
        const mx = (g.x1 + g.x2) / 2;
        const my = (g.y1 + g.y2) / 2;
        ctx.beginPath();
        ctx.roundRect(mx - w / 2 - padX, my - h / 2, w + padX * 2, h, h / 2);
        ctx.fillStyle = ALIGN_COLOR;
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, mx, my);
      }
    }
    ctx.restore();
  }

  // 绘制端口圆点：active 非空时该位置的圆点改为实心蓝（吸附高亮）；
  // hoverIdx/hoverDir 指向悬浮端口：放大、实心蓝并在内部绘制指向外侧的方向箭头
  // （提示点击可沿该方向快速新建节点）
  private drawPorts(
    ctx: CanvasRenderingContext2D,
    pts: Array<{ x: number; y: number }>,
    k: number,
    active: { x: number; y: number } | null,
    hoverIdx = -1,
    hoverDir?: PortDir | null,
  ) {
    ctx.strokeStyle = SELECT_COLOR;
    pts.forEach((p, i) => {
      const isActive = active && active.x === p.x && active.y === p.y;
      const isHover = i === hoverIdx && hoverDir;
      const r = (isHover ? PORT_RADIUS * PORT_HOVER_SCALE : PORT_RADIUS) * k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (isActive || isHover) {
        ctx.fillStyle = SELECT_COLOR;
        ctx.fill();
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        // 显式恢复描边样式：悬浮端口的白色箭头会改写 strokeStyle，
        // 不重置会让其后绘制的端口用白色描边（视觉上"样式被改变"）
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();
      }
      // 悬浮箭头：白色雪佛龙指向端口外法向
      if (isHover && hoverDir) {
        const v = PORT_DIR_VEC[hoverDir];
        const n = { x: -v.y, y: v.x };
        const tip = { x: p.x + v.x * r * 0.45, y: p.y + v.y * r * 0.45 };
        const base = { x: p.x - v.x * r * 0.2, y: p.y - v.y * r * 0.2 };
        const w = r * 0.42;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5 * k;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(base.x + n.x * w, base.y + n.y * w);
        ctx.lineTo(tip.x, tip.y);
        ctx.lineTo(base.x - n.x * w, base.y - n.y * w);
        ctx.stroke();
        ctx.lineCap = "butt";
      }
    });
  }

  hitTest() {
    return false;
  }
}

export interface FlowChartOptions {
  canvas: HTMLCanvasElement;
  data: FlowData;
  // 数据变化回调：新增 / 删除 / 移动 / 连线 / 文本编辑结束，当前数据用 toJSON() 导出
  onChange?: (type: FlowChangeType) => void;
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
  private cleanups: Array<() => void> = [];

  constructor(private options: FlowChartOptions) {
    this.onChange = options.onChange;
    this.app = new App(options.canvas);
    this.app.use(new Viewport());
    // 安装导出插件：install 时自注册导出能力，toImage 按能力键消费
    this.app.use(new Exporter());
    const editor = new TextEditor({
      // 输入实时同步：文本重测后重新居中（不改形状尺寸），覆盖层跟随新位置
      onInput: () => {
        const shape = this.editing;
        if (!shape) return;
        shape.layout();
        this.app.requestRender();
        this.editor.reposition();
      },
      // 编辑结束（失焦）：文字居中落定并通知外部
      onEditEnd: () => this.finishEdit(),
    });
    this.app.use(editor);
    this.editor = editor;
    // 安装选中插件：单选/多选模型与框选会话（机制），选中语义（selected 高亮、
    // 连线置顶等）由本场景定义；框选命中规则 = 与矩形相交的形状
    this.app.use(
      new Selection<Shape | FlowEdge>({
        hitRect: (rect) => this.marqueeHits(rect),
      }),
    );
    this.sel = this.app.require(selectionCapabilityKey<Shape | FlowEdge>());
    // 拖框中实时显示已框中节点的整体选框（随拖拽更新，未框中节点时不显示）
    this.sel.onMarqueeMove = (_rect, hits) => {
      this.marqueeCombo = hits.length ? this.unionBounds(hits) : null;
    };
    // 框选落定：单个退化为普通单选，多个进入组合选中，落空保持无选中
    this.sel.onMarqueeEnd = (_rect, hits) => {
      this.marqueeCombo = null;
      if (hits.length === 1) this.select(hits[0]);
      else if (hits.length > 1) {
        this.sel.set(hits);
        this.app.requestRender();
      }
    };
    this.load(options.data);
    // 选中框覆盖层置于最上层（registerShape 追加新节点后需 raiseOverlay 保持）
    this.overlay = new SelectionOverlay(() => {
      const scale = this.app.renderer.viewport.scale;
      const dirs = ["top", "right", "bottom", "left"] as const;
      const selShape = this.selShape;
      const selEdge = this.selEdge;
      return {
        shape: selShape,
        scale,
        ports: selShape
          ? dirs.map((dir) => this.portPos(selShape, dir, scale))
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
    const shape = createShape(input.shape, {
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      text: input.text,
    });
    this.registerShape(shape);
    this.app.requestRender();
    this.onChange?.("add");
    return shape.id as string;
  }

  // 删除当前选中（形状连同其关联连线，或单条连线；多选时删除全部成员）
  deleteSelected() {
    if (this.sel.items.length > 1) {
      const list = [...this.selShapes];
      this.sel.clear();
      list.forEach((s) => this.removeShape(s));
      this.app.requestRender();
      this.onChange?.("delete");
      return;
    }
    const sel = this.sel.items[0];
    if (!sel) return;
    if (sel instanceof FlowEdge) {
      this.select(null);
      this.removeTop(sel);
      this.edges = this.edges.filter((e) => e !== sel);
    } else {
      this.removeShape(sel);
    }
    this.app.requestRender();
    this.onChange?.("delete");
  }

  // 替换当前选中形状的类型：保留位置、尺寸、文本、id 与全部连线
  // （连线两端引用直接重绑到新形状，端口方向维持创建时冻结的值不重选边），
  // 新形状占据原形状的 z 序位置并进入选中态；多选或类型相同时不操作
  replaceSelected(kind: ShapeKind) {
    const old = this.selShape;
    if (!old || old.kind === kind) return;
    if (this.editing === old) {
      this.editing = null;
      this.editor.stop();
    }
    const shape = createShape(kind, {
      id: old.id as string,
      x: old.x,
      y: old.y,
      width: old.width,
      height: old.height,
      text: old.text.text,
    });
    for (const e of this.edges) {
      if (e.fromNode === old) e.fromNode = shape;
      if (e.toNode === old) e.toNode = shape;
    }
    const idx = this.app.children.indexOf(old);
    this.removeTop(old);
    this.shapes.delete(old.id as string);
    if (idx !== -1) {
      shape.parent = null;
      this.app.children.splice(idx, 0, shape);
    } else {
      this.app.add(shape);
    }
    this.shapes.set(shape.id as string, shape);
    this.raiseOverlay();
    this.select(shape);
    this.app.requestRender();
    this.onChange?.("replace");
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

  // 卸载事件监听（页面级销毁用）
  destroy() {
    this.cleanups.forEach((fn) => fn());
    this.cleanups = [];
  }
  //#endregion

  //#region 模型维护
  private load(data: FlowData) {
    for (const n of data.nodes) {
      const shape = createShape(n.shape, {
        id: n.id,
        x: n.x,
        y: n.y,
        width: n.width,
        height: n.height,
        text: n.text,
      });
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
  // hints 指定两端固定端口（拖拽吸附创建时传入），缺省按主导方向自动选边
  private addEdgeBetween(
    from: Shape,
    to: Shape,
    notify: boolean,
    hints?: FlowEdgeHints,
  ) {
    const edge = new FlowEdge(from, to, hints);
    this.edges.push(edge);
    const idx = this.app.children.findIndex((n) => n instanceof Shape);
    if (idx === -1) this.app.children.push(edge);
    else this.app.children.splice(idx, 0, edge);
    if (notify) this.onChange?.("connect");
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
    return this.unionBounds(shapes);
  }

  // 多个形状的并集包围盒（接受任意含 x/y/width/height 的载体，含原始位置快照）
  private unionBounds(
    shapes: Array<{ x: number; y: number; width: number; height: number }>,
  ): Bounds {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const s of shapes) {
      x0 = Math.min(x0, s.x);
      y0 = Math.min(y0, s.y);
      x1 = Math.max(x1, s.x + s.width);
      y1 = Math.max(y1, s.y + s.height);
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  // 与框选矩形相交的形状（相交即命中）
  private marqueeHits(r: Bounds): Shape[] {
    return [...this.shapes.values()].filter(
      (sh) =>
        sh.x < r.x + r.width &&
        sh.x + sh.width > r.x &&
        sh.y < r.y + r.height &&
        sh.y + sh.height > r.y,
    );
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

  // 命中连线：距折线各段容差内命中（世界坐标容差）
  private hitEdge(p: { x: number; y: number }, scale: number): FlowEdge | null {
    const tol = EDGE_TOLERANCE / scale;
    for (const edge of this.edges) {
      if (edge.hitPoint(p, tol)) return edge;
    }
    return null;
  }

  // 连线端点手柄命中：返回命中的端，未命中返回 null
  private edgeHandleHit(
    edge: FlowEdge,
    p: { x: number; y: number },
    scale: number,
  ): "from" | "to" | null {
    const pts = edge.points;
    if (pts.length < 2) return null;
    const r = EDGE_HANDLE_HIT / scale;
    if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= r) return "from";
    const last = pts[pts.length - 1];
    if (Math.hypot(p.x - last.x, p.y - last.y) <= r) return "to";
    return null;
  }
  //#endregion

  //#region 编辑
  // 进入编辑：point 为按下时屏幕坐标，编辑器经浏览器命中测试把光标折叠到点击处
  private startEdit(shape: Shape, point?: { x: number; y: number }) {
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
    this.app.requestRender();
    this.onChange?.("text");
  }
  //#endregion

  //#region 交互
  private bindEvents(canvas: HTMLCanvasElement) {
    const listen = (target: EventTarget, type: string, fn: EventListener) => {
      target.addEventListener(type, fn);
      this.cleanups.push(() => target.removeEventListener(type, fn));
    };
    listen(canvas, "mousedown", (e) => this.onDown(e as MouseEvent));
    listen(window, "mousemove", (e) => this.onMove(e as MouseEvent));
    listen(window, "mouseup", (e) => this.onUp(e as MouseEvent));
    listen(document, "keydown", (e) => this.onKeyDown(e as KeyboardEvent));
  }

  // 屏幕坐标 → 世界坐标（视口逆变换）
  private toWorld(e: MouseEvent) {
    const rect = this.options.canvas.getBoundingClientRect();
    const { x: vx, y: vy, scale } = this.app.renderer.viewport;
    return {
      x: (e.clientX - rect.left - vx) / scale,
      y: (e.clientY - rect.top - vy) / scale,
    };
  }

  // 命中形状：hitNode 返回最深层（可能是形状内嵌 Text），沿父链回溯到 Shape
  private hitShape(p: { x: number; y: number }): Shape | null {
    for (let i = this.app.children.length - 1; i >= 0; i--) {
      const hit = this.app.children[i].hitNode(p.x, p.y);
      if (!hit) continue;
      let cur: Node | null = hit;
      while (cur && !(cur instanceof Shape)) cur = cur.parent;
      if (cur) return cur;
    }
    return null;
  }

  // 端口显示位置：边中点沿外法向偏移 PORT_OFFSET 屏幕像素（圆点浮在形状外侧）。
  // 节点描边为 border-box（画在尺寸内部、外缘即几何边界），圆点与可见边线的间距恒定
  private portPos(
    shape: Shape,
    dir: "top" | "right" | "bottom" | "left",
    scale: number,
  ) {
    const port = shape.portAt(dir);
    const off = PORT_OFFSET / scale;
    const d = {
      top: { x: 0, y: -1 },
      right: { x: 1, y: 0 },
      bottom: { x: 0, y: 1 },
      left: { x: -1, y: 0 },
    }[dir];
    return { x: port.x + d.x * off, y: port.y + d.y * off };
  }

  // 端口命中：返回命中的方向，未命中返回 null（按外浮后的圆点位置判定）
  private portHit(shape: Shape, p: { x: number; y: number }, scale: number) {
    // 命中范围 = 悬浮放大后的视觉圆（PORT_RADIUS * PORT_HOVER_SCALE），
    // 进入即触发悬浮/点击，之外不响应
    const r = (PORT_RADIUS * PORT_HOVER_SCALE) / scale;
    for (const dir of ["top", "right", "bottom", "left"] as const) {
      const port = this.portPos(shape, dir, scale);
      if (Math.hypot(p.x - port.x, p.y - port.y) <= r) return dir;
    }
    return null;
  }

  // 四角手柄命中（屏幕像素半径换算到世界坐标），形状与框选框通用
  private cornerHit(
    b: Bounds,
    p: { x: number; y: number },
    scale: number,
  ): "nw" | "ne" | "se" | "sw" | null {
    const r = HANDLE_HIT / scale;
    const { x, y, width: w, height: h } = b;
    const corners: Array<["nw" | "ne" | "se" | "sw", number, number]> = [
      ["nw", x, y],
      ["ne", x + w, y],
      ["se", x + w, y + h],
      ["sw", x, y + h],
    ];
    for (const [handle, cx, cy] of corners) {
      if (Math.hypot(p.x - cx, p.y - cy) <= r) return handle;
    }
    return null;
  }

  // bounds 边线命中（四边拖拽缩放）：距边线 EDGE_TOLERANCE 内命中；
  // 四角让位给角手柄、四边中点让位给连线端口（连接与缩放互不干扰）
  private edgeHit(
    b: Bounds,
    p: { x: number; y: number },
    scale: number,
  ): "n" | "e" | "s" | "w" | null {
    const tol = EDGE_TOLERANCE / scale;
    const nearCorner = HANDLE_HIT / scale + 2;
    const nearPort = PORT_HIT_RADIUS;
    const { x, y, width: w, height: h } = b;
    const sides: Array<
      [
        "n" | "e" | "s" | "w",
        { x: number; y: number },
        { x: number; y: number },
      ]
    > = [
      ["n", { x, y }, { x: x + w, y }],
      ["e", { x: x + w, y }, { x: x + w, y: y + h }],
      ["s", { x, y: y + h }, { x: x + w, y: y + h }],
      ["w", { x, y }, { x, y: y + h }],
    ];
    for (const [side, a, b] of sides) {
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len === 0) continue;
      // 点到线段的投影参数 t（截断到 0..1）与垂距
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len),
        ),
      );
      const proj = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (Math.hypot(p.x - proj.x, p.y - proj.y) > tol) continue;
      const along = t * len;
      if (along < nearCorner || len - along < nearCorner) continue;
      if (Math.abs(along - len / 2) < nearPort) continue;
      return side;
    }
    return null;
  }

  // 悬停光标：手柄/边线给缩放光标（端口与节点本体保持默认光标）
  private hoverCursor(
    shape: Shape,
    p: { x: number; y: number },
    scale: number,
  ): string | null {
    const corner = this.cornerHit(shape, p, scale);
    if (corner)
      return corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
    const side = this.edgeHit(shape, p, scale);
    if (side) return side === "n" || side === "s" ? "ns-resize" : "ew-resize";
    return null;
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const p = this.toWorld(e);
    const scale = this.app.renderer.viewport.scale;
    // 按下后进入交互会话，悬浮端口提示不再显示
    this.hoverPort = null;
    if (this.hoverEdge) {
      this.hoverEdge.hovered = false;
      this.hoverEdge = null;
    }
    // 选中态下按优先级命中：角手柄缩放 → 端口连线 → 边线缩放 → 形状体移动
    const sel = this.selShape;
    if (sel) {
      const corner = this.cornerHit(sel, p, scale);
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
      const dir = this.portHit(sel, p, scale);
      if (dir) {
        // 按下时不创建预览边（此刻无法区分点击/拖拽）：位移超过点击阈值
        // 进入拖拽连线时才插入预览并取消选中（见 onMove 的 armed 逻辑）
        const preview = new LinkPreview();
        preview.from = sel.portAt(dir);
        preview.fromDir = dir;
        preview.fromStub = sel.portStub(dir);
        preview.to = p;
        preview.toDir = this.previewToDir(dir, preview.from, p);
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
      const side = this.edgeHit(sel, p, scale);
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
      const which = this.edgeHandleHit(edge, p, scale);
      if (which) {
        // 直接拖拽原连线：被拖端进入拖拽态，路由以光标为虚拟端口
        const fixedDir = which === "from" ? edge.toDir : edge.fromDir;
        const fixedPort =
          which === "from"
            ? edge.toNode.portAt(edge.toDir)
            : edge.fromNode.portAt(edge.fromDir);
        edge.dragWhich = which;
        edge.dragPoint = p;
        edge.dragDir = this.previewToDir(fixedDir, fixedPort, p);
        this.session = { kind: "edge-move", edge, which };
        this.options.canvas.style.cursor = "crosshair";
        this.app.requestRender();
        return;
      }
    }
    // 多选组合框的手柄/边线：整体缩放（优先于命中形状）
    const mb = this.multiBounds;
    if (mb) {
      const handle = this.cornerHit(mb, p, scale) ?? this.edgeHit(mb, p, scale);
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
    const hit = this.hitShape(p);
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
    const hitLine = this.hitEdge(p, scale);
    if (hitLine) {
      this.select(hitLine);
      this.app.requestRender();
      return;
    }
    // 选中形状（单/多选通用）：选框并集内任意位置按下即整体移动（无需按在
    // 节点上，菱形/椭圆空白角落也可拖拽）；未拖动时保持原选中态不塌缩
    const selList = this.selShapes;
    if (selList.length) {
      const b = this.unionBounds(selList);
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
      const p = this.toWorld(e);
      const scale = this.app.renderer.viewport.scale;
      // 光标反馈先行：手柄/边线给缩放光标、连线端点手柄给移动光标
      let cursor: string | null = null;
      // 多选组合框的手柄/边线优先给缩放光标
      const mb = this.multiBounds;
      if (mb) {
        const corner = this.cornerHit(mb, p, scale);
        if (corner)
          cursor =
            corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
        else {
          const side = this.edgeHit(mb, p, scale);
          if (side)
            cursor = side === "n" || side === "s" ? "ns-resize" : "ew-resize";
        }
      }
      if (cursor === null)
        cursor = this.selShape
          ? this.hoverCursor(this.selShape, p, scale)
          : null;
      const selEdgeHover = this.selEdge;
      if (
        cursor === null &&
        selEdgeHover &&
        this.edgeHandleHit(selEdgeHover, p, scale)
      )
        cursor = "move";
      // 悬浮端口跟踪：单选形状的端口上悬浮时覆盖层放大该圆点并绘制方向箭头
      const hp = this.selShape ? this.portHit(this.selShape, p, scale) : null;
      if (hp !== this.hoverPort) {
        this.hoverPort = hp;
        this.app.requestRender();
      }
      // 悬浮连线跟踪：只有鼠标不压在任何形状或覆盖层手柄/端口上才考虑 edge 悬浮
      //（形状层在上、edge 层在下，被形状遮住的 edge 不该响应；覆盖层手柄不参与
      // 场景命中，但端点手柄压在连线上、端口浮在连线经过处，悬浮时不应穿透
      // 高亮下层连线——光标反馈已表达交互意图）
      const onHandle = cursor !== null || hp !== null;
      const shapeHit = this.hitShape(p);
      const he = onHandle || shapeHit ? null : this.hitEdge(p, scale);
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
    const p = this.toWorld(e);
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
        const b0 = this.unionBounds([
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
      this.applyResize(s, p.x - s.start.x, p.y - s.start.y);
      this.app.requestRender();
    } else if (s.kind === "group-resize") {
      this.applyGroupResize(s, p.x - s.start.x, p.y - s.start.y);
      this.app.requestRender();
    } else if (s.kind === "link") {
      const scale = this.app.renderer.viewport.scale;
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
        s.preview.toDir = this.previewToDir(s.sourceDir, s.preview.from, p);
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
        s.edge.dragDir = this.previewToDir(fixedDir, fixedPort, p);
      }
      this.app.requestRender();
    }
  }

  // 自由拖拽时预览的虚拟进入方向：与出口方向同轴，按光标相对出口端口的位置
  // 选边——光标在出口外法向一侧时沿行进方向顺势进入对侧（如从下方出来、
  // 光标在下方则按从上面进入，形成下、右、下的顺向路径），越过出口端口时同侧进入
  private previewToDir(
    exitDir: PortDir,
    exitPort: { x: number; y: number },
    p: { x: number; y: number },
  ): PortDir {
    const v = PORT_DIR_VEC[exitDir];
    const proj = (p.x - exitPort.x) * v.x + (p.y - exitPort.y) * v.y;
    return proj > 0 ? OPPOSITE_DIR[exitDir] : exitDir;
  }

  // 连线拖拽中更新吸附目标：光标进入某节点包围盒外扩 LINK_SNAP_MARGIN 范围时，
  // 该节点成为目标（浮出对接手柄），并吸附到距光标最近的端口（任意节点均可，
  // 包括连线/预览自身的节点——支持改接边与自环）
  private updateLinkTarget(p: { x: number; y: number }) {
    const scale = this.app.renderer.viewport.scale;
    const m = LINK_SNAP_MARGIN / scale;
    this.linkTarget = null;
    this.linkSnap = null;
    for (const shape of this.shapes.values()) {
      if (
        p.x < shape.x - m ||
        p.x > shape.x + shape.width + m ||
        p.y < shape.y - m ||
        p.y > shape.y + shape.height + m
      )
        continue;
      this.linkTarget = shape;
      let best = Infinity;
      for (const dir of ["top", "right", "bottom", "left"] as const) {
        const q = this.portPos(shape, dir, scale);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < best) {
          best = d;
          this.linkSnap = dir;
        }
      }
      break;
    }
  }

  // 节点拖拽吸附：候选参考目标 = 除被拖载体（单形状）与组内成员（组合拖拽）
  // 之外的全部形状；吸附算法在 snap.ts 纯函数 computeSnap 中实现，
  // 这里只负责按视口缩放折算容差、筛选候选、把位移写回载体
  private applySnap(shape: Bounds, exclude: Set<Shape> | null = null) {
    const scale = this.app.renderer.viewport.scale;
    const candidates = [...this.shapes.values()].filter(
      (o) => o !== shape && !(exclude && exclude.has(o)),
    );
    const r = computeSnap(shape, candidates, {
      snapTol: SNAP_TOLERANCE / scale,
      spacingTol: SPACING_TOLERANCE / scale,
      prev: this.snapPrev,
    });
    this.snapPrev = { x: r.snappedX, y: r.snappedY };
    shape.x += r.dx;
    shape.y += r.dy;
    this.guides = r.guides;
  }

  // 按手柄方位应用缩放：对侧边/对角锚定，尺寸钳制到 MIN_SIZE
  private applyResize(
    s: Extract<Session, { kind: "resize" }>,
    dx: number,
    dy: number,
  ) {
    const o = s.origin;
    let { x, y, width: w, height: h } = o;
    if (s.handle.includes("e")) w = o.width + dx;
    if (s.handle.includes("s")) h = o.height + dy;
    if (s.handle.includes("w")) w = o.width - dx;
    if (s.handle.includes("n")) h = o.height - dy;
    if (s.handle.length === 2) {
      // 角手柄：锁定比例等比缩放，取相对变化更大的轴作为统一缩放比
      // （边手柄仅单轴生效，仍可自由改变比例）
      const r = Math.max(
        Math.abs(w / o.width) >= Math.abs(h / o.height)
          ? w / o.width
          : h / o.height,
        MIN_SIZE / o.width,
        MIN_SIZE / o.height,
      );
      w = o.width * r;
      h = o.height * r;
    } else {
      w = Math.max(MIN_SIZE, w);
      h = Math.max(MIN_SIZE, h);
    }
    // 锚点：拖拽方向的对侧边/角固定不动
    if (s.handle.includes("w")) x = o.x + o.width - w;
    if (s.handle.includes("n")) y = o.y + o.height - h;
    s.shape.x = x;
    s.shape.y = y;
    s.shape.width = w;
    s.shape.height = h;
    s.shape.layout();
  }

  // 多选组合缩放：以组合 bounds 的对侧为锚点，按整体缩放比等比变换每个成员
  // 的位置与尺寸；按组内最小形状钳制缩放比，保证任何成员不低于 MIN_SIZE
  private applyGroupResize(
    s: Extract<Session, { kind: "group-resize" }>,
    dx: number,
    dy: number,
  ) {
    const o = s.origin;
    let sx = 1;
    let sy = 1;
    if (s.handle.includes("e")) sx = (o.width + dx) / o.width;
    if (s.handle.includes("w")) sx = (o.width - dx) / o.width;
    if (s.handle.includes("s")) sy = (o.height + dy) / o.height;
    if (s.handle.includes("n")) sy = (o.height - dy) / o.height;
    const minW = Math.min(...s.origins.map((g) => g.width));
    const minH = Math.min(...s.origins.map((g) => g.height));
    if (s.handle.length === 2) {
      // 角手柄：锁定比例等比缩放，取相对变化更大的轴作为统一缩放比
      // （边手柄仅单轴生效，仍可自由改变比例）
      const r = Math.max(
        Math.abs(sx) >= Math.abs(sy) ? sx : sy,
        MIN_SIZE / minW,
        MIN_SIZE / minH,
      );
      sx = r;
      sy = r;
    } else {
      sx = Math.max(sx, MIN_SIZE / minW);
      sy = Math.max(sy, MIN_SIZE / minH);
    }
    // 锚点：拖拽方向的对侧边/角固定不动
    const ax = s.handle.includes("w") ? o.x + o.width : o.x;
    const ay = s.handle.includes("n") ? o.y + o.height : o.y;
    for (const g of s.origins) {
      g.shape.x = ax + (g.x - ax) * sx;
      g.shape.y = ay + (g.y - ay) * sy;
      g.shape.width = g.width * sx;
      g.shape.height = g.height * sy;
      g.shape.layout();
    }
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
      if (s.moved) this.onChange?.("move");
      else if (s.press && Math.hypot(e.clientX - s.press.x, e.clientY - s.press.y) <= CLICK_MOVE_TOLERANCE)
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
        this.onChange?.("resize");
      }
    } else if (s.kind === "group-resize") {
      // 有成员相对初始状态发生变化时通知
      if (
        s.origins.some(
          (g) =>
            g.shape.x !== g.x ||
            g.shape.y !== g.y ||
            g.shape.width !== g.width ||
            g.shape.height !== g.height,
        )
      ) {
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
      const hit = target ?? this.hitShape(this.toWorld(e));
      const cur = s.which === "from" ? s.edge.fromNode : s.edge.toNode;
      if (hit && !(hit === cur && !target)) {
        s.edge.reattachEnd(s.which, hit, target && snap ? snap : undefined);
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
      const p = this.toWorld(e);
      // 未进入拖拽态（armed）即为纯点击端口：沿端口方向自动新建节点并连线
      if (!s.armed) {
        this.createNodeInDirection(s.source, s.sourceDir);
      } else if (target && snap) {
        this.addEdgeBetween(s.source, target, true, {
          from: s.sourceDir,
          to: snap,
        });
      } else {
        const hit = this.hitShape(p);
        if (hit && hit !== s.source) this.addEdgeBetween(s.source, hit, true);
      }
      this.app.requestRender();
    }
  }

  // 端口点击快速创建：沿端口方向新建与源节点同类型、同尺寸的节点并连线
  //（边缘间距 CLICK_CREATE_GAP，垂直于方向的轴线与源节点中心对齐），
  // 新节点进入选中态
  private createNodeInDirection(source: Shape, dir: PortDir) {
    const shape = createShape(source.kind, {
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
    this.registerShape(shape);
    this.addEdgeBetween(source, shape, false, {
      from: dir,
      to: OPPOSITE_DIR[dir],
    });
    this.select(shape);
    this.onChange?.("add");
  }

  private onKeyDown(e: KeyboardEvent) {
    // 覆盖层持有焦点时按键属于输入，交由编辑器处理
    if (this.editing || this.editor.hasFocus()) return;
    // Delete/Backspace：删除选中
    if (e.key === "Delete" || e.key === "Backspace") {
      if (!this.sel.items.length) return;
      e.preventDefault();
      this.deleteSelected();
      return;
    }
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
    for (const s of targets) {
      s.x += dx;
      s.y += dy;
    }
    this.app.requestRender();
    this.onChange?.("move");
  }
  //#endregion
}
