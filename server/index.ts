import express from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadSampleData, snippetFromContent } from "./dataStore";
import { initSse, sendSseEvent, sleep } from "./sse";
import { runLangChainAgent } from "./langchainAgent";
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

    await runLangChainAgent({ res, conversationId, userMessage: message, traceId, context });
    sendSseEvent(res, "final", { traceId });
    res.end();
    return;
  }

  const data = await loadSampleData();
  const conversation = data.conversations.find((c: any) => c.conversationId === conversationId);

  const isLogistics =
    /物流|没收到|未收到|到哪|到哪了|快递|派送|轨迹|滞留|异常/i.test(message);

  const isPolicy = /规则|政策|SOP|退货|无理由|破损|少件|运费|丢失/i.test(message);

  type Step = { stepId: string; title: string; status: "pending" | "running" | "done" };

  const steps: Step[] = isLogistics
    ? [
        { stepId: "step_01", title: "定位订单", status: "running" },
        { stepId: "step_02", title: "查询物流轨迹", status: "pending" },
        { stepId: "step_03", title: "生成解释与下一步建议", status: "pending" }
      ]
    : [
        { stepId: "step_01", title: "检索知识库条款", status: "running" },
        { stepId: "step_02", title: "生成带引用的答复", status: "pending" }
      ];

  sendSseEvent(res, "plan_update", { traceId, steps });
  await sleep(120);

  if (isLogistics) {
    const linkedOrderId = conversation?.linkedOrderId ?? null;
    const orderDetail = linkedOrderId
      ? data.orderDetails.find((o: any) => o.orderId === linkedOrderId) ?? null
      : null;

    const step1Start = Date.now();
    sendSseEvent(res, "tool_call", {
      toolCallId: `tc_${Date.now()}_1`,
      traceId,
      conversationId,
      stepId: "step_01",
      toolName: "getOrderDetail",
      inputRedacted: { orderId: linkedOrderId ?? "unknown" },
      outputRedacted: {},
      status: "success",
      latencyMs: 0,
      error: null,
      createdAt: new Date().toISOString()
    });
    await sleep(150);
    sendSseEvent(res, "tool_result", {
      toolCallId: `tc_${Date.now()}_1r`,
      traceId,
      conversationId,
      stepId: "step_01",
      toolName: "getOrderDetail",
      inputRedacted: { orderId: linkedOrderId ?? "unknown" },
      outputRedacted: { orderDetail },
      status: orderDetail ? "success" : "fail",
      latencyMs: Date.now() - step1Start,
      error: orderDetail ? null : { code: "ORDER_NOT_FOUND", message: "未能定位订单，请补充订单号或手机号后四位" },
      createdAt: new Date().toISOString()
    });

    if (!orderDetail) {
      sendSseEvent(res, "assistant_delta", { traceId, delta: "我还没定位到具体订单。请提供订单号或手机号后四位，我再帮你查物流轨迹。" });
      sendSseEvent(res, "final", { traceId });
      res.end();
      return;
    }

    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const shipmentId = orderDetail.shipmentIds?.[0] ?? null;
    const shipment = shipmentId ? data.shipments.find((s: any) => s.shipmentId === shipmentId) ?? null : null;

    const step2Start = Date.now();
    sendSseEvent(res, "tool_call", {
      toolCallId: `tc_${Date.now()}_2`,
      traceId,
      conversationId,
      stepId: "step_02",
      toolName: "getShipmentTracking",
      inputRedacted: { shipmentId: shipmentId ?? "unknown" },
      outputRedacted: {},
      status: "success",
      latencyMs: 0,
      error: null,
      createdAt: new Date().toISOString()
    });
    await sleep(180);
    sendSseEvent(res, "tool_result", {
      toolCallId: `tc_${Date.now()}_2r`,
      traceId,
      conversationId,
      stepId: "step_02",
      toolName: "getShipmentTracking",
      inputRedacted: { shipmentId: shipmentId ?? "unknown" },
      outputRedacted: { shipment },
      status: shipment ? "success" : "fail",
      latencyMs: Date.now() - step2Start,
      error: shipment ? null : { code: "SHIPMENT_NOT_FOUND", message: "未查到包裹信息" },
      createdAt: new Date().toISOString()
    });

    steps[1].status = shipment ? "done" : "done";
    steps[2].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const lastEvent = shipment?.events?.at(-1);
    const status = shipment?.status ?? "unknown";
    const delta = shipment
      ? `已为你查到物流：${shipment.carrier}（${shipment.trackingNoMasked}）。当前状态：${status}。\n最新轨迹：${lastEvent?.location ?? "-"} · ${lastEvent?.description ?? "-"} · ${lastEvent?.time ?? "-"}。\n如果 48 小时无更新或显示异常，我可以按SOP帮你继续处理。`
      : "我查到了订单，但暂时没查到包裹轨迹。你可以提供更多信息（例如是否分包裹/是否更换地址），我再继续排查。";

    for (const chunk of delta.split("")) {
      sendSseEvent(res, "assistant_delta", { traceId, delta: chunk });
      await sleep(6);
    }

    steps[2].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    sendSseEvent(res, "final", { traceId });
    res.end();
    return;
  }

  if (isPolicy) {
    const step1Start = Date.now();
    sendSseEvent(res, "tool_call", {
      toolCallId: `tc_${Date.now()}_1`,
      traceId,
      conversationId,
      stepId: "step_01",
      toolName: "kbSearch",
      inputRedacted: { q: message },
      outputRedacted: {},
      status: "success",
      latencyMs: 0,
      error: null,
      createdAt: new Date().toISOString()
    });
    await sleep(180);

    const qLower = message.toLowerCase();
    const hits = data.kbArticles
      .filter((a: any) => {
        const title = String(a.title ?? "").toLowerCase();
        const content = String(a.content ?? "").toLowerCase();
        const tags = Array.isArray(a.tags) ? a.tags.join(" ").toLowerCase() : "";
        return title.includes(qLower) || content.includes(qLower) || tags.includes(qLower);
      })
      .slice(0, 3)
      .map((a: any) => ({
        articleId: a.articleId,
        title: a.title,
        snippet: snippetFromContent(String(a.content ?? "")),
        tags: a.tags ?? [],
        updatedAt: a.updatedAt
      }));

    sendSseEvent(res, "tool_result", {
      toolCallId: `tc_${Date.now()}_1r`,
      traceId,
      conversationId,
      stepId: "step_01",
      toolName: "kbSearch",
      inputRedacted: { q: message },
      outputRedacted: { hits },
      status: "success",
      latencyMs: Date.now() - step1Start,
      error: null,
      createdAt: new Date().toISOString()
    });

    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const best = hits[0];
    const answer = best
      ? `我查到相关条款：${best.title}（引用：${best.articleId}）。\n要点：${best.snippet}\n如果你告诉我订单号/手机号后四位和具体商品状态，我可以继续按流程给你下一步建议。`
      : "我暂时没在知识库里命中对应条款。你能补充一下是“退货/换货/破损/少件/运费”哪一类吗？";

    for (const chunk of answer.split("")) {
      sendSseEvent(res, "assistant_delta", { traceId, delta: chunk });
      await sleep(6);
    }

    steps[1].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    sendSseEvent(res, "final", { traceId });
    res.end();
    return;
  }

  sendSseEvent(res, "assistant_delta", {
    traceId,
    delta: "里程碑1当前仅演示：查物流、政策/SOP问答。你可以问“帮我查下物流”或“物流异常滞留怎么处理”。"
  });
  sendSseEvent(res, "final", { traceId });
  res.end();
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
