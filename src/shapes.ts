import { Shape } from "./Shape";
import type { ShapeOptions } from "./Shape";
import type { ShapeKind } from "./data";

// 圆角矩形（流程步骤）：默认矩形命中
export class RectShape extends Shape {
  radius = 8;

  // 矩形本身即最大内接矩形
  protected get textFit() {
    return 1;
  }

  constructor(options: ShapeOptions = {}) {
    super("rect", { width: 160, height: 99 }, options);
  }

  protected boundaryT(dx: number, dy: number) {
    // 射线与矩形边界求交：取两个轴向比例中的较小者（轴向分量为 0 时记无穷大）
    const tx = dx === 0 ? Infinity : this.width / 2 / Math.abs(dx);
    const ty = dy === 0 ? Infinity : this.height / 2 / Math.abs(dy);
    return Math.min(tx, ty);
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    ctx.roundRect(0, 0, this.width, this.height, this.radius);
  }

  protected contains(x: number, y: number) {
    return x >= 0 && x <= this.width && y >= 0 && y <= this.height;
  }
}

// 菱形（判断分支）
export class Diamond extends Shape {
  // 文本盒略宽于最大居中内接矩形（1/2 倍宽高），换取更多横向空间
  protected get textFit() {
    return 1.5;
  }

  constructor(options: ShapeOptions = {}) {
    super("diamond", { width: 160, height: 99 }, options);
  }

  // 菱形方程 |dx|/a + |dy|/b = 1，方向系数为该式的倒数
  protected boundaryT(dx: number, dy: number) {
    const a = this.width / 2;
    const b = this.height / 2;
    return 1 / (Math.abs(dx) / a + Math.abs(dy) / b);
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    ctx.moveTo(this.width / 2, 0);
    ctx.lineTo(this.width, this.height / 2);
    ctx.lineTo(this.width / 2, this.height);
    ctx.lineTo(0, this.height / 2);
    ctx.closePath();
  }

  protected contains(x: number, y: number) {
    const a = this.width / 2;
    const b = this.height / 2;
    return Math.abs(x - a) / a + Math.abs(y - b) / b <= 1;
  }
}

// 椭圆（开始 / 结束）
export class EllipseShape extends Shape {
  // 椭圆内最大居中内接矩形为 1/√2 倍宽高，取倒数
  protected get textFit() {
    return Math.SQRT2;
  }

  constructor(options: ShapeOptions = {}) {
    super("ellipse", { width: 160, height: 99 }, options);
  }

  // 椭圆方程 (dx/a)² + (dy/b)² = 1，方向系数为该式的 -1/2 次幂
  protected boundaryT(dx: number, dy: number) {
    const a = this.width / 2;
    const b = this.height / 2;
    return 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2);
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    ctx.ellipse(
      this.width / 2,
      this.height / 2,
      this.width / 2,
      this.height / 2,
      0,
      0,
      Math.PI * 2,
    );
  }

  protected contains(x: number, y: number) {
    const a = this.width / 2;
    const b = this.height / 2;
    return ((x - a) / a) ** 2 + ((y - b) / b) ** 2 <= 1;
  }
}

// 按类型创建形状（数据模型 ShapeKind → 渲染模型实例）
export function createShape(
  kind: ShapeKind,
  options: ShapeOptions = {},
): Shape {
  switch (kind) {
    case "diamond":
      return new Diamond(options);
    case "ellipse":
      return new EllipseShape(options);
    default:
      return new RectShape(options);
  }
}
