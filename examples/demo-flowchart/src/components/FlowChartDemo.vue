<script setup lang="ts">
// 流程图 Demo 宿主：显式装配 App + 官方插件预设，再交给 FlowChart 复用
// （starter-kit 模式，应用层可自由增减/替换插件）。Vue 只管理响应式 UI 状态，
// 画布与门面实例保持为非响应式变量，避免深度代理破坏内部状态。
import { onMounted, onUnmounted, ref } from "vue";
import { App } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import { FlowChart } from "@silker/flowchart";
import type { ShapeKind } from "@silker/flowchart";
import { initialData, noteShapes, shapeOptions } from "../lib/flowchart";
import { useFlowChartAI } from "../composables/useFlowChartAI";
import Icon from "./Icon.vue";
import IconSprites from "./IconSprites.vue";
import FlowChartToolbar from "./FlowChartToolbar.vue";
import AISidebar from "./AISidebar.vue";

const canvasRef = ref<HTMLCanvasElement | null>(null);
const canUndo = ref(false);
const canRedo = ref(false);
const zoom = ref(100);
const copied = ref(false);

let app: App | null = null;
let flowchart: FlowChart | null = null;

const {
  messages,
  pending,
  busy,
  sidebarOpen,
  settingsOpen,
  prompt,
  config,
  ready,
  aiGenerate,
  send: sendAi,
  stop: stopAi,
  clear: clearChat,
  saveConfig,
  toggleSettings,
  toggleSidebar,
} = useFlowChartAI(() => flowchart);

function syncToolbar() {
  canUndo.value = flowchart?.canUndo ?? false;
  canRedo.value = flowchart?.canRedo ?? false;
}

function undo() {
  flowchart?.undo();
  syncToolbar();
}

function redo() {
  flowchart?.redo();
  syncToolbar();
}

