import path from "node:path";
import { createAgent, tool } from "langchain";
import { ChatOpenAI } from "@langchain/openai";
import { z } from "zod";
import type { Response } from "express";
import { loadSampleData, snippetFromContent, appendMessage } from "./dataStore";
import { sendSseEvent, sleep } from "./sse";
import { getFilesystemMcpClient, getSqliteMcpClient } from "./mcpClients";

/**
 * 这个文件刻意“单文件集中”：便于学习与面试讲解。
 *
 * 推荐的阅读顺序（自上而下）：
 * 1) LLM：createModel / extractDeltaFromChunk / streamText（流式输出）
 * 2) 规划：PlanStep + createPlanSteps（前端右侧 Plan）
 * 3) 记忆：parseOrderNo/parsePhoneLast4/buildPriorMessages（上下文抽取与历史）
 * 4) 工具：tool(...) 定义 + tool_call/tool_result 事件（可观测链路）
 * 5) 编排：runLangChainAgent（按意图走“物流/退货/政策/其他”）
 *
 * 你在 面试准备.md#L122-126 提到的能力，在本文件中对应：
 * - 工具集合：searchOrders/getOrderDetail/getShipmentTracking/kbSearch + MCP(export/sqlite)
 * - 事件派发：工具内统一发送 tool_call/tool_result；LLM streamEvents 转发 assistant_delta
 * - Human-in-the-loop：need_confirm（退货创建需确认）
 * - MCP：filesystem 导出（export_ready）、sqlite 查询（sqlite_result）
 */

type PlanStep = { stepId: string; title: string; status: "pending" | "running" | "done" };
type Intent = "logistics" | "return" | "policy" | "modify_address" | "other";

type ReturnEligibility = {
  eligible: boolean;
  windowDaysLeft: number;
  feeRule: "buyer" | "seller";
  requiredProof: string[];
  reason: string;
};

function env(name: string) {
  return process.env[name]?.trim() || "";
}

function chunkString(s: string, size = 8) {
  const parts: string[] = [];
  for (let i = 0; i < s.length; i += size) parts.push(s.slice(i, i + size));
  return parts;
}

/**
 * 把一段文本“拆块”通过 SSE 逐步推给前端（assistant_delta）。
 * - 这不是模型 token 流，而是用于“人类可读的流式体验”（工具结果说明/引导文案等）。
 */
async function streamText(res: Response, traceId: string, text: string, conversationId?: string) {
  for (const chunk of chunkString(text, 6)) {
    sendSseEvent(res, "assistant_delta", { traceId, delta: chunk });
    await sleep(8);
  }
  if (conversationId) {
    appendMessage(conversationId, "agent", text);
  }
}

/**
 * 从 LangChain 的 streamEvents chunk 中抽取“增量文本”。
 * - 不同版本/模型可能返回 string 或多段 content 数组，这里做兼容。
 */
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

/**
 * 模型工厂：DeepSeek/OpenAI 兼容，开启 streaming。
 * - 真实 token 流通过 streamEvents 转成 assistant_delta（见下方“其他意图”分支）。
 */
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
  const maxTokensRaw =
    env(usingDeepSeek ? "DEEPSEEK_MAX_TOKENS" : "OPENAI_MAX_TOKENS") || env("OPENAI_MAX_TOKENS");

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

function isLogisticsQuery(text: string) {
  return /物流|没收到|未收到|到哪|到哪了|快递|派送|轨迹|滞留|异常/i.test(text);
}

function isPolicyQuery(text: string) {
  return /规则|政策|SOP|退货|无理由|破损|少件|运费|丢失/i.test(text);
}

function isReturnQuery(text: string) {
  return /退货|退掉|不要了|无理由退|退回/i.test(text);
}

function isAddressText(text: string) {
  const t = text.trim();
  if (t.length < 5) return false;
  return /(省|市|区|县|镇|乡|街|道|路|大道|小区|大厦|号)/.test(t);
}

function isModifyAddressQuery(text: string) {
  return /修改地址|改地址|地址写错|换地址|重新发/i.test(text);
}

