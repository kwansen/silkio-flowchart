// 交互几何辅助（纯函数）：命中测试、端口定位、缩放几何、框选命中与连线吸附
// 目标查找——不持有画布或交互状态，输入数据、输出结果，供交互策略组合调用；
// 常量为屏幕像素口径，调用方按视口缩放换算成世界坐标

import type { Node } from "@silker/core";
import { Shape } from "./Shape";
import { OPPOSITE_DIR, PORT_DIR_VEC } from "./FlowEdge";
import type { FlowEdge, PortDir } from "./FlowEdge";
import type { Bounds } from "./snap";
import { CLICK_CREATE_GAP } from "./session";

// 端口命中半径（世界坐标）：也用作缩放边线对四边中点的避让宽度
export const PORT_HIT_RADIUS = 10;

// 命中参数（屏幕像素）：手柄、边线、连线折线与端点手柄共用口径
export const HANDLE_HIT = 8; // 手柄命中半径（屏幕像素）
export const EDGE_TOLERANCE = 5; // 边线命中容差（屏幕像素）
export const EDGE_HANDLE_HIT = 8; // 连线端点手柄命中半径（屏幕像素）
export const MIN_SIZE = 20; // 缩放最小尺寸（世界坐标）

// 连线端口圆点外观：圆心相对边中点向外的偏移与悬浮放大倍数（屏幕像素）
export const PORT_RADIUS = 5;
export const PORT_OFFSET = 24;
export const PORT_HOVER_SCALE = 2.4;

// 连线拖拽吸附：光标进入目标节点包围盒外扩该范围时，目标节点浮出对接手柄
export const LINK_SNAP_MARGIN = 16; // 吸附感应范围（屏幕像素）

// 缩放手柄方位：四角 + 四边
export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

// 命中形状：hitNode 返回最深层（可能是形状内嵌 Text），沿父链回溯到 Shape
export function hitShape(
  children: readonly Node[],
  p: { x: number; y: number },
): Shape | null {
  for (let i = children.length - 1; i >= 0; i--) {
    const hit = children[i].hitNode(p.x, p.y);
    if (!hit) continue;
    let cur: Node | null = hit;
    while (cur && !(cur instanceof Shape)) cur = cur.parent;
    if (cur) return cur;
  }
  return null;
}

// 端口显示位置：边中点沿外法向偏移 PORT_OFFSET 屏幕像素（圆点浮在形状外侧）。
// 节点描边为 border-box（画在尺寸内部、外缘即几何边界），圆点与可见边线的间距恒定
export function portPos(
  shape: Shape,
  dir: "top" | "right" | "bottom" | "left",
  scale: number,
) {
  const port = shape.portAt(dir);
  const off = PORT_OFFSET / scale;
  const d = {
    top: { x: 0, y: -1 },
    right: { x: 1, y: 0 },
    bottom: { x: 0, y: 1 },
    left: { x: -1, y: 0 },
  }[dir];
  return { x: port.x + d.x * off, y: port.y + d.y * off };
}

// 端口命中：返回命中的方向，未命中返回 null（按外浮后的圆点位置判定）
export function portHit(
  shape: Shape,
  p: { x: number; y: number },
  scale: number,
) {
  // 命中范围 = 悬浮放大后的视觉圆（PORT_RADIUS * PORT_HOVER_SCALE），
  // 进入即触发悬浮/点击，之外不响应
  const r = (PORT_RADIUS * PORT_HOVER_SCALE) / scale;
  for (const dir of ["top", "right", "bottom", "left"] as const) {
    const port = portPos(shape, dir, scale);
    if (Math.hypot(p.x - port.x, p.y - port.y) <= r) return dir;
  }
  return null;
}

// 四角手柄命中（屏幕像素半径换算到世界坐标），形状与框选框通用
export function cornerHit(
  b: Bounds,
  p: { x: number; y: number },
  scale: number,
): "nw" | "ne" | "se" | "sw" | null {
  const r = HANDLE_HIT / scale;
  const { x, y, width: w, height: h } = b;
  const corners: Array<["nw" | "ne" | "se" | "sw", number, number]> = [
    ["nw", x, y],
    ["ne", x + w, y],
    ["se", x + w, y + h],
    ["sw", x, y + h],
  ];
  for (const [handle, cx, cy] of corners) {
    if (Math.hypot(p.x - cx, p.y - cy) <= r) return handle;
  }
  return null;
}

