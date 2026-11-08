import { App, EdgePan } from "@silker/core";
import type { HistoryCapability } from "@silker/core";
import { compose } from "@silker/core";
import { POINTER_CAPABILITY } from "@silker/core";
import type { SelectionCapability } from "@silker/core";
import type { TextEditorCapability } from "@silker/core";
import { FlowEdge, OPPOSITE_DIR, PORT_STUB } from "./FlowEdge";
import type { PortDir } from "./FlowEdge";
import { LinkPreview } from "./overlay";
import { Shape } from "./Shape";
import {
  applyGroupResize,
  applyResize,
  cornerHit,
  edgeHandleHit,
  edgeHit,
  findLinkTarget,
  hitEdge,
  hitShape,
  portHit,
  previewToDir,
  unionBounds,
} from "./geometry";
import type { ResizeHandle } from "./geometry";
import type { Bounds, SnapGuides } from "./snap";
import type { SnapCapability } from "./snap-capability";
import type { EdgeRouterCapability } from "./edge-router";
import {
  groupResizeCommand,
  moveCommand,
  nudgeCommand,
  reconnectCommand,
  resizeCommand,
  shapeData,
} from "./commands";
import { CLICK_CREATE_GAP, CLICK_MOVE_TOLERANCE } from "./session";
import type { Session } from "./session";
import { multiBounds, selEdge, selShape, selShapes } from "./selection";
import type { FlowChangeType } from "./data";
import type { FlowEditing } from "./editing";
import type { HoverFeedback } from "./hover";
import type { FlowModel } from "./model";

// 交互依赖：能力与协作模块经门面装配注入，本类不自建
export interface FlowInteractionsDeps {
  app: App;
  canvas: HTMLCanvasElement;
  model: FlowModel;
  // 选中能力（Selection 插件注册）：单选/多选模型统一存取
  sel: SelectionCapability<Shape | FlowEdge>;
  editing: FlowEditing;
  hover: HoverFeedback;
  snapper: SnapCapability;
  router: EdgeRouterCapability;
  editor: TextEditorCapability;
  history: HistoryCapability;
  onChange?: (type: FlowChangeType) => void;
}

// 交互会话控制器：指针事件 → 交互策略（点选、拖拽移动/缩放、端口连线、
// 端点重接、方向键微移）与选中语义；会话/吸附/框选组合框状态归本类所有
export class FlowInteractions {
  // 当前交互会话（拖拽移动/缩放/组合缩放/连线/端点重接，无会话为 null）
  private session: Session | null = null;
  // 连线拖拽吸附状态：接近中的目标节点与吸附中的端口方向
  linkTarget: Shape | null = null;
  linkSnap: PortDir | null = null;
  // 节点拖拽对齐参考线（applySnap 更新，拖拽结束清除）
  guides: SnapGuides | null = null;
  // 吸附迟滞状态：上一帧两轴是否处于对齐吸附态（拖拽会话内逐帧回传给
  // computeSnap，会话结束清零），已吸附的轴用加倍的释放容差维持吸附，
  // 光标在阈值边界抖动时吸附不反复进出
  private snapPrev = { x: false, y: false };
  // 框选拖拽中的实时组合框（已框中节点的并集 bounds，供覆盖层绘制；松手后清空，
  // 由门面的 selection.onMarqueeMove/onMarqueeEnd 写入）
  marqueeCombo: Bounds | null = null;
  // 边缘自动平移（core 机制）：节点拖拽移动中指针贴近画布边缘时持续平移视口，
  // 每次平移后按指针屏幕坐标重放移动逻辑（节点跟随鼠标）；相机-only 呈现由 core 负责
  private edgePan: EdgePan;

  constructor(private deps: FlowInteractionsDeps) {
    this.edgePan = new EdgePan(deps.app, (x, y) => this.onEdgePan(x, y));
  }

  // 边缘平移帧回调：仅节点移动会话跟随（缩放/连线等会话不平移视口）
  private onEdgePan(clientX: number, clientY: number) {
    const s = this.session;
    if (!s || s.kind !== "move") return;
    this.applyMove(s, this.deps.app.camera.toWorld(clientX, clientY));
  }

