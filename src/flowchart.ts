import { App, Node } from '@silker/core'
import { Viewport } from '@silker/core-viewport'
import { TextEditor } from '@silker/plugin-text-editor'
import type { TextEditorCapability } from '@silker/plugin-text-editor'
import { createShape } from './shapes'
import { Shape } from './Shape'
import { FlowEdge, OPPOSITE_DIR, PORT_DIR_VEC, renderEdgePreview } from './FlowEdge'
import type { FlowEdgeHints, PortDir } from './FlowEdge'
import type { FlowChangeType, FlowData, ShapeKind } from './data'

// 端口命中半径（世界坐标）
const PORT_HIT_RADIUS = 10

// 选中框（bounds）外观与命中参数：尺寸用屏幕像素，除以视口缩放换算成世界坐标
const SELECT_COLOR = '#3b82f6'
const HANDLE_SIZE = 9      // 四角手柄边长（屏幕像素）
const HANDLE_HIT = 8       // 手柄命中半径（屏幕像素）
const EDGE_TOLERANCE = 5   // 边线命中容差（屏幕像素）
const EDGE_HANDLE_HIT = 8  // 连线端点手柄命中半径（屏幕像素）
const MIN_SIZE = 20        // 缩放最小尺寸（世界坐标）

// 连线端口圆点外观：沿边中点外法向浮在形状外侧，不遮挡边线与箭头
const PORT_RADIUS = 5      // 端口圆点半径（屏幕像素）
const PORT_OFFSET = 12     // 端口圆点圆心相对边中点向外的偏移（屏幕像素）

// 连线拖拽吸附：光标进入目标节点包围盒外扩该范围时，目标节点浮出对接手柄
const LINK_SNAP_MARGIN = 16 // 吸附感应范围（屏幕像素）

// 节点拖拽对齐：左/中/右与上/中/下接近其他节点的对应边时吸附，并绘制对齐参考线
const SNAP_TOLERANCE = 3      // 对齐吸附阈值（屏幕像素），过大会产生粘滞感
const ALIGN_COLOR = '#f43f5e' // 对齐参考线颜色
const SPACING_TOLERANCE = 4   // 等间距吸附阈值（屏幕像素）

// 等间距测量线段：起止点（世界坐标）与间距值
interface SpacingGuide { x1: number; y1: number; x2: number; y2: number; value: number }

// 缩放手柄方位：四角 + 四边
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

// 矩形包围盒（世界坐标）：框选矩形与多选组合 bounds
type Bounds = { x: number; y: number; width: number; height: number }

// 连线拖拽预览：与正式连线同款式的正交折线 + 箭头（from 为固定端端口及其方向，
// to 为光标或吸附端端口；toDir 随光标相对出口端口的位置实时变化）
class LinkPreview extends Node {
  from = { x: 0, y: 0 }
  to = { x: 0, y: 0 }
  fromDir: PortDir = 'right'
  toDir: PortDir = 'left'

  render(ctx: CanvasRenderingContext2D) {
    ctx.save()
    renderEdgePreview(ctx, FlowEdge.routeBetween(this.from, this.fromDir, this.to, this.toDir))
    ctx.restore()
  }

  hitTest() {
    return false
  }
}

// 选中框覆盖层：为选中形状绘制 bounds 边框、四角缩放手柄与外浮的连线端口圆点，
// 连线拖拽时为目标节点绘制对接手柄并高亮吸附端口，
// 尺寸按视口缩放反算，保证任何缩放级别下都是恒定屏幕像素大小
class SelectionOverlay extends Node {
  constructor(private getState: () => {
    shape: Shape | null
    scale: number
    ports: Array<{ x: number; y: number }>
    // 激活连线的首尾端点手柄（世界坐标）
    edgeHandles: Array<{ x: number; y: number }>
    // 连线拖拽中的目标节点：ports 为其四个对接手柄，active 为吸附中的手柄
    link: { ports: Array<{ x: number; y: number }>; active: { x: number; y: number } | null } | null
    // 节点拖拽对齐参考线：v 为竖线 x 坐标、h 为横线 y 坐标（世界坐标），
    // spacing 为等间距测量线段
    guides: { v: number[]; h: number[]; spacing: SpacingGuide[] } | null
    // 框选矩形（拖拽中）或多选组合 bounds（落定后），样式与单选框一致
    marquee: Bounds | null
    // 左键拖拽中的框选矩形：半透明纯矩形，无手柄（同思维导图 Marquee 样式）
    dragRect: Bounds | null
  }) {
    super()
  }