function isGreeting(text: string) {
  const t = text.trim();
  return /^(你好|您好|在吗|嗨|hi|hello|hey)\b/i.test(t) && t.length <= 8;
}

function createPlanSteps(intent: Intent): PlanStep[] {
  if (intent === "logistics") {
    return [
      { stepId: "step_01", title: "补齐订单信息", status: "running" },
      { stepId: "step_02", title: "查询物流轨迹", status: "pending" },
      { stepId: "step_03", title: "生成解释与下一步建议", status: "pending" }
    ];
  }
  if (intent === "return") {
    return [
      { stepId: "step_01", title: "补齐订单信息", status: "running" },
      { stepId: "step_02", title: "判断是否可退", status: "pending" },
      { stepId: "step_03", title: "确认并创建退货申请", status: "pending" }
    ];
  }
  if (intent === "modify_address") {
    return [
      { stepId: "step_01", title: "补齐订单信息", status: "running" },
      { stepId: "step_02", title: "判断是否可改地址", status: "pending" },
      { stepId: "step_03", title: "确认并修改地址", status: "pending" }
    ];
  }
  if (intent === "policy") {
    return [
      { stepId: "step_01", title: "检索知识库条款", status: "running" },
      { stepId: "step_02", title: "生成带引用的答复", status: "pending" }
    ];
  }
  return [
    { stepId: "step_01", title: "理解问题", status: "running" },
    { stepId: "step_02", title: "检索信息与调用工具", status: "pending" },
    { stepId: "step_03", title: "生成答复", status: "pending" }
  ];
}

function parseOrderNo(text: string) {
  const m = text.match(/E\d{10,}/i);
  return m ? m[0].toUpperCase() : null;
}

function parsePhoneLast4(text: string) {
  const patterns = [/(?:手机号|手机|电话|尾号|后四位)\D*(\d{4})/, /(\d{4})\s*(?:后四位|尾号)/];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1];
  }
  return null;
}

function parseReturnReason(text: string) {
  const t = text.trim();
  if (/质量|破损|少件|错发|漏发|瑕疵|损坏/i.test(t)) return { reasonType: "quality" as const, reason: "质量问题退货" };
  if (/无理由|不想要|不要了|七天|7天/i.test(t)) return { reasonType: "no_reason" as const, reason: "7天无理由退货" };
  return { reasonType: "no_reason" as const, reason: "7天无理由退货" };
}

/**
 * 从数据仓库构造“最近 N 轮历史消息”，供 LLM 当作短期记忆。
 */
function buildPriorMessages(data: any, conversationId: string, limit = 8) {
  return data.messages
    .filter((m: any) => m.conversationId === conversationId)
    .slice(-limit)
    .map((m: any) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.content
    }));
}

function daysBetween(fromIso: string, toIso: string) {
  const a = new Date(fromIso).getTime();
  const b = new Date(toIso).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Infinity;
  return Math.floor((b - a) / (24 * 3600 * 1000));
}

/**
 * 可退判断：
 * - no_reason：签收后 7 天无理由（必须有 deliveredAt）
 * - quality：质量问题售后（演示规则：签收后 30 天内；未签收也允许发起，但提示“建议拒收/补凭证”）
 */