  // 移动会话帧应用：按世界坐标 p 重放「按下时原始位置 + 本帧位移 + 吸附修正」，
  // mousemove 与边缘自动平移的帧回调共用（平移后无需鼠标再动，节点也要跟随）
  private applyMove(
    s: Extract<Session, { kind: "move" }>,
    p: { x: number; y: number },
  ) {
    if (s.group) {
      // 组合移动：以整体框（成员并集 bounds）的四边/中线与外部节点对齐吸附，
      // 全部组内成员（含被按住的主节点）不作为参考目标，避免内部基线；
      // 全量拖拽位移 + 吸附修正统一应用到全部成员。
      // 吸附基准框必须由各成员"按下时原始位置 + 本帧原始位移"构成——若混入
      // 已被上一帧吸附修正过的当前位置，上一帧的修正量会泄漏进本帧的吸附
      // 计算，吸附会在开/关之间震荡（参考线闪烁、整体位置抖动）
      const exclude = new Set([s.shape, ...s.group.map((g) => g.shape)]);
      const b0 = unionBounds([
        {
          x: s.origin.x,
          y: s.origin.y,
          width: s.shape.width,
          height: s.shape.height,
        },
        ...s.group.map((g) => ({
          x: g.x,
          y: g.y,
          width: g.shape.width,
          height: g.shape.height,
        })),
      ]);
      b0.x += p.x - s.start.x;
      b0.y += p.y - s.start.y;
      const box: Bounds = { ...b0 };
      this.applySnap(box, exclude);
      const mx = p.x - s.start.x + (box.x - b0.x);
      const my = p.y - s.start.y + (box.y - b0.y);
      s.shape.x = s.origin.x + mx;
      s.shape.y = s.origin.y + my;
      for (const g of s.group) {
        g.shape.x = g.x + mx;
        g.shape.y = g.y + my;
      }
    } else {
      s.shape.x = s.origin.x + (p.x - s.start.x);
      s.shape.y = s.origin.y + (p.y - s.start.y);
      this.applySnap(s.shape);
    }
    this.deps.app.requestRender();
  }

  // 交互会话进行中（undo/redo 拒绝执行的判定）
  get busy(): boolean {
    return this.session !== null;
  }

  // 统一指针监听：绑定/撤销与屏幕→世界坐标换算由指针能力承担（机制层），
  // 本场景只声明各事件的交互策略；返回的撤销函数由门面并入 cleanups 统一管理
  bind(canvas: HTMLCanvasElement): () => void {
    const pointer = this.deps.app.require(POINTER_CAPABILITY);
    return pointer.bind(canvas, {
      onDown: (e) => this.onDown(e),
      onWindowMove: (e) => this.onMove(e),
      onWindowUp: (e) => this.onUp(e),
      onKeydown: (e) => this.onKeyDown(e),
    });
  }

  // 悬浮连线待编辑态：按下时命中已选中的连线（第二次点击，即"双击"语义），
  // 抬起未拖动时进入标签编辑（与节点"单击已选中进入编辑"同一交互模式；
  // 延迟到抬起是为避开编辑覆盖层聚焦与本次点击事件的焦点竞争）
  private pendingEdgeEdit: { edge: FlowEdge; press: { x: number; y: number } } | null =
    null;

