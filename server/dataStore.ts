import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const SampleDataSchema = z.object({
  users: z.array(
    z.object({
      userId: z.string(),
      nameMasked: z.string(),
      phoneMasked: z.string(),
      phoneLast4: z.string(),
      createdAt: z.string(),
      riskFlags: z.array(z.string())
    })
  ),
  orders: z.array(
    z.object({
      orderId: z.string(),
      orderNo: z.string(),
      userId: z.string(),
      status: z.enum(["paid", "shipped", "delivered", "cancelled"]),
      paidAt: z.string(),
      totalAmount: z.number(),
      currency: z.string(),
      itemsSummary: z.string()
    })
  ),
  orderDetails: z.array(z.any()),
  shipments: z.array(z.any()),
  kbArticles: z.array(z.any()),
  conversations: z.array(z.any()),
  messages: z.array(z.any()),
  toolCalls: z.array(z.any()),
  indexes: z.object({
    ordersByOrderNo: z.record(z.string(), z.string()),
    usersByPhoneLast4: z.record(z.string(), z.array(z.string())),
    ordersByUserId: z.record(z.string(), z.array(z.string()))
  })
});

type SampleData = z.infer<typeof SampleDataSchema> & {
  orderDetails: any[];
  shipments: any[];
  kbArticles: any[];
  conversations: any[];
  messages: any[];
  toolCalls: any[];
};

let cached: { data: SampleData } | null = null;

function dataPath() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  return path.resolve(repoRoot, "data", "milestone1", "sample-data.json");
}

export async function loadSampleData(): Promise<SampleData> {
  if (cached) return cached.data;
  const raw = await readFile(dataPath(), "utf-8");
  const json = JSON.parse(raw);
  // 清空示例对话，让会话默认从空白开始
  json.messages = [];
  const data = SampleDataSchema.parse(json) as SampleData;
  cached = { data };
  return data;
}

export function appendMessage(conversationId: string, role: "user" | "agent", content: string) {
  if (cached) {
    cached.data.messages.push({
      messageId: `m_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      conversationId,
      role,
      content,
      createdAt: new Date().toISOString(),
      citations: []
    });
  }
}

export function snippetFromContent(content: string, maxLen = 140) {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLen) return normalized;
  return normalized.slice(0, maxLen) + "…";
}
