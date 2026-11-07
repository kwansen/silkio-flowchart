import { capabilityKey } from "@silker/core";
import type { App, Plugin } from "@silker/core";
import type { Bounds, SnapOptions, SnapResult } from "./snap";
import { computeSnap } from "./snap";

// 吸附能力：契约由 flowchart（Domain Core）定义，官方实现是 BuiltinSnap 插件
// （install 时自注册），第三方吸附策略（网格吸附、无吸附等）按能力键注册同名
// 能力覆盖官方实现（App.provide 替换 + uninstall 恢复），不与官方插件互相依赖
//（架构文档 §2.3：替换实现 ≠ 插件互相依赖）

// 吸附输入：拖拽载体与候选参考目标的 bounds（世界坐标）、视口缩放比、
// 上一帧迟滞状态。容差以屏幕像素为契约单位，由实现方按 scale 折算世界坐标——
// 换实现不需要感知视口，网格吸附等策略在任意缩放下手感一致
export interface SnapInput {
  box: Bounds;
  candidates: readonly Bounds[];
  scale: number;
  // 迟滞：上一帧对齐吸附在两轴上是否处于吸附态（会话内逐帧回传，会话结束清零）
  prev?: { x: boolean; y: boolean };
}

// 吸附能力契约：对拖拽载体做吸附，返回位移与绘制用参考线，由调用方应用与渲染。
// 契约语义（实现方必须遵守）：
// 1. 纯函数：不修改传入的 box，只返回 dx/dy 与 guides
// 2. 参考线几何（v/h 基线与 spacing 测量线段）是世界坐标，样式与绘制由宿主负责
// 3. 无任何参考线时 guides 为 null
export interface SnapCapability {
  snap(input: SnapInput): SnapResult;
}

// 能力键：消费方只认能力名与契约，不认提供方插件
export const SNAP_CAPABILITY = capabilityKey<SnapCapability>("flowchart.snap");

// 官方吸附容差（屏幕像素）：对齐吸附阈值 / 等间距吸附阈值
const DEFAULT_SNAP_TOL = 6;
const DEFAULT_SPACING_TOL = 4;

// 官方吸附插件：对齐吸附 + 等间距吸附（算法在 snap.ts 纯函数 computeSnap），
// install 时自注册 flowchart.snap 能力，容差可按需覆盖
export class BuiltinSnap implements Plugin {
  constructor(
    private options?: { snapTol?: number; spacingTol?: number },
  ) {}

  install(app: App) {
    const snapTol = this.options?.snapTol ?? DEFAULT_SNAP_TOL;
    const spacingTol = this.options?.spacingTol ?? DEFAULT_SPACING_TOL;
    const impl: SnapCapability = {
      snap: ({ box, candidates, scale, prev }: SnapInput): SnapResult => {
        const opts: SnapOptions = {
          snapTol: snapTol / scale,
          spacingTol: spacingTol / scale,
          prev,
        };
        return computeSnap(box, candidates, opts);
      },
    };
    app.provide(SNAP_CAPABILITY, impl, {
      provider: "flowchart.builtin-snap",
    });
  }
}