  private onDown(e: MouseEvent) {
    if (e.button !== 0) return;
    const p = this.deps.app.camera.toWorld(e.clientX, e.clientY);
    const scale = this.deps.app.camera.viewport.scale;
    this.pendingEdgeEdit = null;
    // 按下后进入交互会话，悬浮端口提示不再显示
    this.deps.hover.reset();
    // 选中态下按优先级命中：角手柄缩放 → 端口连线 → 边线缩放 → 形状体移动
    const sel = selShape(this.deps.sel);
    if (sel) {
      const corner = cornerHit(sel, p, scale);
      if (corner) {
        this.session = {
          kind: "resize",
          shape: sel,
          handle: corner,
          start: p,
          origin: { x: sel.x, y: sel.y, width: sel.width, height: sel.height },
        };
        return;
      }
      const dir = portHit(sel, p, scale);
      if (dir) {
        // 按下时不创建预览边（此刻无法区分点击/拖拽）：位移超过点击阈值
        // 进入拖拽连线时才插入预览并取消选中（见 onMove 的 armed 逻辑）
        const preview = new LinkPreview();
        preview.router = this.deps.router;
        preview.from = sel.portAt(dir);
        preview.fromDir = dir;
        preview.fromStub = sel.portStub(dir);
        preview.to = p;
        preview.toDir = previewToDir(dir, preview.from, p);
        this.session = {
          kind: "link",
          source: sel,
          sourceDir: dir,
          preview,
          start: p,
        };
        this.deps.app.requestRender();
        return;
      }
      const side = edgeHit(sel, p, scale);
      if (side) {
        this.session = {
          kind: "resize",
          shape: sel,
          handle: side,
          start: p,
          origin: { x: sel.x, y: sel.y, width: sel.width, height: sel.height },
        };
        return;
      }
    }
    // 激活连线的首尾手柄：拖拽重接该端（优先于命中其他形状）
    const selEdgeDown = selEdge(this.deps.sel);
    if (selEdgeDown) {
      const edge = selEdgeDown;
      const which = edgeHandleHit(edge, p, scale);
      if (which) {
        // 护住激活覆盖层焦点：mousedown 的默认动作（焦点移向不可聚焦的 canvas，
        // 即回落 body）会 blur 覆盖层 → TextEditor 切回隐藏态，重接结束后打字
        // 不再直接进入标签。preventDefault 只拦焦点移动，拖拽重接不受影响
        e.preventDefault();
        // 直接拖拽原连线：被拖端进入拖拽态，路由以光标为虚拟端口
        const fixedDir = which === "from" ? edge.toDir : edge.fromDir;
        const fixedPort =
          which === "from"
            ? edge.toNode.portAt(edge.toDir)
            : edge.fromNode.portAt(edge.fromDir);
        edge.dragWhich = which;
        edge.dragPoint = p;
        edge.dragDir = previewToDir(fixedDir, fixedPort, p);
        this.session = { kind: "edge-move", edge, which };
        this.deps.canvas.style.cursor = "crosshair";
        this.deps.app.requestRender();
        return;
      }
    }
    // 多选组合框的手柄/边线：整体缩放（优先于命中形状）
    const mb = multiBounds(this.deps.sel);
    if (mb) {
      const handle = cornerHit(mb, p, scale) ?? edgeHit(mb, p, scale);
      if (handle) {
        this.session = {
          kind: "group-resize",
          handle,
          start: p,
          origin: mb,
          origins: selShapes(this.deps.sel).map((s) => ({
            shape: s,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
          })),
        };
        return;
      }
    }
    const hit = hitShape(this.deps.app.children, p);
    if (hit) {
      // 按下在已单选节点上：记录屏幕坐标，抬起未拖动时进入编辑（拖拽仍优先）。
      // 多选组内按下不记录（未拖动的抬起塌缩为单选，不进编辑）
      const press =
        this.deps.sel.items.length === 1 && this.deps.sel.items[0] === hit
          ? { x: e.clientX, y: e.clientY }
          : undefined;
      if (this.deps.sel.items.includes(hit)) {
        // 组内形状：整体移动，保持多选（单击不动则抬起时塌缩为单选）
        this.session = {
          kind: "move",
          shape: hit,
          start: p,
          origin: { x: hit.x, y: hit.y },
          moved: false,
          press,
          group: selShapes(this.deps.sel)
            .filter((s) => s !== hit)
            .map((s) => ({ shape: s, x: s.x, y: s.y })),
        };
      } else {
        this.select(hit);
        this.session = {
          kind: "move",
          shape: hit,
          start: p,
          origin: { x: hit.x, y: hit.y },
          moved: false,
          group: null,
          press,
        };
      }
      return;
    }
    // 形状未命中时尝试命中连线（形状层在上，优先选中形状）；
    // 已选中的连线再次点击（双击语义）时抬起进入标签编辑
    const hitLine = hitEdge(this.deps.model.edges, p, scale);
    if (hitLine) {
      // 关键：连线激活在 mousedown 内同步执行（select → activateLabel →
      // editor.start 的 el.focus 已在本事件处理器中完成）。若放行 mousedown
      // 默认动作，焦点会在处理器返回后被浏览器夺回 body，覆盖层 blur 切回
      // 隐藏态，激活态打字全部落空。mindmap 在 click（mouseup 后）里激活
      // 无此竞争，此处必须显式 preventDefault 护住覆盖层焦点
      e.preventDefault();
      const already =
        this.deps.sel.items.length === 1 && this.deps.sel.items[0] === hitLine;
      this.select(hitLine);
      if (already)
        this.pendingEdgeEdit = { edge: hitLine, press: { x: e.clientX, y: e.clientY } };
      this.deps.app.requestRender();
      return;
    }
    // 选中形状（单/多选通用）：选框并集内任意位置按下即整体移动（无需按在
    // 节点上，菱形/椭圆空白角落也可拖拽）；未拖动时保持原选中态不塌缩
    const selList = selShapes(this.deps.sel);
    if (selList.length) {
      const b = unionBounds(selList);
      if (
        p.x >= b.x &&
        p.x <= b.x + b.width &&
        p.y >= b.y &&
        p.y <= b.y + b.height
      ) {
        const [first, ...rest] = selList;
        this.session = {
          kind: "move",
          shape: first,
          start: p,
          origin: { x: first.x, y: first.y },
          moved: false,
          group: rest.length
            ? rest.map((s) => ({ shape: s, x: s.x, y: s.y }))
            : null,
          keepMulti: true,
        };
        return;
      }
    }
    // 空白按下：立即取消选中，框选会话由选中插件接管（橡皮筋 + 松手落定多选）
    this.select(null);
    this.deps.sel.beginMarquee(e);
  }

