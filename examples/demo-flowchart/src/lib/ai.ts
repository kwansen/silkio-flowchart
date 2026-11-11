// AI 侧边栏共享的数据模型与小工具（纯 TS，无 DOM 事件绑定）
export interface AIConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface ChatMessage {
  id: number;
  // user = 用户指令；assistant = 回答/执行反馈；error = 失败信息
  role: "user" | "assistant" | "error";
  text: string;
  detail?: string; // 画布变更摘要（以 ✓ 反馈链展示）
  reasoning?: string; // 思考过程（完成后保留可折叠回看）
}

export interface PendingReply {
  reasoning: string;
  content: string;
}

export const AI_CONFIG_KEY = "flowchart-ai-config";

export function loadAIConfig(): AIConfig {
  const empty: AIConfig = { baseURL: "", apiKey: "", model: "" };
  if (typeof localStorage === "undefined") return empty;
  try {
    return {
      ...empty,
      ...JSON.parse(localStorage.getItem(AI_CONFIG_KEY) ?? "{}"),
    };
  } catch {
    return empty;
  }
}

// 语义图 JSON 形态的输出不实时渲染，等解析完成后以执行反馈展示；
// 纯文本回答（提问类指令）才走 Markdown 流式渲染
export function isOpsStream(text: string): boolean {
  const s = text.trimStart();
  return s.startsWith("{") || s.startsWith("[") || s.startsWith("```");
}