function calcReturnEligibility(params: {
  nowIso: string;
  orderDetail: any;
  shipments: any[];
  reasonType: "no_reason" | "quality";
}): ReturnEligibility {
  const deliveredAt =
    params.shipments
      .map((s) => s?.deliveredAt)
      .filter((x) => typeof x === "string")
      .sort()
      .at(-1) ?? null;

  if (params.reasonType === "quality") {
    const proof = ["外包装面单照片", "商品问题照片/视频", "开箱视频（如有）"];

    if (params.orderDetail?.aftersaleStatus && params.orderDetail.aftersaleStatus !== "none") {
      return {
        eligible: false,
        windowDaysLeft: 0,
        feeRule: "seller",
        requiredProof: proof,
        reason: "该订单已存在售后处理中，暂不支持再次发起退货。"
      };
    }

    if (!deliveredAt) {
      return {
        eligible: true,
        windowDaysLeft: 30,
        feeRule: "seller",
        requiredProof: proof,
        reason: "可按质量问题售后发起退货。若未签收，建议优先拒收或签收后补充凭证。"
      };
    }

    const days = daysBetween(deliveredAt, params.nowIso);
    const windowDaysLeft = Math.max(0, 30 - days);
    if (days > 30) {
      return {
        eligible: false,
        windowDaysLeft,
        feeRule: "seller",
        requiredProof: proof,
        reason: "已超过签收后30天质量问题售后时效。"
      };
    }

    return {
      eligible: true,
      windowDaysLeft,
      feeRule: "seller",
      requiredProof: proof,
      reason: "满足质量问题售后退货条件。"
    };
  }

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

function createToolEmitters(res: Response) {
  return {
    emitToolCall: (payload: any) => sendSseEvent(res, "tool_call", payload),
    emitToolResult: (payload: any) => sendSseEvent(res, "tool_result", payload)
  };
}

function parseAuditRowsFromSqliteToolResult(out: any) {
  const text = out?.result?.content?.find?.((c: any) => c?.type === "text")?.text;
  if (typeof text !== "string") return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed?.rows) ? parsed.rows : [];
  } catch {
    return [];
  }
}

/**
 * 工具集合（Tools）：
 * - 重要：每个工具都要在内部发 tool_call/tool_result，才能实现“可观测”链路。
 * - 重要：入参 schema 由 zod 定义，保证模型/调用方不会传入不可控数据结构。
 */