  private onMove(e: MouseEvent) {
    const s = this.session;
    // 无会话时做悬停反馈：缩放手柄/边线/端口/形状体/连线分别给对应光标。
    // 框选会话中跳过：悬浮命中是 O(n) 全树遍历 + O(m) 连线扫掠（每事件执行），
    // 橡皮筋扫过连线时 hoverEdge 翻转还会触发全量重光栅化——大场景框选卡顿主因
    if (!s) {
      if (!this.deps.sel.marqueeActive) this.deps.hover.track(e);
      return;
    }
    const p = this.deps.app.camera.toWorld(e.clientX, e.clientY);
    if (s.kind === "move") {
      s.moved = true;
      // 边缘自动平移：记录指针位置并确保会话循环在跑（幂等，会话结束在 onUp 停止）
      this.edgePan.start(e.clientX, e.clientY);
      this.applyMove(s, p);
    } else if (s.kind === "resize") {
      applyResize(s.shape, s.handle, s.origin, p.x - s.start.x, p.y - s.start.y);
      this.deps.app.requestRender();
    } else if (s.kind === "group-resize") {
      applyGroupResize(s.handle, s.origin, s.origins, p.x - s.start.x, p.y - s.start.y);
      this.deps.app.requestRender();
    } else if (s.kind === "link") {
      const scale = this.deps.app.camera.viewport.scale;
      // 位移超过点击阈值才确认是拖拽连线：此时才插入预览边并取消选中
      if (!s.armed) {
        if (
          Math.hypot(p.x - s.start.x, p.y - s.start.y) <=
          CLICK_MOVE_TOLERANCE / scale
        )
          return;
        s.armed = true;
        const idx = this.deps.app.children.findIndex((n) => n instanceof Shape);
        this.deps.app.insert(s.preview, idx === -1 ? this.deps.app.children.length : idx);
        this.deps.canvas.style.cursor = "crosshair";
        this.select(null);
      }
      this.updateLinkTarget(p);
      // 吸附时预览以手柄的具体位置与端口方向渲染；自由拖拽时按光标相对
      // 出口端口的位置确定虚拟进入方向
      if (this.linkTarget && this.linkSnap) {
        s.preview.to = this.linkTarget.portAt(this.linkSnap);
        s.preview.toDir = this.linkSnap;
        s.preview.toStub = this.linkTarget.portStub(this.linkSnap);
      } else {
        s.preview.to = p;
        s.preview.toStub = PORT_STUB;
        s.preview.toDir = previewToDir(s.sourceDir, s.preview.from, p);
      }
      this.deps.app.requestRender();
    } else if (s.kind === "edge-move") {
      // 原连线被拖端跟随光标：吸附时落在目标手柄上，自由拖拽时按出口方向
      // 与光标位置确定虚拟进入方向。任意节点均可吸附（含本连线两端节点，
      // 可调整接入边或形成自环）
      this.updateLinkTarget(p);
      if (this.linkTarget && this.linkSnap) {
        s.edge.dragPoint = this.linkTarget.portAt(this.linkSnap);
        s.edge.dragDir = this.linkSnap;
      } else {
        const fixedDir = s.which === "from" ? s.edge.toDir : s.edge.fromDir;
        const fixedPort =
          s.which === "from"
            ? s.edge.toNode.portAt(s.edge.toDir)
            : s.edge.fromNode.portAt(s.edge.fromDir);
        s.edge.dragPoint = p;
        s.edge.dragDir = previewToDir(fixedDir, fixedPort, p);
      }
      this.deps.app.requestRender();
    }
  }