// bounds 边线命中（四边拖拽缩放）：距边线 EDGE_TOLERANCE 内命中；
// 四角让位给角手柄、四边中点让位给连线端口（连接与缩放互不干扰）
export function edgeHit(
  b: Bounds,
  p: { x: number; y: number },
  scale: number,
): "n" | "e" | "s" | "w" | null {
  const tol = EDGE_TOLERANCE / scale;
  const nearCorner = HANDLE_HIT / scale + 2;
  const nearPort = PORT_HIT_RADIUS;
  const { x, y, width: w, height: h } = b;
  const sides: Array<
    [
      "n" | "e" | "s" | "w",
      { x: number; y: number },
      { x: number; y: number },
    ]
  > = [
    ["n", { x, y }, { x: x + w, y }],
    ["e", { x: x + w, y }, { x: x + w, y: y + h }],
    ["s", { x, y: y + h }, { x: x + w, y: y + h }],
    ["w", { x, y }, { x, y: y + h }],
  ];
  for (const [side, a, b] of sides) {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len === 0) continue;
    // 点到线段的投影参数 t（截断到 0..1）与垂距
    const t = Math.max(
      0,
      Math.min(
        1,
        ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len),
      ),
    );
    const proj = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (Math.hypot(p.x - proj.x, p.y - proj.y) > tol) continue;
    const along = t * len;
    if (along < nearCorner || len - along < nearCorner) continue;
    if (Math.abs(along - len / 2) < nearPort) continue;
    return side;
  }
  return null;
}

// 命中连线：距折线各段容差内命中；可见标签的白底盒同样算连线的一部分
//（标签盒遮住线体且上下沿超出线宽，仅按线体容差时点击标签上下边缘会落空）
export function hitEdge(
  edges: FlowEdge[],
  p: { x: number; y: number },
  scale: number,
): FlowEdge | null {
  const tol = EDGE_TOLERANCE / scale;
  for (const edge of edges) {
    if (edge.hitPoint(p, tol)) return edge;
    const l = edge.label;
    if (
      l.visible &&
      p.x >= l.x - tol &&
      p.x <= l.x + l.width + tol &&
      p.y >= l.y - tol &&
      p.y <= l.y + l.height + tol
    )
      return edge;
  }
  return null;
}

// 连线端点手柄命中：返回命中的端，未命中返回 null
export function edgeHandleHit(
  edge: FlowEdge,
  p: { x: number; y: number },
  scale: number,
): "from" | "to" | null {
  const pts = edge.points;
  if (pts.length < 2) return null;
  const r = EDGE_HANDLE_HIT / scale;
  if (Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= r) return "from";
  const last = pts[pts.length - 1];
  if (Math.hypot(p.x - last.x, p.y - last.y) <= r) return "to";
  return null;
}

// 悬停光标：手柄/边线给缩放光标（端口与节点本体保持默认光标）
export function hoverCursor(
  shape: Shape,
  p: { x: number; y: number },
  scale: number,
): string | null {
  const corner = cornerHit(shape, p, scale);
  if (corner)
    return corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
  const side = edgeHit(shape, p, scale);
  if (side) return side === "n" || side === "s" ? "ns-resize" : "ew-resize";
  return null;
}

// 自由拖拽时预览的虚拟进入方向：与出口方向同轴，按光标相对出口端口的位置
// 选边——光标在出口外法向一侧时沿行进方向顺势进入对侧（如从下方出来、
// 光标在下方则按从上面进入，形成下、右、下的顺向路径），越过出口端口时同侧进入
export function previewToDir(
  exitDir: PortDir,
  exitPort: { x: number; y: number },
  p: { x: number; y: number },
): PortDir {
  const v = PORT_DIR_VEC[exitDir];
  const proj = (p.x - exitPort.x) * v.x + (p.y - exitPort.y) * v.y;
  return proj > 0 ? OPPOSITE_DIR[exitDir] : exitDir;
}

// 多个形状的并集包围盒（接受任意含 x/y/width/height 的载体，含原始位置快照）
export function unionBounds(
  shapes: Array<{ x: number; y: number; width: number; height: number }>,
): Bounds {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const s of shapes) {
    x0 = Math.min(x0, s.x);
    y0 = Math.min(y0, s.y);
    x1 = Math.max(x1, s.x + s.width);
    y1 = Math.max(y1, s.y + s.height);
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

// 与框选矩形相交的形状（相交即命中）
export function marqueeHits(shapes: Iterable<Shape>, r: Bounds): Shape[] {
  return [...shapes].filter(
    (sh) =>
      sh.x < r.x + r.width &&
      sh.x + sh.width > r.x &&
      sh.y < r.y + r.height &&
      sh.y + sh.height > r.y,
  );
}

// 连线拖拽吸附目标查找：光标进入某节点包围盒外扩 LINK_SNAP_MARGIN 范围时，
// 该节点成为目标，并吸附到距光标最近的端口（任意节点均可，包括连线/预览
// 自身的节点——支持改接边与自环）；无节点在感应范围内返回 null
export function findLinkTarget(
  shapes: Iterable<Shape>,
  p: { x: number; y: number },
  scale: number,
): { target: Shape; snap: PortDir } | null {
  const m = LINK_SNAP_MARGIN / scale;
  for (const shape of shapes) {
    if (
      p.x < shape.x - m ||
      p.x > shape.x + shape.width + m ||
      p.y < shape.y - m ||
      p.y > shape.y + shape.height + m
    )
      continue;
    let best = Infinity;
    let snap: PortDir = "top";
    for (const dir of ["top", "right", "bottom", "left"] as const) {
      const q = portPos(shape, dir, scale);
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < best) {
        best = d;
        snap = dir;
      }
    }
    return { target: shape, snap };
  }
  return null;
}

