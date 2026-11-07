import { App } from "@silker/core";
import type { SelectionCapability } from "@silker/core";
import { FlowEdge } from "./FlowEdge";
import type { PortDir } from "./FlowEdge";
import { Shape } from "./Shape";
import {
  cornerHit,
  edgeHandleHit,
  edgeHit,
  hitEdge,
  hitShape,
  hoverCursor,
  portHit,
} from "./geometry";
import { multiBounds, selEdge, selShape } from "./selection";

// 悬浮反馈依赖：能力与协作模块经门面注入
export interface HoverFeedbackDeps {
  app: App;
  canvas: HTMLCanvasElement;
  // 连线表（经 getter 取最新值：模型可能整体替换数组）
  edges: () => FlowEdge[];
  // 选中集合：单选形状/连线与多选组合框的派生读取（selection.ts 纯函数）
  sel: SelectionCapability<Shape | FlowEdge>;
  // 激活连线置顶（门面接线到 model.raiseEdgeTop）
  onRaiseEdgeTop: (edge: FlowEdge) => void;
}

// 悬浮反馈（无交互会话时逐帧调用）：悬浮端口与悬浮连线状态的唯一属主，
// 负责光标样式联动与连线高亮/置顶；选中框覆盖层经 port 只读悬浮端口
export class HoverFeedback {
  // 悬浮中的端口方向（单选形状的四向端口）：覆盖层放大该圆点并绘制方向箭头
  private hoverPort: PortDir | null = null;
  // 悬浮中的连线：浅蓝色高亮（类似 hoverPort，状态变化时重绘）
  private hoverEdge: FlowEdge | null = null;

  constructor(private deps: HoverFeedbackDeps) {}

  // 悬浮中的端口方向（覆盖层状态提供者只读）
  get port(): PortDir | null {
    return this.hoverPort;
  }

  // 悬浮反馈跟踪：缩放手柄/边线/端口/形状体/连线分别给对应光标
  track(e: MouseEvent) {
    // 右键拖拽视口时跳过：viewport 已设置 grabbing，不要覆盖
    if (e.buttons & 2) return;
    const p = this.deps.app.camera.toWorld(e.clientX, e.clientY);
    const scale = this.deps.app.camera.viewport.scale;
    const sel = this.deps.sel;
    // 光标反馈先行：手柄/边线给缩放光标、连线端点手柄给移动光标
    let cursor: string | null = null;
    // 多选组合框的手柄/边线优先给缩放光标
    const mb = multiBounds(sel);
    if (mb) {
      const corner = cornerHit(mb, p, scale);
      if (corner)
        cursor =
          corner === "nw" || corner === "se" ? "nwse-resize" : "nesw-resize";
      else {
        const side = edgeHit(mb, p, scale);
        if (side)
          cursor = side === "n" || side === "s" ? "ns-resize" : "ew-resize";
      }
    }
    const hoverSel = selShape(sel);
    if (cursor === null)
      cursor = hoverSel ? hoverCursor(hoverSel, p, scale) : null;
    const selEdgeHover = selEdge(sel);
    if (
      cursor === null &&
      selEdgeHover &&
      edgeHandleHit(selEdgeHover, p, scale)
    )
      cursor = "move";
    // 悬浮端口跟踪：单选形状的端口上悬浮时覆盖层放大该圆点并绘制方向箭头
    const hp = hoverSel ? portHit(hoverSel, p, scale) : null;
    if (hp !== this.hoverPort) {
      this.hoverPort = hp;
      this.deps.app.requestRender();
    }
    // 悬浮连线跟踪：只有鼠标不压在任何形状或覆盖层手柄/端口上才考虑 edge 悬浮
    //（形状层在上、edge 层在下，被形状遮住的 edge 不该响应；覆盖层手柄不参与
    // 场景命中，但端点手柄压在连线上、端口浮在连线经过处，悬浮时不应穿透
    // 高亮下层连线——光标反馈已表达交互意图）
    const onHandle = cursor !== null || hp !== null;
    const shapeHit = hitShape(this.deps.app.children, p);
    const he = onHandle || shapeHit ? null : hitEdge(this.deps.edges(), p, scale);
    if (he !== this.hoverEdge) {
      const prev = this.hoverEdge;
      if (prev) prev.hovered = false;
      this.hoverEdge = he;
      // 悬浮离开（含移向另一条连线）时把激活连线重新置顶，不再被刚才的
      // 悬浮连线遮盖；随后提升新悬浮的连线，保证悬浮中的连线始终在最顶层
      const selEdgeHover2 = selEdge(sel);
      if (prev && selEdgeHover2 && selEdgeHover2 !== he)
        this.deps.onRaiseEdgeTop(selEdgeHover2);
      if (he) {
        he.hovered = true;
        this.deps.onRaiseEdgeTop(he);
      }
      this.deps.app.requestRender();
    }
    // 连线、节点、空白区域统一 default 光标，悬浮反馈由视觉（浅蓝色）而非光标表达
    this.deps.canvas.style.cursor = cursor ?? "";
  }

  // 清空悬浮状态（按下进入交互会话时调用）：端口提示消失、连线取消高亮
  reset() {
    this.hoverPort = null;
    if (this.hoverEdge) {
      this.hoverEdge.hovered = false;
      this.hoverEdge = null;
    }
  }

  // 仅清空悬浮端口（选中变化时调用：可能指向新选中形状的错误方向）
  clearPort() {
    this.hoverPort = null;
  }
}