  // 连线拖拽中更新吸附目标：光标进入某节点包围盒外扩 LINK_SNAP_MARGIN 范围时，
  // 该节点成为目标（浮出对接手柄），并吸附到距光标最近的端口（任意节点均可，
  // 包括连线/预览自身的节点——支持改接边与自环）
  private updateLinkTarget(p: { x: number; y: number }) {
    const r = findLinkTarget(
      this.deps.model.shapes.values(),
      p,
      this.deps.app.camera.viewport.scale,
    );
    this.linkTarget = r ? r.target : null;
    this.linkSnap = r ? r.snap : null;
  }

  // 节点拖拽吸附：候选参考目标 = 除被拖载体（单形状）与组内成员（组合拖拽）
  // 之外的全部形状；吸附算法按能力键消费（BuiltinSnap 官方实现，第三方可覆盖），
  // 这里只负责筛选候选、回传迟滞状态、把位移写回载体
  private applySnap(shape: Bounds, exclude: Set<Shape> | null = null) {
    const scale = this.deps.app.camera.viewport.scale;
    const candidates = [...this.deps.model.shapes.values()].filter(
      (o) => o !== shape && !(exclude && exclude.has(o)),
    );
    const r = this.deps.snapper.snap({
      box: shape,
      candidates,
      scale,
      prev: this.snapPrev,
    });
    this.snapPrev = { x: r.snappedX, y: r.snappedY };
    shape.x += r.dx;
    shape.y += r.dy;
    this.guides = r.guides;
  }

