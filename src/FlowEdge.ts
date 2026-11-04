import { Edge } from '@silker/plugin-edge'
import type { EdgePoint } from '@silker/plugin-edge'
import type { Shape } from './Shape'

// 端口方向（四边中点）
export type PortDir = 'top' | 'right' | 'bottom' | 'left'

// 连线端口提示：创建时固定两端的对接端口（拖拽连线吸附创建时使用）；
// 未指定时按两端中心连线的主导方向自动选边
export interface FlowEdgeHints {
  from?: PortDir
  to?: PortDir
}

// 流程图连线：横平竖直的正交折线，拐点用小圆角过渡，末端绘制实心箭头。
// 路由规则：按两端形状中心连线的主导方向选择出边/入边——
// 水平主导从源右/左边中点引出，经 x 中点垂直转折接入目标左/右边中点；
// 垂直主导从源下/上边中点引出，经 y 中点水平转折接入目标下/上边中点。
// 节点移动/缩放后每帧重算，连线自动跟随。
export class FlowEdge extends Edge {
  fromNode: Shape
  toNode: Shape
  // 固定端口提示（null 表示该端按主导方向自动选边）
  fromDir: PortDir | null
  toDir: PortDir | null

  constructor(from: Shape, to: Shape, hints: FlowEdgeHints = {}) {
    super({ color: '#94a3b8', lineWidth: 2, cornerRadius: 8 })
    this.fromNode = from
    this.toNode = to
    this.fromDir = hints.from ?? null
    this.toDir = hints.to ?? null
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

  // 生成正交路径点（含起止锚点与 1 个转折中点，相邻重复点已剔除）。
  // 有端口提示时按固定端口路由，否则按中心连线主导方向自动选边
  private route(): EdgePoint[] {
    if (this.fromDir && this.toDir) {
      const s = this.fromNode.portAt(this.fromDir)
      const t = this.toNode.portAt(this.toDir)
      const horiz = (d: PortDir) => d === 'left' || d === 'right'
      if (horiz(this.fromDir) && horiz(this.toDir)) {
        // 横出横入：经 x 中点垂直转折的 Z 形
        const mx = (s.x + t.x) / 2
        return dedupe([s, { x: mx, y: s.y }, { x: mx, y: t.y }, t])
      }
      if (!horiz(this.fromDir) && !horiz(this.toDir)) {
        // 竖出竖入：经 y 中点水平转折的 Z 形
        const my = (s.y + t.y) / 2
        return dedupe([s, { x: s.x, y: my }, { x: t.x, y: my }, t])
      }
      // 横出竖入 / 竖出横入：L 形，转折点在两段正交方向线的交点
      return dedupe(horiz(this.fromDir) ? [s, { x: t.x, y: s.y }, t] : [s, { x: s.x, y: t.y }, t])
    }
    const sc = this.fromNode.center()
    const tc = this.toNode.center()
    const dx = tc.x - sc.x
    const dy = tc.y - sc.y
    if (Math.abs(dx) >= Math.abs(dy)) {
      const s = this.fromNode.portAt(dx >= 0 ? 'right' : 'left')
      const t = this.toNode.portAt(dx >= 0 ? 'left' : 'right')
      const mx = (s.x + t.x) / 2
      return dedupe([s, { x: mx, y: s.y }, { x: mx, y: t.y }, t])
    }
    const s = this.fromNode.portAt(dy >= 0 ? 'bottom' : 'top')
    const t = this.toNode.portAt(dy >= 0 ? 'top' : 'bottom')
    const my = (s.y + t.y) / 2
    return dedupe([s, { x: s.x, y: my }, { x: t.x, y: my }, t])
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

// 剔除相邻重复点（锚点恰好落在转折中点上时会出现），避免零长度段干扰圆弧
function dedupe(pts: EdgePoint[]): EdgePoint[] {
  const out: EdgePoint[] = []
  for (const p of pts) {
    const q = out[out.length - 1]
    if (!q || q.x !== p.x || q.y !== p.y) out.push(p)
  }
  return out
}
