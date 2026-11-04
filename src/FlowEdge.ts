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
// 中段形态由两端端口方向组合决定：同轴且顺畅（下出上入 / 上出下入、右出左入 / 左出右入）
// 为三段 Z 形；同轴绕行（同侧出入或目标位于反侧，如下出上入但入口位高于出口位）
// 为五段 S 形——先下、再右、再上、再右、再下，不产生折返锯齿；
// 横竖混搭为 L 形直角转折，按进入方向选择先横后竖或先竖后横。
export class FlowEdge extends Edge {
  fromNode: Shape
  toNode: Shape
  // 两端固定端口方向（创建时冻结，节点移动不再改变）
  fromDir: PortDir
  toDir: PortDir

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

  // 渲染前重算路由（也刷新 from/to 供箭头取末端方向）
  update() {
    const pts = this.route()
    this.from = pts[0]
    this.to = pts[pts.length - 1]
  }

  render(ctx: CanvasRenderingContext2D) {
    this.update()
    const pts = this.route()
    this.renderOrtho(ctx, pts)
    this.drawArrow(ctx, pts)
  }

  // 生成正交路径点（相邻重复点已剔除）。
  // 首段沿源端口外法向、末段沿目标端口外法向反向进入，方向锁定；
  // 中段按方向组合与相对位置选 Z 形（顺畅）或 S 形（绕行，无折返）
  private route(): EdgePoint[] {
    const s = this.fromNode.portAt(this.fromDir)
    const t = this.toNode.portAt(this.toDir)
    const fv = PORT_DIR_VEC[this.fromDir]
    const tv = PORT_DIR_VEC[this.toDir]
    // 沿外法向引出固定长度直段，保证出口/入口段方向始终与端口方向一致
    const s2 = { x: s.x + fv.x * PORT_STUB, y: s.y + fv.y * PORT_STUB }
    const t2 = { x: t.x + tv.x * PORT_STUB, y: t.y + tv.y * PORT_STUB }
    const fh = fv.x !== 0
    const th = tv.x !== 0
    if (fh && th) {
      // 横出横入：右→左 / 左→右 且整体前进方向一致时走竖向中转 Z 形；
      // 否则（同侧出入或目标在反侧）走横向中转的 S 形绕行，避免折返
      const d = t2.x - s2.x
      if (d * fv.x >= 0 && d * -tv.x >= 0) {
        const mx = (s2.x + t2.x) / 2
        return dedupe([s, s2, { x: mx, y: s2.y }, { x: mx, y: t2.y }, t2, t])
      }
      const my = (s2.y + t2.y) / 2
      return dedupe([s, s2, { x: s2.x, y: my }, { x: t2.x, y: my }, t2, t])
    }
    if (!fh && !th) {
      // 竖出竖入：下→上 / 上→下且整体前进方向一致时走横向中转 Z 形；
      // 否则（如下出上入但入口位高于出口位）走竖向中转 S 形：下、右、上、右、下
      const d = t2.y - s2.y
      if (d * fv.y >= 0 && d * -tv.y >= 0) {
        const my = (s2.y + t2.y) / 2
        return dedupe([s, s2, { x: s2.x, y: my }, { x: t2.x, y: my }, t2, t])
      }
      const mx = (s2.x + t2.x) / 2
      return dedupe([s, s2, { x: mx, y: s2.y }, { x: mx, y: t2.y }, t2, t])
    }
    // 横出竖入 / 竖出横入：L 形，按末段进入方向选择转折顺序，避免与进入段折返
    if (fh) {
      const d = t2.y - s2.y
      return dedupe(d * -tv.y >= 0
        ? [s, s2, { x: t2.x, y: s2.y }, t2, t]   // 先横后竖：水平段与进入段同向衔接
        : [s, s2, { x: s2.x, y: t2.y }, t2, t])  // 先竖后横
    }
    const d = t2.x - s2.x
    return dedupe(d * -tv.x >= 0
      ? [s, s2, { x: s2.x, y: t2.y }, t2, t]     // 先竖后横：竖直段与进入段同向衔接
      : [s, s2, { x: t2.x, y: s2.y }, t2, t])    // 先横后竖
  }

  // 正交折线渲染：中间每个拐点用 arcTo 做四分之一圆弧（半径 cornerRadius，
  // 自动收缩到相邻边长一半以内），其余为水平/垂直直线段
  private renderOrtho(ctx: CanvasRenderingContext2D, pts: EdgePoint[]) {
    const r = this.cornerRadius
    ctx.strokeStyle = this.color
    ctx.lineWidth = this.lineWidth
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
  private drawArrow(ctx: CanvasRenderingContext2D, pts: EdgePoint[]) {
    const to = pts[pts.length - 1]
    const prev = pts[pts.length - 2]
    if (prev.x === to.x && prev.y === to.y) return
    ctx.save()
    ctx.translate(to.x, to.y)
    ctx.rotate(Math.atan2(to.y - prev.y, to.x - prev.x))
    ctx.beginPath()
    ctx.moveTo(0, 0)
    ctx.lineTo(-10, 4)
    ctx.lineTo(-10, -4)
    ctx.closePath()
    ctx.fillStyle = this.color
    ctx.fill()
    ctx.restore()
  }
}

// 端口外法向单位向量（top 向上、right 向右、bottom 向下、left 向左）
const PORT_DIR_VEC: Record<PortDir, EdgePoint> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}

// 出口/入口直段长度（世界坐标）：端口沿外法向引出的锁定方向段
const PORT_STUB = 24

// 剔除相邻重复点（锚点恰好落在转折中点上时会出现），避免零长度段干扰圆弧
function dedupe(pts: EdgePoint[]): EdgePoint[] {
  const out: EdgePoint[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || q.x !== p.x || q.y !== p.y) out.push(p)
  }
  return out
}