// 按手柄方位应用缩放：对侧边/对角锚定，尺寸钳制到 MIN_SIZE
export function applyResize(
  shape: Shape,
  handle: ResizeHandle,
  origin: Bounds,
  dx: number,
  dy: number,
) {
  let { x, y, width: w, height: h } = origin;
  if (handle.includes("e")) w = origin.width + dx;
  if (handle.includes("s")) h = origin.height + dy;
  if (handle.includes("w")) w = origin.width - dx;
  if (handle.includes("n")) h = origin.height - dy;
  if (handle.length === 2) {
    // 角手柄：锁定比例等比缩放，取相对变化更大的轴作为统一缩放比
    // （边手柄仅单轴生效，仍可自由改变比例）
    const r = Math.max(
      Math.abs(w / origin.width) >= Math.abs(h / origin.height)
        ? w / origin.width
        : h / origin.height,
      MIN_SIZE / origin.width,
      MIN_SIZE / origin.height,
    );
    w = origin.width * r;
    h = origin.height * r;
  } else {
    w = Math.max(MIN_SIZE, w);
    h = Math.max(MIN_SIZE, h);
  }
  // 锚点：拖拽方向的对侧边/角固定不动
  if (handle.includes("w")) x = origin.x + origin.width - w;
  if (handle.includes("n")) y = origin.y + origin.height - h;
  shape.x = x;
  shape.y = y;
  shape.width = w;
  shape.height = h;
  shape.layout();
}

// 多选组合缩放：以组合 bounds 的对侧为锚点，按整体缩放比等比变换每个成员
// 的位置与尺寸；按组内最小形状钳制缩放比，保证任何成员不低于 MIN_SIZE
export function applyGroupResize(
  handle: ResizeHandle,
  origin: Bounds,
  origins: Array<{
    shape: Shape;
    x: number;
    y: number;
    width: number;
    height: number;
  }>,
  dx: number,
  dy: number,
) {
  let sx = 1;
  let sy = 1;
  if (handle.includes("e")) sx = (origin.width + dx) / origin.width;
  if (handle.includes("w")) sx = (origin.width - dx) / origin.width;
  if (handle.includes("s")) sy = (origin.height + dy) / origin.height;
  if (handle.includes("n")) sy = (origin.height - dy) / origin.height;
  const minW = Math.min(...origins.map((g) => g.width));
  const minH = Math.min(...origins.map((g) => g.height));
  if (handle.length === 2) {
    // 角手柄：锁定比例等比缩放，取相对变化更大的轴作为统一缩放比
    // （边手柄仅单轴生效，仍可自由改变比例）
    const r = Math.max(
      Math.abs(sx) >= Math.abs(sy) ? sx : sy,
      MIN_SIZE / minW,
      MIN_SIZE / minH,
    );
    sx = r;
    sy = r;
  } else {
    sx = Math.max(sx, MIN_SIZE / minW);
    sy = Math.max(sy, MIN_SIZE / minH);
  }
  // 锚点：拖拽方向的对侧边/角固定不动
  const ax = handle.includes("w") ? origin.x + origin.width : origin.x;
  const ay = handle.includes("n") ? origin.y + origin.height : origin.y;
  for (const g of origins) {
    g.shape.x = ax + (g.x - ax) * sx;
    g.shape.y = ay + (g.y - ay) * sy;
    g.shape.width = g.width * sx;
    g.shape.height = g.height * sy;
    g.shape.layout();
  }
}

// ---- 端口方向快速创建的共享几何 ----
//
// 端口手柄点击新建节点（interactions.createNodeInDirection）与 AI 语义图新增节点
// 落位（ai-protocol.mergeFlowGeometry）共用同一份口径，避免两套几何各自实现。

// 沿 dir 在源节点外侧放置新节点：边缘间距 CLICK_CREATE_GAP，垂直于方向的
// 轴线与源节点中心对齐。交互入口传入在位 Shape，程序化入口传入数据快照即可。
export function placeNodeInDirection(
  source: { x: number; y: number; width: number; height: number },
  dir: PortDir,
  size: { width: number; height: number },
): { x: number; y: number } {
  if (dir === "right") {
    return {
      x: source.x + source.width + CLICK_CREATE_GAP,
      y: source.y + (source.height - size.height) / 2,
    };
  }
  if (dir === "left") {
    return {
      x: source.x - CLICK_CREATE_GAP - size.width,
      y: source.y + (source.height - size.height) / 2,
    };
  }
  if (dir === "bottom") {
    return {
      x: source.x + (source.width - size.width) / 2,
      y: source.y + source.height + CLICK_CREATE_GAP,
    };
  }
  return {
    x: source.x + (source.width - size.width) / 2,
    y: source.y - CLICK_CREATE_GAP - size.height,
  };
}

// 由两节点中心的主导方向推断端口方向（与 FlowEdge 构造时 hints 缺省的选边口径一致）：
// 语义图不含方向信息，程序据此把「布局里在谁下方/右侧」翻译成手柄方向
export function dominantPortDir(
  from: { x: number; y: number; width: number; height: number },
  to: { x: number; y: number; width: number; height: number },
): PortDir {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}
