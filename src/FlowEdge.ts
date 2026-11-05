import { Edge } from '@silker/plugin-edge'
import type { EdgePoint } from '@silker/plugin-edge'
import type { Shape } from './Shape'

// 端口方向（四边中点）
export type PortDir = 'top' | 'right' | 'bottom' | 'left'

// 连线端口提示：指定两端的对接端口（拖拽连线吸附创建时使用）；
// 未指定的端在创建时按两端中心连线的主导方向自动选边并冻结
export interface FlowEdgeHints {
  from?: PortDir
  to?: PortDir
}

// 流程图连线：横平竖直的正交折线，拐点用小圆角过渡，末端绘制实心箭头。
// 路由规则：连线从源节点四向端口（上/右/下/左边中点）之一引出，接入目标节点四向端口之一；
// 两端端口在创建时固定（显式指定或按当时主导方向自动选边），此后节点移动/缩放
// 只改变连线途经的折点位置，不再改变出入口端口。
// 出口/入口段锁定端口方向：从端口沿外法向先引出一段固定长度直段
// （下方出口第一段必为向下竖线，上方入口最后一段必为竖线），再正交连接两端。
// 中段形态由两端端口方向组合与相对位置决定，均保证首段沿出口、末段沿入口且无折返：
// 同轴顺畅（右出左入等）为三段 Z 形；同侧出入或目标偏居一侧时取三段 L 形
// （如右出右入为右、上/下、左）；仅面对面且目标在源后方时走五段绕行
// （如下出上入但目标在源上方：下、右、上、右、下）；横竖混搭为 L 形，
// 转折顺序按出口延伸与进入衔接自动选择。
export class FlowEdge extends Edge {
  fromNode: Shape
  toNode: Shape
  // 两端固定端口方向（创建时冻结，节点移动不再改变）
  fromDir: PortDir
  toDir: PortDir
  // 选中态标志（由 FlowChart 维护；选中视觉——线色高亮——由渲染处理）
  selected = false
  // 悬浮态标志：浅蓝色高亮（优先级低于选中）
  hovered = false
  // 最近一次路由的折线点（渲染时更新，供命中检测使用）
  points: EdgePoint[] = []

