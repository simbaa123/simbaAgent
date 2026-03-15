import path from "node:path";
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { Response } from "express";
import { loadSampleData, snippetFromContent } from "./dataStore";
import { sendSseEvent, sleep } from "./sse";
import { getFilesystemMcpClient, getSqliteMcpClient } from "./mcpClients";

type PlanStep = { stepId: string; title: string; status: "pending" | "running" | "done" };

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function isLogisticsQuery(text: string) {
  return /物流|没收到|未收到|到哪|到哪了|快递|派送|轨迹|滞留|异常/i.test(text);
}

function isPolicyQuery(text: string) {
  return /规则|政策|SOP|退货|无理由|破损|少件|运费|丢失/i.test(text);
}

function parseOrderNo(text: string) {
  const m = text.match(/E\d{10,}/i);
  return m ? m[0].toUpperCase() : null;
}

function parsePhoneLast4(text: string) {
  const patterns = [
    /(?:手机号|手机|电话|尾号|后四位)\D*(\d{4})/,
    /(\d{4})\s*(?:后四位|尾号)/
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

async function streamText(res: Response, traceId: string, text: string) {
  for (const chunk of chunkString(text, 6)) {
    sendSseEvent(res, "assistant_delta", { traceId, delta: chunk });
    await sleep(8);
  }
}

type ReturnEligibility = {
  eligible: boolean;
  windowDaysLeft: number;
  feeRule: "buyer" | "seller";
  requiredProof: string[];
  reason: string;
};

function daysBetween(fromIso: string, toIso: string) {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.floor((b - a) / (24 * 3600 * 1000));
}

function calcReturnEligibility(params: {
  nowIso: string;
  orderDetail: any;
  shipments: any[];
}): ReturnEligibility {
  const deliveredAt =
    params.shipments
      .map((s) => s?.deliveredAt)
      .filter((x) => typeof x === "string")
      .sort()
      .at(-1) ?? null;

  if (!deliveredAt) {
    return {
      eligible: false,
      windowDaysLeft: 0,
      feeRule: "buyer",
      requiredProof: [],
      reason: "订单未签收或缺少签收时间，暂无法按7天无理由处理。"
    };
  }

  const days = daysBetween(deliveredAt, params.nowIso);
  const windowDaysLeft = Math.max(0, 7 - days);
  if (days > 7) {
    return {
      eligible: false,
      windowDaysLeft,
      feeRule: "buyer",
      requiredProof: [],
      reason: "已超过签收后7天无理由退货时效。"
    };
  }

  if (params.orderDetail?.aftersaleStatus && params.orderDetail.aftersaleStatus !== "none") {
    return {
      eligible: false,
      windowDaysLeft,
      feeRule: "buyer",
      requiredProof: [],
      reason: "该订单已存在售后处理中，暂不支持再次发起退货。"
    };
  }

  return {
    eligible: true,
    windowDaysLeft,
    feeRule: "buyer",
    requiredProof: [],
    reason: "满足签收后7天内退货条件。"
  };
}

function createModel() {
  const deepseekApiKey = env("DEEPSEEK_API_KEY");
  const openaiApiKey = env("OPENAI_API_KEY");

  const usingDeepSeek = Boolean(deepseekApiKey);

  const model =
    (usingDeepSeek ? env("DEEPSEEK_MODEL") : "") ||
    env("OPENAI_MODEL") ||
    (usingDeepSeek ? "deepseek-chat" : "gpt-4.1-mini");

  const baseURL =
    (usingDeepSeek ? env("DEEPSEEK_BASE_URL") : "") ||
    env("OPENAI_BASE_URL") ||
    (usingDeepSeek ? "https://api.deepseek.com/v1" : "");

  const apiKey = usingDeepSeek ? deepseekApiKey : openaiApiKey;

  const timeoutMsRaw = env(usingDeepSeek ? "DEEPSEEK_TIMEOUT_MS" : "OPENAI_TIMEOUT_MS") || env("OPENAI_TIMEOUT_MS");
  const maxRetriesRaw = env(usingDeepSeek ? "DEEPSEEK_MAX_RETRIES" : "OPENAI_MAX_RETRIES") || env("OPENAI_MAX_RETRIES");
  const maxTokensRaw = env(usingDeepSeek ? "DEEPSEEK_MAX_TOKENS" : "OPENAI_MAX_TOKENS") || env("OPENAI_MAX_TOKENS");

  const timeout = timeoutMsRaw ? Number(timeoutMsRaw) : 120_000;
  const maxRetries = maxRetriesRaw ? Number(maxRetriesRaw) : 2;
  const maxTokens = maxTokensRaw ? Number(maxTokensRaw) : undefined;

  return new ChatOpenAI({
    model,
    temperature: 0,
    apiKey,
    configuration: baseURL ? { baseURL } : undefined,
    timeout: Number.isFinite(timeout) ? timeout : 120_000,
    maxRetries: Number.isFinite(maxRetries) ? maxRetries : 2,
    ...(typeof maxTokens === "number" && Number.isFinite(maxTokens) ? { maxTokens } : {}),
    streaming: true,
    streamUsage: false
  });
}

function chunkString(s: string, size = 8) {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts;
}

function extractDeltaFromChunk(chunk: any): string {
  const content = chunk?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") return String((p as any).text ?? (p as any).content ?? "");
        return "";
      })
      .join("");
  }
  return "";
}

