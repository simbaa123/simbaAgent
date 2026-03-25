import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadSampleData, snippetFromContent, appendMessage } from "./dataStore";
import { initSse, sendSseEvent } from "./sse";
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/conversations", async (_req, res) => {
  const data = await loadSampleData();
  res.json(data.conversations);
});

app.get("/api/conversations/:conversationId", async (req, res) => {
  const data = await loadSampleData();
  const conversationId = req.params.conversationId;
  const conversation = data.conversations.find((c: any) => c.conversationId === conversationId);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const messages = data.messages.filter((m: any) => m.conversationId === conversationId);
  const orderDetail = conversation.linkedOrderId
    ? data.orderDetails.find((o: any) => o.orderId === conversation.linkedOrderId) ?? null
    : null;
  const shipments = orderDetail?.shipmentIds
    ? data.shipments.filter((s: any) => orderDetail.shipmentIds.includes(s.shipmentId))
    : [];

  res.json({ conversation, messages, orderDetail, shipments });
});

app.get("/api/orders/search", async (req, res) => {
  const data = await loadSampleData();
  const orderNo = typeof req.query.orderNo === "string" ? req.query.orderNo.trim() : "";
  const phoneLast4 = typeof req.query.phoneLast4 === "string" ? req.query.phoneLast4.trim() : "";

  const orderIds = new Set<string>();

  if (orderNo) {
    const orderId = data.indexes.ordersByOrderNo[orderNo];
    if (orderId) orderIds.add(orderId);
  }

  if (phoneLast4) {
    const userIds = data.indexes.usersByPhoneLast4[phoneLast4] ?? [];
    for (const userId of userIds) {
      const oids = data.indexes.ordersByUserId[userId] ?? [];
      for (const oid of oids) orderIds.add(oid);
    }
  }

  const orders = data.orders.filter((o) => orderIds.has(o.orderId));
  res.json({ orders });
});

app.get("/api/orders/:orderId", async (req, res) => {
  const data = await loadSampleData();
  const order = data.orderDetails.find((o: any) => o.orderId === req.params.orderId);
  if (!order) return res.status(404).json({ error: "Order not found" });
  res.json(order);
});

app.get("/api/shipments/:shipmentId", async (req, res) => {
  const data = await loadSampleData();
  const shipment = data.shipments.find((s: any) => s.shipmentId === req.params.shipmentId);
  if (!shipment) return res.status(404).json({ error: "Shipment not found" });
  res.json(shipment);
});

app.get("/api/kb/search", async (req, res) => {
  const data = await loadSampleData();
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!q) return res.json({ hits: [] });
  const qLower = q.toLowerCase();
  const hits = data.kbArticles
    .filter((a: any) => {
      const title = String(a.title ?? "").toLowerCase();
      const content = String(a.content ?? "").toLowerCase();
      const tags = Array.isArray(a.tags) ? a.tags.join(" ").toLowerCase() : "";
      return title.includes(qLower) || content.includes(qLower) || tags.includes(qLower);
    })
    .slice(0, 5)
    .map((a: any) => ({
      articleId: a.articleId,
      title: a.title,
      snippet: snippetFromContent(String(a.content ?? "")),
      tags: a.tags ?? [],
      updatedAt: a.updatedAt
    }));
  res.json({ hits });
});

const ChatStreamBodySchema = z.object({
  conversationId: z.string().min(1),
  message: z.string().min(1),
  context: z
    .object({
      orderId: z.string().optional(),
      confirm: z
        .object({
          action: z.string(),
          payload: z.unknown()
        })
        .optional()
    })
    .optional()
});

app.post("/api/chat/stream", async (req, res) => {
  initSse(res);

  const parsed = ChatStreamBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendSseEvent(res, "error", { traceId: "t_invalid", message: "Invalid request body" });
    res.end();
    return;
  }

  const { conversationId, message, context } = parsed.data;
  const traceId = `t_${Date.now()}`;

  // 忽略 MCP 命令本身的记录，或者也记录？用户命令 /export 记录的话也没关系，不过它不算是真实的对话。
  // 为了让对话连贯，将用户输入保存在内存中
  if (!/^\/(export|sql|audit)\b/i.test(message)) {
    appendMessage(conversationId, "user", message);
  }

  if (process.env.USE_LANGCHAIN === "1") {
    const hasKey = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
    const allowMcpOnlyCommand = Boolean(
      process.env.USE_MCP === "1" && /^\/(export|sql|audit)\b/i.test(message)
    );
    if (!hasKey && !allowMcpOnlyCommand) {
      sendSseEvent(res, "error", {
        traceId,
        message: "未配置 OPENAI_API_KEY 或 DEEPSEEK_API_KEY，暂时无法启用 LangChain Agent。"
      });
      sendSseEvent(res, "final", { traceId });
      res.end();
      return;
    }

    const { runLangChainAgent } = await import("./langchainAgent");
    await runLangChainAgent({ res, conversationId, userMessage: message, traceId, context });
    sendSseEvent(res, "final", { traceId });
    res.end();
    return;
  }

  sendSseEvent(res, "error", {
    traceId,
    message:
      "当前仅支持真实 Agent 模式，请设置 USE_LANGCHAIN=1，并配置 OPENAI/DEEPSEEK Key 后重试。"
  });
  sendSseEvent(res, "final", { traceId });
  res.end();
  return;
});

const distDir = path.resolve(process.cwd(), "dist");
const shouldServeStatic = process.env.NODE_ENV === "production" || process.env.SERVE_STATIC === "1";

if (shouldServeStatic && existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/?).*/, (_req, res) => {
    res.sendFile(path.join(distDir, "index.html"));
  });
}

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => {
  console.log(`[server] http://localhost:${port}`);
});
