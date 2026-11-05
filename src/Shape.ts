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
// 锚点/端口/选中态/文字居中/高度自适应由基类统一处理。
export abstract class Shape extends Node {
  readonly kind: ShapeKind
  style: ShapeStyle
  text: Text
  // 选中态标志（由 FlowChart 维护；选中视觉——bounds 框/手柄/端口——由其覆盖层绘制）
  selected = false
  // 尺寸下限：子类给定的形状默认尺寸（fit 内容定尺寸时兜底）
  private defaultSize: { width: number; height: number }

  constructor(kind: ShapeKind, defaults: { width: number; height: number }, options: ShapeOptions = {}) {
    super(options)
    this.kind = kind
    this.style = { ...defaultStyle, ...options.style }
    this.defaultSize = { ...defaults }
    // 形状尺寸固定：未显式给宽高时套用该形状的默认尺寸（Node 默认的 autoWidth 关闭）
    const explicitSize = options.width !== undefined && options.height !== undefined
    if (options.width === undefined) {
      this.autoWidth = false
      this.width = defaults.width
    }
    if (options.height === undefined) {
      this.autoHeight = false
      this.height = defaults.height
    }
    // 文本不自动定宽：换行宽度始终跟随形状宽度，打字只影响高度
    this.text = new Text({
      text: options.text ?? '',
      fill: this.style.color,
      fontSize: this.style.fontSize,
      fontFamily: this.style.fontFamily,
      wrap: true,
      lineHeight: TEXT_LINE_HEIGHT,
    })
    this.text.autoWidth = false
    this.add(this.text)
    // 未显式给全尺寸时按内容自适应高度，否则保留外部尺寸仅居中
    if (explicitSize) this.layout()
    else this.fit()
  }

  // 文本居中：换行宽度同步为形状内接内容盒宽度并重测，再居中（不改形状高度）
  layout() {
    this.text.width = Math.max(0, this.width / this.textFit - TEXT_PAD * 2)
    this.text.measure()
    this.text.x = Math.round((this.width - this.text.width) / 2)
    this.text.y = Math.round((this.height - this.text.height) / 2)
  }

  // 打字只影响高度：按当前宽度重排文本，高度按内接关系换算后取与默认高度的最大值，
  // 宽度保持不变；文本改动（编辑输入/结束）后由 FlowChart 调用
  fit() {
    this.layout()
    this.height = Math.max(Math.ceil(this.text.height * this.textFit) + TEXT_PAD * 2, this.defaultSize.height)
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
