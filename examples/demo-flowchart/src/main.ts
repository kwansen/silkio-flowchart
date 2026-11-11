// 流程图 Demo：canvas + 胶囊工具条（撤销/重做、添加/替换形状、复制粘贴、导出、缩放）
// + 对话式 AI 侧边栏（历史消息、流式思考、执行反馈、服务配置）。
// 显式装配示例（starter-kit 模式）：宿主自建 App 并安装官方插件预设，
// 再交给 FlowChart 复用——应用层可自由增减/替换插件。
// 样式由 index.html <head> 的 <link> 加载（避免 FOUC），模块内不再重复引入
import { App } from "@silker/core";
import { officialPlugins } from "@silker/preset";
import {
  FlowChart,
  Shape,
  SHAPE_REGISTRY_CAPABILITY,
  defaultAIFlowPrompt,
} from "@silker/flowchart";
import type {
  AIFlowGenerate,
  AIFlowTurn,
  FlowData,
  Plugin,
  ShapeKind,
  ShapeOptions,
  ShapeStyle,
} from "@silker/flowchart";
import { renderMarkdown } from "./markdown";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 与 index.html 静态图标保持同一套 Tailwind 线性描边工具类
const ICON_BASE =
  "shrink-0 fill-none stroke-current stroke-[1.5] [stroke-linecap:round] [stroke-linejoin:round]";

function icon(symbol: string, size = "h-4 w-4", extra = ""): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", `${ICON_BASE} ${size} ${extra}`.trim());
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#${symbol}`);
  svg.appendChild(use);
  return svg;
}

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

// ── AI 服务配置（OpenAI 兼容接口，localStorage 持久化，不入代码仓库）──
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
const aiReady = () => !!(aiConfig.baseURL && aiConfig.apiKey && aiConfig.model);

// ── AI 对话状态 ──
interface ChatMessage {
  // user = 用户指令；assistant = 回答/执行反馈；error = 失败信息
  role: "user" | "assistant" | "error";
  text: string;
  detail?: string; // 画布变更摘要（以 ✓ 反馈链展示）
  reasoning?: string; // 思考过程（完成后保留可折叠回看）
}
const messages: ChatMessage[] = [];
// 进行中的回复：流式思考与回答文本实时更新，完成后并入 messages
let pending: { reasoning: string; content: string } | null = null;
let aiBusy = false;
// 当前请求的中止控制器：停止按钮 abort 它以同时中断 fetch 与流式读取
let aiAbort: AbortController | null = null;

const chatBox = $("chat-box");
const aiEmpty = $("ai-empty");
const aiPrompt = $<HTMLInputElement>("ai-prompt");
const aiSend = $<HTMLButtonElement>("ai-send");
const sendIcon = $("send-icon");
const stopIcon = $("stop-icon");
const aiClear = $<HTMLButtonElement>("ai-clear");
const aiSidebar = $("ai-sidebar");
const aiToggle = $("ai-toggle");
const aiSettings = $("ai-settings");
const aiSettingsToggle = $("ai-settings-toggle");

// 进行中节点的可变部分：流式增量只更新文本，避免整段重建导致闪烁
let pendingNode: HTMLDivElement | null = null;
let pendingReasoning: HTMLDivElement | null = null;
let pendingAnswer: HTMLDivElement | null = null;
let pendingStatus: HTMLSpanElement | null = null;

// 语义图 JSON 形态的输出不实时渲染，等解析完成后以执行反馈展示；
// 纯文本回答（提问类指令）才走 Markdown 流式渲染
function isOpsStream(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith("{") || s.startsWith("[") || s.startsWith("```");
}

function scrollChat() {
  chatBox.scrollTop = chatBox.scrollHeight;
}

function updateEmpty() {
  aiEmpty.hidden = messages.length > 0 || pending !== null;
  aiClear.disabled = aiBusy || messages.length === 0;
}