function createAgentTools(params: {
  res: Response;
  traceId: string;
  conversationId: string;
  userMessage: string;
  data: any;
  markToolUsed: () => void;
  isMcpEnabled: boolean;
}) {
  const { res, traceId, conversationId, userMessage, data, markToolUsed, isMcpEnabled } = params;
  const { emitToolCall, emitToolResult } = createToolEmitters(res);

  const sqliteUrl = env("MCP_SQLITE_URL") || "sqlite://./data/agent.sqlite";
  let sqliteSchemaReady = false;

  async function ensureSqliteSchema() {
    if (!isMcpEnabled || sqliteSchemaReady) return;
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
    isMcpEnabled
      ? tool(
          async ({ format }: { format?: "md" | "json" }) => {
            const started = Date.now();
            const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            markToolUsed();
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
                ? JSON.stringify(
                    { conversationId, traceId, messages: data.messages.filter((m: any) => m.conversationId === conversationId) },
                    null,
                    2
                  )
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
    isMcpEnabled
      ? tool(
          async ({ query, parameters }: { query: string; parameters?: unknown[] }) => {
            if (!/^\s*select\b/i.test(query)) throw new Error("sqliteQuery 仅支持 SELECT 查询");
            const started = Date.now();
            const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
            markToolUsed();
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

  const searchOrders = tool(
    async ({ orderNo, phoneLast4 }: { orderNo?: string; phoneLast4?: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      markToolUsed();
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

      const orders = data.orders.filter((o: any) => orderIds.has(o.orderId));
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
      markToolUsed();
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
      markToolUsed();
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
      markToolUsed();
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
    async ({ orderId, reasonType }: { orderId: string; reasonType?: "no_reason" | "quality" }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      markToolUsed();
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "getReturnEligibility",
        inputRedacted: { orderId, reasonType: reasonType ?? "no_reason" },
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
      const rt = reasonType ?? "no_reason";
      const eligibility = orderDetail
        ? calcReturnEligibility({ nowIso: new Date().toISOString(), orderDetail, shipments, reasonType: rt })
        : { eligible: false, windowDaysLeft: 0, feeRule: "buyer", requiredProof: [], reason: "未找到订单。" };

      const output = { eligibility };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: "step_02",
        toolName: "getReturnEligibility",
        inputRedacted: { orderId, reasonType: reasonType ?? "no_reason" },
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
      description: "判断订单是否可退（7天无理由/质量问题），并返回原因、剩余天数、运费规则与所需凭证",
      schema: z.object({
        orderId: z.string(),
        reasonType: z.enum(["no_reason", "quality"]).optional()
      })
    }
  );

  const createReturnRequest = tool(
    async ({ orderId, reason }: { orderId: string; reason: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      markToolUsed();
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: "step_03",
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
          stepId: "step_03",
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
        stepId: "step_03",
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

  const modifyOrderAddress = tool(
    async ({ orderId, newAddress }: { orderId: string; newAddress: string }) => {
      const started = Date.now();
      const toolCallId = `tc_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      markToolUsed();
      emitToolCall({
        toolCallId,
        traceId,
        conversationId,
        stepId: "step_03",
        toolName: "modifyOrderAddress",
        inputRedacted: { orderId, newAddress },
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
          stepId: "step_03",
          toolName: "modifyOrderAddress",
          inputRedacted: { orderId, newAddress },
          outputRedacted: {},
          status: "fail",
          latencyMs: Date.now() - started,
          error: { code: "ORDER_NOT_FOUND", message: "Order not found" },
          createdAt: new Date().toISOString()
        });
        return { modified: false };
      }

      // Simulate address modification success
      const output = {
        modified: true,
        orderNo: orderDetail.orderNo,
        newAddress,
        message: "地址修改成功"
      };

      emitToolResult({
        toolCallId: `${toolCallId}_r`,
        traceId,
        conversationId,
        stepId: "step_03",
        toolName: "modifyOrderAddress",
        inputRedacted: { orderId, newAddress },
        outputRedacted: output,
        status: "success",
        latencyMs: Date.now() - started,
        error: null,
        createdAt: new Date().toISOString()
      });

      return output;
    },
    {
      name: "modifyOrderAddress",
      description: "修改订单的收货地址",
      schema: z.object({
        orderId: z.string(),
        newAddress: z.string().min(1)
      })
    }
  );

  return {
    exportConversationToFile,
    sqliteQuery,
    searchOrders,
    getOrderDetail,
    getShipmentTracking,
    kbSearch,
    getReturnEligibility,
    createReturnRequest,
    modifyOrderAddress
  };
}

async function handleMcpCommands(params: {
  res: Response;
  traceId: string;
  conversationId: string;
  userMessage: string;
  exportConversationToFile: any | null;
  sqliteQuery: any | null;
}) {
  const { res, traceId, conversationId, userMessage, exportConversationToFile, sqliteQuery } = params;
  const t = userMessage.trim();

  const exportMatch = t.match(/^\/export(?:\s+(md|json))?$/i);
  if (exportMatch && exportConversationToFile) {
    const format = (exportMatch[1]?.toLowerCase() as "md" | "json" | undefined) ?? "md";
    const out = await exportConversationToFile.invoke({ format });
    const outPath = (out as any)?.path as string | undefined;
    if (outPath) sendSseEvent(res, "export_ready", { traceId, format, path: outPath });
    await streamText(res, traceId, `已导出：${(out as any)?.path ?? ""}`, conversationId);
    return true;
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
    const rows = parseAuditRowsFromSqliteToolResult(out);
    sendSseEvent(res, "sqlite_result", { traceId, query, rows });
    await streamText(res, traceId, `已返回最近审计（${rows.length}条）`, conversationId);
    return true;
  }

  const sqlMatch = t.match(/^\/sql\s+([\s\S]+)$/i);
  if (sqlMatch && sqliteQuery) {
    const query = sqlMatch[1].trim();
    const out = await sqliteQuery.invoke({ query, parameters: [] });
    const rows = parseAuditRowsFromSqliteToolResult(out);
    sendSseEvent(res, "sqlite_result", { traceId, query, rows });
    await streamText(res, traceId, `已返回查询结果（${rows.length}行）`, conversationId);
    return true;
  }

  return false;
}

async function resolveOrderIdOrAsk(params: {
  res: Response;
  traceId: string;
  conversationId: string;
  steps: PlanStep[];
  context?: { orderId?: string };
  linkedOrderId: string | null;
  userMessage: string;
  searchOrders: any;
  prompt: string;
  askText: string;
}) {
  const { res, traceId, conversationId, steps, context, linkedOrderId, userMessage, searchOrders, prompt, askText } = params;
  const rr = parseReturnReason(userMessage);
  const orderNo = parseOrderNo(userMessage);
  const phoneLast4 = parsePhoneLast4(userMessage);
  const shouldSearchByInput = !context?.orderId && Boolean(orderNo || phoneLast4);
  const resolvedOrderId: string | null = shouldSearchByInput ? null : context?.orderId ?? linkedOrderId;

  if (typeof resolvedOrderId === "string" && resolvedOrderId)
    return { resolvedOrderId, reasonType: rr.reasonType, reason: rr.reason };

  if (!orderNo && !phoneLast4) {
    steps[0].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    await streamText(res, traceId, askText, conversationId);
    return null;
  }

  const ordersOut = await searchOrders.invoke({
    orderNo: orderNo ?? undefined,
    phoneLast4: phoneLast4 ?? undefined
  });
  const orders = (ordersOut as any)?.orders ?? [];

  if (!Array.isArray(orders) || orders.length === 0) {
    steps[0].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    await streamText(res, traceId, "未查到对应订单。请确认订单号是否正确，或换一个手机号后四位再试。", conversationId);
    return null;
  }

  if (orders.length > 1) {
    const options = orders.slice(0, 10).map((o: any) => ({
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
    sendSseEvent(res, "need_choice", { traceId, choiceType: "order", prompt, options });
    await streamText(res, traceId, askText.replace(/。$/, "") + "。", conversationId);
    return null;
  }

  return { resolvedOrderId: String(orders[0].orderId), reasonType: rr.reasonType, reason: rr.reason };
}

/**
 * Agent 编排入口：
 * - 这是 index.ts 在 USE_LANGCHAIN=1 时调用的核心函数。
 * - 你可以把它看作“按意图执行的工作流引擎 + LLM 兜底”。
 */
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

  let toolUsed = false;
  const markToolUsed = () => {
    toolUsed = true;
  };

  const isMcpEnabled = env("USE_MCP") === "1";
  const tools = createAgentTools({ res, traceId, conversationId, userMessage, data, markToolUsed, isMcpEnabled });

  // 1) MCP 命令优先处理（/export /audit /sql），直接返回结构化事件给前端。
  if (isMcpEnabled) {
    const handled = await handleMcpCommands({
      res,
      traceId,
      conversationId,
      userMessage,
      exportConversationToFile: tools.exportConversationToFile,
      sqliteQuery: tools.sqliteQuery
    });
    if (handled) return;
  }

  // 2) Human-in-the-loop 回流：用户在前端 ConfirmModal 点击“确认执行”后，context.confirm 会带回来。
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
      await streamText(res, traceId, "缺少订单信息，无法创建退货申请。", conversationId);
      confirmSteps[1].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      return;
    }

    const out = await tools.createReturnRequest.invoke({ orderId, reason });
    const created = Boolean((out as any)?.created);

    confirmSteps[0].status = "done";
    confirmSteps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });

    if (!created) {
      await streamText(res, traceId, "创建退货申请失败，请稍后再试。", conversationId);
      confirmSteps[1].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      return;
    }

    const rr = (out as any)?.returnRequest;
    await streamText(
      res,
      traceId,
      `退货申请已创建。\n退货单号：${rr?.returnId ?? "-"}\n订单号：${rr?.orderNo ?? "-"}\n退货地址：${rr?.returnAddress ?? "-"}\n下一步：${rr?.nextSteps ?? "-"}`,
      conversationId
    );
    confirmSteps[1].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
    return;
  }

  if (context?.confirm?.action === "modify_order_address") {
    const payload = (context.confirm.payload ?? {}) as any;
    const orderId = typeof payload.orderId === "string" ? payload.orderId : context.orderId;
    const newAddress = typeof payload.newAddress === "string" ? payload.newAddress : "";

    const confirmSteps: PlanStep[] = [
      { stepId: "step_01", title: "确认并修改地址", status: "running" },
      { stepId: "step_02", title: "生成用户通知", status: "pending" }
    ];
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });

    if (!orderId || !newAddress) {
      confirmSteps[0].status = "done";
      confirmSteps[1].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      await streamText(res, traceId, "缺少订单或新地址信息，无法修改地址。", conversationId);
      confirmSteps[1].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      return;
    }

    const out = await tools.modifyOrderAddress.invoke({ orderId, newAddress });
    const modified = Boolean((out as any)?.modified);

    confirmSteps[0].status = "done";
    confirmSteps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });

    if (!modified) {
      await streamText(res, traceId, "修改地址失败，请确认订单状态是否允许修改（如已发货则无法修改）。", conversationId);
      confirmSteps[1].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
      return;
    }

    await streamText(res, traceId, `地址修改成功！\n订单号：${(out as any).orderNo}\n新地址：${(out as any).newAddress}`, conversationId);
    confirmSteps[1].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps: confirmSteps });
    return;
  }

  // 3) 意图识别与 Plan 初始化（前端右侧 Plan 的“骨架”）
  const intent: Intent = isReturnQuery(userMessage)
    ? "return"
    : (isModifyAddressQuery(userMessage) || isAddressText(userMessage))
      ? "modify_address"
      : isLogisticsQuery(userMessage)
        ? "logistics"
        : isPolicyQuery(userMessage)
          ? "policy"
          : "other";

  const steps = createPlanSteps(intent);
  sendSseEvent(res, "plan_update", { traceId, steps });

  // 3.1) 问候语快速回复：避免“你好”时等模型首 token 导致空白体验
  if (intent === "other" && isGreeting(userMessage)) {
    steps[0].status = "done";
    steps[1].status = "done";
    steps[2].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });
    await streamText(res, traceId, "你好！我在的。你可以直接描述问题（查物流/退货/修改地址/运费/破损少件等），并提供订单号或手机号后四位，我会帮你处理。", conversationId);
    steps[2].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    return;
  }

  // 4) 物流用例：订单定位 → 查询物流 → 组织解释
  if (intent === "logistics") {
    const resolved = await resolveOrderIdOrAsk({
      res,
      traceId,
      conversationId,
      steps,
      context,
      linkedOrderId,
      userMessage,
      searchOrders: tools.searchOrders,
      prompt: "查到多个订单，请选择要查询的订单",
      askText: "我可以帮你查询物流轨迹。请先提供订单号或手机号后四位。"
    });
    if (!resolved) return;

    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const orderDetailOut = await tools.getOrderDetail.invoke({ orderId: resolved.resolvedOrderId });
    const orderDetail = (orderDetailOut as any)?.orderDetail ?? null;
    if (!orderDetail) {
      steps[1].status = "done";
      steps[2].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps });
      await streamText(res, traceId, "我没能拉取到订单详情，稍后再试或换一个订单号/手机号后四位。", conversationId);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    const shipmentId = orderDetail.shipmentIds?.[0] ?? null;
    if (!shipmentId) {
      steps[1].status = "done";
      steps[2].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps });
      await streamText(res, traceId, `订单号：${orderDetail.orderNo}。\n该订单暂无包裹信息（可能未发货或已拆分发货）。你可以确认是否已发货/是否分包裹。`, conversationId);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    const shipmentOut = await tools.getShipmentTracking.invoke({ shipmentId });
    const shipment = (shipmentOut as any)?.shipment ?? null;

    steps[1].status = "done";
    steps[2].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    if (!shipment) {
      await streamText(res, traceId, `订单号：${orderDetail.orderNo}。\n我查到了订单，但暂时没查到包裹轨迹。你可以确认是否分包裹或更换了承运商，我再继续排查。`, conversationId);
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
    await streamText(res, traceId, base + tail + advice, conversationId);

    steps[2].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    return;
  }

  // 5) 退货用例：可退判断 → need_confirm → 等待确认回流再创建
  if (intent === "return") {
    const rr = parseReturnReason(userMessage);
    const resolved = await resolveOrderIdOrAsk({
      res,
      traceId,
      conversationId,
      steps,
      context,
      linkedOrderId,
      userMessage,
      searchOrders: tools.searchOrders,
      prompt: "查到多个订单，请选择要退货的订单",
      askText: "我可以帮你发起退货申请。请先提供订单号或手机号后四位。"
    });
    if (!resolved) return;

    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const eligibilityOut = await tools.getReturnEligibility.invoke({
      orderId: resolved.resolvedOrderId,
      reasonType: rr.reasonType
    });
    const eligibility = (eligibilityOut as any)?.eligibility;

    steps[1].status = "done";
    steps[2].status = "pending";
    sendSseEvent(res, "plan_update", { traceId, steps });

    if (!eligibility?.eligible) {
      await streamText(res, traceId, `暂不支持退货：${eligibility?.reason ?? "无法判断可退条件"}`, conversationId);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    sendSseEvent(res, "need_confirm", {
      traceId,
      action: "create_return_request",
      title: "确认发起退货申请",
      details: {
        orderId: resolved.resolvedOrderId,
        reason: rr.reason,
        windowDaysLeft: eligibility.windowDaysLeft,
        feeRule: eligibility.feeRule,
        requiredProof: eligibility.requiredProof
      }
    });

    const proofText =
      Array.isArray(eligibility.requiredProof) && eligibility.requiredProof.length
        ? `\n建议凭证：${eligibility.requiredProof.join("、")}`
        : "";
    await streamText(res, traceId, `可发起退货（原因：${rr.reason}，剩余${eligibility.windowDaysLeft}天）。请确认是否发起退货申请。${proofText}`, conversationId);
    return;
  }

  // 修改地址用例：确认订单 -> 确认新地址 -> need_confirm -> 执行
  if (intent === "modify_address") {
    const resolved = await resolveOrderIdOrAsk({
      res,
      traceId,
      conversationId,
      steps,
      context,
      linkedOrderId,
      userMessage,
      searchOrders: tools.searchOrders,
      prompt: "查到多个订单，请选择要修改地址的订单",
      askText: "我可以帮你修改订单地址。请先提供订单号或手机号后四位。"
    });
    if (!resolved) return;

    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const orderDetailOut = await tools.getOrderDetail.invoke({ orderId: resolved.resolvedOrderId });
    const orderDetail = (orderDetailOut as any)?.orderDetail ?? null;
    if (!orderDetail) {
      steps[1].status = "done";
      steps[2].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps });
      await streamText(res, traceId, "我没能拉取到订单详情，稍后再试或换一个订单号/手机号后四位。", conversationId);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    if (orderDetail.status !== "paid") {
      steps[1].status = "done";
      steps[2].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps });
      await streamText(res, traceId, `订单号：${orderDetail.orderNo}。\n当前订单状态为 ${orderDetail.status}，已发货或已签收的订单无法修改地址。`, conversationId);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    const newAddressMatch = userMessage.match(/(?:改为|改成|地址是|新地址(?:为|是)?)[:：]?\s*([\u4e00-\u9fa5A-Za-z0-9_ -]{5,})/);
    let newAddress = newAddressMatch?.[1];
    if (!newAddress && isAddressText(userMessage)) {
      newAddress = userMessage.trim();
    }

    if (!newAddress) {
      steps[1].status = "done";
      steps[2].status = "running";
      sendSseEvent(res, "plan_update", { traceId, steps });
      await streamText(res, traceId, `订单号：${orderDetail.orderNo} 可以修改地址。\n请问新的收货地址是什么？（例如：新地址是广东省深圳市南山区xxx）`, conversationId);
      steps[2].status = "done";
      sendSseEvent(res, "plan_update", { traceId, steps });
      return;
    }

    steps[1].status = "done";
    steps[2].status = "pending";
    sendSseEvent(res, "plan_update", { traceId, steps });

    sendSseEvent(res, "need_confirm", {
      traceId,
      action: "modify_order_address",
      title: "确认修改地址",
      details: {
        orderId: resolved.resolvedOrderId,
        newAddress: newAddress
      }
    });

    await streamText(res, traceId, `订单号：${orderDetail.orderNo} 可以修改地址。\n新的收货地址为：${newAddress}\n请确认是否修改。`, conversationId);
    return;
  }

  // 6) 政策用例：kbSearch（RAG）→ 带引用回答
  if (intent === "policy") {
    steps[0].status = "done";
    steps[1].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });

    const hitsOut = await tools.kbSearch.invoke({ q: userMessage });
    const hits = (hitsOut as any)?.hits ?? [];
    const best = hits?.[0];
    const answer = best
      ? `条款引用：${best.articleId}。\n${best.title}\n要点：${best.snippet}\n如果你提供订单号/手机号后四位和具体问题细节，我可以继续结合订单信息给更精确的下一步。`
      : "我暂时没在知识库里命中对应条款。你能补充一下是“退货/换货/破损/少件/运费/丢失”哪一类吗？";
    await streamText(res, traceId, answer, conversationId);

    steps[1].status = "done";
    sendSseEvent(res, "plan_update", { traceId, steps });
    return;
  }

  // 7) 其他意图：走 LLM + Tools（真正的 Agent 决策），并把模型 token 流转发给前端
  steps[0].status = "done";
  steps[1].status = "running";
  sendSseEvent(res, "plan_update", { traceId, steps });

  const model = createModel();
  const system = [
    "你是电商售后智能客服助手，必须遵循：",
    "1) 不确定就追问缺失信息（订单号或手机号后四位）。",
    "2) 事实必须来自工具返回（订单字段/物流轨迹/知识库命中），不要编造。",
    "3) 回答需要给出引用：订单引用写“订单号：<orderNo>”，知识库引用写“条款引用：<articleId>”。",
    "4) 当前只支持：查物流轨迹、政策/SOP 问答、退货申请（需二次确认）；不要承诺退款/改址等敏感动作。",
    "5) 如用户要求导出会话或查询本地 sqlite，可调用 exportConversationToFile / sqliteQuery（仅用于演示与自查）。"
  ].join("\n");

  const priorMessages = buildPriorMessages(data, conversationId, 8);
  const messages = [
    { role: "system" as const, content: system },
    ...priorMessages,
    linkedOrderId ? ({ role: "system" as const, content: `已知上下文：linkedOrderId=${linkedOrderId}` } as const) : null,
    { role: "user" as const, content: userMessage }
  ].filter(Boolean) as Array<{ role: "system" | "user" | "assistant"; content: string }>;

  const toolsForAgent: any[] = [tools.searchOrders, tools.getOrderDetail, tools.getShipmentTracking, tools.kbSearch].filter(Boolean);
  if (tools.exportConversationToFile) toolsForAgent.push(tools.exportConversationToFile);
  if (tools.sqliteQuery) toolsForAgent.push(tools.sqliteQuery);
  if (tools.getReturnEligibility) toolsForAgent.push(tools.getReturnEligibility);
  if (tools.createReturnRequest) toolsForAgent.push(tools.createReturnRequest);

  const agent = createAgent({ model, tools: toolsForAgent });

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
    const msg = e instanceof Error ? e.message : typeof e === "string" ? e : "模型请求失败";
    sendSseEvent(res, "error", { traceId, message: msg });
    if (!startedAnswer) {
      sendSseEvent(res, "assistant_delta", { traceId, delta: `请求失败：${msg}` });
      startedAnswer = true;
    }
  }

  const finalText = bufferedText || fallbackFinalText || (toolUsed ? "已完成查询，但未生成文本答复。" : "未生成文本答复。");

  // 没有拿到 stream token 时，使用 fallback 文本补一段输出，避免前端空白。
  if (!startedAnswer) {
    steps[1].status = "done";
    steps[2].status = "running";
    sendSseEvent(res, "plan_update", { traceId, steps });
    for (const chunk of chunkString(finalText, 6)) {
      sendSseEvent(res, "assistant_delta", { traceId, delta: chunk });
    }
  }

  appendMessage(conversationId, "agent", finalText);

  steps[2].status = "done";
  sendSseEvent(res, "plan_update", { traceId, steps });
}
