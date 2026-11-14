// AI 助手的组合式状态：对话历史、流式思考/回答、OpenAI 兼容 SSE 适配器。
// 画布实例由宿主在 onMounted 创建，故用 getter 延迟取用；适配器经 FlowChart
// 的 ai 选项注入，模型只输出语义图，坐标与端口方向由包内布局器计算。
import { computed, ref, watch } from "vue";
import { defaultAIFlowPrompt } from "silkio-flowchart";
import type { AIFlowGenerate, AIFlowTurn, FlowChart } from "silkio-flowchart";
import { AI_CONFIG_KEY, isOpsStream, loadAIConfig } from "../lib/ai";
import type { AIConfig, ChatMessage, PendingReply } from "../lib/ai";

export function useFlowChartAI(getFlowChart: () => FlowChart | null) {
  // 历史消息保留在内存，不随单次对话丢失
  const messages = ref<ChatMessage[]>([]);
  // 进行中的回复：流式增量实时更新，完成后并入 messages
  const pending = ref<PendingReply | null>(null);
  const busy = ref(false);
  const sidebarOpen = ref(true);
  const settingsOpen = ref(false);
  const prompt = ref("");
  const config = ref<AIConfig>(loadAIConfig());
  const ready = computed(
    () => !!(config.value.baseURL && config.value.apiKey && config.value.model),
  );

  // 配置变更后自动落盘：侧边栏以草稿编辑，点「保存」写回 config（含初始化载入），
  // 此处统一持久化到 localStorage，组件内不直接触达存储
  watch(config, (value) => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(value));
    }
  });

  // 当前请求的中止控制器：停止按钮 abort 它以同时中断 fetch 与流式读取
  let abort: AbortController | null = null;
  let seq = 0;
  // 每次发送 / 切换文档递增：让切换后迟到的 AI 结果与对话不落到新画布上
  let generation = 0;

  function append(message: Omit<ChatMessage, "id">) {
    messages.value.push({ ...message, id: ++seq });
  }

  // 浏览器直连要求服务端允许 CORS，否则需经本地代理转发
  const fetchAIGraph: AIFlowGenerate = async (req) => {
    const { baseURL, apiKey, model } = config.value;
    if (!baseURL || !apiKey || !model) {
      throw new Error("请先点击侧边栏齿轮配置 AI 服务");
    }
    const ac = new AbortController();
    abort = ac;
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
      const p = pending.value;
      if (p) {
        const think = msg?.reasoning_content ?? msg?.reasoning;
        if (typeof think === "string" && think) p.reasoning = think;
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
          const p = pending.value;
          const think = delta.reasoning_content ?? delta.reasoning;
          if (typeof think === "string" && think && p) p.reasoning += think;
          if (typeof delta.content === "string" && delta.content) {
            content += delta.content;
            if (p) p.content = content;
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
          const p = pending.value;
          const think = msg.reasoning_content ?? msg.reasoning;
          if (typeof think === "string" && think && p) p.reasoning = think;
          return msg.content;
        }
      } catch {
        // 落到统一报错
      }
      throw new Error("AI 服务返回内容为空");
    }
    return content;
  };

  // 切换/新建文档后，迟到的 AI 结果不得再交给 FlowChart.generate 整图替换
  const aiGenerate: AIFlowGenerate = async (req) => {
    const gen = generation;
    const content = await fetchAIGraph(req);
    if (gen !== generation) {
      throw new DOMException("请求已中止", "AbortError");
    }
    return content;
  };

  // 一次 generate = 语义图解析 + 程序布局 + 整图替换（一次 Ctrl+Z 可撤销）
  async function send() {
    if (busy.value) return;
    const text = prompt.value.trim();
    if (!text) return;
    // 未配置 AI 服务：展开侧边栏并直接打开设置
    if (!ready.value) {
      sidebarOpen.value = true;
      settingsOpen.value = true;
      return;
    }
    const flowchart = getFlowChart();
    if (!flowchart) return;

    // 对话历史（不含本次指令）：助手轮无回答文本时以执行反馈链代之
    const history: AIFlowTurn[] = messages.value
      .filter((m) => m.role !== "error")
      .map(
        (m): AIFlowTurn => ({
          role: m.role === "user" ? "user" : "assistant",
          text:
            m.text ||
            (m.steps ?? []).map((s) => s.label).join("；"),
        }),
      )
      .filter((t) => t.text);

    // 标记本次生成：切换/新建文档会递增 generation，使迟到的结果被丢弃
    const gen = ++generation;
    prompt.value = "";
    append({ role: "user", text });
    busy.value = true;
    pending.value = { reasoning: "", content: "" };
    try {
      const result = await flowchart.generate(text, { history });
      if (gen !== generation) return;
      const reasoning = pending.value?.reasoning || undefined;
      pending.value = null;
      append({
        role: "assistant",
        // 有回答就展示回答；改图/撤销/重做无回答时以反馈链说明执行结果
        text: result.answer ?? (result.applied ? "" : "（未产生任何操作）"),
        steps: result.steps.length ? result.steps : undefined,
        reasoning,
      });
    } catch (e) {
      if (gen !== generation) return;
      const partial = pending.value?.content ?? "";
      const reasoning = pending.value?.reasoning || undefined;
      pending.value = null;
      // 用户主动停止：不算错误，保留已流式产生的部分回答
      if (e instanceof DOMException && e.name === "AbortError") {
        append({
          role: "assistant",
          text: partial && !isOpsStream(partial) ? partial : "（已停止生成）",
          reasoning,
        });
      } else {
        append({
          role: "error",
          text: e instanceof Error ? e.message : String(e),
        });
      }
    } finally {
      // 旧文档的异步收尾不能重置新文档的会话状态
      if (gen === generation) {
        busy.value = false;
        pending.value = null;
        abort = null;
      }
    }
  }

  function stop() {
    abort?.abort();
  }

  // 切换/新建文档：中止进行中的生成并清空对话，避免旧文档回复污染新画布
  function reset() {
    generation++;
    abort?.abort();
    abort = null;
    busy.value = false;
    pending.value = null;
    messages.value = [];
    prompt.value = "";
  }

  function clear() {
    if (busy.value) return;
    messages.value = [];
  }

  function toggleSettings() {
    settingsOpen.value = !settingsOpen.value;
  }

  function toggleSidebar() {
    sidebarOpen.value = !sidebarOpen.value;
  }

  return {
    messages,
    pending,
    busy,
    sidebarOpen,
    settingsOpen,
    prompt,
    config,
    ready,
    aiGenerate,
    send,
    stop,
    clear,
    reset,
    toggleSettings,
    toggleSidebar,
  };
}