function updateComposer() {
  // 生成中切成深色停止按钮：直接切换 Tailwind 背景工具类
  aiSend.classList.toggle("bg-gray-900", aiBusy);
  aiSend.classList.toggle("hover:bg-gray-700", aiBusy);
  aiSend.classList.toggle("bg-violet-500", !aiBusy);
  aiSend.classList.toggle("hover:bg-violet-600", !aiBusy);
  aiSend.disabled = !aiBusy && !aiPrompt.value.trim();
  aiSend.title = aiBusy ? "停止生成" : "发送";
  aiSend.setAttribute("aria-label", aiSend.title);
  sendIcon.hidden = aiBusy;
  stopIcon.hidden = !aiBusy;
  updateEmpty();
}

// 动态消息节点的 Tailwind 类：与 index.html 的静态样式保持同一套尺度
const MD_CLASS = "ai-md text-xs leading-5 text-gray-600";
const THINKING_CLASS = "rounded-lg bg-gray-50 px-2.5 py-1.5";
const SUMMARY_CLASS = "cursor-pointer text-xs text-gray-400 select-none";
const THINKING_BODY_CLASS = "mt-1 text-[11px] leading-5 text-gray-400 whitespace-pre-wrap";

// comark 解析是异步的：每个容器只应用最新一次的结果，避免慢一帧的旧渲染覆盖新内容
const renderSeq = new WeakMap<HTMLElement, number>();
function renderInto(el: HTMLElement, text: string, streaming: boolean) {
  const seq = (renderSeq.get(el) ?? 0) + 1;
  renderSeq.set(el, seq);
  void renderMarkdown(text, streaming)
    .then((html) => {
      if (renderSeq.get(el) === seq && el.isConnected) el.innerHTML = html;
    })
    .catch(() => {
      if (renderSeq.get(el) === seq && el.isConnected) el.textContent = text;
    });
}

function appendMessage(m: ChatMessage) {
  messages.push(m);
  let node: HTMLElement;
  if (m.role === "user") {
    const wrap = make("div", "flex justify-end");
    wrap.appendChild(
      make(
        "div",
        "max-w-[85%] rounded-xl rounded-br-sm bg-violet-500 px-3 py-2 text-xs leading-5 text-white whitespace-pre-wrap break-words",
        m.text,
      ),
    );
    node = wrap;
  } else if (m.role === "error") {
    node = make("div", "text-xs leading-5 text-red-500 whitespace-pre-wrap break-words", m.text);
  } else {
    const wrap = make("div", "flex flex-col gap-2");
    if (m.reasoning) {
      const details = make("details", THINKING_CLASS);
      details.appendChild(make("summary", SUMMARY_CLASS, "思考过程"));
      details.appendChild(make("div", THINKING_BODY_CLASS, m.reasoning));
      wrap.appendChild(details);
    }
    if (m.text && !isOpsStream(m.text)) {
      const md = make("div", MD_CLASS);
      renderInto(md, m.text, false);
      wrap.appendChild(md);
    } else if (m.text) {
      wrap.appendChild(
        make("div", "text-xs leading-5 text-gray-600 whitespace-pre-wrap break-words", m.text),
      );
    }
    if (m.detail) {
      const step = make("div", "flex items-start gap-1.5 text-xs leading-5 text-gray-600");
      step.appendChild(make("span", "text-emerald-500", "✓"));
      step.appendChild(make("span", "", m.detail));
      wrap.appendChild(step);
    }
    node = wrap;
  }
  chatBox.appendChild(node);
  updateEmpty();
  scrollChat();
}

function startPending() {
  pending = { reasoning: "", content: "" };
  const wrap = make("div", "flex flex-col gap-2");
  pendingAnswer = make("div", MD_CLASS);
  pendingAnswer.hidden = true;
  const status = make("div", "flex items-center gap-1.5 text-xs text-gray-400");
  status.appendChild(icon("i-sparkles", "h-3.5 w-3.5", "text-violet-400 animate-pulse"));
  pendingStatus = make("span", "", "等待响应…");
  status.appendChild(pendingStatus);
  wrap.appendChild(pendingAnswer);
  wrap.appendChild(status);
  pendingNode = wrap;
  chatBox.appendChild(wrap);
  updateEmpty();
}