  constructor(from: Shape, to: Shape, hints: FlowEdgeHints = {}) {
    super({ color: '#94a3b8', lineWidth: 2, cornerRadius: 8 })
    this.fromNode = from
    this.toNode = to
    // 创建时冻结两端端口：未显式指定的端按当前中心连线主导方向选边，
    // 之后节点位置变化只影响折线路径，不再改变出入口
    const sc = from.center()
    const tc = to.center()
    const dx = tc.x - sc.x
    const dy = tc.y - sc.y
    const horizontal = Math.abs(dx) >= Math.abs(dy)
    this.fromDir = hints.from ?? (horizontal ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top'))
    this.toDir = hints.to ?? (horizontal ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom'))
  }

  // 重接一端：更换该端节点并重选端口方向（dir 缺省时按与另一端的主导方向自动选边）
  reattachEnd(which: 'from' | 'to', node: Shape, dir?: PortDir) {
    const other = which === 'from' ? this.toNode : this.fromNode
    const oc = other.center()
    const nc = node.center()
    // 主导方向以“源→目标”为正方向计算，which 为 from 时源是 node、目标是 other，反之亦然
    const dx = which === 'from' ? oc.x - nc.x : nc.x - oc.x
    const dy = which === 'from' ? oc.y - nc.y : nc.y - oc.y
    const horizontal = Math.abs(dx) >= Math.abs(dy)
    if (which === 'from') {
      this.fromNode = node
      this.fromDir = dir ?? (horizontal ? (dx >= 0 ? 'right' : 'left') : (dy >= 0 ? 'bottom' : 'top'))
    } else {
      this.toNode = node
      this.toDir = dir ?? (horizontal ? (dx >= 0 ? 'left' : 'right') : (dy >= 0 ? 'top' : 'bottom'))
    }
  }

  // 渲染前重算路由（也刷新 from/to 供箭头取末端方向）
  update() {
    const pts = this.route()
    this.points = pts
    this.from = pts[0]
    this.to = pts[pts.length - 1]
  }

  render(ctx: CanvasRenderingContext2D) {
    this.update()
    const pts = this.route()
    // 拖拽端点期间不显示高亮，保持常态线色；选中 > 悬浮 > 默认
    const color = this.selected && !this.dragWhich
      ? SELECT_COLOR
      : this.hovered && !this.selected
        ? HOVER_COLOR
        : this.color
    // 线体末端回缩一个箭头长度再绘制，避免线头从三角箭头下方露出
    renderOrthoPolyline(ctx, trimEdgeEnd(pts), color, this.lineWidth, this.cornerRadius)
    drawEdgeArrow(ctx, pts, color)
  }

  // 命中检测：点到折线各段的最近距离是否在容差内（世界坐标）
  hitPoint(p: { x: number; y: number }, tolerance: number): boolean {
    const pts = this.points
    if (pts.length < 2) return false
    for (let i = 1; i < pts.length; i++) {
      if (distSeg(p, pts[i - 1], pts[i]) <= tolerance) return true
    }
    return false
  }

  // 端点拖拽态：拖拽中的端以 dragPoint（光标或吸附端口）替代原端口参与路由，
  // dragDir 为该端的虚拟方向（随光标位置变化）；null 表示未在拖拽
  dragWhich: 'from' | 'to' | null = null
  dragPoint: EdgePoint = { x: 0, y: 0 }
  dragDir: PortDir = 'top'

  // 生成正交路径点（相邻重复点已剔除）。首段沿源端口外法向、末段沿目标端口
  // 外法向反向进入，方向锁定；中段按方向组合与相对位置选 Z 形（顺畅）或
  // L 形 / S 形（绕行，无折返）
  private route(): EdgePoint[] {
    if (this.dragWhich === 'from') {
      return FlowEdge.routeBetween(this.dragPoint, this.dragDir, this.toNode.portAt(this.toDir), this.toDir)
    }
    if (this.dragWhich === 'to') {
      return FlowEdge.routeBetween(this.fromNode.portAt(this.fromDir), this.fromDir, this.dragPoint, this.dragDir)
    }
    return FlowEdge.routeBetween(this.fromNode.portAt(this.fromDir), this.fromDir, this.toNode.portAt(this.toDir), this.toDir)
  }

  // 两端口间的正交路由：实例连线与拖拽预览共用。
  // 首段沿 fromDir 外法向引出 stub、末段沿 toDir 外法向反向进入，方向锁定
  static routeBetween(s: EdgePoint, fromDir: PortDir, t: EdgePoint, toDir: PortDir): EdgePoint[] {
    const fv = PORT_DIR_VEC[fromDir]
    const tv = PORT_DIR_VEC[toDir]
    // 沿外法向引出固定长度直段，保证出口/入口段方向始终与端口方向一致
    const s2 = { x: s.x + fv.x * PORT_STUB, y: s.y + fv.y * PORT_STUB }
    const t2 = { x: t.x + tv.x * PORT_STUB, y: t.y + tv.y * PORT_STUB }
    const fh = fv.x !== 0
    const th = tv.x !== 0
    if (fh && th) {
      // 横出横入：右→左 / 左→右且整体前进方向一致时走竖向中转 Z 形；
      // 否则优先三段 L 形（先沿出口方向横行再竖折，或先竖折再沿进入方向横行），
      // 两侧 L 均不成立（如右出左入但目标在源后方）才走横向中转的五段绕行
      const d = t2.x - s2.x
      if (d * fv.x >= 0 && d * -tv.x >= 0) {
        const mx = (s2.x + t2.x) / 2
        return dedupe([s, s2, { x: mx, y: s2.y }, { x: mx, y: t2.y }, t2, t])
      }
      if (d * fv.x >= 0) {
        // 先横后竖：沿出口方向横行至目标 x，竖行对齐后水平进入（如右出右入：右、上/下、左）
        return dedupe([s, s2, { x: t2.x, y: s2.y }, t2, t])
      }
      if (d * -tv.x >= 0) {
        // 先竖后横：竖行至进入高度，再沿进入方向水平进入
        return dedupe([s, s2, { x: s2.x, y: t2.y }, t2, t])
      }
      const my = (s2.y + t2.y) / 2
      return dedupe([s, s2, { x: s2.x, y: my }, { x: t2.x, y: my }, t2, t])
    }
    if (!fh && !th) {
      // 竖出竖入：下→上 / 上→下且整体前进方向一致时走横向中转 Z 形；
      // 否则优先三段 L 形，均不成立（如下出上入但目标在源上方）才走竖向中转的
      // 五段 S 形绕行（下、右、上、右、下），不产生折返锯齿
      const d = t2.y - s2.y
      if (d * fv.y >= 0 && d * -tv.y >= 0) {
        const my = (s2.y + t2.y) / 2
        return dedupe([s, s2, { x: s2.x, y: my }, { x: t2.x, y: my }, t2, t])
      }
      if (d * fv.y >= 0) {
        // 先竖后横：沿出口方向竖行至目标 y，横行对齐后竖直进入
        return dedupe([s, s2, { x: s2.x, y: t2.y }, t2, t])
      }
      if (d * -tv.y >= 0) {
        // 先横后竖：横行至进入侧 x，再沿进入方向竖直进入
        return dedupe([s, s2, { x: t2.x, y: s2.y }, t2, t])
      }
      const mx = (s2.x + t2.x) / 2
      return dedupe([s, s2, { x: mx, y: s2.y }, { x: mx, y: t2.y }, t2, t])
    }
    // 横竖混搭：L 形，转折顺序需同时满足——折线延续出口 stub 方向、
    // 末段与进入方向同向衔接；一侧不满足时换另一侧（另一侧恒无折返），
    // 例如下出左入但入口位高于出口位时为：下、右、上、右
    if (fh) {
      const ok = (t2.x - s2.x) * fv.x >= 0 && (t2.y - s2.y) * -tv.y >= 0
      return dedupe(ok
        ? [s, s2, { x: t2.x, y: s2.y }, t2, t]   // 先横后竖
        : [s, s2, { x: s2.x, y: t2.y }, t2, t])  // 先竖后横（恒安全）
    }
    const ok = (t2.y - s2.y) * fv.y >= 0 && (t2.x - s2.x) * -tv.x >= 0
    return dedupe(ok
      ? [s, s2, { x: s2.x, y: t2.y }, t2, t]     // 先竖后横
      : [s, s2, { x: t2.x, y: s2.y }, t2, t])    // 先横后竖（恒安全）
  }
}

// 正交折线渲染：中间每个拐点用 arcTo 做四分之一圆弧（半径 cornerRadius，
// 自动收缩到相邻边长一半以内），其余为水平/垂直直线段
function renderOrthoPolyline(ctx: CanvasRenderingContext2D, pts: EdgePoint[], color: string, lineWidth: number, cornerRadius: number) {
  const r = cornerRadius
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.beginPath()
  ctx.moveTo(pts[0].x, pts[0].y)
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const d1 = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const d2 = Math.hypot(next.x - cur.x, next.y - cur.y)
    if (d1 === 0 || d2 === 0) {
      ctx.lineTo(cur.x, cur.y)
      continue
    }
    const rr = Math.min(r, d1 / 2, d2 / 2)
    // 直线走到圆弧起点（沿 cur→prev 方向回退 rr），再经拐点圆弧切向接入下一段
    ctx.lineTo(cur.x + ((prev.x - cur.x) / d1) * rr, cur.y + ((prev.y - cur.y) / d1) * rr)
    ctx.arcTo(cur.x, cur.y, next.x, next.y, rr)
  }
  const last = pts[pts.length - 1]
  ctx.lineTo(last.x, last.y)
  ctx.stroke()
}

// 实心三角箭头：平移到终点并按最后一段直线方向旋转后绘制
function drawEdgeArrow(ctx: CanvasRenderingContext2D, pts: EdgePoint[], color: string) {
  const to = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  if (prev.x === to.x && prev.y === to.y) return
  ctx.save()
  ctx.translate(to.x, to.y)
  ctx.rotate(Math.atan2(to.y - prev.y, to.x - prev.x))
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(-ARROW_LEN, 4)
  ctx.lineTo(-ARROW_LEN, -4)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

// 拖拽预览渲染：与正式连线同款式的正交折线（末端回缩）+ 箭头
export function renderEdgePreview(ctx: CanvasRenderingContext2D, pts: EdgePoint[], color = '#3b82f6') {
  renderOrthoPolyline(ctx, trimEdgeEnd(pts), color, 2, 8)
  drawEdgeArrow(ctx, pts, color)
}

// 选中态线色（与选中框同色系）
const SELECT_COLOR = '#3b82f6'

// 悬浮态线色（更浅的蓝，比选中淡、比默认亮）
const HOVER_COLOR = '#93c5fd'

// 箭头长度（三角沿行进方向的底边到尖端距离），线体末端按此回缩
const ARROW_LEN = 10

// 端口外法向单位向量（top 向上、right 向右、bottom 向下、left 向左）
export const PORT_DIR_VEC: Record<PortDir, EdgePoint> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

// 端口方向的相反方向
export const OPPOSITE_DIR: Record<PortDir, PortDir> = {
  top: 'bottom',
  bottom: 'top',
  left: 'right',
  right: 'left',
}

// 返回末端沿最后一段回缩 ARROW_LEN 的折线副本（回缩量不超过该段长度）
function trimEdgeEnd(pts: EdgePoint[]): EdgePoint[] {
  const n = pts.length
  if (n < 2) return pts
  const to = pts[n - 1]
  const prev = pts[n - 2]
  const dx = to.x - prev.x
  const dy = to.y - prev.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return pts
  const back = Math.min(ARROW_LEN, len)
  const out = pts.slice()
  out[n - 1] = { x: to.x - (dx / len) * back, y: to.y - (dy / len) * back }
  return out
}

// 出口/入口直段长度（世界坐标）：端口沿外法向引出的锁定方向段
const PORT_STUB = 24

// 点到线段的最短距离
function distSeg(p: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

// 剔除相邻重复点（锚点恰好落在转折中点上时会出现），避免零长度段干扰圆弧
function dedupe(pts: EdgePoint[]): EdgePoint[] {
  const out: EdgePoint[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || q.x !== p.x || q.y !== p.y) out.push(p)
  }
  return out
}
