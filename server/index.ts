import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadSampleData, appendMessage } from "./dataStore";
import { initSse, sendSseEvent, ssePing } from "./sse";
import { loadEnvFiles } from "./loadEnv";

loadEnvFiles();

const app = express();
app.use(express.json({ limit: "1mb" })); // 限制请求体大小，防止恶意 Payload

// ----------------------------------------------------------------------
// 静态数据读取 API (供前端拉取列表、详情等展示用)
// ----------------------------------------------------------------------

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/conversations", async (_req, res) => {
  res.json((await loadSampleData()).conversations);
});

app.get("/api/conversations/:conversationId", async (req, res) => {
  const data = await loadSampleData();
  const cid = req.params.conversationId;
  const conversation = data.conversations.find((c: any) => c.conversationId === cid);
  if (!conversation) return res.status(404).json({ error: "Conversation not found" });

  const orderDetail = conversation.linkedOrderId ? data.orderDetails.find((o: any) => o.orderId === conversation.linkedOrderId) : null;
  const shipments = orderDetail?.shipmentIds ? data.shipments.filter((s: any) => orderDetail.shipmentIds.includes(s.shipmentId)) : [];
  res.json({ conversation, messages: data.messages.filter((m: any) => m.conversationId === cid), orderDetail, shipments });
});

// ----------------------------------------------------------------------
// Agent 流式交互 API (核心)
// ----------------------------------------------------------------------

const ChatStreamBodySchema = z.object({
  conversationId: z.string().min(1),
  message: z.string().min(1),
  context: z.object({ orderId: z.string().optional(), confirm: z.object({ action: z.string(), payload: z.unknown() }).optional() }).optional()
});

app.post("/api/chat/stream", async (req, res) => {
  // 1. 初始化 SSE Headers (Content-Type: text/event-stream, Keep-Alive)
  initSse(res);
  const traceId = `t_${Date.now()}`;
  sendSseEvent(res, "plan_update", {
    traceId,
    steps: [{ stepId: "boot", title: "启动 Agent", status: "running" }]
  });
  ssePing(res);
  const pingTimer = setInterval(() => ssePing(res), 10_000);
  res.on("close", () => clearInterval(pingTimer));

  const parsed = ChatStreamBodySchema.safeParse(req.body);
  if (!parsed.success) {
    sendSseEvent(res, "error", { traceId, message: "Invalid request body" });
    clearInterval(pingTimer);
    return res.end();
  }

  const { conversationId, message, context } = parsed.data;

  // 记录用户真实输入（排除 MCP 调试命令）
  if (!/^\/(export|sql|audit)\b/i.test(message)) appendMessage(conversationId, "user", message);

  // 校验必须的 API Key 或是否仅为纯 MCP 调试命令
  const hasKey = Boolean(process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY);
  const allowMcpOnlyCommand = Boolean(process.env.USE_MCP === "1" && /^\/(export|sql|audit)\b/i.test(message));
  
  if (!hasKey && !allowMcpOnlyCommand) {
    sendSseEvent(res, "error", { traceId, message: "未配置 API Key，无法启动 LangChain Agent。" });
    sendSseEvent(res, "final", { traceId });
    return res.end();
  }

  try {
    // 动态引入 langchainAgent，避免启动时强制加载导致没配 Key 就报错
    const { runLangChainAgent } = await import("./langchainAgent");
    await runLangChainAgent({ res, conversationId, userMessage: message, traceId, context });
  } catch (err: any) {
    sendSseEvent(res, "error", { traceId, message: err.message || "Agent 运行异常" });
  } finally {
    clearInterval(pingTimer);
    // 2. 结束 SSE 流
    sendSseEvent(res, "final", { traceId });
    res.end();
  }
});

// ----------------------------------------------------------------------
// 静态资源托管 (生产环境或配置 SERVE_STATIC=1 时启用)
// ----------------------------------------------------------------------
const distDir = path.resolve(process.cwd(), "dist");
if ((process.env.NODE_ENV === "production" || process.env.SERVE_STATIC === "1") && existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/?).*/, (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

const port = Number(process.env.PORT) || 8787;
app.listen(port, () => console.log(`[server] http://localhost:${port}`));
