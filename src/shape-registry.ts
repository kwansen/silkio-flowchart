import { capabilityKey } from "@silkor/core";
import type { App, Plugin } from "@silkor/core";
import type { Shape, ShapeOptions } from "./Shape";
import {
  RectShape,
  Diamond,
  EllipseShape,
  Parallelogram,
  Hexagon,
  Database,
} from "./shapes";

// 形状描述：kind + 展示名（label 供工具栏等 UI 使用，可缺省）
export interface ShapeDescriptor {
  kind: string;
  label?: string;
}

// 形状注册表能力契约：kind → 形状工厂。契约由 flowchart（Domain Core）定义，
// 内置六形状是官方实现（BuiltinShapes 插件 install 时注册），第三方形状以
// Extension 身份按能力键拿到同一注册表追加注册——实现 Core 契约或扩展内容，
// 不与官方插件互相依赖（架构文档 §2.3：替换实现 ≠ 插件互相依赖）
export interface ShapeRegistryCapability {
  // 注册形状：kind 为开放字符串，同名注册为替换（后装插件可覆盖官方实现）
  register(
    kind: string,
    factory: (options: ShapeOptions) => Shape,
    meta?: { label?: string },
  ): void;
  // 已注册形状（按注册顺序）：供 UI 动态生成形状按钮
  list(): readonly ShapeDescriptor[];
  // 按类型创建形状：未注册返回 undefined，消费方自行降级
  //（数据反序列化跳过未知 kind；编程路径用 require 的注册表兜底 fail fast）
  create(kind: string, options?: ShapeOptions): Shape | undefined;
}

// 能力键：形状注册表供消费方查询（消费方只认能力名与契约，不认提供方插件）
export const SHAPE_REGISTRY_CAPABILITY =
  capabilityKey<ShapeRegistryCapability>("flowchart.shape-registry");

// 注册表实现：Map 保持插入序，list/create 直接映射
class ShapeRegistry implements ShapeRegistryCapability {
  private entries = new Map<
    string,
    { factory: (options: ShapeOptions) => Shape; label?: string }
  >();

  register(
    kind: string,
    factory: (options: ShapeOptions) => Shape,
    meta?: { label?: string },
  ) {
    this.entries.set(kind, { factory, label: meta?.label });
  }

  list(): readonly ShapeDescriptor[] {
    return [...this.entries].map(([kind, e]) => ({ kind, label: e.label }));
  }

  create(kind: string, options?: ShapeOptions): Shape | undefined {
    const e = this.entries.get(kind);
    return e?.factory(options ?? {});
  }
}

// 官方形状插件：内置六种流程图形状，install 时自注册注册表能力。
// 第三方形状插件按能力键消费同一注册表追加/覆盖条目，不 import 本插件类型
export class BuiltinShapes implements Plugin {
  install(app: App) {
    const registry = new ShapeRegistry();
    registry.register("rect", (o) => new RectShape(o), { label: "矩形" });
    registry.register("diamond", (o) => new Diamond(o), { label: "菱形" });
    registry.register("ellipse", (o) => new EllipseShape(o), { label: "椭圆" });
    registry.register("parallelogram", (o) => new Parallelogram(o), {
      label: "平行四边形",
    });
    registry.register("hexagon", (o) => new Hexagon(o), { label: "六边形" });
    registry.register("database", (o) => new Database(o), { label: "数据库" });
    app.provide(SHAPE_REGISTRY_CAPABILITY, registry, {
      provider: "flowchart.builtin-shapes",
    });
  }
}
