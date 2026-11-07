import type { FlowEdge, PortDir } from "./FlowEdge";
import type { ResizeHandle } from "./geometry";
import type { LinkPreview } from "./overlay";
import type { Shape } from "./Shape";
import type { Bounds } from "./snap";

// 端口点击快速创建：点击（非拖拽）端口时沿该方向自动新建节点并连线；
// 拖拽仍是手动连线，以按下后的位移区分两种意图
export const CLICK_MOVE_TOLERANCE = 4; // 判定点击的最大位移（屏幕像素）
export const CLICK_CREATE_GAP = 80; // 新节点与源节点边缘的间距（世界坐标）

// 交互会话：节点拖拽移动（多选时为组合移动）/ 拖拽缩放 / 框选组合缩放
// / 端口拖拽连线 / 连线端点重接（空白按下由选中插件的框选会话接管，不经会话）
export type Session =
  | {
      kind: "move";
      shape: Shape;
      start: { x: number; y: number };
      origin: { x: number; y: number };
      moved: boolean;
      group: Array<{ shape: Shape; x: number; y: number }> | null;
      keepMulti?: boolean;
      // 按下在已选中节点上的屏幕坐标：抬起未拖动时视为点击进入编辑
      press?: { x: number; y: number };
    }
  | {
      kind: "resize";
      shape: Shape;
      handle: ResizeHandle;
      start: { x: number; y: number };
      origin: Bounds;
    }
  | {
      kind: "group-resize";
      handle: ResizeHandle;
      start: { x: number; y: number };
      origin: Bounds;
      origins: Array<{
        shape: Shape;
        x: number;
        y: number;
        width: number;
        height: number;
      }>;
    }
  | {
      kind: "link";
      source: Shape;
      sourceDir: PortDir;
      preview: LinkPreview;
      start: { x: number; y: number }; // 按下位置：抬起时未进入拖拽态视为点击（快速建节点）
      armed?: boolean; // 位移超过点击阈值、确认是拖拽连线后为 true（此时才显示预览边）
    }
  | { kind: "edge-move"; edge: FlowEdge; which: "from" | "to" };
