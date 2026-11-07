import { capabilityKey } from "@silker/core";
import type { App, Plugin } from "@silker/core";
import type { EdgePoint } from "@silker/plugin-edge";
import { FlowEdge } from "./FlowEdge";
import type { PortDir } from "./FlowEdge";
import { drawEdgeArrow, renderOrthoPolyline, trimEdgeEnd } from "./FlowEdge";

// 边路由能力：契约由 flowchart（Domain Core）定义，官方实现是 BuiltinEdgeRouter
// 插件（install 时自注册），第三方路由策略（贝塞尔、绕障、直线等）按能力键注册
// 同名能力覆盖官方实现（App.provide 替换 + uninstall 恢复），不与官方插件互相依赖
//（架构文档 §2.3：替换实现 ≠ 插件互相依赖）

// 路由输入：两端端口点（世界坐标）与外法向、两端出口/入口直段长度。
// 端口方向由宿主在连线创建时冻结，节点移动/缩放只改变端口点与直段长度
export interface EdgeRouteInput {
  from: EdgePoint; // 源端口点
  fromDir: PortDir; // 源端口外法向
  to: EdgePoint; // 目标端口点
  toDir: PortDir; // 目标端口外法向
  fromStub: number; // 源端口直段长度（沿外法向引出的锁定方向段）
  toStub: number; // 目标端口直段长度
}

// 路由渲染样式：颜色由宿主按业务状态（选中/悬浮/默认）传入，能力不持有状态
export interface EdgeRenderStyle {
  color: string;
  lineWidth: number;
  // 拐角圆弧半径（正交折线的拐点过渡）；非折线路由可忽略
  cornerRadius?: number;
}

// 边路由能力契约。契约语义（实现方必须遵守）：
// 1. route 为纯函数：不修改输入，返回途经点序列（首点 = from，末点 = to），
//    相邻重复点应剔除；points 同时供宿主做命中检测与包围盒计算，
//    曲线路由应让途经点贴合实际曲线（密集采样）
// 2. render 负责路径绘制（含末端箭头等路由风格自带的装饰），
//    线体末端应回缩箭头长度避免线头露出；颜色/线宽以 style 为准
export interface EdgeRouterCapability {
  route(input: EdgeRouteInput): EdgePoint[];
  render(
    ctx: CanvasRenderingContext2D,
    points: EdgePoint[],
    style: EdgeRenderStyle,
  ): void;
}

// 能力键：消费方只认能力名与契约，不认提供方插件
export const EDGE_ROUTER_CAPABILITY =
  capabilityKey<EdgeRouterCapability>("flowchart.edge-router");

// 官方边路由插件：正交折线路由 + 圆角拐点 + 实心箭头（算法在 FlowEdge.routeBetween
// 静态方法与 FlowEdge.ts 渲染辅助中），install 时自注册 flowchart.edge-router 能力
export class BuiltinEdgeRouter implements Plugin {
  install(app: App) {
    const impl: EdgeRouterCapability = {
      route: (input: EdgeRouteInput) =>
        FlowEdge.routeBetween(
          input.from,
          input.fromDir,
          input.to,
          input.toDir,
          input.fromStub,
          input.toStub,
        ),
      render: (ctx, points, style) => {
        // 线体末端回缩一个箭头长度再绘制，避免线头从三角箭头下方露出
        renderOrthoPolyline(
          ctx,
          trimEdgeEnd(points),
          style.color,
          style.lineWidth,
          style.cornerRadius ?? 8,
        );
        drawEdgeArrow(ctx, points, style.color);
      },
    };
    app.provide(EDGE_ROUTER_CAPABILITY, impl, {
      provider: "flowchart.builtin-edge-router",
    });
  }
}