// 流式增量：思考过程逐段追加，回答文本实时渲染；语义图 JSON 只显示状态提示
function updatePending() {
  if (!pending || !pendingNode || !pendingAnswer || !pendingStatus) return;
  if (pending.reasoning) {
    if (!pendingReasoning) {
      const details = make("details", THINKING_CLASS);
      details.open = true;
      details.appendChild(make("summary", SUMMARY_CLASS, "思考中…"));
      pendingReasoning = make("div", THINKING_BODY_CLASS);
      details.appendChild(pendingReasoning);
      pendingNode.insertBefore(details, pendingNode.firstChild);
    }
    pendingReasoning.textContent = pending.reasoning;
  }
  const ops = isOpsStream(pending.content);
  if (pending.content && !ops) {
    pendingAnswer.hidden = false;
    renderInto(pendingAnswer, pending.content, true);
  } else {
    pendingAnswer.hidden = true;
  }
  pendingStatus.textContent = pending.content
    ? ops
      ? "生成流程中…"
      : "回答中…"
    : pending.reasoning
      ? "思考中…"
      : "等待响应…";
  scrollChat();
}

function endPending() {
  pendingNode?.remove();
  pendingNode = null;
  pendingReasoning = null;
  pendingAnswer = null;
  pendingStatus = null;
  pending = null;
}

function clearChat() {
  messages.length = 0;
  chatBox.replaceChildren(aiEmpty, ...(pendingNode ? [pendingNode] : []));
  updateComposer();
}

// ── AI 生成适配器（宿主注入，OpenAI 兼容接口 / SSE 流式）──
// 与 mindmap demo 同款：包内 defaultAIFlowPrompt 渲染提示词（含对话历史与当前
// 语义图），返回的语义图 JSON 由 FlowChart.generate 解析 + 自动布局 + 整图原子替换。
// 浏览器直连要求服务端允许 CORS，否则需经本地代理转发。
const aiGenerate: AIFlowGenerate = async (req) => {
  const { baseURL, apiKey, model } = aiConfig;
  if (!baseURL || !apiKey || !model) {
    throw new Error("请先点击侧边栏齿轮配置 AI 服务");
  }
  const ac = new AbortController();
  aiAbort = ac;
  const res = await fetch(baseURL.replace(/\/+$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: ac.signal,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: defaultAIFlowPrompt(req) }],
      temperature: 0.3,
      stream: true,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `AI 服务请求失败（HTTP ${res.status}）${text ? `：${text.slice(0, 160)}` : ""}`,
    );
  }
  // 服务端不支持流式（或 responses 为一次性 JSON）：读取完整 message
  if (!res.body) {
    const json = await res.json();
    const msg = json?.choices?.[0]?.message;
    if (pending) {
      const think = msg?.reasoning_content ?? msg?.reasoning;
      if (typeof think === "string" && think) {
        pending.reasoning = think;
        updatePending();
      }
    }
    if (typeof msg?.content !== "string" || !msg.content) {
      throw new Error("AI 服务返回内容为空");
    }
    return msg.content;
  }
  // SSE 流式解析：逐 delta 分离思考（reasoning）与答案（content）
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let raw = "";
  let content = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    buf += chunk;
    // 仅留一份原文用于「服务端忽略 stream 参数」的兜底解析，做长度上限保护
    if (raw.length < 200_000) raw += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith("data:")) continue;
      const payload = s.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const delta = JSON.parse(payload)?.choices?.[0]?.delta;
        if (!delta) continue;
        const think = delta.reasoning_content ?? delta.reasoning;
        if (typeof think === "string" && think && pending) {
          pending.reasoning += think;
          updatePending();
        }
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          if (pending) {
            pending.content = content;
            updatePending();
          }
        }
      } catch {
        // 忽略无法解析的行（心跳/注释等）
      }
    }
  }
  if (!content) {
    // 部分网关会忽略 stream 参数直接返回完整 chat/completions JSON
    try {
      const msg = JSON.parse(raw.trim())?.choices?.[0]?.message;
      if (typeof msg?.content === "string" && msg.content) {
        if (pending) {
          const think = msg.reasoning_content ?? msg.reasoning;
          if (typeof think === "string" && think) {
            pending.reasoning = think;
            updatePending();
          }
        }
        return msg.content;
      }
    } catch {
      // 落到统一报错
    }
    throw new Error("AI 服务返回内容为空");
  }
  return content;
};

