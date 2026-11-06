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

// 凸多边形几何工具：顶点按顺序给出（本地坐标），返回中心射线 (dx, dy) 与
// 边界的比例 t（中心 + t·方向），无交返回 Infinity（射线方向为零向量时）
function polygonBoundaryT(
  poly: Array<{ x: number; y: number }>,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    // 射线 C + t·D 与边 A + s·E 联立求解（克莱姆法则）
    const den = dx * ey - dy * ex;
    if (den === 0) continue;
    const px = a.x - cx;
    const py = a.y - cy;
    const t = (px * ey - py * ex) / den;
    const s = (dy * px - dx * py) / den;
    if (t > 0 && s >= 0 && s <= 1 && t < best) best = t;
  }
  return best;
}

// 平行四边形（输入 / 输出）：上边右移、下边左移的斜切四边形
export class Parallelogram extends Shape {
  constructor(options: ShapeOptions = {}) {
    super("parallelogram", { width: 160, height: 99 }, options);
  }

  // 斜切量：高度的 30%
  private get skew() {
    return this.height * 0.3;
  }

  // 顺时针顶点
  private get poly() {
    const k = this.skew;
    const { width: w, height: h } = this;
    return [
      { x: k, y: 0 },
      { x: w, y: 0 },
      { x: w - k, y: h },
      { x: 0, y: h },
    ];
  }

  // 内接矩形宽 ≈ w − 2·skew
  protected get textFit() {
    return 1.4;
  }

  protected boundaryT(dx: number, dy: number) {
    const t = polygonBoundaryT(
      this.poly,
      this.width / 2,
      this.height / 2,
      dx,
      dy,
    );
    return t === Infinity ? 0 : t;
  }

  // 凸多边形内含判定：沿中心 → 点方向的边界比例 t ≥ 1 即在边界内（含边界）
  protected contains(x: number, y: number) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    if (x === cx && y === cy) return true;
    return polygonBoundaryT(this.poly, cx, cy, x - cx, y - cy) >= 1;
  }

  // 左右端口补偿到斜边中点（左斜边 x = k/2、右斜边 x = w − k/2），
  // 使连线端点与对接手柄落在可见边界上；上下端口仍在上下边中点
  portAt(dir: "top" | "right" | "bottom" | "left") {
    const k = this.skew;
    const local = {
      top: { x: this.width / 2, y: 0 },
      right: { x: this.width - k / 2, y: this.height / 2 },
      bottom: { x: this.width / 2, y: this.height },
      left: { x: k / 2, y: this.height / 2 },
    }[dir];
    const p = this.getWorldTransform().transformPoint(local);
    return { x: p.x, y: p.y };
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    const [a, b, c, d] = this.poly;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.closePath();
  }
}

// 六边形（准备）：左右两侧斜切的等边六边形
export class Hexagon extends Shape {
  constructor(options: ShapeOptions = {}) {
    super("hexagon", { width: 160, height: 99 }, options);
  }

  // 左右斜切量：宽度的 15%
  private get cut() {
    return this.width * 0.15;
  }

  private get poly() {
    const n = this.cut;
    const { width: w, height: h } = this;
    return [
      { x: n, y: 0 },
      { x: w - n, y: 0 },
      { x: w, y: h / 2 },
      { x: w - n, y: h },
      { x: n, y: h },
      { x: 0, y: h / 2 },
    ];
  }

  // 内接矩形宽 ≈ w − 2·cut
  protected get textFit() {
    return 1.35;
  }

  protected boundaryT(dx: number, dy: number) {
    const t = polygonBoundaryT(
      this.poly,
      this.width / 2,
      this.height / 2,
      dx,
      dy,
    );
    return t === Infinity ? 0 : t;
  }

  protected contains(x: number, y: number) {
    const cx = this.width / 2;
    const cy = this.height / 2;
    if (x === cx && y === cy) return true;
    return polygonBoundaryT(this.poly, cx, cy, x - cx, y - cy) >= 1;
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    const [a, b, c, d, e, f] = this.poly;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.lineTo(c.x, c.y);
    ctx.lineTo(d.x, d.y);
    ctx.lineTo(e.x, e.y);
    ctx.lineTo(f.x, f.y);
    ctx.closePath();
  }
}

// 数据库（存储）：圆柱体，顶帽完整椭圆 + 侧边 + 底帽半椭圆
export class Database extends Shape {
  constructor(options: ShapeOptions = {}) {
    super("database", { width: 160, height: 99 }, options);
  }

  // 顶/底帽椭圆的纵向半径：高度的 15%
  private get capRy() {
    return this.height * 0.15;
  }

  // 文本落在中段柱体（全宽），仅多行延伸到帽区时略收窄
  protected get textFit() {
    return 1.15;
  }

  // 侧边（中段有效）与顶/底帽椭圆的射线求交取最小正 t；
  // 帽椭圆解二次方程：t²·A + t·B + C = 0
  protected boundaryT(dx: number, dy: number) {
    const { width: w, height: h } = this;
    const a = w / 2;
    const ry = this.capRy;
    const cx = a;
    const cy = h / 2;
    let best = Infinity;
    // 左右侧边：x = 0 / w，且交点纵坐标落在中段
    if (dx !== 0) {
      const t = (dx > 0 ? w - cx : -cx) / dx;
      const y = cy + t * dy;
      if (t > 0 && y >= ry && y <= h - ry) best = t;
    }
    // 顶/底帽：射线起点相对帽心的纵偏移 oy，代入椭圆方程
    for (const ey of [ry, h - ry]) {
      const oy = cy - ey;
      const A = (dx * dx) / (a * a) + (dy * dy) / (ry * ry);
      const B = (2 * oy * dy) / (ry * ry);
      const C = (oy * oy) / (ry * ry) - 1;
      const disc = B * B - 4 * A * C;
      if (disc < 0) continue;
      const sq = Math.sqrt(disc);
      for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
        if (t > 0 && t < best) best = t;
      }
    }
    return best === Infinity ? 0 : best;
  }

  // 中段柱体全宽有效；帽区按对应椭圆方程判定
  protected contains(x: number, y: number) {
    const { width: w, height: h } = this;
    const ry = this.capRy;
    if (x < 0 || x > w) return false;
    if (y >= ry && y <= h - ry) return true;
    const cy = y < ry ? ry : h - ry;
    const nx = (x - w / 2) / (w / 2);
    const ny = (y - cy) / ry;
    return nx * nx + ny * ny <= 1;
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    const { width: w, height: h } = this;
    const ry = this.capRy;
    ctx.moveTo(0, ry);
    ctx.lineTo(0, h - ry);
    // 底帽：经最低点的半椭圆（左 → 下 → 右）
    ctx.ellipse(w / 2, h - ry, w / 2, ry, 0, Math.PI, 0, true);
    ctx.lineTo(w, ry);
    // 顶帽：经最高点的半椭圆（右 → 上 → 左）闭合轮廓
    ctx.ellipse(w / 2, ry, w / 2, ry, 0, 0, Math.PI, true);
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
    case "parallelogram":
      return new Parallelogram(options);
    case "hexagon":
      return new Hexagon(options);
    case "database":
      return new Database(options);
    default:
      return new RectShape(options);
  }
}
