import type { SerializedCommand } from "@silker/core";
import type { MovePayload, RenderPayload, ResizePayload, ReconnectPayload, TextPayload, EdgeTextPayload, ConnectPayload } from "./commands";
import type { AddShapePayload, DeletePayload, ReplacePayload } from "./history-codec";
import type { FlowModel } from "./model";
import type { ShapeKind } from "./data";

// 历史描述（AI history 操作的读取实现，纯函数，导出便于测试）：
// 把撤销/重做栈的序列化命令转为人类可读文案。
// 各 kind 命令的载荷形状统一取自 commands.ts / history-codec.ts（与生产端、
// 解码端共享同一类型源），本模块只读不写。

// 形状 kind 的中文名：历史文案面向用户，未知 kind（第三方形状）退化为 kind 原文
const SHAPE_LABEL: Record<string, string> = {
  rect: "矩形",
  diamond: "判断",
  ellipse: "椭圆",
  parallelogram: "输入输出",
  hexagon: "六边形",
  database: "存储",
};

const shapeKindLabel = (kind: ShapeKind | string): string => SHAPE_LABEL[kind] ?? kind;

// 把单条序列化命令转为可读描述："将「校验通过？」改为「是否为管理员」"。
// 节点文本按 id 经模型解析（已删节点的文本从载荷内嵌数据读取）；
// 组合命令递归描述子命令并以分号连接；未知 kind 退化为 kind 字符串
export function describeHistoryCommand(
  s: SerializedCommand,
  model: Pick<FlowModel, "shapes">,
): string {
  const shapeText = (id: string | null | undefined): string =>
    (id ? model.shapes.get(id)?.text.text : "") || "（已不存在的节点）";
  if (s.kind === "composite") {
    const p = s.payload as { children?: SerializedCommand[] } | null;
    const children = (p?.children ?? [])
      .map((c) => describeHistoryCommand(c, model))
      .filter(Boolean);
    return children.join("；") || s.kind;
  }
  switch (s.kind) {
    case "flowchart.move": {
      const p = s.payload as MovePayload;
      const ids = p.v === "delta" ? (p.targets ?? []) : p.before.map((b) => b.shapeId);
      return ids.length === 1
        ? `移动「${shapeText(ids[0])}」`
        : `移动 ${ids.length} 个节点`;
    }
    case "flowchart.resize": {
      const p = s.payload as ResizePayload;
      const ids =
        p.v === "single" ? [p.shapeId] : p.before.map((b) => b.shapeId);
      return ids.length === 1
        ? `调整「${shapeText(ids[0])}」的大小`
        : `调整 ${ids.length} 个节点的大小`;
    }
    case "flowchart.reconnect": {
      const p = s.payload as ReconnectPayload;
      return `把连到「${shapeText(p.oldNodeId)}」的一端改接到「${shapeText(p.newNodeId)}」`;
    }
    case "flowchart.text": {
      const p = s.payload as TextPayload;
      return `将「${p.before}」改为「${p.after}」`;
    }
    case "flowchart.edgeText": {
      const p = s.payload as EdgeTextPayload;
      return `把连线标签从「${p.before || "空"}」改为「${p.after || "空"}」`;
    }
    case "flowchart.add-shape": {
      const p = s.payload as AddShapePayload;
      return `添加${shapeKindLabel(p.data.shape)}节点「${p.data.text}」`;
    }
    case "flowchart.connect": {
      const p = s.payload as ConnectPayload;
      return `连接「${shapeText(p.fromId)}」→「${shapeText(p.toId)}」`;
    }
    case "flowchart.delete": {
      const p = s.payload as DeletePayload;
      if (p.v === "edge") return "删除一条连线";
      const first = p.items?.[0];
      if (!first) return "删除节点";
      const more = (p.items?.length ?? 0) > 1 ? ` 等 ${p.items!.length} 个节点` : "";
      return `删除「${first.data.text}」${more}`;
    }
    case "flowchart.replace": {
      const p = s.payload as ReplacePayload;
      return `把「${p.oldData.text}」的形状改为「${shapeKindLabel(p.newData.shape)}」`;
    }
    case "flowchart.render": {
      const p = s.payload as RenderPayload;
      return `重绘整张流程图（${p.after.data.nodes.length} 个节点）`;
    }
    default:
      return s.kind;
  }
}
