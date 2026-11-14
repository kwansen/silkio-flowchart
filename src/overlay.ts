// 画布覆盖层：连线拖拽预览与选中态渲染——只负责"画"，交互状态由 FlowChart
// 经 getState 回调按帧提供，覆盖层自身不持有交互状态

import { Node } from "@silkor/core";
import { PORT_DIR_VEC, PORT_STUB } from "./FlowEdge";
import type { PortDir } from "./FlowEdge";
import type { EdgeRouterCapability } from "./edge-router";
import { PORT_HOVER_SCALE, PORT_RADIUS } from "./geometry";
import type { Shape } from "./Shape";
import type { Bounds, SnapGuides } from "./snap";

// 选中框（bounds）外观参数：尺寸用屏幕像素，除以视口缩放换算成世界坐标
const SELECT_COLOR = "#3b82f6";
const HANDLE_SIZE = 9; // 四角手柄边长（屏幕像素）

// 节点拖拽吸附：对齐参考线颜色（吸附算法与容差在吸附能力实现内，此处只负责渲染）
const ALIGN_COLOR = "#eea5ffff";

// 连线拖拽预览：与正式连线同款式的折线 + 箭头
const LINK_PREVIEW_COLOR = "#3b82f6";

// 连线拖拽预览：与正式连线同款式的折线 + 箭头（from 为固定端端口及其方向，
// to 为光标或吸附端端口；toDir 随光标相对出口端口的位置实时变化）。
// 路由与渲染按能力键消费边路由能力（FlowChart 装配时注入）
export class LinkPreview extends Node {
  from = { x: 0, y: 0 };
  to = { x: 0, y: 0 };
  fromDir: PortDir = "right";
  toDir: PortDir = "left";
  // 两端直段长度：源端在创建时按其 portStub 设置，目标端吸附时跟随目标节点
  fromStub = PORT_STUB;
  toStub = PORT_STUB;
  router!: EdgeRouterCapability;

  render(ctx: CanvasRenderingContext2D) {
    ctx.save();
    const pts = this.router.route({
      from: this.from,
      fromDir: this.fromDir,
      to: this.to,
      toDir: this.toDir,
      fromStub: this.fromStub,
      toStub: this.toStub,
    });
    this.router.render(ctx, pts, {
      color: LINK_PREVIEW_COLOR,
      lineWidth: 2,
      cornerRadius: 8,
    });
    ctx.restore();
  }

  hitTest() {
    return false;
  }
}

// 选中框覆盖层：为选中形状绘制 bounds 边框、四角缩放手柄与外浮的连线端口圆点，
// 连线拖拽时为目标节点绘制对接手柄并高亮吸附端口，
// 尺寸按视口缩放反算，保证任何缩放级别下都是恒定屏幕像素大小
export class SelectionOverlay extends Node {
  constructor(
    private getState: () => {
      shape: Shape | null;
      scale: number;
      ports: Array<{ x: number; y: number }>;
      // 悬浮中的端口方向：该端口圆点放大并显示方向箭头（点击快速建节点提示）
      hoverPort: PortDir | null;
      // 激活连线的首尾端点手柄（世界坐标）
      edgeHandles: Array<{ x: number; y: number }>;
      // 激活连线的标签激活框（世界坐标 + 圆角）：类似思维导图节点的蓝色高亮环，
      // 紧贴标签白底盒包围盒；连线未选中或标签为空（不可见）时为 null
      edgeLabel: {
        x: number;
        y: number;
        width: number;
        height: number;
        radius: number;
      } | null;
      // 连线拖拽中的目标节点：ports 为其四个对接手柄，active 为吸附中的手柄
      link: {
        ports: Array<{ x: number; y: number }>;
        active: { x: number; y: number } | null;
      } | null;
      // 节点拖拽对齐参考线：v 为竖线 x 坐标、h 为横线 y 坐标（世界坐标），
      // spacing 为等间距测量线段
      guides: SnapGuides | null;
      // 框选拖拽中（插件橡皮筋之外的）实时组合框或多选组合 bounds，样式与单选框一致
      marquee: Bounds | null;
    },
  ) {
    super();
  }