// 新增节点落在视口中心附近（逐个略微错开避免完全重叠）
let addCount = 0;
function addShape(kind: ShapeKind, text: string) {
  const canvas = canvasRef.value;
  if (!flowchart || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  // 屏幕坐标 → 世界坐标走门面语义 API（浏览器事件坐标口径，画布偏移由相机扣除）
  const center = flowchart.screenToWorld(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  const offset = (addCount++ % 5) * 24 - 48;
  flowchart.addNode({ shape: kind, text, x: center.x - 80 + offset, y: center.y - 32 + offset });
}

function replaceShape(kind: ShapeKind) {
  flowchart?.replaceSelected(kind);
}
function copySelected() {
  flowchart?.copySelected();
}
function paste() {
  flowchart?.paste();
}
function removeSelected() {
  flowchart?.deleteSelected();
}
function fit() {
  flowchart?.fit();
}

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function copyJson() {
  if (!flowchart) return;
  void navigator.clipboard
    ?.writeText(JSON.stringify(flowchart.toJSON(), null, 2))
    .then(() => {
      copied.value = true;
      setTimeout(() => (copied.value = false), 1500);
    })
    .catch(() => undefined);
}

function exportJson() {
  if (!flowchart) return;
  const json = JSON.stringify(flowchart.toJSON(), null, 2);
  console.log(json);
  download(new Blob([json], { type: "application/json" }), "flowchart.json");
}

async function exportImage() {
  if (!flowchart) return;
  download(await flowchart.toImage({ background: "#ffffff" }), "flowchart.png");
}

async function exportImageHd() {
  if (!flowchart) return;
  // 默认已是 2x，"2 倍高清" 再翻倍到 4x
  download(
    await flowchart.toImage({ background: "#ffffff", scale: 4 }),
    "flowchart-hd.png",
  );
}

function onZoomInput(scale: number) {
  const host = app;
  const canvas = canvasRef.value;
  if (!host || !canvas) return;
  const vp = host.camera.viewport;
  const rect = canvas.getBoundingClientRect();
  // 画布中心的世界坐标在缩放前后保持不动
  const wx = (rect.width / 2 - vp.x) / vp.scale;
  const wy = (rect.height / 2 - vp.y) / vp.scale;
  host.camera.setViewport({
    x: rect.width / 2 - wx * scale,
    y: rect.height / 2 - wy * scale,
    scale,
  });
  // setViewport 只更新相机状态，需显式触发相机-only 重渲染
  host.requestCameraRender();
  zoom.value = Math.round(scale * 100);
}

onMounted(() => {
  const canvas = canvasRef.value!;
  const host = new App(canvas);
  app = host;
  for (const p of officialPlugins()) host.use(p);

  // 滚轮等外部视口变化 → 同步滑块与百分比显示
  host.camera.onViewportChange(() => {
    zoom.value = Math.min(800, Math.max(20, Math.round(host.camera.scale * 100)));
  });

  flowchart = new FlowChart({
    canvas,
    app: host,
    data: initialData,
    // 第三方形状插件经 plugins 选项装配（在初始数据 load 之前安装）
    plugins: [noteShapes],
    // AI 生成适配器：模型只输出语义图，坐标与端口方向由包内布局器计算
    ai: aiGenerate,
    // 延后一帧同步工具条：构造期若触发变更，此时工具条状态尚未初始化
    onChange: (type) => {
      queueMicrotask(() => {
        console.log(`[FlowChart] ${type}`, JSON.stringify(flowchart?.toJSON()));
        syncToolbar();
      });
    },
  });
  syncToolbar();
  // 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
  (window as unknown as { __flowchart?: FlowChart }).__flowchart = flowchart;
});

onUnmounted(() => {
  // 只销毁门面自有插件与场景节点，宿主 App 及其官方插件保持可复用
  flowchart?.destroy();
  flowchart = null;
  app = null;
});
</script>

<template>
  <IconSprites />
  <div class="flex h-screen w-screen overflow-hidden">
    <!-- 画布区：悬浮控件锚定于此容器，宽度随 AI 侧边栏开合自动伸缩 -->
    <main id="stage" class="relative h-full min-w-0 flex-1">
      <canvas ref="canvasRef" class="block h-full w-full bg-white"></canvas>

      <!-- 左上角标识 -->
      <div
        class="absolute top-4 left-4 z-10 flex h-10 items-center gap-2 rounded-[10px] bg-white px-3 text-xs shadow-[0_2px_8px_rgba(0,0,0,0.1)] select-none"
      >
        <Icon name="i-flow" class="text-violet-500" />
        <span>流程图</span>
        <span class="border-l border-gray-200 pl-2 text-[10px] text-gray-400">Silker Demo</span>
      </div>

      <FlowChartToolbar
        :can-undo="canUndo"
        :can-redo="canRedo"
        :zoom="zoom"
        :copied="copied"
        :ai-sidebar-open="sidebarOpen"
        :shape-options="shapeOptions"
        @undo="undo"
        @redo="redo"
        @add-shape="addShape"
        @replace-shape="replaceShape"
        @copy="copySelected"
        @paste="paste"
        @remove="removeSelected"
        @fit="fit"
        @copy-json="copyJson"
        @export-json="exportJson"
        @export-image="exportImage"
        @export-image-hd="exportImageHd"
        @zoom-input="onZoomInput"
        @toggle-ai="toggleSidebar"
      />

      <div
        class="absolute bottom-4 left-4 z-10 max-w-[min(680px,calc(100%-32px))] rounded-[10px] border border-gray-200 bg-[rgba(255,255,255,0.92)] px-3 py-2 text-[11px] leading-[1.7] text-gray-500 backdrop-blur-[6px] select-none"
      >
        点击选中 · 拖拽移动 · 双击编辑文字 · 选中后拖动蓝色圆点连线 · Ctrl+C 复制 · Ctrl+V 粘贴 · Ctrl+Z 撤销 · Ctrl+Y 重做 · Delete 删除 · 滚轮缩放 · 右键拖拽平移
      </div>
    </main>

    <!-- AI 助手侧边栏：并列布局面板，保留对话历史 / 流式思考 / 执行反馈。
         收起时只隐藏不卸载，消息流与配置面板状态随开合保留 -->
    <AISidebar
      v-show="sidebarOpen"
      v-model="prompt"
      v-model:config="config"
      :messages="messages"
      :pending="pending"
      :busy="busy"
      :ready="ready"
      :settings-open="settingsOpen"
      @send="sendAi"
      @stop="stopAi"
      @clear="clearChat"
      @collapse="toggleSidebar"
      @toggle-settings="toggleSettings"
      @save-config="saveConfig"
    />
  </div>
</template>