  render(ctx: CanvasRenderingContext2D) {
    const { shape, scale, ports, edgeHandles, link, guides, marquee, dragRect } = this.getState()
    const k = 1 / scale
    ctx.save()
    // 左键拖拽中的框选矩形：半透明填充 + 半透明描边的纯矩形（与思维导图一致）
    if (dragRect) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.08)'
      ctx.strokeStyle = 'rgba(59, 130, 246, 0.6)'
      ctx.lineWidth = 1 * k
      ctx.fillRect(dragRect.x, dragRect.y, dragRect.width, dragRect.height)
      ctx.strokeRect(dragRect.x, dragRect.y, dragRect.width, dragRect.height)
    }
    // 框选框 / 多选组合框：与单选框同样式（边框 + 四角手柄），无连线端口
    if (marquee) {
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.5 * k
      ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height)
      const s = HANDLE_SIZE * k
      const { x, y, width: w, height: h } = marquee
      for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
        ctx.beginPath()
        ctx.rect(cx - s / 2, cy - s / 2, s, s)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.stroke()
      }
    }
    if (shape) {
      const { x, y, width: w, height: h } = shape
      // bounds 边框
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.5 * k
      ctx.strokeRect(x, y, w, h)
      // 四角手柄（白底蓝边方块）
      const s = HANDLE_SIZE * k
      for (const [cx, cy] of [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]) {
        ctx.beginPath()
        ctx.rect(cx - s / 2, cy - s / 2, s, s)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.stroke()
      }
      // 四向连线端口圆点（浮在形状外侧）
      this.drawPorts(ctx, ports, k, null)
    }
    // 激活连线的首尾端点手柄（白底蓝边圆形）
    if (edgeHandles.length) {
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.5 * k
      const r = (HANDLE_SIZE / 2) * k
      for (const h of edgeHandles) {
        ctx.beginPath()
        ctx.arc(h.x, h.y, r, 0, Math.PI * 2)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.stroke()
      }
    }
    // 连线拖拽目标：浮出对接手柄，吸附中的手柄实心高亮
    if (link) this.drawPorts(ctx, link.ports, k, link.active)
    // 对齐参考线：贯穿画布的虚线
    if (guides && (guides.v.length || guides.h.length)) {
      ctx.strokeStyle = ALIGN_COLOR
      ctx.lineWidth = 1 * k
      ctx.setLineDash([4 * k, 4 * k])
      ctx.beginPath()
      for (const x of guides.v) {
        ctx.moveTo(x, -10000)
        ctx.lineTo(x, 10000)
      }
      for (const y of guides.h) {
        ctx.moveTo(-10000, y)
        ctx.lineTo(10000, y)
      }
      ctx.stroke()
      ctx.setLineDash([])
    }
    // 等间距测量线：虚线段 + 两端刻度 + 间距数值标签
    if (guides && guides.spacing.length) {
      ctx.strokeStyle = ALIGN_COLOR
      ctx.lineWidth = 1 * k
      ctx.setLineDash([4 * k, 4 * k])
      ctx.beginPath()
      for (const g of guides.spacing) {
        ctx.moveTo(g.x1, g.y1)
        ctx.lineTo(g.x2, g.y2)
      }
      ctx.stroke()
      ctx.setLineDash([])
      // 两端垂直于线段的刻度
      const t = 3 * k
      ctx.beginPath()
      for (const g of guides.spacing) {
        if (g.y1 === g.y2) {
          ctx.moveTo(g.x1, g.y1 - t); ctx.lineTo(g.x1, g.y1 + t)
          ctx.moveTo(g.x2, g.y2 - t); ctx.lineTo(g.x2, g.y2 + t)
        } else {
          ctx.moveTo(g.x1 - t, g.y1); ctx.lineTo(g.x1 + t, g.y1)
          ctx.moveTo(g.x2 - t, g.y2); ctx.lineTo(g.x2 + t, g.y2)
        }
      }
      ctx.stroke()
      // 数值标签（圆角底 + 白字），缩放级别恒定屏幕像素大小
      ctx.font = `${10 * k}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const padX = 3 * k
      const h = 14 * k
      for (const g of guides.spacing) {
        const label = String(Math.round(g.value))
        const w = ctx.measureText(label).width
        const mx = (g.x1 + g.x2) / 2
        const my = (g.y1 + g.y2) / 2
        ctx.beginPath()
        ctx.roundRect(mx - w / 2 - padX, my - h / 2, w + padX * 2, h, h / 2)
        ctx.fillStyle = ALIGN_COLOR
        ctx.fill()
        ctx.fillStyle = '#ffffff'
        ctx.fillText(label, mx, my)
      }
    }
    ctx.restore()
  }

  // 绘制端口圆点：active 非空时该位置的圆点改为实心蓝（吸附高亮）
  private drawPorts(ctx: CanvasRenderingContext2D, pts: Array<{ x: number; y: number }>, k: number, active: { x: number; y: number } | null) {
    ctx.strokeStyle = SELECT_COLOR
    for (const p of pts) {
      const isActive = active && active.x === p.x && active.y === p.y
      ctx.beginPath()
      ctx.arc(p.x, p.y, PORT_RADIUS * k, 0, Math.PI * 2)
      if (isActive) {
        ctx.fillStyle = SELECT_COLOR
        ctx.fill()
      } else {
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.lineWidth = 1.5 * k
        ctx.stroke()
      }
    }
  }

  hitTest() {
    return false
  }
}

export interface FlowChartOptions {
  canvas: HTMLCanvasElement
  data: FlowData
  // 数据变化回调：新增 / 删除 / 移动 / 连线 / 文本编辑结束，当前数据用 toJSON() 导出
  onChange?: (type: FlowChangeType) => void
}

// 交互会话：节点拖拽移动（多选时为组合移动）/ 拖拽缩放 / 空白按下（可拖出框选）
// / 框选组合缩放 / 端口拖拽连线 / 连线端点重接
type Session =
  | { kind: 'move'; shape: Shape; start: { x: number; y: number }; origin: { x: number; y: number }; moved: boolean; group: Array<{ shape: Shape; x: number; y: number }> | null }
  | { kind: 'resize'; shape: Shape; handle: ResizeHandle; start: { x: number; y: number }; origin: Bounds }
  | { kind: 'blank'; start: { x: number; y: number }; rect: Bounds | null }
  | { kind: 'group-resize'; handle: ResizeHandle; start: { x: number; y: number }; origin: Bounds; origins: Array<{ shape: Shape; x: number; y: number; width: number; height: number }> }
  | { kind: 'link'; source: Shape; sourceDir: PortDir; preview: LinkPreview }
  | { kind: 'edge-move'; edge: FlowEdge; which: 'from' | 'to' }

// 流程图场景门面：组装视口 / 文本编辑插件，持有形状与连线模型，
// 内置交互：点选、拖拽移动、双击编辑文字、端口拖拽连线、Delete 删除
export class FlowChart {
  app: App
  private editor: TextEditorCapability
  private shapes = new Map<string, Shape>()
  private edges: FlowEdge[] = []
  // 当前选中：形状或连线
  private selection: Shape | FlowEdge | null = null
  // 多选（框选）：非空时为组合选中态，selection 置空
  private multi: Shape[] = []
  private editing: Shape | null = null
  private session: Session | null = null
  private overlay: SelectionOverlay
  // 连线拖拽吸附状态：接近中的目标节点与吸附中的端口方向
  private linkTarget: Shape | null = null
  private linkSnap: PortDir | null = null
  // 节点拖拽对齐参考线（applySnap/applySpacingSnap 更新，拖拽结束清除）
  private guides: { v: number[]; h: number[]; spacing: SpacingGuide[] } | null = null
  private onChange?: (type: FlowChangeType) => void
  private cleanups: Array<() => void> = []

  constructor(private options: FlowChartOptions) {
    this.onChange = options.onChange
    this.app = new App(options.canvas)
    this.app.use(new Viewport())
    const editor = new TextEditor({
      // 输入实时同步：文本重测后重新居中，并让覆盖层跟随新位置
      onInput: () => {
        const shape = this.editing
        if (!shape) return
        shape.layout()
        this.app.render()
        this.editor.reposition()
      },
      // 编辑结束（失焦）：文字居中落定并通知外部
      onEditEnd: () => this.finishEdit(),
    })
    this.app.use(editor)
    this.editor = editor
    this.load(options.data)
    // 选中框覆盖层置于最上层（registerShape 追加新节点后需 raiseOverlay 保持）
    this.overlay = new SelectionOverlay(() => {
      const scale = this.app.renderer.viewport.scale
      const dirs = ['top', 'right', 'bottom', 'left'] as const
      const selShape = this.selShape
      const selEdge = this.selection instanceof FlowEdge ? this.selection : null
      return {
        shape: selShape,
        scale,
        ports: selShape ? dirs.map(dir => this.portPos(selShape, dir, scale)) : [],
        // 激活连线的首尾端点手柄（端点拖拽期间隐藏）
        edgeHandles: selEdge && !selEdge.dragWhich && selEdge.points.length >= 2
          ? [selEdge.points[0], selEdge.points[selEdge.points.length - 1]]
          : [],
        link: this.linkTarget
          ? {
              // 对接手柄位于节点边缘的实际连接点（与连线端口/预览吸附一致）
              ports: dirs.map(dir => this.linkTarget!.portAt(dir)),
              active: this.linkSnap ? this.linkTarget.portAt(this.linkSnap) : null,
            }
          : null,
        guides: this.guides,
        // 框选拖拽中：实时显示已框中节点的整体选框（随拖拽更新，未框中节点时
        // 不显示），拖拽矩形本身由 dragRect 以纯矩形样式绘制；落定后为多选组合 bounds
        marquee: (() => {
          const s = this.session
          if (s && s.kind === 'blank') {
            if (!s.rect) return null
            const hits = this.marqueeHits(s.rect)
            return hits.length ? this.unionBounds(hits) : null
          }
          return this.multiBounds
        })(),
        dragRect: this.session?.kind === 'blank' ? this.session.rect : null,
      }
    })
    this.app.add(this.overlay)
    this.bindEvents(options.canvas)
  }

  //#region 公开 API
  // 新增节点（默认居中样式），返回节点 id
  addNode(input: { shape: ShapeKind; text?: string; x?: number; y?: number; width?: number; height?: number }) {
    const shape = createShape(input.shape, {
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      text: input.text,
    })
    this.registerShape(shape)
    this.app.render()
    this.onChange?.('add')
    return shape.id as string
  }

  // 删除当前选中（形状连同其关联连线，或单条连线；多选时删除全部成员）
  deleteSelected() {
    if (this.multi.length) {
      const list = [...this.multi]
      this.multi = []
      list.forEach(s => this.removeShape(s))
      this.app.render()
      this.onChange?.('delete')
      return
    }
    const sel = this.selection
    if (!sel) return
    if (sel instanceof FlowEdge) {
      this.select(null)
      this.removeTop(sel)
      this.edges = this.edges.filter(e => e !== sel)
    } else {
      this.removeShape(sel)
    }
    this.app.render()
    this.onChange?.('delete')
  }

  // 导出当前数据（位置为最新拖拽结果）
  toJSON(): FlowData {
    return {
      nodes: [...this.shapes.values()].map(s => ({
        id: s.id ?? undefined,
        shape: s.kind,
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        text: s.text.text,
      })),
      edges: this.edges.map(e => ({
        from: e.fromNode.id as string,
        to: e.toNode.id as string,
        fromDir: e.fromDir,
        toDir: e.toDir,
      })),
    }
  }

  // 卸载事件监听（页面级销毁用）
  destroy() {
    this.cleanups.forEach(fn => fn())
    this.cleanups = []
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
      })
      this.registerShape(shape)
    }
    for (const e of data.edges) {
      const from = this.shapes.get(e.from)
      const to = this.shapes.get(e.to)
      if (from && to) this.addEdgeBetween(from, to, false, { from: e.fromDir, to: e.toDir })
    }
    this.app.render()
  }

  private registerShape(shape: Shape) {
    this.shapes.set(shape.id as string, shape)
    this.app.add(shape)
    this.raiseOverlay()
  }

  // 保持选中框覆盖层在最上层（新增节点会追加到 children 末尾）
  private raiseOverlay() {
    const c = this.app.children
    const i = c.indexOf(this.overlay)
    if (i !== -1 && i !== c.length - 1) {
      c.splice(i, 1)
      c.push(this.overlay)
    }
  }

  // 新建连线：两节点间可存在多条连线，不做去重限制；
  // 插入到形状层之下保证连线画在节点下方；
  // hints 指定两端固定端口（拖拽吸附创建时传入），缺省按主导方向自动选边
  private addEdgeBetween(from: Shape, to: Shape, notify: boolean, hints?: FlowEdgeHints) {
    const edge = new FlowEdge(from, to, hints)
    this.edges.push(edge)
    const idx = this.app.children.findIndex(n => n instanceof Shape)
    if (idx === -1) this.app.children.push(edge)
    else this.app.children.splice(idx, 0, edge)
    if (notify) this.onChange?.('connect')
  }

  private removeShape(shape: Shape) {
    if (this.editing === shape) {
      this.editing = null
      this.editor.stop()
    }
    this.select(null)
    const related = this.edges.filter(e => e.fromNode === shape || e.toNode === shape)
    this.edges = this.edges.filter(e => !related.includes(e))
    related.forEach(e => this.removeTop(e))
    this.removeTop(shape)
    this.shapes.delete(shape.id as string)
  }

  private removeTop(node: Node) {
    const i = this.app.children.indexOf(node)
    if (i !== -1) this.app.children.splice(i, 1)
  }

  private select(sel: Shape | FlowEdge | null) {
    // 多选与单选互斥：任何单选变化都清空组合选中
    const hadMulti = this.multi.length > 0
    this.multi = []
    if (this.selection === sel && !hadMulti) return
    if (this.selection) this.selection.selected = false
    this.selection = sel
    if (sel) {
      sel.selected = true
      // 激活的连线提到连线层最上再渲染，避免激活样式被其他连线覆盖
      if (sel instanceof FlowEdge) this.raiseEdgeTop(sel)
    }
    this.app.render()
  }

  // 多选组合的包围盒（少于 2 个形状时视为无组合）
  private get multiBounds(): Bounds | null {
    if (this.multi.length < 2) return null
    return this.unionBounds(this.multi)
  }

  // 多个形状的并集包围盒
  private unionBounds(shapes: Shape[]): Bounds {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const s of shapes) {
      x0 = Math.min(x0, s.x)
      y0 = Math.min(y0, s.y)
      x1 = Math.max(x1, s.x + s.width)
      y1 = Math.max(y1, s.y + s.height)
    }
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }

  // 与框选矩形相交的形状（相交即命中）
  private marqueeHits(r: Bounds): Shape[] {
    return [...this.shapes.values()].filter(sh =>
      sh.x < r.x + r.width && sh.x + sh.width > r.x && sh.y < r.y + r.height && sh.y + sh.height > r.y)
  }

  // 把连线移到连线层最上（保持在形状层/覆盖层之下）
  private raiseEdgeTop(edge: FlowEdge) {
    const children = this.app.children
    const from = children.indexOf(edge)
    if (from === -1) return
    let to = from
    for (let j = from + 1; j < children.length; j++) {
      const c = children[j]
      if (c instanceof Shape || c === this.overlay) break
      to = j
    }
    if (to !== from) {
      children.splice(from, 1)
      children.splice(to, 0, edge)
    }
  }

  // 选中的形状（选中连线时为 null）
  private get selShape(): Shape | null {
    return this.selection instanceof Shape ? this.selection : null
  }

  // 命中连线：距折线各段容差内命中（世界坐标容差）
  private hitEdge(p: { x: number; y: number }, scale: number): FlowEdge | null {
    const tol = EDGE_TOLERANCE / scale
    for (const edge of this.edges) {
      if (edge.hitPoint(p, tol)) return edge
    }
    return null
  }

  // 连线端点手柄命中：返回命中的端，未命中返回 null
  private edgeHandleHit(edge: FlowEdge, p: { x: number; y: number }, scale: number): 'from' | 'to' | null {
    const pts = edge.points
    if (pts.length < 2) return null
    const r = EDGE_HANDLE_HIT / scale
    if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= r) return 'from'
    const last = pts[pts.length - 1]
    if (Math.hypot(p.x - last.x, p.y - last.y) <= r) return 'to'
    return null
  }
  //#endregion

  //#region 编辑
  private startEdit(shape: Shape) {
    this.editing = shape
    this.editor.start(shape.text)
    this.editor.show({ fill: true })
  }

  private finishEdit() {
    const shape = this.editing
    if (!shape) return
    this.editing = null
    shape.layout()
    this.app.render()
    this.onChange?.('text')
  }
  //#endregion

  //#region 交互
  private bindEvents(canvas: HTMLCanvasElement) {
    const listen = (target: EventTarget, type: string, fn: EventListener) => {
      target.addEventListener(type, fn)
      this.cleanups.push(() => target.removeEventListener(type, fn))
    }
    listen(canvas, 'mousedown', e => this.onDown(e as MouseEvent))
    listen(window, 'mousemove', e => this.onMove(e as MouseEvent))
    listen(window, 'mouseup', e => this.onUp(e as MouseEvent))
    listen(canvas, 'dblclick', e => this.onDblClick(e as MouseEvent))
    listen(document, 'keydown', e => this.onKeyDown(e as KeyboardEvent))
  }

  // 屏幕坐标 → 世界坐标（视口逆变换）
  private toWorld(e: MouseEvent) {
    const rect = this.options.canvas.getBoundingClientRect()
    const { x: vx, y: vy, scale } = this.app.renderer.viewport
    return { x: (e.clientX - rect.left - vx) / scale, y: (e.clientY - rect.top - vy) / scale }
  }

  // 命中形状：hitNode 返回最深层（可能是形状内嵌 Text），沿父链回溯到 Shape
  private hitShape(p: { x: number; y: number }): Shape | null {
    for (let i = this.app.children.length - 1; i >= 0; i--) {
      const hit = this.app.children[i].hitNode(p.x, p.y)
      if (!hit) continue
      let cur: Node | null = hit
      while (cur && !(cur instanceof Shape)) cur = cur.parent
      if (cur) return cur
    }
    return null
  }

  // 端口显示位置：边中点沿外法向偏移 PORT_OFFSET 屏幕像素（圆点浮在形状外侧）。
  // 节点描边为 border-box（画在尺寸内部、外缘即几何边界），圆点与可见边线的间距恒定
  private portPos(shape: Shape, dir: 'top' | 'right' | 'bottom' | 'left', scale: number) {
    const port = shape.portAt(dir)
    const off = PORT_OFFSET / scale
    const d = { top: { x: 0, y: -1 }, right: { x: 1, y: 0 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 } }[dir]
    return { x: port.x + d.x * off, y: port.y + d.y * off }
  }

  // 端口命中：返回命中的方向，未命中返回 null（按外浮后的圆点位置判定）
  private portHit(shape: Shape, p: { x: number; y: number }, scale: number) {
    for (const dir of ['top', 'right', 'bottom', 'left'] as const) {
      const port = this.portPos(shape, dir, scale)
      if (Math.hypot(p.x - port.x, p.y - port.y) <= PORT_HIT_RADIUS) return dir
    }
    return null
  }

  // 四角手柄命中（屏幕像素半径换算到世界坐标），形状与框选框通用
  private cornerHit(b: Bounds, p: { x: number; y: number }, scale: number): 'nw' | 'ne' | 'se' | 'sw' | null {
    const r = HANDLE_HIT / scale
    const { x, y, width: w, height: h } = b
    const corners: Array<['nw' | 'ne' | 'se' | 'sw', number, number]> = [
      ['nw', x, y], ['ne', x + w, y], ['se', x + w, y + h], ['sw', x, y + h],
    ]
    for (const [handle, cx, cy] of corners) {
      if (Math.hypot(p.x - cx, p.y - cy) <= r) return handle
    }
    return null
  }

  // bounds 边线命中（四边拖拽缩放）：距边线 EDGE_TOLERANCE 内命中；
  // 四角让位给角手柄、四边中点让位给连线端口（连接与缩放互不干扰）
  private edgeHit(b: Bounds, p: { x: number; y: number }, scale: number): 'n' | 'e' | 's' | 'w' | null {
    const tol = EDGE_TOLERANCE / scale
    const nearCorner = HANDLE_HIT / scale + 2
    const nearPort = PORT_HIT_RADIUS
    const { x, y, width: w, height: h } = b
    const sides: Array<['n' | 'e' | 's' | 'w', { x: number; y: number }, { x: number; y: number }]> = [
      ['n', { x, y }, { x: x + w, y }],
      ['e', { x: x + w, y }, { x: x + w, y: y + h }],
      ['s', { x, y: y + h }, { x: x + w, y: y + h }],
      ['w', { x, y }, { x, y: y + h }],
    ]
    for (const [side, a, b] of sides) {
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len === 0) continue
      // 点到线段的投影参数 t（截断到 0..1）与垂距
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len)))
      const proj = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
      if (Math.hypot(p.x - proj.x, p.y - proj.y) > tol) continue
      const along = t * len
      if (along < nearCorner || len - along < nearCorner) continue
      if (Math.abs(along - len / 2) < nearPort) continue
      return side
    }
    return null
  }

  // 悬停光标：手柄/边线给缩放光标，端口给十字，形状体给移动光标
  private hoverCursor(shape: Shape, p: { x: number; y: number }, scale: number): string | null {
    const corner = this.cornerHit(shape, p, scale)
    if (corner) return corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize'
    const side = this.edgeHit(shape, p, scale)
    if (side) return side === 'n' || side === 's' ? 'ns-resize' : 'ew-resize'
    if (this.portHit(shape, p, scale)) return 'crosshair'
    return null
  }

  private onDown(e: MouseEvent) {
    if (e.button !== 0) return
    const p = this.toWorld(e)
    const scale = this.app.renderer.viewport.scale
    // 选中态下按优先级命中：角手柄缩放 → 端口连线 → 边线缩放 → 形状体移动
    const sel = this.selShape
    if (sel) {
      const corner = this.cornerHit(sel, p, scale)
      if (corner) {
        this.session = { kind: 'resize', shape: sel, handle: corner, start: p, origin: { x: sel.x, y: sel.y, width: sel.width, height: sel.height } }
        return
      }
      const dir = this.portHit(sel, p, scale)
      if (dir) {
        const preview = new LinkPreview()
        preview.from = sel.portAt(dir)
        preview.fromDir = dir
        preview.to = p
        preview.toDir = this.previewToDir(dir, preview.from, p)
        const idx = this.app.children.findIndex(n => n instanceof Shape)
        if (idx === -1) this.app.children.push(preview)
        else this.app.children.splice(idx, 0, preview)
        this.session = { kind: 'link', source: sel, sourceDir: dir, preview }
        this.options.canvas.style.cursor = 'crosshair'
        // 拖拽开始即取消形状激活，选中框与手柄不再显示
        this.select(null)
        this.app.render()
        return
      }
      const side = this.edgeHit(sel, p, scale)
      if (side) {
        this.session = { kind: 'resize', shape: sel, handle: side, start: p, origin: { x: sel.x, y: sel.y, width: sel.width, height: sel.height } }
        return
      }
    }
    // 激活连线的首尾手柄：拖拽重接该端（优先于命中其他形状）
    if (this.selection instanceof FlowEdge) {
      const edge = this.selection
      const which = this.edgeHandleHit(edge, p, scale)
      if (which) {
        // 直接拖拽原连线：被拖端进入拖拽态，路由以光标为虚拟端口
        const fixedDir = which === 'from' ? edge.toDir : edge.fromDir
        const fixedPort = which === 'from' ? edge.toNode.portAt(edge.toDir) : edge.fromNode.portAt(edge.fromDir)
        edge.dragWhich = which
        edge.dragPoint = p
        edge.dragDir = this.previewToDir(fixedDir, fixedPort, p)
        this.session = { kind: 'edge-move', edge, which }
        this.options.canvas.style.cursor = 'crosshair'
        this.app.render()
        return
      }
    }
    // 多选组合框的手柄/边线：整体缩放（优先于命中形状）
    const mb = this.multiBounds
    if (mb) {
      const handle = this.cornerHit(mb, p, scale) ?? this.edgeHit(mb, p, scale)
      if (handle) {
        this.session = {
          kind: 'group-resize',
          handle,
          start: p,
          origin: mb,
          origins: this.multi.map(s => ({ shape: s, x: s.x, y: s.y, width: s.width, height: s.height })),
        }
        return
      }
    }
    const hit = this.hitShape(p)
    if (hit) {
      if (this.multi.includes(hit)) {
        // 组内形状：整体移动，保持多选（单击不动则抬起时塌缩为单选）
        this.session = {
          kind: 'move',
          shape: hit,
          start: p,
          origin: { x: hit.x, y: hit.y },
          moved: false,
          group: this.multi.filter(s => s !== hit).map(s => ({ shape: s, x: s.x, y: s.y })),
        }
      } else {
        this.select(hit)
        this.session = { kind: 'move', shape: hit, start: p, origin: { x: hit.x, y: hit.y }, moved: false, group: null }
      }
      return
    }
    // 形状未命中时尝试命中连线（形状层在上，优先选中形状）
    const hitLine = this.hitEdge(p, scale)
    if (hitLine) {
      this.select(hitLine)
      this.app.render()
      return
    }
    // 空白按下：立即取消选中，可拖出框选矩形（光标保持 default）
    this.select(null)
    this.session = { kind: 'blank', start: p, rect: null }
  }

  private onMove(e: MouseEvent) {
    const s = this.session
    // 无会话时做悬停反馈：缩放手柄/边线/端口/形状体/连线分别给对应光标
    if (!s) {
      const p = this.toWorld(e)
      const scale = this.app.renderer.viewport.scale
      let cursor: string | null = null
      // 多选组合框的手柄/边线优先给缩放光标
      const mb = this.multiBounds
      if (mb) {
        const corner = this.cornerHit(mb, p, scale)
        if (corner) cursor = corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize'
        else {
          const side = this.edgeHit(mb, p, scale)
          if (side) cursor = side === 'n' || side === 's' ? 'ns-resize' : 'ew-resize'
        }
      }
      if (cursor === null) cursor = this.selShape ? this.hoverCursor(this.selShape, p, scale) : null
      if (cursor === null && this.selection instanceof FlowEdge && this.edgeHandleHit(this.selection, p, scale)) cursor = 'move'
      if (cursor === null) cursor = this.hitShape(p) ? 'move' : null
      if (cursor === null) cursor = this.hitEdge(p, scale) ? 'pointer' : null
      this.options.canvas.style.cursor = cursor ?? ''
      return
    }
    const p = this.toWorld(e)
    if (s.kind === 'move') {
      s.shape.x = s.origin.x + (p.x - s.start.x)
      s.shape.y = s.origin.y + (p.y - s.start.y)
      s.moved = true
      if (s.group) {
        // 组合移动：以整体框（成员并集 bounds）的四边/中线与外部节点对齐吸附，
        // 全部组内成员（含被按住的主节点）不作为参考目标，避免内部基线；
        // 全量拖拽位移 + 吸附修正统一应用到全部成员
        const exclude = new Set([s.shape, ...s.group.map((g) => g.shape)])
        const b0 = this.unionBounds([s.shape, ...exclude])
        const box: Bounds = { ...b0 }
        this.applySnap(box, exclude)
        const mx = (p.x - s.start.x) + (box.x - b0.x)
        const my = (p.y - s.start.y) + (box.y - b0.y)
        s.shape.x = s.origin.x + mx
        s.shape.y = s.origin.y + my
        for (const g of s.group) {
          g.shape.x = g.x + mx
          g.shape.y = g.y + my
        }
      } else {
        this.applySnap(s.shape)
      }
      this.app.render()
    } else if (s.kind === 'resize') {
      this.applyResize(s, p.x - s.start.x, p.y - s.start.y)
      this.app.render()
    } else if (s.kind === 'group-resize') {
      this.applyGroupResize(s, p.x - s.start.x, p.y - s.start.y)
      this.app.render()
    } else if (s.kind === 'blank') {
      // 框选矩形：拖动超过 3 屏幕像素才显示，避免与单击取消选中混淆
      const k = 3 / this.app.renderer.viewport.scale
      const w = Math.abs(p.x - s.start.x)
      const h = Math.abs(p.y - s.start.y)
      s.rect = w > k || h > k
        ? { x: Math.min(s.start.x, p.x), y: Math.min(s.start.y, p.y), width: w, height: h }
        : null
      this.app.render()
    } else if (s.kind === 'link') {
      this.updateLinkTarget(p)
      // 吸附时预览以手柄的具体位置与端口方向渲染；自由拖拽时按光标相对
      // 出口端口的位置确定虚拟进入方向
      if (this.linkTarget && this.linkSnap) {
        s.preview.to = this.linkTarget.portAt(this.linkSnap)
        s.preview.toDir = this.linkSnap
      } else {
        s.preview.to = p
        s.preview.toDir = this.previewToDir(s.sourceDir, s.preview.from, p)
      }
      this.app.render()
    } else if (s.kind === 'edge-move') {
      // 原连线被拖端跟随光标：吸附时落在目标手柄上，自由拖拽时按出口方向
      // 与光标位置确定虚拟进入方向。任意节点均可吸附（含本连线两端节点，
      // 可调整接入边或形成自环）
      this.updateLinkTarget(p)
      if (this.linkTarget && this.linkSnap) {
        s.edge.dragPoint = this.linkTarget.portAt(this.linkSnap)
        s.edge.dragDir = this.linkSnap
      } else {
        const fixedDir = s.which === 'from' ? s.edge.toDir : s.edge.fromDir
        const fixedPort = s.which === 'from' ? s.edge.toNode.portAt(s.edge.toDir) : s.edge.fromNode.portAt(s.edge.fromDir)
        s.edge.dragPoint = p
        s.edge.dragDir = this.previewToDir(fixedDir, fixedPort, p)
      }
      this.app.render()
    }
  }

  // 自由拖拽时预览的虚拟进入方向：与出口方向同轴，按光标相对出口端口的位置
  // 选边——光标在出口外法向一侧时沿行进方向顺势进入对侧（如从下方出来、
  // 光标在下方则按从上面进入，形成下、右、下的顺向路径），越过出口端口时同侧进入
  private previewToDir(exitDir: PortDir, exitPort: { x: number; y: number }, p: { x: number; y: number }): PortDir {
    const v = PORT_DIR_VEC[exitDir]
    const proj = (p.x - exitPort.x) * v.x + (p.y - exitPort.y) * v.y
    return proj > 0 ? OPPOSITE_DIR[exitDir] : exitDir
  }

  // 连线拖拽中更新吸附目标：光标进入某节点包围盒外扩 LINK_SNAP_MARGIN 范围时，
  // 该节点成为目标（浮出对接手柄），并吸附到距光标最近的端口（任意节点均可，
  // 包括连线/预览自身的节点——支持改接边与自环）
  private updateLinkTarget(p: { x: number; y: number }) {
    const scale = this.app.renderer.viewport.scale
    const m = LINK_SNAP_MARGIN / scale
    this.linkTarget = null
    this.linkSnap = null
    for (const shape of this.shapes.values()) {
      if (p.x < shape.x - m || p.x > shape.x + shape.width + m || p.y < shape.y - m || p.y > shape.y + shape.height + m) continue
      this.linkTarget = shape
      let best = Infinity
      for (const dir of ['top', 'right', 'bottom', 'left'] as const) {
        const q = this.portPos(shape, dir, scale)
        const d = Math.hypot(p.x - q.x, p.y - q.y)
        if (d < best) {
          best = d
          this.linkSnap = dir
        }
      }
      break
    }
  }

  // 节点拖拽吸附：对 bounds 载体（单形状，或多选组合的并集框）做吸附——
  // 等间距吸附优先——某轴发生等间距吸附后该轴不再做对齐吸附，
  // 避免两类吸附点相邻时（如间距 40px 恰与中线对齐差 1px）来回切换产生抖动；
  // 对齐吸附仅同类型基准配对——左对左、中对中、右对右（上/中/下同理），取各类
  // 最小差值做吸附平移；第二遍收集吸附后所有阈值内已对齐的基准（等宽节点上下
  // 对齐时中线随之对齐，跳过中线参考线）；吸附平移直接写入载体坐标
  private applySnap(shape: Bounds, exclude: Set<Shape> | null = null) {
    const scale = this.app.renderer.viewport.scale
    const tol = SNAP_TOLERANCE / scale
    const spacing = this.applySpacingSnap(shape, false, false, exclude)
    const skipX = spacing.snappedX
    const skipY = spacing.snappedY
    const xs = () => [shape.x, shape.x + shape.width / 2, shape.x + shape.width]
    const ys = () => [shape.y, shape.y + shape.height / 2, shape.y + shape.height]
    let bestX: { d: number; shift: number } | null = null
    let bestY: { d: number; shift: number } | null = null
    for (const other of this.shapes.values()) {
      if (other === shape || (exclude && exclude.has(other))) continue
      const oxs = [other.x, other.x + other.width / 2, other.x + other.width]
      const oys = [other.y, other.y + other.height / 2, other.y + other.height]
      for (let i = 0; i < 3; i++) {
        if (!skipX) {
          const d = Math.abs(oxs[i] - xs()[i])
          if (d <= tol && (!bestX || d < bestX.d)) bestX = { d, shift: oxs[i] - xs()[i] }
        }
        if (!skipY) {
          const dy = Math.abs(oys[i] - ys()[i])
          if (dy <= tol && (!bestY || dy < bestY.d)) bestY = { d: dy, shift: oys[i] - ys()[i] }
        }
      }
    }
    if (bestX) shape.x += bestX.shift
    if (bestY) shape.y += bestY.shift
    // 吸附后收集所有已对齐基准（去重，仍仅同类型配对）
    const v = new Set<number>()
    const h = new Set<number>()
    const vSkip = new Set<number>()
    const hSkip = new Set<number>()
    for (const other of this.shapes.values()) {
      if (other === shape || (exclude && exclude.has(other))) continue
      const oxs = [other.x, other.x + other.width / 2, other.x + other.width]
      const oys = [other.y, other.y + other.height / 2, other.y + other.height]
      for (let i = 0; i < 3; i++) {
        if (Math.abs(oxs[i] - xs()[i]) <= tol) v.add(oxs[i])
        if (Math.abs(oys[i] - ys()[i]) <= tol) h.add(oys[i])
      }
      // 左右两边都已对齐时宽度必然相等、中线随之对齐，跳过中线参考线（上下同理）
      if (Math.abs(oxs[0] - xs()[0]) <= tol && Math.abs(oxs[2] - xs()[2]) <= tol) vSkip.add(oxs[1])
      if (Math.abs(oys[0] - ys()[0]) <= tol && Math.abs(oys[2] - ys()[2]) <= tol) hSkip.add(oys[1])
    }
    for (const m of vSkip) v.delete(m)
    for (const m of hSkip) h.delete(m)
    this.guides = v.size || h.size || spacing.guides.length
      ? { v: [...v], h: [...h], spacing: spacing.guides }
      : null
  }

  // 节点拖拽等间距（主流画板做法）：
  // 1. 轴线投影过滤——仅与拖拽节点在另一轴上重叠（含少量容差）的节点参与计算，
  //    远处行/列夹杂的零碎间距不进入间距池；
  // 2. 高频间距锁定——投影带内相邻节点的间隙聚类取众数（至少出现 2 次），
  //    接近众数时直接磁吸到该间距，孤立、不规则的间距不产生吸附力；
  // 3. 两侧邻居间隙相等时平分差值；仅一侧有邻居时复现既有间距。
  // 返回绘制用的测量线段，以及两轴是否发生了吸附
  // （skipX/skipY 用于跳过对应轴；调用方以间距吸附结果决定对齐吸附是否生效）
  private applySpacingSnap(shape: Bounds, skipX: boolean, skipY: boolean, exclude: Set<Shape> | null = null): {
    guides: SpacingGuide[]; snappedX: boolean; snappedY: boolean
  } {
    const tol = SPACING_TOLERANCE / this.app.renderer.viewport.scale
    const out: SpacingGuide[] = []
    let snappedX = false
    let snappedY = false
    // exclude：组合拖拽时排除组内成员，避免组内部间距/基线干扰吸附
    const shapes = [...this.shapes.values()].filter((o) => !exclude || !exclude.has(o))
    // 间隙聚类取众数：簇内相邻差值 <= tol，出现次数 >= 2 时取簇均值，否则 NaN
    const modeGap = (gaps: number[]): number => {
      if (gaps.length < 2) return NaN
      const s = [...gaps].sort((a, b) => a - b)
      let best = NaN
      let bestN = 1
      let i = 0
      while (i < s.length) {
        let j = i
        while (j + 1 < s.length && s[j + 1] - s[j] <= tol) j++
        if (j - i + 1 > bestN) {
          bestN = j - i + 1
          best = (s[i] + s[j]) / 2
        }
        i = j + 1
      }
      return bestN >= 2 ? best : NaN
    }
    // 单侧吸附的目标间距：当前间隙接近众数时锁定众数，否则复现既有间距 g
    const targetGap = (cur: number, g: number, mode: number): number =>
      !Number.isNaN(mode) && Math.abs(cur - mode) <= tol ? mode : g
    if (!skipX) {
      // 水平投影带：与拖拽节点垂直方向重叠（含容差）的节点
      const band = shapes.filter(
        (o) => o !== shape && o.y < shape.y + shape.height + tol && o.y + o.height > shape.y - tol,
      )
      const midY = shape.y + shape.height / 2
      let L: Shape | null = null
      let R: Shape | null = null
      for (const o of band) {
        if (o.x + o.width <= shape.x && (!L || o.x + o.width > L.x + L.width)) L = o
        if (o.x >= shape.x + shape.width && (!R || o.x < R.x)) R = o
      }
      // 高频间距样本：带内每个节点与其最近右邻的间隙
      const gapsX: number[] = []
      for (const o of band) {
        let nr: Shape | null = null
        for (const p of band) {
          if (p === o || p.x < o.x + o.width) continue
          if (!nr || p.x < nr.x) nr = p
        }
        if (nr) {
          const g = nr.x - (o.x + o.width)
          if (g > 0) gapsX.push(g)
        }
      }
      const modeX = modeGap(gapsX)
      const gL = L ? shape.x - (L.x + L.width) : Infinity
      const gR = R ? R.x - (shape.x + shape.width) : Infinity
      if (L && R && gL > 0 && gR > 0) {
        if (Math.abs(gL - gR) <= tol) {
          shape.x -= (gL - gR) / 2 // 平分差值，两侧间隙相等
          snappedX = true
        } else if (!Number.isNaN(modeX) && Math.abs(gL - modeX) <= tol && Math.abs(gR - modeX) <= tol) {
          shape.x = L.x + L.width + modeX // 两侧都接近高频间距，磁吸过去
          snappedX = true
        }
      } else if (L && !R && gL > 0) {
        // 仅左侧有邻居：优先吸附到高频间距，否则复现 L 与其左邻 LL
        // （投影带内最近）的既有间距
        let LL: Shape | null = null
        for (const o of band) {
          if (o === L) continue
          if (o.x + o.width <= L.x && (!LL || o.x + o.width > LL.x + LL.width)) LL = o
        }
        if (LL) {
          const g = L.x - (LL.x + LL.width)
          const target = targetGap(gL, g, modeX)
          if (target > 0 && Math.abs(gL - target) <= tol) {
            shape.x = L.x + L.width + target
            snappedX = true
          }
        }
      } else if (R && !L && gR > 0) {
        // 仅右侧有邻居：优先吸附到高频间距，否则复现 R 与其右邻 RR
        // （投影带内最近）的既有间距
        let RR: Shape | null = null
        for (const o of band) {
          if (o === R) continue
          if (o.x >= R.x + R.width && (!RR || o.x < RR.x)) RR = o
        }
        if (RR) {
          const g = RR.x - (R.x + R.width)
          const target = targetGap(gR, g, modeX)
          if (target > 0 && Math.abs(gR - target) <= tol) {
            shape.x = R.x - target - shape.width
            snappedX = true
          }
        }
      }
      // 吸附平移后重算，两侧间隙相等时输出测量线段
      if (L && R) {
        const a = shape.x - (L.x + L.width)
        const b = R.x - (shape.x + shape.width)
        if (a > 0 && Math.abs(a - b) <= tol) {
          out.push({ x1: L.x + L.width, y1: midY, x2: shape.x, y2: midY, value: a })
          out.push({ x1: shape.x + shape.width, y1: midY, x2: R.x, y2: midY, value: b })
        }
      } else if (L) {
        // 外侧等间距：把 L 左侧的既有间距一并画出
        let LL: Shape | null = null
        for (const o of band) {
          if (o === L) continue
          if (o.x + o.width <= L.x && (!LL || o.x + o.width > LL.x + LL.width)) LL = o
        }
        if (LL) {
          const g = L.x - (LL.x + LL.width)
          const a = shape.x - (L.x + L.width)
          if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeX) <= tol)) {
            out.push({ x1: LL.x + LL.width, y1: L.y + L.height / 2, x2: L.x, y2: L.y + L.height / 2, value: g })
            out.push({ x1: L.x + L.width, y1: midY, x2: shape.x, y2: midY, value: a })
          }
        }
      } else if (R) {
        // 外侧等间距（拖拽节点在左）：把 R 右侧的既有间距一并画出
        let RR: Shape | null = null
        for (const o of band) {
          if (o === R) continue
          if (o.x >= R.x + R.width && (!RR || o.x < RR.x)) RR = o
        }
        if (RR) {
          const g = RR.x - (R.x + R.width)
          const a = R.x - (shape.x + shape.width)
          if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeX) <= tol)) {
            out.push({ x1: shape.x + shape.width, y1: midY, x2: R.x, y2: midY, value: a })
            out.push({ x1: R.x + R.width, y1: R.y + R.height / 2, x2: RR.x, y2: R.y + R.height / 2, value: g })
          }
        }
      }
    }
    if (!skipY) {
      // 垂直投影带：与拖拽节点水平方向重叠（含容差）的节点，逻辑与水平对称
      const band = shapes.filter(
        (o) => o !== shape && o.x < shape.x + shape.width + tol && o.x + o.width > shape.x - tol,
      )
      const midX = shape.x + shape.width / 2
      let T: Shape | null = null
      let B: Shape | null = null
      for (const o of band) {
        if (o.y + o.height <= shape.y && (!T || o.y + o.height > T.y + T.height)) T = o
        if (o.y >= shape.y + shape.height && (!B || o.y < B.y)) B = o
      }
      // 高频间距样本：带内每个节点与其最近下邻的间隙
      const gapsY: number[] = []
      for (const o of band) {
        let nb: Shape | null = null
        for (const p of band) {
          if (p === o || p.y < o.y + o.height) continue
          if (!nb || p.y < nb.y) nb = p
        }
        if (nb) {
          const g = nb.y - (o.y + o.height)
          if (g > 0) gapsY.push(g)
        }
      }
      const modeY = modeGap(gapsY)
      const gT = T ? shape.y - (T.y + T.height) : Infinity
      const gB = B ? B.y - (shape.y + shape.height) : Infinity
      if (T && B && gT > 0 && gB > 0) {
        if (Math.abs(gT - gB) <= tol) {
          shape.y -= (gT - gB) / 2
          snappedY = true
        } else if (!Number.isNaN(modeY) && Math.abs(gT - modeY) <= tol && Math.abs(gB - modeY) <= tol) {
          shape.y = T.y + T.height + modeY
          snappedY = true
        }
      } else if (T && !B && gT > 0) {
        let TT: Shape | null = null
        for (const o of band) {
          if (o === T) continue
          if (o.y + o.height <= T.y && (!TT || o.y + o.height > TT.y + TT.height)) TT = o
        }
        if (TT) {
          const g = T.y - (TT.y + TT.height)
          const target = targetGap(gT, g, modeY)
          if (target > 0 && Math.abs(gT - target) <= tol) {
            shape.y = T.y + T.height + target
            snappedY = true
          }
        }
      } else if (B && !T && gB > 0) {
        let BB: Shape | null = null
        for (const o of band) {
          if (o === B) continue
          if (o.y >= B.y + B.height && (!BB || o.y < BB.y)) BB = o
        }
        if (BB) {
          const g = BB.y - (B.y + B.height)
          const target = targetGap(gB, g, modeY)
          if (target > 0 && Math.abs(gB - target) <= tol) {
            shape.y = B.y - target - shape.height
            snappedY = true
          }
        }
      }
      if (T && B) {
        const a = shape.y - (T.y + T.height)
        const b = B.y - (shape.y + shape.height)
        if (a > 0 && Math.abs(a - b) <= tol) {
          out.push({ x1: midX, y1: T.y + T.height, x2: midX, y2: shape.y, value: a })
          out.push({ x1: midX, y1: shape.y + shape.height, x2: midX, y2: B.y, value: b })
        }
      } else if (T) {
        let TT: Shape | null = null
        for (const o of band) {
          if (o === T) continue
          if (o.y + o.height <= T.y && (!TT || o.y + o.height > TT.y + TT.height)) TT = o
        }
        if (TT) {
          const g = T.y - (TT.y + TT.height)
          const a = shape.y - (T.y + T.height)
          if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeY) <= tol)) {
            out.push({ x1: T.x + T.width / 2, y1: TT.y + TT.height, x2: T.x + T.width / 2, y2: T.y, value: g })
            out.push({ x1: midX, y1: T.y + T.height, x2: midX, y2: shape.y, value: a })
          }
        }
      } else if (B) {
        // 外侧等间距（拖拽节点在上）：把 B 下方的既有间距一并画出
        let BB: Shape | null = null
        for (const o of band) {
          if (o === B) continue
          if (o.y >= B.y + B.height && (!BB || o.y < BB.y)) BB = o
        }
        if (BB) {
          const g = BB.y - (B.y + B.height)
          const a = B.y - (shape.y + shape.height)
          if (g > 0 && a > 0 && (Math.abs(a - g) <= tol || Math.abs(a - modeY) <= tol)) {
            out.push({ x1: midX, y1: shape.y + shape.height, x2: midX, y2: B.y, value: a })
            out.push({ x1: B.x + B.width / 2, y1: B.y + B.height, x2: B.x + B.width / 2, y2: BB.y, value: g })
          }
        }
      }
    }
    return { guides: out, snappedX, snappedY }
  }

  // 按手柄方位应用缩放：对侧边/对角锚定，尺寸钳制到 MIN_SIZE
  private applyResize(s: Extract<Session, { kind: 'resize' }>, dx: number, dy: number) {
    const o = s.origin
    let { x, y, width: w, height: h } = o
    if (s.handle.includes('e')) w = Math.max(MIN_SIZE, o.width + dx)
    if (s.handle.includes('s')) h = Math.max(MIN_SIZE, o.height + dy)
    if (s.handle.includes('w')) {
      w = Math.max(MIN_SIZE, o.width - dx)
      x = o.x + o.width - w
    }
    if (s.handle.includes('n')) {
      h = Math.max(MIN_SIZE, o.height - dy)
      y = o.y + o.height - h
    }
    s.shape.x = x
    s.shape.y = y
    s.shape.width = w
    s.shape.height = h
    s.shape.layout()
  }

  // 多选组合缩放：以组合 bounds 的对侧为锚点，按整体缩放比等比变换每个成员
  // 的位置与尺寸；按组内最小形状钳制缩放比，保证任何成员不低于 MIN_SIZE
  private applyGroupResize(s: Extract<Session, { kind: 'group-resize' }>, dx: number, dy: number) {
    const o = s.origin
    let sx = 1
    let sy = 1
    if (s.handle.includes('e')) sx = (o.width + dx) / o.width
    if (s.handle.includes('w')) sx = (o.width - dx) / o.width
    if (s.handle.includes('s')) sy = (o.height + dy) / o.height
    if (s.handle.includes('n')) sy = (o.height - dy) / o.height
    const minW = Math.min(...s.origins.map(g => g.width))
    const minH = Math.min(...s.origins.map(g => g.height))
    if (s.handle.length === 2) {
      // 角手柄：锁定比例等比缩放，取相对变化更大的轴作为统一缩放比
      // （边手柄仅单轴生效，仍可自由改变比例）
      const r = Math.max(
        Math.abs(sx) >= Math.abs(sy) ? sx : sy,
        MIN_SIZE / minW,
        MIN_SIZE / minH,
      )
      sx = r
      sy = r
    } else {
      sx = Math.max(sx, MIN_SIZE / minW)
      sy = Math.max(sy, MIN_SIZE / minH)
    }
    // 锚点：拖拽方向的对侧边/角固定不动
    const ax = s.handle.includes('w') ? o.x + o.width : o.x
    const ay = s.handle.includes('n') ? o.y + o.height : o.y
    for (const g of s.origins) {
      g.shape.x = ax + (g.x - ax) * sx
      g.shape.y = ay + (g.y - ay) * sy
      g.shape.width = g.width * sx
      g.shape.height = g.height * sy
      g.shape.layout()
    }
  }

  private onUp(e: MouseEvent) {
    const s = this.session
    if (!s) return
    this.session = null
    this.options.canvas.style.cursor = ''
    if (s.kind === 'move') {
      this.guides = null
      this.app.render() // 清除参考线后立即重绘，否则画面残留拖拽时最后一帧
      if (s.moved) this.onChange?.('move')
      else if (s.group) this.select(s.shape) // 组内单击未拖动：塌缩为单选该形状
    } else if (s.kind === 'resize') {
      const o = s.origin
      if (s.shape.x !== o.x || s.shape.y !== o.y || s.shape.width !== o.width || s.shape.height !== o.height) {
        this.onChange?.('resize')
      }
    } else if (s.kind === 'group-resize') {
      // 有成员相对初始状态发生变化时通知
      if (s.origins.some(g => g.shape.x !== g.x || g.shape.y !== g.y || g.shape.width !== g.width || g.shape.height !== g.height)) {
        this.onChange?.('resize')
      }
    } else if (s.kind === 'blank') {
      // 框选落定：与矩形相交的形状进入多选；仅一个时退化为普通单选；
      // 落空（或未拖出矩形）时清除选中——render 覆盖残留的框选画面
      if (s.rect) {
        const hits = this.marqueeHits(s.rect)
        if (hits.length === 1) {
          this.select(hits[0])
        } else if (hits.length > 1) {
          this.multi = hits
          this.app.render()
        } else {
          this.select(null) // 落空清除选中；select 有无变化守卫可能跳过重绘
          this.app.render() // 故显式渲染，覆盖残留的框选画面
        }
      } else {
        this.app.render()
      }
    } else if (s.kind === 'edge-move') {
      // 端点重接结束：退出拖拽态；吸附目标按其端口重接（任意节点，含本连线
      // 两端节点）；未吸附时按落点命中节点重接（主导方向自动选边），纯点击
      // 落回被拖端原节点时视为无操作，连线保持原状
      s.edge.dragWhich = null
      const target = this.linkTarget
      const snap = this.linkSnap
      this.linkTarget = null
      this.linkSnap = null
      const hit = target ?? this.hitShape(this.toWorld(e))
      const cur = s.which === 'from' ? s.edge.fromNode : s.edge.toNode
      if (hit && !(hit === cur && !target)) {
        s.edge.reattachEnd(s.which, hit, target && snap ? snap : undefined)
        this.onChange?.('reconnect')
      }
      this.app.render()
    } else {
      // 连线拖拽结束：移除预览；吸附中的目标按其端口固定创建连线，否则按落点命中建边
      // （源形状在拖拽开始时已取消激活）
      this.removeTop(s.preview)
      const target = this.linkTarget
      const snap = this.linkSnap
      this.linkTarget = null
      this.linkSnap = null
      if (target && snap) {
        this.addEdgeBetween(s.source, target, true, { from: s.sourceDir, to: snap })
      } else {
        const hit = this.hitShape(this.toWorld(e))
        if (hit && hit !== s.source) this.addEdgeBetween(s.source, hit, true)
      }
      this.app.render()
    }
  }

  private onDblClick(e: MouseEvent) {
    const hit = this.hitShape(this.toWorld(e))
    if (hit) this.startEdit(hit)
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Delete' && e.key !== 'Backspace') return
    // 覆盖层持有焦点时按键属于输入，交由编辑器处理
    if (this.editing || this.editor.hasFocus()) return
    if (!this.selection && !this.multi.length) return
    e.preventDefault()
    this.deleteSelected()
  }
  //#endregion
}