// 发送指令：一次 generate = 语义图解析 + 程序布局 + 整图替换（一次 Ctrl+Z 可撤销）
async function sendAi() {
  if (aiBusy) return;
  const prompt = aiPrompt.value.trim();
  if (!prompt) return;
  // 未配置 AI 服务：展开侧边栏并直接打开设置
  if (!aiReady()) {
    setSidebar(true);
    setSettings(true);
    return;
  }
  // 对话历史（不含本次指令）：助手轮无回答文本时以执行反馈摘要代之
  const history: AIFlowTurn[] = messages
    .filter((m) => m.role !== "error")
    .map((m): AIFlowTurn => ({
      role: m.role === "user" ? "user" : "assistant",
      text: m.text || m.detail || "",
    }))
    .filter((t) => t.text);
  const before = JSON.stringify(flowchart.toJSON());
  aiPrompt.value = "";
  appendMessage({ role: "user", text: prompt });
  aiBusy = true;
  updateComposer();
  startPending();
  try {
    const result = await flowchart.generate(prompt, { history });
    const changed = JSON.stringify(result.data) !== before;
    const reasoning = pending?.reasoning || undefined;
    endPending();
    appendMessage({
      role: "assistant",
      text: result.answer ?? (changed ? "" : "（未产生任何操作）"),
      detail: changed
        ? `已生成 ${result.data.nodes.length} 个节点、${result.data.edges.length} 条连线（Ctrl+Z 可撤销）`
        : undefined,
      reasoning,
    });
  } catch (e) {
    const partial = pending?.content ?? "";
    const reasoning = pending?.reasoning || undefined;
    endPending();
    // 用户主动停止：不算错误，保留已流式产生的部分回答
    if (e instanceof DOMException && e.name === "AbortError") {
      appendMessage({
        role: "assistant",
        text: partial && !isOpsStream(partial) ? partial : "（已停止生成）",
        reasoning,
      });
    } else {
      appendMessage({
        role: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    }
  } finally {
    aiBusy = false;
    pending = null;
    aiAbort = null;
    updateComposer();
    refreshToolbar();
  }
}

function stopAi() {
  aiAbort?.abort();
}

// ── 侧边栏 / 服务配置交互 ──
// 激活态直接切换 Tailwind 文本色工具类（不写自定义状态类）
function setIconTone(el: HTMLElement, on: boolean) {
  el.classList.toggle("text-violet-500", on);
  el.classList.toggle("text-gray-400", !on);
}

function setSidebar(open: boolean) {
  aiSidebar.hidden = !open;
  setIconTone(aiToggle, open);
}

function setSettings(open: boolean) {
  aiSettings.hidden = !open;
  setIconTone(aiSettingsToggle, open || aiReady());
}

function syncAiReady() {
  setIconTone(aiSettingsToggle, !aiSettings.hidden || aiReady());
}

$<HTMLInputElement>("ai-base-url").value = aiConfig.baseURL;
$<HTMLInputElement>("ai-api-key").value = aiConfig.apiKey;
$<HTMLInputElement>("ai-model").value = aiConfig.model;
syncAiReady();

aiToggle.addEventListener("click", () => setSidebar(!!aiSidebar.hidden));
$("ai-collapse").addEventListener("click", () => setSidebar(false));
aiSettingsToggle.addEventListener("click", () => setSettings(!!aiSettings.hidden));
$("ai-save").addEventListener("click", () => {
  aiConfig.baseURL = $<HTMLInputElement>("ai-base-url").value.trim();
  aiConfig.apiKey = $<HTMLInputElement>("ai-api-key").value.trim();
  aiConfig.model = $<HTMLInputElement>("ai-model").value.trim();
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(aiConfig));
  setSettings(false);
  syncAiReady();
});
aiClear.addEventListener("click", clearChat);
aiPrompt.addEventListener("input", updateComposer);
aiPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) void sendAi();
});
aiSend.addEventListener("click", () => (aiBusy ? stopAi() : void sendAi()));