  private onUp(e: MouseEvent) {
    const s = this.session;
    if (!s) {
      // 无会话的抬起：命中已选中连线的点击（双击语义）且未拖动时进入标签编辑
      const pend = this.pendingEdgeEdit;
      this.pendingEdgeEdit = null;
      if (
        pend &&
        Math.hypot(e.clientX - pend.press.x, e.clientY - pend.press.y) <=
          CLICK_MOVE_TOLERANCE
      )
        this.deps.editing.startEdit(pend.edge, pend.press);
      return;
    }
    this.session = null;
    // 交互会话结束：停止边缘自动平移（仅移动会话启动过，幂等）
    this.edgePan.stop();
    this.deps.canvas.style.cursor = "";
    if (s.kind === "move") {
      this.guides = null;
      this.snapPrev = { x: false, y: false };
      this.deps.app.requestRender(); // 清除参考线后立即重绘，否则画面残留拖拽时最后一帧
      if (s.moved) {
        // 拖拽移动记录为可逆命令（变更已发生）：主节点与组内成员合并为一条，
        // undo 一次全回退；位置全部未变（吸附归位）时不记录
        const before = [
          { shape: s.shape, x: s.origin.x, y: s.origin.y },
          ...(s.group ?? []).map((g) => ({ shape: g.shape, x: g.x, y: g.y })),
        ];
        const after = before.map((m) => ({
          shape: m.shape,
          x: m.shape.x,
          y: m.shape.y,
        }));
        if (before.some((m) => m.shape.x !== m.x || m.shape.y !== m.y)) {
          this.deps.history.record(moveCommand(before, after));
        }
        this.deps.onChange?.("move");
      } else if (s.press && Math.hypot(e.clientX - s.press.x, e.clientY - s.press.y) <= CLICK_MOVE_TOLERANCE)
        // 未拖动的点击落在已选中节点上：进入编辑（光标聚焦到点击处）
        this.deps.editing.startEdit(s.shape, s.press);
      else if (s.group && !s.keepMulti) this.select(s.shape); // 组内单击未拖动：塌缩为单选该形状
    } else if (s.kind === "resize") {
      const o = s.origin;
      if (
        s.shape.x !== o.x ||
        s.shape.y !== o.y ||
        s.shape.width !== o.width ||
        s.shape.height !== o.height
      ) {
        // 缩放记录为可逆命令（变更已发生）：before/after 各定格一份 bounds
        this.deps.history.record(
          resizeCommand(
            s.shape,
            { x: o.x, y: o.y, width: o.width, height: o.height },
            {
              x: s.shape.x,
              y: s.shape.y,
              width: s.shape.width,
              height: s.shape.height,
            },
          ),
        );
        this.deps.onChange?.("resize");
      }
    } else if (s.kind === "group-resize") {
      // 有成员相对初始状态发生变化时通知，并记录为可逆命令（变更已发生）
      if (
        s.origins.some(
          (g) =>
            g.shape.x !== g.x ||
            g.shape.y !== g.y ||
            g.shape.width !== g.width ||
            g.shape.height !== g.height,
        )
      ) {
        const before = s.origins.map((g) => ({
          shape: g.shape,
          x: g.x,
          y: g.y,
          width: g.width,
          height: g.height,
        }));
        const after = s.origins.map((g) => ({
          shape: g.shape,
          x: g.shape.x,
          y: g.shape.y,
          width: g.shape.width,
          height: g.shape.height,
        }));
        this.deps.history.record(groupResizeCommand(before, after));
        this.deps.onChange?.("resize");
      }
    } else if (s.kind === "edge-move") {
      // 端点重接结束：退出拖拽态；吸附目标按其端口重接（任意节点，含本连线
      // 两端节点）；未吸附时按落点命中节点重接（主导方向自动选边），纯点击
      // 落回被拖端原节点时视为无操作，连线保持原状
      s.edge.dragWhich = null;
      const target = this.linkTarget;
      const snap = this.linkSnap;
      this.linkTarget = null;
      this.linkSnap = null;
      const hit =
        target ?? hitShape(this.deps.app.children, this.deps.app.camera.toWorld(e.clientX, e.clientY));
      const cur = s.which === "from" ? s.edge.fromNode : s.edge.toNode;
      if (hit && !(hit === cur && !target)) {
        // 重接前定格原端（节点 + 端口方向），undo/redo 对称重接
        const oldNode = cur;
        const oldDir = s.which === "from" ? s.edge.fromDir : s.edge.toDir;
        s.edge.reattachEnd(s.which, hit, target && snap ? snap : undefined);
        const newNode = s.which === "from" ? s.edge.fromNode : s.edge.toNode;
        const newDir = s.which === "from" ? s.edge.fromDir : s.edge.toDir;
        this.deps.history.record(
          reconnectCommand(s.edge, s.which, oldNode, oldDir, newNode, newDir),
        );
        this.deps.onChange?.("reconnect");
      }
      this.deps.app.requestRender();
    } else {
      // 连线交互结束：移除预览。（源形状在按下时已取消激活）
      // 纯点击端口（位移在阈值内）：沿端口方向自动新建节点并连线；
      // 拖拽时吸附中的目标按其端口固定创建连线，否则按落点命中建边
      this.deps.model.removeTop(s.preview);
      const target = this.linkTarget;
      const snap = this.linkSnap;
      this.linkTarget = null;
      this.linkSnap = null;
      const p = this.deps.app.camera.toWorld(e.clientX, e.clientY);
      // 未进入拖拽态（armed）即为纯点击端口：沿端口方向自动新建节点并连线
      if (!s.armed) {
        this.createNodeInDirection(s.source, s.sourceDir);
      } else if (target && snap) {
        this.deps.model.addEdgeBetween(s.source, target, true, {
          from: s.sourceDir,
          to: snap,
        });
      } else {
        const hit = hitShape(this.deps.app.children, p);
        if (hit && hit !== s.source)
          this.deps.model.addEdgeBetween(s.source, hit, true);
      }
      this.deps.app.requestRender();
    }
  }

