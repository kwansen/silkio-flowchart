// 入口：挂载 canvas 并渲染一张示例流程图
// 显式装配示例（starter-kit 模式）：宿主自建 App 并安装官方插件预设
// （@silker/preset 的 officialPlugins），再交给 FlowChart 复用——应用层可自由增减/替换插件
import { App } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import { FlowChart, Shape, SHAPE_REGISTRY_CAPABILITY, defaultAIFlowPrompt } from "@silker/flowchart";
import type { Plugin, ShapeOptions, ShapeStyle, AIFlowGenerate } from "@silker/flowchart";
import type { FlowData, ShapeKind } from "@silker/flowchart";

// ── 第三方形状扩展示例：便签（折角矩形，经形状注册表插件注册）──
// 只依赖 flowchart 导出的 Shape 基类与能力键，不依赖 FlowChart 内部实现
class NoteShape extends Shape {
  constructor(options: ShapeOptions = {}) {
    super("note", { width: 160, height: 99 }, {
      ...options,
      style: { fill: "#fef9c3", stroke: "#ca8a04", ...options.style } as Partial<ShapeStyle>,
    });
  }

  // 内接矩形近似（折角只占右上角一小块）
  protected get textFit() {
    return 1.15;
  }

  protected boundaryT(dx: number, dy: number) {
    const tx = dx === 0 ? Infinity : this.width / 2 / Math.abs(dx);
    const ty = dy === 0 ? Infinity : this.height / 2 / Math.abs(dy);
    return Math.min(tx, ty);
  }

  protected contains(x: number, y: number) {
    return x >= 0 && x <= this.width && y >= 0 && y <= this.height;
  }

  protected drawPath(ctx: CanvasRenderingContext2D) {
    const fold = 18;
    ctx.moveTo(0, 0);
    ctx.lineTo(this.width - fold, 0);
    ctx.lineTo(this.width, fold);
    ctx.lineTo(this.width, this.height);
    ctx.lineTo(0, this.height);
    ctx.closePath();
  }
}

// 第三方形状插件：install 期间经能力键向注册表追加自定义 kind
const noteShapes: Plugin = {
  install(app) {
    app
      .require(SHAPE_REGISTRY_CAPABILITY)
      .register("note", (o) => new NoteShape(o), { label: "便签" });
  },
};

// 示例数据：开始 → 处理 → 判断 →（通过/驳回）两条分支
const data: FlowData = {
  nodes: [
    { id: "start", shape: "ellipse", x: 60, y: 220, text: "开始" },
    { id: "handle", shape: "rect", x: 300, y: 220, text: "处理请求" },
    { id: "check", shape: "diamond", x: 560, y: 220, text: "校验通过？" },
    { id: "ok", shape: "ellipse", x: 840, y: 100, text: "返回成功" },
    { id: "retry", shape: "rect", x: 840, y: 330, text: "返回错误" },
    // 第三方形状（note 插件经 plugins 选项装配后，初始数据即可用）
    { id: "note1", shape: "note", x: 300, y: 420, text: "自定义形状：便签" },
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

// ── AI 生成适配器（宿主注入，OpenAI 兼容接口）──
// 与 mindmap demo 同款：配置存 localStorage，包内 defaultAIFlowPrompt 渲染提示词，
// 返回的语义图 JSON 由 FlowChart.generate 解析 + 自动布局 + 整图原子替换。
// 注意：浏览器直连要求服务端允许 CORS，否则需经本地代理转发。
interface AIConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}
const AI_CONFIG_KEY = "flowchart-ai-config";
const aiConfig: AIConfig = (() => {
  try {
    return {
      baseURL: "",
      apiKey: "",
      model: "",
      ...JSON.parse(localStorage.getItem(AI_CONFIG_KEY) ?? "{}"),
    };
  } catch {
    return { baseURL: "", apiKey: "", model: "" };
  }
})();
const aiGenerate: AIFlowGenerate = async (req) => {
  const { baseURL, apiKey, model } = aiConfig;
  if (!baseURL || !apiKey || !model) {
    throw new Error("请先点击「设置」填写 AI 服务配置");
  }
  const res = await fetch(baseURL.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: defaultAIFlowPrompt(req) }],
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `AI 服务请求失败（HTTP ${res.status}）${text ? `：${text.slice(0, 160)}` : ""}`,
    );
  }
  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("AI 服务返回内容为空");
  }
  return content;
};

const canvas = document.getElementById("canvas") as HTMLCanvasElement;

// 显式装配：自建 App 并安装官方插件预设（集合与顺序的单一事实来源在 @silker/preset），
// FlowChart 按能力键复用这些能力，只补齐自有的形状/吸附/边路由插件
const app = new App(canvas);
for (const p of officialPlugins()) app.use(p);

