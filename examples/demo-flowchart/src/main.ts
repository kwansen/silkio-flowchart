// 入口：挂载 canvas 并渲染一张示例流程图
import { FlowChart } from "@silker/flowchart";
import { VIEWPORT_CAPABILITY } from "@silker/core-viewport";
import type { FlowData, ShapeKind } from "@silker/flowchart";

// 示例数据：开始 → 处理 → 判断 →（通过/驳回）两条分支
const data: FlowData = {
  nodes: [
    { id: "start", shape: "ellipse", x: 60, y: 220, text: "开始" },
    { id: "handle", shape: "rect", x: 300, y: 220, text: "处理请求" },
    { id: "check", shape: "diamond", x: 560, y: 220, text: "校验通过？" },
    { id: "ok", shape: "ellipse", x: 840, y: 100, text: "返回成功" },
    { id: "retry", shape: "rect", x: 840, y: 330, text: "返回错误" },
  ],
  edges: [
    { from: "start", to: "handle" },
    { from: "handle", to: "check" },
    { from: "check", to: "ok" },
    { from: "check", to: "retry" },
    // 演示四向端口与方向锁定：从“开始”底部竖直引出，竖直接入“返回错误”顶部
    { from: "start", to: "retry", fromDir: "bottom", toDir: "top" },
  ],
};

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

const flowchart = new FlowChart({
  canvas,
  data,
  // 数据变化（新增/删除/移动/连线/编辑）时打印当前数据 JSON
  onChange: (type) => {
    console.log(`[FlowChart] ${type}`, JSON.stringify(flowchart.toJSON()));
  },
});

// 工具栏：新增节点落在视口中心附近（逐个略微错开避免完全重叠）
let addCount = 0;
const addAtCenter = (shape: ShapeKind, text: string) => {
  const rect = canvas.getBoundingClientRect();
  const { x: vx, y: vy, scale } = flowchart.app.renderer.viewport;
  const offset = (addCount++ % 5) * 24 - 48;
  flowchart.addNode({
    shape,
    text,
    x: (rect.width / 2 - vx) / scale - 80 + offset,
    y: (rect.height / 2 - vy) / scale - 32 + offset,
  });
};
document
  .getElementById("add-rect")!
  .addEventListener("click", () => addAtCenter("rect", "新步骤"));
document
  .getElementById("add-diamond")!
  .addEventListener("click", () => addAtCenter("diamond", "新判断"));
document
  .getElementById("add-ellipse")!
  .addEventListener("click", () => addAtCenter("ellipse", "新端点"));
document
  .getElementById("add-para")!
  .addEventListener("click", () => addAtCenter("parallelogram", "输入数据"));
document
  .getElementById("add-hexagon")!
  .addEventListener("click", () => addAtCenter("hexagon", "准备阶段"));
document
  .getElementById("add-database")!
  .addEventListener("click", () => addAtCenter("database", "存储数据"));

document
  .getElementById("delete-btn")!
  .addEventListener("click", () => flowchart.deleteSelected());

// 替换选中节点形状：保留位置、尺寸、文本与连线
document
  .getElementById("to-rect")!
  .addEventListener("click", () => flowchart.replaceSelected("rect"));
document
  .getElementById("to-diamond")!
  .addEventListener("click", () => flowchart.replaceSelected("diamond"));
document
  .getElementById("to-ellipse")!
  .addEventListener("click", () => flowchart.replaceSelected("ellipse"));
document
  .getElementById("to-para")!
  .addEventListener("click", () => flowchart.replaceSelected("parallelogram"));
document
  .getElementById("to-hexagon")!
  .addEventListener("click", () => flowchart.replaceSelected("hexagon"));
document
  .getElementById("to-database")!
  .addEventListener("click", () => flowchart.replaceSelected("database"));

// 适应视图：按全部节点包围盒拟合视口（Viewport 插件的 fit）
document.getElementById("fit-btn")!.addEventListener("click", () => {
  const nodes = flowchart.toJSON().nodes;
  if (!nodes.length) return;
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + (n.width ?? 0)));
  const maxY = Math.max(...nodes.map((n) => n.y + (n.height ?? 0)));
  // 经能力键消费视口能力（与 FlowChart 内部同一套协议）
  flowchart.app.require(VIEWPORT_CAPABILITY).fit({ minX, minY, maxX, maxY });
  flowchart.app.render();
});

// 导出 JSON：控制台打印并触发下载
document.getElementById("export-btn")!.addEventListener("click", () => {
  const json = JSON.stringify(flowchart.toJSON(), null, 2);
  console.log(json);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "flowchart.json";
  a.click();
  URL.revokeObjectURL(url);
});

// 导出图片：全部形状与连线离屏渲染为 PNG（白底）并触发下载
document
  .getElementById("export-img-btn")!
  .addEventListener("click", async () => {
    const blob = await flowchart.toImage({ background: "#ffffff" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "flowchart.png";
    a.click();
    URL.revokeObjectURL(url);
  });

// 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
(window as any).__flowchart = flowchart;