  // 端口点击快速创建：沿端口方向新建与源节点同类型、同尺寸的节点并连线
  //（边缘间距 CLICK_CREATE_GAP，垂直于方向的轴线与源节点中心对齐），
  // 新节点进入选中态
  private createNodeInDirection(source: Shape, dir: PortDir) {
    const shape = this.deps.model.createShape(source.kind, {
      width: source.width,
      height: source.height,
    });
    if (dir === "right") {
      shape.x = source.x + source.width + CLICK_CREATE_GAP;
      shape.y = source.y + (source.height - shape.height) / 2;
    } else if (dir === "left") {
      shape.x = source.x - CLICK_CREATE_GAP - shape.width;
      shape.y = source.y + (source.height - shape.height) / 2;
    } else if (dir === "bottom") {
      shape.x = source.x + (source.width - shape.width) / 2;
      shape.y = source.y + source.height + CLICK_CREATE_GAP;
    } else {
      shape.x = source.x + (source.width - shape.width) / 2;
      shape.y = source.y - CLICK_CREATE_GAP - shape.height;
    }
    // 节点注册与连线创建组合为一条原子命令（不预先注册，避免 exec 重放时重复入列）：
    // undo 逆序回退——先摘连线再摘节点，整体回到创建前；redo 顺序重建
    const edge = new FlowEdge(source, shape, {
      from: dir,
      to: OPPOSITE_DIR[dir],
    });
    edge.router = this.deps.router;
    this.deps.history.exec(
      compose(
        "add",
        {
          redo: () => this.deps.model.registerShape(shape),
          undo: () => this.deps.model.removeShape(shape),
          // 序列化载荷：内嵌形状数据快照，与 addNode 命令同构
          toJSON: () => ({
            kind: "flowchart.add-shape",
            payload: { data: shapeData(shape) },
          }),
        },
        this.deps.model.edgeAddRemove(edge),
      ),
    );
    this.select(shape);
    this.deps.onChange?.("add");
  }

  private onKeyDown(e: KeyboardEvent) {
    // 覆盖层持有焦点时按键属于输入，交由编辑器处理
    if (this.deps.editing.editing || this.deps.editor.hasFocus()) return;
    // 撤销/重做/删除已注册为命令并绑定键位（构造器），由命令插件统一分发；
    // 此处只处理领域语义按键（方向键微移选中节点）
    // 方向键：微移选中节点（Shift 加速），连线不参与移动
    const dir = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }[e.key];
    if (!dir) return;
    const step = e.shiftKey ? 10 : 1;
    const dx = dir[0] * step;
    const dy = dir[1] * step;
    const targets = selShapes(this.deps.sel);
    if (!targets.length) return;
    e.preventDefault();
    // 微移记录为可逆命令（变更已发生）：undo 回到按前位置，redo 重放同向位移
    const before = targets.map((s) => ({ shape: s, x: s.x, y: s.y }));
    for (const s of targets) {
      s.x += dx;
      s.y += dy;
    }
    this.deps.history.record(nudgeCommand(targets, dx, dy, before));
    this.deps.app.requestRender();
    this.deps.onChange?.("move");
  }

  select(sel: Shape | FlowEdge | null) {
    // 多选与单选互斥：选中集合整体替换，天然互斥
    // 选中变化后悬浮端口不再有效（可能指向新选中形状的错误方向）
    this.deps.hover.clearPort();
    if (sel) {
      if (this.deps.sel.items.length === 1 && this.deps.sel.items[0] === sel)
        return;
      for (const it of this.deps.sel.items) it.selected = false;
      this.deps.sel.set([sel]);
      sel.selected = true;
      // 激活的连线提到连线层最上再渲染，避免激活样式被其他连线覆盖
      if (sel instanceof FlowEdge) this.deps.model.raiseEdgeTop(sel);
      // 单选连线：挂载标签激活覆盖层（空缓冲常驻接收打字/IME，打字即编辑）；
      // 单选形状：摘除连线标签覆盖层（形状仍走点击/双击进入编辑）
      if (sel instanceof FlowEdge) this.deps.editing.activateLabel(sel);
      else this.deps.editing.deactivateLabel();
    } else {
      if (!this.deps.sel.items.length) return;
      for (const it of this.deps.sel.items) it.selected = false;
      this.deps.sel.clear();
      this.deps.editing.deactivateLabel();
    }
    this.deps.app.requestRender();
  }
}