// ── 画布装配：宿主 App + 官方插件预设，FlowChart 按能力键复用 ──
const canvas = $<HTMLCanvasElement>("canvas");
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
  // 延后一帧同步工具条：构造期若触发变更，此时工具条 DOM 状态尚未初始化
  onChange: (type) => {
    queueMicrotask(() => {
      console.log(`[FlowChart] ${type}`, JSON.stringify(flowchart.toJSON()));
      refreshToolbar();
    });
  },
});

// ── 工具条：撤销/重做、形状菜单、剪贴板、适应视图、导出、缩放 ──
const undoBtn = $<HTMLButtonElement>("undo-btn");
const redoBtn = $<HTMLButtonElement>("redo-btn");
function refreshToolbar() {
  undoBtn.disabled = !flowchart.canUndo;
  redoBtn.disabled = !flowchart.canRedo;
}
undoBtn.addEventListener("click", () => {
  flowchart.undo();
  refreshToolbar();
});
redoBtn.addEventListener("click", () => {
  flowchart.redo();
  refreshToolbar();
});
refreshToolbar();

// 形状选项：添加与替换共用（symbol 对应 index.html 里的形状预览图标）
const shapeOptions: { kind: ShapeKind; label: string; text: string; symbol: string }[] = [
  { kind: "rect", label: "矩形 · 步骤", text: "新步骤", symbol: "s-rect" },
  { kind: "diamond", label: "菱形 · 判断", text: "新判断", symbol: "s-diamond" },
  { kind: "ellipse", label: "椭圆 · 起止", text: "新端点", symbol: "s-ellipse" },
  { kind: "parallelogram", label: "平行四边形 · 输入输出", text: "输入数据", symbol: "s-parallelogram" },
  { kind: "hexagon", label: "六边形 · 准备", text: "准备阶段", symbol: "s-hexagon" },
  { kind: "database", label: "数据库 · 存储", text: "存储数据", symbol: "s-database" },
  { kind: "note", label: "便签 · 自定义形状", text: "便签", symbol: "s-note" },
];

// 新增节点落在视口中心附近（逐个略微错开避免完全重叠）
let addCount = 0;
const addAtCenter = (shape: ShapeKind, text: string) => {
  const rect = canvas.getBoundingClientRect();
  // 屏幕坐标 → 世界坐标走门面语义 API（浏览器事件坐标口径，画布偏移由相机扣除）
  const center = flowchart.screenToWorld(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2,
  );
  const offset = (addCount++ % 5) * 24 - 48;
  flowchart.addNode({ shape, text, x: center.x - 80 + offset, y: center.y - 32 + offset });
};

function fillShapeMenu(menu: HTMLElement, onPick: (kind: ShapeKind, text: string) => void) {
  for (const opt of shapeOptions) {
    const btn = make(
      "button",
      "menu-item group flex w-full cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs whitespace-nowrap text-gray-700 hover:bg-gray-100",
    );
    btn.type = "button";
    const preview = icon(opt.symbol, "h-[18px] w-7", "text-gray-400 group-hover:text-violet-500");
    btn.appendChild(preview);
    btn.appendChild(make("span", "", opt.label));
    btn.addEventListener("click", () => {
      onPick(opt.kind, opt.text);
      closeMenu();
    });
    menu.appendChild(btn);
  }
}
fillShapeMenu($("add-menu"), addAtCenter);
fillShapeMenu($("replace-menu"), (kind) => flowchart.replaceSelected(kind));

