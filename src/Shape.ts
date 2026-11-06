import { Node, Text } from '@silker/core'
import type { NodeOptions } from '@silker/core'
import { PORT_STUB } from './FlowEdge'
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

// 文本到形状边界的单侧留白（内容盒 = 形状宽度 - 左右留白）
const TEXT_PAD = 16
// 多行文本行高
const TEXT_LINE_HEIGHT = 1.4

// 形状构造选项：kind 由具体子类决定，不对外暴露
export interface ShapeOptions extends NodeOptions {
  text?: string
  style?: Partial<ShapeStyle>
}

// 流程图形状基类：容器 Node，内嵌居中 Text 子节点。
// 子类只负责四件事：drawPath（边界路径）、contains（命中判定）、
// boundaryT（中心到边界的方向系数）、textFit（文本盒内接换算系数），
// 锚点/端口/选中态/文字居中由基类统一处理。
// 形状尺寸完全由外部决定（默认值/拖拽/序列化），文本改动只重排居中，不改尺寸。
export abstract class Shape extends Node {
  readonly kind: ShapeKind
  style: ShapeStyle
  text: Text
  // 选中态标志（由 FlowChart 维护；选中视觉——bounds 框/手柄/端口——由其覆盖层绘制）
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
    // 文本不自动定宽：换行宽度始终跟随形状宽度，打字不改节点尺寸；多行水平居中
    this.text = new Text({
      text: options.text ?? '',
      fill: this.style.color,
      fontSize: this.style.fontSize,
      fontFamily: this.style.fontFamily,
      wrap: true,
      align: 'center',
      lineHeight: TEXT_LINE_HEIGHT,
    })
    this.text.autoWidth = false
    this.add(this.text)
    this.layout()
  }

  // 文本居中：换行宽度同步为形状内接内容盒宽度并重测，再居中（不改形状尺寸）
  layout() {
    this.text.width = Math.max(0, this.width / this.textFit - TEXT_PAD * 2)
    this.text.measure()
    this.text.x = Math.round((this.width - this.text.width) / 2)
    this.text.y = Math.round((this.height - this.text.height) / 2)
  }

  //#region 锚点与端口
  // 中心到边界的方向系数：沿 (dx, dy) 从中心出发，t 为到达边界的比例（中心 + t·方向）
  protected abstract boundaryT(dx: number, dy: number): number

  // 文本盒内接换算系数：形状内最大居中内接矩形的宽高占形状的比例的倒数
  //（矩形 1、椭圆 √2、菱形 2）。决定文本换行宽度（宽/k）与高度换算（高×k）
  protected abstract get textFit(): number

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

  // 连线出口/入口直段长度：端口沿外法向引出的锁定方向段（世界坐标）。
  // 默认端口位于包围盒边上，转折点落在包围盒外 PORT_STUB 处；端口被补偿
  // 内收的形状（如平行四边形斜边中点）覆写 portAt 时需同时覆写此方法
  // 加上内收量，保证转折点仍在包围盒外，后续正交段不穿过形状
  portStub(_dir: 'top' | 'right' | 'bottom' | 'left') {
    return PORT_STUB
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
    // border-box 语义：描边完全画在节点尺寸内部，宽度不改变节点整体大小
    //（裁剪到形状路径后以 2 倍线宽描边，外半被裁掉，可见部分恰好是内侧 lineWidth）
    if (stroke) {
      ctx.save()
      ctx.beginPath()
      this.drawPath(ctx)
      ctx.clip()
      ctx.beginPath()
      this.drawPath(ctx)
      ctx.strokeStyle = stroke
      ctx.lineWidth = lineWidth * 2
      ctx.stroke()
      ctx.restore()
    }
  }
  //#endregion
}
