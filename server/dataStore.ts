import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 数据类型定义简写，去掉冗余的 Zod 校验（在纯演示/POC阶段可以简化以缩减代码）
export type SampleData = {
  users: any[];
  orders: any[];
  orderDetails: any[];
  shipments: any[];
  kbArticles: any[];
  conversations: any[];
  messages: any[];
  toolCalls: any[];
  indexes: {
    ordersByOrderNo: Record<string, string>;
    usersByPhoneLast4: Record<string, string[]>;
    ordersByUserId: Record<string, string[]>;
  };
};

let cached: SampleData | null = null;

/**
 * 加载并缓存本地 mock 数据
 * - 为了让每次会话从空白开始，这里强制清空了 json.messages
 */
export async function loadSampleData(): Promise<SampleData> {
  if (cached) return cached;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const raw = await readFile(path.resolve(repoRoot, "data/milestone1/sample-data.json"), "utf-8");
  const json = JSON.parse(raw);
  json.messages = []; // 每次启动清空聊天记录
  cached = json as SampleData;
  return cached;
}

/**
 * 内存中追加聊天记录，用于支持 /export 导出最新的真实对话
 */
export function appendMessage(conversationId: string, role: "user" | "agent" | "cs", content: string) {
  cached?.messages.push({
    messageId: `m_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    conversationId,
    role,
    content,
    createdAt: new Date().toISOString(),
    citations: []
  });
}

/**
 * 生成定长摘要，用于截断过长文本
 */
export function snippetFromContent(content: string, maxLen = 140) {
  const norm = content.replace(/\s+/g, " ").trim();
  return norm.length <= maxLen ? norm : norm.slice(0, maxLen) + "…";
}
