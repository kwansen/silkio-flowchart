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

// 缩放手柄方位：四角 + 四边
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

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
  }) {
    super()
  }

  render(ctx: CanvasRenderingContext2D) {
    const { shape, scale, ports, edgeHandles, link } = this.getState()
    const k = 1 / scale
    ctx.save()
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
    // 激活连线的首尾端点手柄（样式同四角手柄）
    if (edgeHandles.length) {
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.5 * k
      const s = HANDLE_SIZE * k
      for (const h of edgeHandles) {
        ctx.beginPath()
        ctx.rect(h.x - s / 2, h.y - s / 2, s, s)
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.stroke()
      }
    }
    // 连线拖拽目标：浮出对接手柄，吸附中的手柄实心高亮
    if (link) this.drawPorts(ctx, link.ports, k, link.active)
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

// 交互会话：节点拖拽移动 / 拖拽缩放 / 空白按下（抬起时取消选中）/ 端口拖拽连线 / 连线端点重接
type Session =
  | { kind: 'move'; shape: Shape; start: { x: number; y: number }; origin: { x: number; y: number }; moved: boolean }
  | { kind: 'resize'; shape: Shape; handle: ResizeHandle; start: { x: number; y: number }; origin: { x: number; y: number; width: number; height: number } }
  | { kind: 'blank'; start: { x: number; y: number } }
  | { kind: 'link'; source: Shape; sourceDir: PortDir; preview: LinkPreview }
  | { kind: 'edge-move'; edge: FlowEdge; which: 'from' | 'to'; preview: LinkPreview }

// 流程图场景门面：组装视口 / 文本编辑插件，持有形状与连线模型，
// 内置交互：点选、拖拽移动、双击编辑文字、端口拖拽连线、Delete 删除
export class FlowChart {
  app: App
  private editor: TextEditorCapability
  private shapes = new Map<string, Shape>()
  private edges: FlowEdge[] = []
  // 当前选中：形状或连线
  private selection: Shape | FlowEdge | null = null
  private editing: Shape | null = null
  private session: Session | null = null
  private overlay: SelectionOverlay
  // 连线拖拽吸附状态：接近中的目标节点与吸附中的端口方向
  private linkTarget: Shape | null = null
  private linkSnap: PortDir | null = null
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
        // 激活连线的首尾端点手柄
        edgeHandles: selEdge && selEdge.points.length >= 2
          ? [selEdge.points[0], selEdge.points[selEdge.points.length - 1]]
          : [],
        link: this.linkTarget
          ? {
              ports: dirs.map(dir => this.portPos(this.linkTarget!, dir, scale)),
              active: this.linkSnap ? this.portPos(this.linkTarget, this.linkSnap, scale) : null,
            }
          : null,
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

  // 删除当前选中（形状连同其关联连线，或单条连线）
  deleteSelected() {
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
    if (this.selection === sel) return
    if (this.selection) this.selection.selected = false
    this.selection = sel
    if (sel) {
      sel.selected = true
      // 激活的连线提到连线层最上再渲染，避免激活样式被其他连线覆盖
      if (sel instanceof FlowEdge) this.raiseEdgeTop(sel)
    }
    this.app.render()
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

  // 四角手柄命中（屏幕像素半径换算到世界坐标）
  private cornerHit(shape: Shape, p: { x: number; y: number }, scale: number): 'nw' | 'ne' | 'se' | 'sw' | null {
    const r = HANDLE_HIT / scale
    const { x, y, width: w, height: h } = shape
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
  private edgeHit(shape: Shape, p: { x: number; y: number }, scale: number): 'n' | 'e' | 's' | 'w' | null {
    const tol = EDGE_TOLERANCE / scale
    const nearCorner = HANDLE_HIT / scale + 2
    const nearPort = PORT_HIT_RADIUS
    const { x, y, width: w, height: h } = shape
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
        const preview = new LinkPreview()
        const pts = edge.points
        // 固定端（另一端）作为预览出口，其端口与方向决定预览路由
        preview.from = which === 'from' ? pts[pts.length - 1] : pts[0]
        preview.fromDir = which === 'from' ? edge.toDir : edge.fromDir
        preview.to = p
        preview.toDir = this.previewToDir(preview.fromDir, preview.from, p)
        const idx = this.app.children.findIndex(n => n instanceof Shape)
        if (idx === -1) this.app.children.push(preview)
        else this.app.children.splice(idx, 0, preview)
        this.session = { kind: 'edge-move', edge, which, preview }
        this.options.canvas.style.cursor = 'crosshair'
        this.app.render()
        return
      }
    }
    const hit = this.hitShape(p)
    if (hit) {
      this.select(hit)
      this.session = { kind: 'move', shape: hit, start: p, origin: { x: hit.x, y: hit.y }, moved: false }
      return
    }
    // 形状未命中时尝试命中连线（形状层在上，优先选中形状）
    const hitLine = this.hitEdge(p, scale)
    if (hitLine) {
      this.select(hitLine)
      this.app.render()
      return
    }
    this.session = { kind: 'blank', start: p }
  }

  private onMove(e: MouseEvent) {
    const s = this.session
    // 无会话时做悬停反馈：缩放手柄/边线/端口/形状体/连线分别给对应光标
    if (!s) {
      const p = this.toWorld(e)
      const scale = this.app.renderer.viewport.scale
      let cursor = this.selShape ? this.hoverCursor(this.selShape, p, scale) : null
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
      this.app.render()
    } else if (s.kind === 'resize') {
      this.applyResize(s, p.x - s.start.x, p.y - s.start.y)
      this.app.render()
    } else if (s.kind === 'link') {
      this.updateLinkTarget(p, [s.source])
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
      // 重接目标排除本连线两端节点（不支持自环）
      this.updateLinkTarget(p, [s.edge.fromNode, s.edge.toNode])
      if (this.linkTarget && this.linkSnap) {
        s.preview.to = this.linkTarget.portAt(this.linkSnap)
        s.preview.toDir = this.linkSnap
      } else {
        s.preview.to = p
        s.preview.toDir = this.previewToDir(s.preview.fromDir, s.preview.from, p)
      }
      this.app.render()
    }
  }

  // 自由拖拽时预览的虚拟进入方向：与出口方向同轴，按光标相对出口端口的位置
  // 选边——光标在出口外法向一侧时同侧进入（如从下方出来、光标在下方则按
  // 从下面进入），越过出口端口时对侧进入
  private previewToDir(exitDir: PortDir, exitPort: { x: number; y: number }, p: { x: number; y: number }): PortDir {
    const v = PORT_DIR_VEC[exitDir]
    const proj = (p.x - exitPort.x) * v.x + (p.y - exitPort.y) * v.y
    return proj > 0 ? exitDir : OPPOSITE_DIR[exitDir]
  }

  // 连线拖拽中更新吸附目标：光标进入某节点包围盒外扩 LINK_SNAP_MARGIN 范围时，
  // 该节点成为目标（浮出对接手柄），并吸附到距光标最近的端口；exclude 为排除的节点
  private updateLinkTarget(p: { x: number; y: number }, exclude: Shape[]) {
    const scale = this.app.renderer.viewport.scale
    const m = LINK_SNAP_MARGIN / scale
    this.linkTarget = null
    this.linkSnap = null
    for (const shape of this.shapes.values()) {
      if (exclude.includes(shape)) continue
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

  private onUp(e: MouseEvent) {
    const s = this.session
    if (!s) return
    this.session = null
    this.options.canvas.style.cursor = ''
    if (s.kind === 'move') {
      if (s.moved) this.onChange?.('move')
    } else if (s.kind === 'resize') {
      const o = s.origin
      if (s.shape.x !== o.x || s.shape.y !== o.y || s.shape.width !== o.width || s.shape.height !== o.height) {
        this.onChange?.('resize')
      }
    } else if (s.kind === 'blank') {
      this.select(null)
    } else if (s.kind === 'edge-move') {
      // 端点重接结束：移除预览；吸附目标按其端口重接，否则按落点命中节点重接（主导方向自动选边）
      this.removeTop(s.preview)
      const target = this.linkTarget
      const snap = this.linkSnap
      this.linkTarget = null
      this.linkSnap = null
      const hit = target ?? this.hitShape(this.toWorld(e))
      if (hit && hit !== s.edge.fromNode && hit !== s.edge.toNode) {
        s.edge.reattachEnd(s.which, hit, target && snap ? snap : undefined)
        this.onChange?.('reconnect')
      }
      this.app.render()
    } else {
      // 连线拖拽结束：移除预览；吸附中的目标按其端口固定创建连线，否则按落点命中建边
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
    if (!this.selection) return
    e.preventDefault()
    this.deleteSelected()
  }
  //#endregion
}