export async function runLangChainAgent(params: {
  res: Response;
  conversationId: string;
  userMessage: string;
  traceId: string;
  context?: { orderId?: string; confirm?: { action: string; payload: unknown } };
}) {
  const { res, conversationId, userMessage, traceId, context } = params;
  const data = await loadSampleData();

  const conversation = data.conversations.find((c: any) => c.conversationId === conversationId) ?? null;
  const linkedOrderId = conversation?.linkedOrderId ?? null;

  const emitToolCall = (payload: any) => sendSseEvent(res, "tool_call", payload);
  const emitToolResult = (payload: any) => sendSseEvent(res, "tool_result", payload);
  let toolUsed = false;

  const useMcp = env("USE_MCP") === "1";
  const sqliteUrl = env("MCP_SQLITE_URL") || "sqlite://./data/agent.sqlite";
  let sqliteSchemaReady = false;

  async function ensureSqliteSchema() {
    if (!useMcp || sqliteSchemaReady) return;
    const client = await getSqliteMcpClient({ url: sqliteUrl });
    await client.callTool({
      name: "sqlite_ddl",
      arguments: {
        query:
          "CREATE TABLE IF NOT EXISTS audit_requests (" +
          "id INTEGER PRIMARY KEY AUTOINCREMENT," +
          "created_at TEXT NOT NULL," +
          "conversation_id TEXT NOT NULL," +
          "trace_id TEXT NOT NULL," +
          "user_message TEXT NOT NULL" +
          ");",
        parameters: []
      }
    });
    sqliteSchemaReady = true;
  }

  const exportConversationToFile =
    useMcp
      ? tool(
          async ({ format }: { format?: "md" | "json" }) => {
            const started = Date.now();
            const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            toolUsed = true;
            emitToolCall({
              toolCallId,
              traceId,
              conversationId,
              stepId: "step_02",
              toolName: "exportConversationToFile",
              inputRedacted: { format: format ?? "md" },
              outputRedacted: {},
              status: "success",
              latencyMs: 0,
              error: null,
              createdAt: new Date().toISOString()
            });

            const fsClient = await getFilesystemMcpClient({
              allowedDirs: [path.resolve(process.cwd(), "exports")]
            });
            const exportsDir = path.resolve(process.cwd(), "exports");
            await fsClient.callTool({ name: "create_directory", arguments: { path: exportsDir } });

            const msgs = data.messages
              .filter((m: any) => m.conversationId === conversationId)
              .map((m: any) => `- [${m.createdAt}] ${m.role}: ${m.content}`)
              .join("\n");

            const content =
              (format ?? "md") === "json"
                ? JSON.stringify({ conversationId, traceId, messages: data.messages.filter((m: any) => m.conversationId === conversationId) }, null, 2)
                : `# Conversation ${conversationId}\n\ntraceId: ${traceId}\n\n${msgs}\n`;

            const ext = (format ?? "md") === "json" ? "json" : "md";
            const outPath = path.resolve(exportsDir, `${conversationId}_${Date.now()}.${ext}`);
            await fsClient.callTool({ name: "write_file", arguments: { path: outPath, content } });

            const output = { ok: true, path: outPath };
            emitToolResult({
              toolCallId: `${toolCallId}_r`,
              traceId,
              conversationId,
              stepId: "step_02",
              toolName: "exportConversationToFile",
              inputRedacted: { format: format ?? "md" },
              outputRedacted: output,
              status: "success",
              latencyMs: Date.now() - started,
              error: null,
              createdAt: new Date().toISOString()
            });
            return output;
          },
          {
            name: "exportConversationToFile",
            description: "将当前会话导出为 markdown/json 文件并返回文件路径（通过 MCP filesystem 写入 exports 目录）",
            schema: z.object({
              format: z.enum(["md", "json"]).optional()
            })
          }
        )
      : null;

  const sqliteQuery =
    useMcp
      ? tool(
          async ({ query, parameters }: { query: string; parameters?: unknown[] }) => {
            if (!/^\s*select\b/i.test(query)) throw new Error("sqliteQuery 仅支持 SELECT 查询");
            const started = Date.now();
            const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            toolUsed = true;
            emitToolCall({
              toolCallId,
              traceId,
              conversationId,
              stepId: "step_02",
              toolName: "sqliteQuery",
              inputRedacted: { query, parameters: Array.isArray(parameters) ? parameters : [] },
              outputRedacted: {},
              status: "success",
              latencyMs: 0,
              error: null,
              createdAt: new Date().toISOString()
            });

            await ensureSqliteSchema();
            const client = await getSqliteMcpClient({ url: sqliteUrl });

            await client.callTool({
              name: "sqlite_insert",
              arguments: {
                query: "INSERT INTO audit_requests (created_at, conversation_id, trace_id, user_message) VALUES (?, ?, ?, ?)",
                parameters: [new Date().toISOString(), conversationId, traceId, userMessage]
              }
            });

            const result = await client.callTool({
              name: "sqlite_query",
              arguments: { query, parameters: Array.isArray(parameters) ? parameters : [] }
            });

            const output = { result };
            emitToolResult({
              toolCallId: `${toolCallId}_r`,
              traceId,
              conversationId,
              stepId: "step_02",
              toolName: "sqliteQuery",
              inputRedacted: { query, parameters: Array.isArray(parameters) ? parameters : [] },
              outputRedacted: { ok: true },
              status: "success",
              latencyMs: Date.now() - started,
              error: null,
              createdAt: new Date().toISOString()
            });
            return output;
          },
          {
            name: "sqliteQuery",
            description: "通过 MCP sqlite 执行 SELECT 查询（同时会写入一条 audit_requests 审计记录）",
            schema: z.object({
              query: z.string().min(1),
              parameters: z.array(z.any()).optional()
            })
          }
        )
      : null;

  if (useMcp) {
    const t = userMessage.trim();
    const exportMatch = t.match(/^\/export(?:\s+(md|json))?$/i);
    if (exportMatch && exportConversationToFile) {
      const format = (exportMatch[1]?.toLowerCase() as "md" | "json" | undefined) ?? "md";
      const out = await exportConversationToFile.invoke({ format });
      const outPath = (out as any)?.path as string | undefined;
      if (outPath) {
        sendSseEvent(res, "export_ready", {
          traceId,
          format,
          path: outPath
        });
      }
      await streamText(res, traceId, `已导出：${(out as any)?.path ?? ""}`);
      return;
    }

    const auditMatch = t.match(/^\/audit$/i);
    if (auditMatch && sqliteQuery) {
      const query =
        "SELECT id, created_at, conversation_id, trace_id, user_message " +
        "FROM audit_requests " +
        "WHERE conversation_id = ? " +
        "ORDER BY id DESC " +
        "LIMIT 20";
      const out = await sqliteQuery.invoke({ query, parameters: [conversationId] });
      const text = (out as any)?.result?.content?.find?.((c: any) => c?.type === "text")?.text;
      let rows: any[] = [];
      if (typeof text === "string") {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed?.rows)) rows = parsed.rows;
        } catch {}
      }
      sendSseEvent(res, "sqlite_result", { traceId, query, rows });
      await streamText(res, traceId, `已返回最近审计（${rows.length}条）`);
      return;
    }

    const sqlMatch = t.match(/^\/sql\s+([\s\S]+)$/i);
    if (sqlMatch && sqliteQuery) {
      const query = sqlMatch[1].trim();
      const out = await sqliteQuery.invoke({ query, parameters: [] });
      const text = (out as any)?.result?.content?.find?.((c: any) => c?.type === "text")?.text;
      let rows: any[] = [];
      if (typeof text === "string") {
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed?.rows)) rows = parsed.rows;
        } catch {}
      }
      sendSseEvent(res, "sqlite_result", { traceId, query, rows });
      await streamText(res, traceId, `已返回查询结果（${rows.length}行）`);
      return;
    }
  }

  if (context?.confirm?.action === "create_return_request") {
    const payload = (context.confirm.payload ?? {}) as any;
    const orderId = typeof payload.orderId === "string" ? payload.orderId : context.orderId;
    const reason = typeof payload.reason === "string" ? payload.reason : "7天无理由退货";

    const confirmSteps: PlanStep[] = [
      { stepId: "step_01", title: "确认并创建退货申请", status: "running" },
      { stepId: "step_02", title: "生成用户通知", status: "pending" }
    ];
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });

    if (!orderId) {
      confirmSteps[0].status = "done";
      confirmSteps[1].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      await streamText(res, traceId, "缺少订单信息，无法创建退货申请。");
      confirmSteps[1].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      return;
    }

    const started = Date.now();
    const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    toolUsed = true;
    emitToolCall({
      toolCallId,
      traceId,
      conversationId,
      stepId: "step_01",
      toolName: "createReturnRequest",
      inputRedacted: { orderId, reason },
      outputRedacted: {},
      status: "success",
      latencyMs: 0,
      error: null,
      createdAt: new Date().toISOString()
    });

    const orderDetail = data.orderDetails.find((o: any) => o.orderId === orderId) ?? null;
    if (!orderDetail) {
      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: "step_01",
        toolName: "createReturnRequest",
        inputRedacted: { orderId, reason },
        outputRedacted: {},
        status: "fail",
        latencyMs: Date.now() - started,
        error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
        createdAt: new Date().toISOString()
      });
      confirmSteps[0].status = "done";
      confirmSteps[1].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      await streamText(res, traceId, "创建退货申请失败，请稍后再试。");
      confirmSteps[1].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      return;
    }

    const returnId = `r_${Date.now()}`;
    const returnAddress = "广东省深圳市南山区***路***号（售后仓）";
    const nextSteps = "请在48小时内寄回商品，并保留物流单号。仓库签收后将进入退款流程。";
    const output = {
      created: true,
      returnRequest: {
        returnId,
        orderId,
        orderNo: orderDetail.orderNo,
        reason,
        status: "created",
        createdAt: new Date().toISOString(),
        returnAddress,
        nextSteps
      }
    };
    emitToolResult({
      toolCallId: `${toolCallId}_r`,
      traceId,
      conversationId,
      stepId: "step_01",
      toolName: "createReturnRequest",
      inputRedacted: { orderId, reason },
      outputRedacted: output,
      status: "success",
      latencyMs: Date.now() - started,
      error: null,
      createdAt: new Date().toISOString()
    });

    confirmSteps[0].status = "done";
    confirmSteps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
    await streamText(
      res,
      traceId,
      `退货申请已创建。\n退货单号：${returnId}\n订单号：${orderDetail.orderNo}\n退货地址：${returnAddress}\n下一步：${nextSteps}`
    );
    confirmSteps[1].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
    return;
  }

  const isReturn = /退货|退掉|不要了|无理由退|退回/i.test(userMessage);
  const intent = isReturn ? "return" : isLogisticsQuery(userMessage) ? "logistics" : isPolicyQuery(userMessage) ? "policy" : "other";

  const steps: PlanStep[] =
    intent === "logistics"
      ? [
          { stepId: "step_01", title: "补齐订单信息", status: "running" },
          { stepId: "step_02", title: "查询物流轨迹", status: "pending" },
          { stepId: "step_03", title: "生成解释与下一步建议", status: "pending" }
        ]
      : intent === "return"
        ? [
            { stepId: "step_01", title: "补齐订单信息", status: "running" },
            { stepId: "step_02", title: "判断是否可退", status: "pending" },
            { stepId: "step_03", title: "确认并创建退货申请", status: "pending" }
          ]
      : intent === "policy"
        ? [
            { stepId: "step_01", title: "检索知识库条款", status: "running" },
            { stepId: "step_02", title: "生成带引用的答复", status: "pending" }
          ]
        : [{ stepId: "step_01", title: "生成答复", status: "running" }];

  sendSseEvent(res, "plan_update", { traceId, steps });

  const searchOrders = tool(
    async ({ orderNo, phoneLast4 }: { orderNo?: string; phoneLast4?: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      toolUsed = true;
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "searchOrders",
        inputRedacted: { orderNo: orderNo ?? undefined, phoneLast4: phoneLast4 ?? undefined },
        outputRedacted: {},
        status: "success",
        latencyMs: 0,
        error: null,
        createdAt: new Date().toISOString()
      });

      const orderIds = new Set<string>();
      if (orderNo) {
        const orderId = data.indexes.ordersByOrderNo[orderNo];
        if (orderId) orderIds.add(orderId);
      }
      if (phoneLast4) {
        const userIds = data.indexes.usersByPhoneLast4[phoneLast4] ?? [];
        for (const uid of userIds) {
          const oids = data.indexes.ordersByUserId[uid] ?? [];
          for (const oid of oids) orderIds.add(oid);
        }
      }

      const orders = data.orders.filter((o) => orderIds.has(o.orderId));
      const output = { orders };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "searchOrders",
        inputRedacted: { orderNo: orderNo ?? undefined, phoneLast4: phoneLast4 ?? undefined },
        outputRedacted: output,
        status: "success",
        latencyMs: Date.now() - started,
        error: null,
        createdAt: new Date().toISOString()
      });

      return output;
    },
    {
      name: "searchOrders",
      description: "根据订单号或手机号后四位检索订单列表（脱敏数据）",
      schema: z.object({
        orderNo: z.string().optional(),
        phoneLast4: z.string().length(4).optional()
      })
    }
  );

  const getOrderDetail = tool(
    async ({ orderId }: { orderId: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      toolUsed = true;
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "getOrderDetail",
        inputRedacted: { orderId },
        outputRedacted: {},
        status: "success",
        latencyMs: 0,
        error: null,
        createdAt: new Date().toISOString()
      });

      const orderDetail = data.orderDetails.find((o: any) => o.orderId === orderId) ?? null;
      const output = { orderDetail };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "getOrderDetail",
        inputRedacted: { orderId },
        outputRedacted: output,
        status: orderDetail ? "success" : "fail",
        latencyMs: Date.now() - started,
        error: orderDetail ? null : { code: "ORDER_NOT_FOUND", message: "Order not found" },
        createdAt: new Date().toISOString()
      });

      return output;
    },
    {
      name: "getOrderDetail",
      description: "根据 orderId 获取订单详情（包含包裹ID、收货信息脱敏、金额、商品）",
      schema: z.object({
        orderId: z.string()
      })
    }
  );

  const getShipmentTracking = tool(
    async ({ shipmentId }: { shipmentId: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      toolUsed = true;
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "getShipmentTracking",
        inputRedacted: { shipmentId },
        outputRedacted: {},
        status: "success",
        latencyMs: 0,
        error: null,
        createdAt: new Date().toISOString()
      });

      const shipment = data.shipments.find((s: any) => s.shipmentId === shipmentId) ?? null;
      const output = { shipment };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "getShipmentTracking",
        inputRedacted: { shipmentId },
        outputRedacted: output,
        status: shipment ? "success" : "fail",
        latencyMs: Date.now() - started,
        error: shipment ? null : { code: "SHIPMENT_NOT_FOUND", message: "Shipment not found" },
        createdAt: new Date().toISOString()
      });

      return output;
    },
    {
      name: "getShipmentTracking",
      description: "根据 shipmentId 获取物流轨迹",
      schema: z.object({
        shipmentId: z.string()
      })
    }
  );

  const kbSearch = tool(
    async ({ q }: { q: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      toolUsed = true;
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "kbSearch",
        inputRedacted: { q },
        outputRedacted: {},
        status: "success",
        latencyMs: 0,
        error: null,
        createdAt: new Date().toISOString()
      });

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

      const output = { hits };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "kbSearch",
        inputRedacted: { q },
        outputRedacted: output,
        status: "success",
        latencyMs: Date.now() - started,
        error: null,
        createdAt: new Date().toISOString()
      });

      return output;
    },
    {
      name: "kbSearch",
      description: "在政策/SOP 知识库中检索相关条款，返回命中列表（包含 articleId 作为引用）",
      schema: z.object({
        q: z.string().min(1)
      })
    }
  );

  const getReturnEligibility = tool(
    async ({ orderId }: { orderId: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      toolUsed = true;
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: intent === "return" ? "step_02" : "step_02",
        toolName: "getReturnEligibility",
        inputRedacted: { orderId },
        outputRedacted: {},
        status: "success",
        latencyMs: 0,
        error: null,
        createdAt: new Date().toISOString()
      });

      const orderDetail = data.orderDetails.find((o: any) => o.orderId === orderId) ?? null;
      const shipments = orderDetail?.shipmentIds
        ? data.shipments.filter((s: any) => orderDetail.shipmentIds.includes(s.shipmentId))
        : [];
      const eligibility = orderDetail
        ? calcReturnEligibility({ nowIso: new Date().toISOString(), orderDetail, shipments })
        : {
            eligible: false,
            windowDaysLeft: 0,
            feeRule: "buyer",
            requiredProof: [],
            reason: "未找到订单。"
          };

      const output = { eligibility };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: intent === "return" ? "step_02" : "step_02",
        toolName: "getReturnEligibility",
        inputRedacted: { orderId },
        outputRedacted: output,
        status: "success",
        latencyMs: Date.now() - started,
        error: null,
        createdAt: new Date().toISOString()
      });

      return output as { eligibility: ReturnEligibility };
    },
    {
      name: "getReturnEligibility",
      description: "判断订单是否可按7天无理由退货，并返回原因与剩余天数",
      schema: z.object({ orderId: z.string() })
    }
  );

  const createReturnRequest = tool(
    async ({ orderId, reason }: { orderId: string; reason: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      toolUsed = true;
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: intent === "return" ? "step_03" : "step_02",
        toolName: "createReturnRequest",
        inputRedacted: { orderId, reason },
        outputRedacted: {},
        status: "success",
        latencyMs: 0,
        error: null,
        createdAt: new Date().toISOString()
      });

      const orderDetail = data.orderDetails.find((o: any) => o.orderId === orderId) ?? null;
      if (!orderDetail) {
        emitToolResult({
          toolCallId: `${toolCallId}_r`,
          traceId,
          conversationId,
          stepId: intent === "return" ? "step_03" : "step_02",
          toolName: "createReturnRequest",
          inputRedacted: { orderId, reason },
          outputRedacted: {},
          status: "fail",
          latencyMs: Date.now() - started,
          error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
          createdAt: new Date().toISOString()
        });
        return { created: false };
      }

      const returnId = `r_${Date.now()}`;
      const returnAddress = "广东省深圳市南山区***路***号（售后仓）";
      const nextSteps = "请在48小时内寄回商品，并保留物流单号。仓库签收后将进入退款流程。";

      const output = {
        created: true,
        returnRequest: {
          returnId,
          orderId,
          orderNo: orderDetail.orderNo,
          reason,
          status: "created",
          createdAt: new Date().toISOString(),
          returnAddress,
          nextSteps
        }
      };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: intent === "return" ? "step_03" : "step_02",
        toolName: "createReturnRequest",
        inputRedacted: { orderId, reason },
        outputRedacted: output,
        status: "success",
        latencyMs: Date.now() - started,
        error: null,
        createdAt: new Date().toISOString()
      });

      return output;
    },
    {
      name: "createReturnRequest",
      description: "创建退货申请（演示用，返回退货单号与退货地址/下一步）",
      schema: z.object({
        orderId: z.string(),
        reason: z.string().min(1)
      })
    }
  );

  if (intent === "logistics") {
    const orderNo = parseOrderNo(userMessage);
    const phoneLast4 = parsePhoneLast4(userMessage);
    const shouldSearchByInput = !context?.orderId && Boolean(orderNo || phoneLast4);
    let resolvedOrderId: string | null = shouldSearchByInput ? null : context?.orderId ?? linkedOrderId;

    if (!resolvedOrderId) {

      if (!orderNo && !phoneLast4) {
        const ask =
          "我可以帮你查物流轨迹。请先提供：\n- 订单号（例如 E202603010001）或\n- 手机号后四位（例如 1024）";
        sendSseEvent(res, "plan_update", { traceId, steps });
        await streamText(res, traceId, ask);
        return;
      }

      const { orders } = await searchOrders.invoke({ orderNo: orderNo ?? undefined, phoneLast4: phoneLast4 ?? undefined });
      if (orders.length === 0) {
        steps[0].status = "done";
        sendSseEvent(res, "plan_update", { traceId, steps });
        await streamText(res, traceId, "未查到对应订单。请确认订单号是否正确，或换一个手机号后四位再试。");
        return;
      }

      if (orders.length > 1) {
        const options = orders.slice(0, 10).map((o) => ({
          orderId: o.orderId,
          orderNo: o.orderNo,
          status: o.status,
          itemsSummary: o.itemsSummary,
          paidAt: o.paidAt,
          totalAmount: o.totalAmount,
          currency: o.currency
        }));
        steps[0].status = "done";
        sendSseEvent(res, "plan_update", { traceId, steps });
        sendSseEvent(res, "need_choice", {
          traceId,
          choiceType: "order",
          prompt: "查到多个订单，请选择要查询的订单",
          options
        });
        await streamText(res, traceId, "查到多个订单，请在右侧弹窗选择要查询的订单。");
        return;
      }

      resolvedOrderId = orders[0].orderId;
    }

    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const { orderDetail } = await getOrderDetail.invoke({ orderId: resolvedOrderId });
    if (!orderDetail) {
      steps[1].status = "done";
      steps[2].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps });
      await streamText(res, traceId, "我没能拉取到订单详情，稍后再试或换一个订单号/手机号后四位。");
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    const shipmentId = orderDetail.shipmentIds?.[0] ?? null;
    if (!shipmentId) {
      steps[1].status = "done";
      steps[2].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps });
      await streamText(res, traceId, `订单号：${orderDetail.orderNo}。\n该订单暂无包裹信息（可能未发货或已拆分发货）。你可以确认是否已发货/是否分包裹。`);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    const { shipment } = await getShipmentTracking.invoke({ shipmentId });

    steps[1].status = "done";
    steps[2].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    if (!shipment) {
      await streamText(res, traceId, `订单号：${orderDetail.orderNo}。\n我查到了订单，但暂时没查到包裹轨迹。你可以确认是否分包裹或更换了承运商，我再继续排查。`);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    const last = shipment.events?.at(-1);
    const base = `订单号：${orderDetail.orderNo}。\n物流：${shipment.carrier}（${shipment.trackingNoMasked}），当前状态：${shipment.status}。`;
    const tail = last ? `\n最新轨迹：${last.location} · ${last.description} · ${last.time}` : "";
    const advice =
      shipment.status === "exception"
        ? "\n建议：如果轨迹 48 小时无更新或持续异常，我可以按SOP帮你继续处理（如催派/核对地址信息）。"
        : "\n建议：如 48 小时无更新，可继续反馈，我会按SOP协助处理。";
    await streamText(res, traceId, base + tail + advice);

    steps[2].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    return;
  }

  if (intent === "return") {
    const orderNo = parseOrderNo(userMessage);
    const phoneLast4 = parsePhoneLast4(userMessage);
    const shouldSearchByInput = !context?.orderId && Boolean(orderNo || phoneLast4);
    let resolvedOrderId: string | null = shouldSearchByInput ? null : context?.orderId ?? linkedOrderId;

    if (!resolvedOrderId) {

      if (!orderNo && !phoneLast4) {
        steps[0].status = "done";
        sendSseEvent(res, "plan_update", { traceId, steps });
        await streamText(res, traceId, "我可以帮你发起退货申请。请先提供订单号或手机号后四位。");
        return;
      }

      const { orders } = await searchOrders.invoke({ orderNo: orderNo ?? undefined, phoneLast4: phoneLast4 ?? undefined });
      if (orders.length === 0) {
        steps[0].status = "done";
        sendSseEvent(res, "plan_update", { traceId, steps });
        await streamText(res, traceId, "未查到对应订单。请确认订单号是否正确，或换一个手机号后四位再试。");
        return;
      }

      if (orders.length > 1) {
        const options = orders.slice(0, 10).map((o) => ({
          orderId: o.orderId,
          orderNo: o.orderNo,
          status: o.status,
          itemsSummary: o.itemsSummary,
          paidAt: o.paidAt,
          totalAmount: o.totalAmount,
          currency: o.currency
        }));
        steps[0].status = "done";
        sendSseEvent(res, "plan_update", { traceId, steps });
        sendSseEvent(res, "need_choice", {
          traceId,
          choiceType: "order",
          prompt: "查到多个订单，请选择要退货的订单",
          options
        });
        await streamText(res, traceId, "查到多个订单，请在右侧弹窗选择要退货的订单。");
        return;
      }

      resolvedOrderId = orders[0].orderId;
    }

    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const { eligibility } = await getReturnEligibility.invoke({ orderId: resolvedOrderId });
    steps[1].status = "done";
    steps[2].status = "pending";
    sendSseEvent(res, "plan_update", { traceId, steps });

    if (!eligibility.eligible) {
      await streamText(res, traceId, `暂不支持退货：${eligibility.reason}`);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    sendSseEvent(res, "need_confirm", {
      traceId,
      action: "create_return_request",
      title: "确认发起退货申请",
      details: {
        orderId: resolvedOrderId,
        reason: "7天无理由退货",
        windowDaysLeft: eligibility.windowDaysLeft,
        feeRule: eligibility.feeRule
      }
    });
    await streamText(res, traceId, `可退货（剩余${eligibility.windowDaysLeft}天）。请确认是否发起退货申请。`);
    return;
  }

  if (intent === "policy") {
    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const { hits } = await kbSearch.invoke({ q: userMessage });
    const best = hits?.[0];
    const answer = best
      ? `条款引用：${best.articleId}。\n${best.title}\n要点：${best.snippet}\n如果你提供订单号/手机号后四位和具体问题细节，我可以继续结合订单信息给更精确的下一步。`
      : "我暂时没在知识库里命中对应条款。你能补充一下是“退货/换货/破损/少件/运费/丢失”哪一类吗？";
    await streamText(res, traceId, answer);

    steps[1].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    return;
  }

  steps[0].status = "done";
  sendSseEvent(res, "plan_update", { traceId, steps });

  const model = createModel();

  const system = [
    "你是电商售后智能客服助手，必须遵循：",
    "1) 不确定就追问缺失信息（订单号或手机号后四位）。",
    "2) 事实必须来自工具返回（订单字段/物流轨迹/知识库命中），不要编造。",
    "3) 回答需要给出引用：订单引用写“订单号：<orderNo>”，知识库引用写“条款引用：<articleId>”。",
    "4) 当前只支持：查物流轨迹、政策/SOP 问答；不要承诺退款/改址等敏感动作。",
    "5) 如用户要求导出会话或查询本地 sqlite，可调用 exportConversationToFile / sqliteQuery（仅用于演示与自查）。"
  ].join("\n");

  const tools: any[] = [searchOrders, getOrderDetail, getShipmentTracking, kbSearch].filter(Boolean);
  if (exportConversationToFile) tools.push(exportConversationToFile);
  if (sqliteQuery) tools.push(sqliteQuery);

  const agent = createAgent({
    model,
    tools
  });

  const priorMessages = data.messages
    .filter((m: any) => m.conversationId === conversationId)
    .slice(-8)
    .map((m: any) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content
    }));

  const messages = [
    { role: "system" as const, content: system },
    ...priorMessages,
    linkedOrderId ? { role: "system" as const, content: `已知上下文：linkedOrderId=${linkedOrderId}` } : null,
    { role: "user" as const, content: userMessage }
  ].filter(Boolean) as Array<{ role: "system" | "user" | "assistant"; content: string }>;

  let startedAnswer = false;
  let bufferedText = "";
  let fallbackFinalText = "";

  const streamEvents = (agent as any).streamEvents;
  try {
    if (typeof streamEvents === "function") {
      for await (const ev of streamEvents.call(agent, { messages }, { version: "v2" })) {
        if (ev?.event === "on_chat_model_stream") {
          const delta = extractDeltaFromChunk(ev?.data?.chunk);
          if (!delta) continue;

          if (!startedAnswer) {
            steps[1].status = "done";
            steps[2].status = "running";
            sendSseEvent(res, "plan_update", { traceId, steps });
            startedAnswer = true;
          }

          bufferedText += delta;
          sendSseEvent(res, "assistant_delta", { traceId, delta });
        }

        if (ev?.event === "on_chain_end") {
          const out = ev?.data?.output;
          if (typeof out === "string") fallbackFinalText = out;
          if (out && typeof out === "object") {
            if (typeof (out as any).output === "string") fallbackFinalText = (out as any).output;
            if (typeof (out as any).final === "string") fallbackFinalText = (out as any).final;
            if (Array.isArray((out as any).messages)) {
              const last = (out as any).messages.at(-1);
              if (typeof last?.content === "string") fallbackFinalText = last.content;
            }
          }
        }
      }
    } else {
      const result = await agent.invoke({ messages });
      fallbackFinalText =
        typeof (result as any)?.output === "string"
          ? (result as any).output
          : typeof (result as any)?.final === "string"
            ? (result as any).final
            : Array.isArray((result as any)?.messages)
              ? String((result as any).messages.at(-1)?.content ?? "")
              : String((result as any)?.content ?? "");
    }
  } catch (e: unknown) {
    const msg =
      e instanceof Error
        ? e.message
        : typeof e === "string"
          ? e
          : "模型请求失败";
    sendSseEvent(res, "error", { traceId, message: msg });
    if (!startedAnswer) {
      sendSseEvent(res, "assistant_delta", { traceId, delta: `请求失败：${msg}` });
      startedAnswer = true;
    }
  }

  if (!startedAnswer) {
    steps[1].status = "done";
    steps[2].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const text = bufferedText || fallbackFinalText || (toolUsed ? "已完成查询，但未生成文本答复。" : "未生成文本答复。");
    for (const chunk of chunkString(text, 6)) {
      sendSseEvent(res, "assistant_delta", { traceId, delta: chunk });
      await sleep(8);
    }
  }

  steps[2].status = "done";
  sendSseEvent(res, "plan_update", { traceId, steps });
}