  render(ctx: CanvasRenderingContext2D) {
    const {
      shape,
      scale,
      ports,
      hoverPort,
      edgeHandles,
      edgeLabel,
      link,
      guides,
      marquee,
    } = this.getState();
    const k = 1 / scale;
    ctx.save();
    // 框选框 / 多选组合框：与单选框同样式（边框 + 四角手柄），无连线端口
    if (marquee) {
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
      const s = HANDLE_SIZE * k;
      const { x, y, width: w, height: h } = marquee;
      for (const [cx, cy] of [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]) {
        ctx.beginPath();
        ctx.rect(cx - s / 2, cy - s / 2, s, s);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
    }
    if (shape) {
      const { x, y, width: w, height: h } = shape;
      // bounds 边框
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5 * k;
      ctx.strokeRect(x, y, w, h);
      // 四角手柄（白底蓝边方块）
      const s = HANDLE_SIZE * k;
      for (const [cx, cy] of [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ]) {
        ctx.beginPath();
        ctx.rect(cx - s / 2, cy - s / 2, s, s);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
      // 四向连线端口圆点（浮在形状外侧），悬浮端口放大并显示方向箭头
      const dirs = ["top", "right", "bottom", "left"] as const;
      this.drawPorts(
        ctx,
        ports,
        k,
        null,
        hoverPort ? dirs.indexOf(hoverPort) : -1,
        hoverPort,
      );
    }
    // 激活连线的首尾端点手柄（白底蓝边圆形）
    if (edgeHandles.length) {
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5 * k;
      const r = (HANDLE_SIZE / 2) * k;
      for (const h of edgeHandles) {
        ctx.beginPath();
        ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        ctx.stroke();
      }
    }
    // 激活连线的标签激活框：紧贴标签盒的蓝色圆角描边（类似思维导图节点高亮环），
    // 圆角沿用标签自身圆角；标签随连线重定位，此处逐帧读状态自动跟随
    if (edgeLabel) {
      ctx.strokeStyle = SELECT_COLOR;
      ctx.lineWidth = 1.5 * k;
      ctx.beginPath();
      ctx.roundRect(
        edgeLabel.x,
        edgeLabel.y,
        edgeLabel.width,
        edgeLabel.height,
        edgeLabel.radius,
      );
      ctx.stroke();
    }
    // 连线拖拽目标：浮出对接手柄，吸附中的手柄实心高亮
    if (link) this.drawPorts(ctx, link.ports, k, link.active);
    // 对齐参考线：贯穿画布的虚线
    if (guides && (guides.v.length || guides.h.length)) {
      ctx.strokeStyle = ALIGN_COLOR;
      ctx.lineWidth = 1 * k;
      ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath();
      for (const x of guides.v) {
        ctx.moveTo(x, -10000);
        ctx.lineTo(x, 10000);
      }
      for (const y of guides.h) {
        ctx.moveTo(-10000, y);
        ctx.lineTo(10000, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 等间距测量线：虚线段 + 两端刻度 + 间距数值标签
    if (guides && guides.spacing.length) {
      ctx.strokeStyle = ALIGN_COLOR;
      ctx.lineWidth = 1 * k;
      ctx.setLineDash([4 * k, 4 * k]);
      ctx.beginPath();
      for (const g of guides.spacing) {
        ctx.moveTo(g.x1, g.y1);
        ctx.lineTo(g.x2, g.y2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      // 两端垂直于线段的刻度
      const t = 3 * k;
      ctx.beginPath();
      for (const g of guides.spacing) {
        if (g.y1 === g.y2) {
          ctx.moveTo(g.x1, g.y1 - t);
          ctx.lineTo(g.x1, g.y1 + t);
          ctx.moveTo(g.x2, g.y2 - t);
          ctx.lineTo(g.x2, g.y2 + t);
        } else {
          ctx.moveTo(g.x1 - t, g.y1);
          ctx.lineTo(g.x1 + t, g.y1);
          ctx.moveTo(g.x2 - t, g.y2);
          ctx.lineTo(g.x2 + t, g.y2);
        }
      }
      ctx.stroke();
      // 数值标签（圆角底 + 白字），缩放级别恒定屏幕像素大小
      ctx.font = `${10 * k}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const padX = 3 * k;
      const h = 14 * k;
      for (const g of guides.spacing) {
        const label = String(Math.round(g.value));
        const w = ctx.measureText(label).width;
        const mx = (g.x1 + g.x2) / 2;
        const my = (g.y1 + g.y2) / 2;
        ctx.beginPath();
        ctx.roundRect(mx - w / 2 - padX, my - h / 2, w + padX * 2, h, h / 2);
        ctx.fillStyle = ALIGN_COLOR;
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, mx, my);
      }
    }
    ctx.restore();
  }

  // 绘制端口圆点：active 非空时该位置的圆点改为实心蓝（吸附高亮）；
  // hoverIdx/hoverDir 指向悬浮端口：放大、实心蓝并在内部绘制指向外侧的方向箭头
  // （提示点击可沿该方向快速新建节点）
  private drawPorts(
    ctx: CanvasRenderingContext2D,
    pts: Array<{ x: number; y: number }>,
    k: number,
    active: { x: number; y: number } | null,
    hoverIdx = -1,
    hoverDir?: PortDir | null,
  ) {
    ctx.strokeStyle = SELECT_COLOR;
    pts.forEach((p, i) => {
      const isActive = active && active.x === p.x && active.y === p.y;
      const isHover = i === hoverIdx && hoverDir;
      const r = (isHover ? PORT_RADIUS * PORT_HOVER_SCALE : PORT_RADIUS) * k;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      if (isActive || isHover) {
        ctx.fillStyle = SELECT_COLOR;
        ctx.fill();
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fill();
        // 显式恢复描边样式：悬浮端口的白色箭头会改写 strokeStyle，
        // 不重置会让其后绘制的端口用白色描边（视觉上"样式被改变"）
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = 1.5 * k;
        ctx.stroke();
      }
      // 悬浮箭头：白色雪佛龙指向端口外法向
      if (isHover && hoverDir) {
        const v = PORT_DIR_VEC[hoverDir];
        const n = { x: -v.y, y: v.x };
        const tip = { x: p.x + v.x * r * 0.45, y: p.y + v.y * r * 0.45 };
        const base = { x: p.x - v.x * r * 0.2, y: p.y - v.y * r * 0.2 };
        const w = r * 0.42;
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5 * k;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(base.x + n.x * w, base.y + n.y * w);
        ctx.lineTo(tip.x, tip.y);
        ctx.lineTo(base.x - n.x * w, base.y - n.y * w);
        ctx.stroke();
        ctx.lineCap = "butt";
      }
    });
  }

  hitTest() {
    return false;
  }
}
