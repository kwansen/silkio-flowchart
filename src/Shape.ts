import { Node, Text } from '@silker/core'
import type { NodeOptions } from '@silker/core'
import type { ShapeKind } from './data'

// 形状样式：边界绘制 + 文本外观
export interface ShapeStyle {
  fill: string
  stroke: string
  lineWidth: number
  color: string
  fontSize: number
  fontFamily: string
}

const defaultStyle: ShapeStyle = {
  fill: '#ffffff',
  stroke: '#334155',
  lineWidth: 1.5,
  color: '#1f2937',
  fontSize: 14,
  fontFamily: 'sans-serif',
}

// 形状构造选项：kind 由具体子类决定，不对外暴露
export interface ShapeOptions extends NodeOptions {
  text?: string
  style?: Partial<ShapeStyle>
}

// 选中态描边与端口颜色（两态：普通边界 / 选中高亮）
const SELECT_COLOR = '#3b82f6'
const PORT_RADIUS = 5

// 流程图形状基类：容器 Node，内嵌居中 Text 子节点。
// 子类只负责三件事：drawPath（边界路径）、contains（命中判定）、
// boundaryT（中心到边界的方向系数），锚点/端口/选中态/文字居中由基类统一处理。
export abstract class Shape extends Node {
  readonly kind: ShapeKind
  style: ShapeStyle
  text: Text
  // 选中态：绘制高亮描边与四个端口圆点（由 FlowChart 维护）
  selected = false

  constructor(kind: ShapeKind, defaults: { width: number; height: number }, options: ShapeOptions = {}) {
    super(options)
    this.kind = kind
    this.style = { ...defaultStyle, ...options.style }
    // 形状尺寸固定：未显式给宽高时套用该形状的默认尺寸（Node 默认的 autoWidth 关闭）
    if (options.width === undefined) {
      this.autoWidth = false
      this.width = defaults.width
    }
    if (options.height === undefined) {
      this.autoHeight = false
      this.height = defaults.height
    }
    this.text = new Text({
      text: options.text ?? '',
      fill: this.style.color,
      fontSize: this.style.fontSize,
      fontFamily: this.style.fontFamily,
      wrap: false,
    })
    this.add(this.text)
    this.layout()
  }

  // 文本居中：文本改动重测后由外部（FlowChart）调用
  layout() {
    this.text.x = Math.round((this.width - this.text.width) / 2)
    this.text.y = Math.round((this.height - this.text.height) / 2)
  }

  //#region 锚点与端口
  // 中心到边界的方向系数：沿 (dx, dy) 从中心出发，t 为到达边界的比例（中心 + t·方向）
  protected abstract boundaryT(dx: number, dy: number): number

  // 朝目标点方向的边界锚点（世界坐标）：中心连线与自身边界求交
  anchor(target: { x: number; y: number }): { x: number; y: number } {
    const c = this.center()
    const dx = target.x - c.x
    const dy = target.y - c.y
    if (dx === 0 && dy === 0) return { x: c.x, y: c.y }
    const t = this.boundaryT(dx, dy)
    return { x: c.x + dx * t, y: c.y + dy * t }
  }

  // 世界坐标中心
  center() {
    const p = this.getWorldTransform().transformPoint({ x: this.width / 2, y: this.height / 2 })
    return { x: p.x, y: p.y }
  }

  // 四向端口（边界中点，世界坐标）
  portAt(dir: 'top' | 'right' | 'bottom' | 'left') {
    const local = { top: { x: this.width / 2, y: 0 }, right: { x: this.width, y: this.height / 2 }, bottom: { x: this.width / 2, y: this.height }, left: { x: 0, y: this.height / 2 } }[dir]
    const p = this.getWorldTransform().transformPoint(local)
    return { x: p.x, y: p.y }
  }
  //#endregion

  //#region 命中
  // 按形状几何判定（菱形/椭圆的矩形角落在形状外），逆变换到本地坐标后交给子类
  hitTest(worldX: number, worldY: number) {
    const local = this.localTransform.inverse().transformPoint({ x: worldX, y: worldY })
    return this.contains(local.x, local.y)
  }

  protected abstract contains(x: number, y: number): boolean
  //#endregion

  //#region 绘制
  // 绘制形状边界路径（本地坐标，原点已由 Renderer 平移）
  protected abstract drawPath(ctx: CanvasRenderingContext2D): void

  render(ctx: CanvasRenderingContext2D) {
    const { fill, stroke, lineWidth } = this.style
    ctx.beginPath()
    this.drawPath(ctx)
    if (fill) {
      ctx.fillStyle = fill
      ctx.fill()
    }
    if (stroke) {
      ctx.strokeStyle = stroke
      ctx.lineWidth = lineWidth
      ctx.stroke()
    }
    if (this.selected) this.drawSelection(ctx)
  }

  // 选中态：高亮描边 + 四个端口圆点
  private drawSelection(ctx: CanvasRenderingContext2D) {
    ctx.beginPath()
    this.drawPath(ctx)
    ctx.strokeStyle = SELECT_COLOR
    ctx.lineWidth = 2
    ctx.stroke()
    for (const dir of ['top', 'right', 'bottom', 'left'] as const) {
      const p = { top: { x: this.width / 2, y: 0 }, right: { x: this.width, y: this.height / 2 }, bottom: { x: this.width / 2, y: this.height }, left: { x: 0, y: this.height / 2 } }[dir]
      ctx.beginPath()
      ctx.arc(p.x, p.y, PORT_RADIUS, 0, Math.PI * 2)
      ctx.fillStyle = '#ffffff'
      ctx.fill()
      ctx.strokeStyle = SELECT_COLOR
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }
  //#endregion
}