const flowchart = new FlowChart({
  canvas,
  app,
  data,
  // 第三方形状插件经 plugins 选项装配（在初始数据 load 之前安装）
  plugins: [noteShapes],
  // AI 生成适配器：模型只输出语义图，坐标与端口方向由包内布局器计算
  ai: aiGenerate,
  // 数据变化（新增/删除/移动/连线/编辑）时打印当前数据 JSON
  onChange: (type) => {
    console.log(`[FlowChart] ${type}`, JSON.stringify(flowchart.toJSON()));
    refreshToolbar();
  },
});

// 撤销/重做工具条：点击触发对应操作，按历史栈可用性禁用按钮（含 undo/redo 后刷新）
const undoBtn = document.getElementById("undo-btn") as HTMLButtonElement;
const redoBtn = document.getElementById("redo-btn") as HTMLButtonElement;
const refreshToolbar = () => {
  undoBtn.disabled = !flowchart.canUndo;
  redoBtn.disabled = !flowchart.canRedo;
};
undoBtn.addEventListener("click", () => flowchart.undo());
redoBtn.addEventListener("click", () => flowchart.redo());
refreshToolbar();

// 工具栏：新增节点落在视口中心附近（逐个略微错开避免完全重叠）
let addCount = 0;
const addAtCenter = (shape: ShapeKind, text: string) => {
  const rect = canvas.getBoundingClientRect();
  // 屏幕坐标 → 世界坐标走门面语义 API（浏览器事件坐标口径，画布偏移由相机扣除）
  const center = flowchart.screenToWorld(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  const offset = (addCount++ % 5) * 24 - 48;
  flowchart.addNode({
    shape,
    text,
    x: center.x - 80 + offset,
    y: center.y - 32 + offset,
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
  .getElementById("add-note")!
  .addEventListener("click", () => addAtCenter("note", "便签"));

// 复制/粘贴：复制当前选中（含组内连线），粘贴到视口中心（连续粘贴逐次错开）
document
  .getElementById("copy-btn")!
  .addEventListener("click", () => flowchart.copySelected());
document
  .getElementById("paste-btn")!
  .addEventListener("click", () => flowchart.paste());

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
document
  .getElementById("to-note")!
  .addEventListener("click", () => flowchart.replaceSelected("note"));

// 适应视图：按全部形状包围盒拟合视口（门面语义 API，与内部同一套视口协议）
document.getElementById("fit-btn")!.addEventListener("click", () => flowchart.fit());

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

// ── AI 面板：服务配置 / 指令输入 / 生成反馈 ──
const aiSettings = document.getElementById("ai-settings") as HTMLDivElement;
const aiBaseURL = document.getElementById("ai-base-url") as HTMLInputElement;
const aiApiKey = document.getElementById("ai-api-key") as HTMLInputElement;
const aiModel = document.getElementById("ai-model") as HTMLInputElement;
const aiPrompt = document.getElementById("ai-prompt") as HTMLTextAreaElement;
const aiGenerateBtn = document.getElementById("ai-generate") as HTMLButtonElement;
const aiStatus = document.getElementById("ai-status") as HTMLSpanElement;
aiBaseURL.value = aiConfig.baseURL;
aiApiKey.value = aiConfig.apiKey;
aiModel.value = aiConfig.model;

document.getElementById("ai-settings-toggle")!.addEventListener("click", () => {
  aiSettings.hidden = !aiSettings.hidden;
});
document.getElementById("ai-save")!.addEventListener("click", () => {
  aiConfig.baseURL = aiBaseURL.value.trim();
  aiConfig.apiKey = aiApiKey.value.trim();
  aiConfig.model = aiModel.value.trim();
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig));
  aiSettings.hidden = true;
  aiStatus.textContent = "配置已保存（仅存本地浏览器）";
});
aiGenerateBtn.addEventListener("click", async () => {
  const prompt = aiPrompt.value.trim();
  if (!prompt || aiGenerateBtn.disabled) return;
  aiGenerateBtn.disabled = true;
  aiStatus.textContent = "生成中…";
  try {
    // 一次 generate = 语义图解析 + 自动布局 + 整图替换（一次 Ctrl+Z 可整体撤销）
    const result = await flowchart.generate(prompt);
    aiStatus.textContent = result.answer
      ? result.answer
      : `已生成 ${result.graph.nodes.length} 个节点、${result.graph.edges.length} 条连线（Ctrl+Z 可撤销）`;
    refreshToolbar();
  } catch (err) {
    aiStatus.textContent = `失败：${err instanceof Error ? err.message : String(err)}`;
  } finally {
    aiGenerateBtn.disabled = false;
  }
});

// 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
(window as any).__flowchart = flowchart;