$("copy-btn").addEventListener("click", () => flowchart.copySelected());
$("paste-btn").addEventListener("click", () => flowchart.paste());
$("delete-btn").addEventListener("click", () => flowchart.deleteSelected());
$("fit-btn").addEventListener("click", () => flowchart.fit());

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$("export-menu").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".menu-item")) closeMenu();
});
$("copy-json-btn").addEventListener("click", () => {
  const btn = $("copy-json-btn");
  void navigator.clipboard
    ?.writeText(JSON.stringify(flowchart.toJSON(), null, 2))
    .then(() => {
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = "复制 JSON"), 1500);
    })
    .catch(() => undefined);
});
$("export-json-btn").addEventListener("click", () => {
  const json = JSON.stringify(flowchart.toJSON(), null, 2);
  console.log(json);
  download(new Blob([json], { type: "application/json" }), "flowchart.json");
});
$("export-img-btn").addEventListener("click", async () => {
  download(await flowchart.toImage({ background: "#ffffff" }), "flowchart.png");
});
$("export-hd-btn").addEventListener("click", async () => {
  // 默认已是 2x，"2 倍高清" 再翻倍到 4x
  download(
    await flowchart.toImage({ background: "#ffffff", scale: 4 }),
    "flowchart-hd.png",
  );
});

// 缩放：以画布中心为锚点，范围与滚轮缩放一致（0.2–8）
const zoomRange = $<HTMLInputElement>("zoom-range");
const zoomLabel = $("zoom-label");
function syncZoom(pct: number) {
  const value = Math.min(800, Math.max(20, pct));
  zoomLabel.textContent = String(value);
  zoomRange.value = String(value);
  const fill = ((value - 20) / (800 - 20)) * 100;
  zoomRange.style.background = `linear-gradient(to right, #8b5cf6 ${fill}%, #e5e7eb ${fill}%)`;
}
app.camera.onViewportChange(() => syncZoom(Math.round(app.camera.scale * 100)));
zoomRange.addEventListener("input", () => {
  const scale = Number(zoomRange.value) / 100;
  const vp = app.camera.viewport;
  const rect = canvas.getBoundingClientRect();
  // 画布中心的世界坐标在缩放前后保持不动
  const wx = (rect.width / 2 - vp.x) / vp.scale;
  const wy = (rect.height / 2 - vp.y) / vp.scale;
  app.camera.setViewport({
    x: rect.width / 2 - wx * scale,
    y: rect.height / 2 - wy * scale,
    scale,
  });
  // setViewport 只更新相机状态，需显式触发相机-only 重渲染
  app.requestCameraRender();
});
syncZoom(100);

// ── 悬浮面板：悬浮 200ms 延迟展开（hover intent），移出立即收起 ──
// 纯 CSS hover 过于灵敏，鼠标划过工具条即弹面板易误触；点击触发器则即时切换
type MenuId = "add" | "replace" | "export" | "zoom";
const menuEls: Record<MenuId, HTMLElement> = {
  add: $("add-menu"),
  replace: $("replace-menu"),
  export: $("export-menu"),
  zoom: document.querySelector<HTMLElement>('[data-menu="zoom"] .menu')!,
};
let menuTimer: number | undefined;
function showMenu(id: MenuId | null) {
  for (const key of Object.keys(menuEls) as MenuId[]) menuEls[key].hidden = key !== id;
}
function scheduleMenu(id: MenuId) {
  clearTimeout(menuTimer);
  menuTimer = window.setTimeout(() => showMenu(id), 200);
}
function closeMenu() {
  clearTimeout(menuTimer);
  showMenu(null);
}
document.querySelectorAll<HTMLElement>(".tb-item").forEach((item) => {
  const id = item.dataset.menu as MenuId;
  item.addEventListener("mouseenter", () => scheduleMenu(id));
  item.addEventListener("mouseleave", closeMenu);
  item.querySelector(".tb-btn")?.addEventListener("click", () => {
    const wasOpen = !menuEls[id].hidden;
    closeMenu();
    if (!wasOpen) showMenu(id);
  });
});

updateComposer();

// 临时调试：暴露实例供浏览器自动化测试定位节点（验证后移除）
(window as any).__flowchart = flowchart;
