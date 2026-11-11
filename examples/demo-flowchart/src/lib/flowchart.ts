// 流程图示例数据与第三方形状扩展：只依赖 @silker/flowchart 的公开导出，
// UI 层（Vue 组件）通过能力键装配即可，不接触 FlowChart 内部实现
import { Shape, SHAPE_REGISTRY_CAPABILITY } from "@silker/flowchart";
import type {
  FlowData,
  Plugin,
  ShapeKind,
  ShapeOptions,
  ShapeStyle,
} from "@silker/flowchart";

// 便签（折角矩形）：演示外部形状经形状注册表插件注册
class NoteShape extends Shape {
  constructor(options: ShapeOptions = {}) {
    super("note", { width: 160, height: 99 }, {
      ...options,
      style: { fill: "#fef9c3", stroke: "#ca8a04", ...options.style } as Partial<ShapeStyle>,
    });
  }

  // 内接矩形近似（折角只占右上角一小块）
  protected get textFit() {
    return 1.15;
  }

  protected boundaryT(dx: number, dy: number) {
    const tx = dx === 0 ? Infinity : this.width / 2 / Math.abs(dx);
    const ty = dy === 0 ? Infinity : this.height / 2 / Math.abs(dy);
    return Math.min(tx, ty);
  }

  protected contains(x: number, y: number) {
    return x >= 0 && x <= this.width && y >= 0 && y <= this.height;
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    const fold = 18;
    ctx.moveTo(0, 0);
    ctx.lineTo(this.width - fold, 0);
    ctx.lineTo(this.width, fold);
    ctx.lineTo(this.width, this.height);
    ctx.lineTo(0, this.height);
    ctx.closePath();
  }
}

// install 期间经能力键向注册表追加自定义 kind
export const noteShapes: Plugin = {
  install(app) {
    app
      .require(SHAPE_REGISTRY_CAPABILITY)
      .register("note", (o) => new NoteShape(o), { label: "便签" });
  },
};

// 开始 → 处理 → 判断 →（通过/驳回）两条分支
export const initialData: FlowData = {
  nodes: [
    { id: "start", shape: "ellipse", x: 60, y: 220, text: "开始" },
    { id: "handle", shape: "rect", x: 300, y: 220, text: "处理请求" },
    { id: "check", shape: "diamond", x: 560, y: 220, text: "校验通过？" },
    { id: "ok", shape: "ellipse", x: 840, y: 100, text: "返回成功" },
    { id: "retry", shape: "rect", x: 840, y: 330, text: "返回错误" },
    // 第三方形状（note 插件经 plugins 选项装配后，初始数据即可用）
    { id: "note1", shape: "note", x: 300, y: 420, text: "自定义形状：便签" },
  ],
  edges: [
    { from: "start", to: "handle" },
    { from: "handle", to: "check" },
    { from: "check", to: "ok" },
    { from: "check", to: "retry" },
    // 演示四向端口与方向锁定：从「开始」底部竖直引出，竖直接入「返回错误」顶部
    { from: "start", to: "retry", fromDir: "bottom", toDir: "top" },
  ],
};

export interface ShapeOption {
  kind: ShapeKind;
  label: string;
  text: string;
  symbol: string;
}

// 添加节点与替换形状共用（symbol 对应 IconSprites 里的形状预览图标）
export const shapeOptions: readonly ShapeOption[] = [
  { kind: "rect", label: "矩形 · 步骤", text: "新步骤", symbol: "s-rect" },
  { kind: "diamond", label: "菱形 · 判断", text: "新判断", symbol: "s-diamond" },
  { kind: "ellipse", label: "椭圆 · 起止", text: "新端点", symbol: "s-ellipse" },
  { kind: "parallelogram", label: "平行四边形 · 输入输出", text: "输入数据", symbol: "s-parallelogram" },
  { kind: "hexagon", label: "六边形 · 准备", text: "准备阶段", symbol: "s-hexagon" },
  { kind: "database", label: "数据库 · 存储", text: "存储数据", symbol: "s-database" },
  { kind: "note", label: "便签 · 自定义形状", text: "便签", symbol: "s-note" },
];
