import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Message, OrderDetail, Shipment, ToolCallLog } from "../api/types";
import { getConversation } from "../api/client";
import ChatPanel from "./console/ChatPanel";
import Composer from "./console/Composer";
import ConfirmModal from "./console/ConfirmModal";
import OrderChoiceModal from "./console/OrderChoiceModal";
import Sidebar from "./console/Sidebar";
import {
  parseSseTextChunk,
  type ExportReadyEvent,
  type NeedChoiceEvent,
  type NeedConfirmEvent,
  type PlanStep,
  type SqliteResultEvent
} from "./console/sse";

export default function ConsolePage() {
  const { conversationId } = useParams();
  const convId = conversationId ?? "";

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [planSteps, setPlanSteps] = useState<PlanStep[]>([]);
  const [toolLogs, setToolLogs] = useState<ToolCallLog[]>([]);
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [shipments, setShipments] = useState<Record<string, Shipment>>({});
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [pendingChoice, setPendingChoice] = useState<NeedChoiceEvent | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<NeedConfirmEvent | null>(null);
  const [lastUserMessage, setLastUserMessage] = useState<string>("");
  const [exportReady, setExportReady] = useState<ExportReadyEvent | null>(null);
  const [sqliteResult, setSqliteResult] = useState<SqliteResultEvent | null>(null);

  const assistantDraftRef = useRef<string>("");

  useEffect(() => {
    if (!convId) return;
    getConversation(convId)
      .then((res) => {
        setMessages(res.messages ?? []);
        setOrder(res.orderDetail ?? null);
        const shipmentMap: Record<string, Shipment> = {};
        for (const s of res.shipments ?? []) shipmentMap[s.shipmentId] = s;
        setShipments(shipmentMap);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed"));
  }, [convId]);

  const linkedShipmentIds = useMemo(() => order?.shipmentIds ?? [], [order]);

  async function send(params?: {
    text?: string;
    context?: { orderId?: string; confirm?: { action: string; payload: unknown } };
    silentUserMessage?: boolean;
  }) {
    if (!convId) return;
    const text = (params?.text ?? input).trim();
    if (!text) return;
    setError(null);
    setInput("");
    setStreaming(true);
    setPendingChoice(null);
    setPendingConfirm(null);
    setLastUserMessage(text);

    if (!params?.silentUserMessage) {
      const userMessage: Message = {
        messageId: `m_${Date.now()}`,
        conversationId: convId,
        role: "user",
        content: text,
        createdAt: new Date().toISOString(),
        citations: []
      };
      setMessages((prev) => [...prev, userMessage]);
    }

    assistantDraftRef.current = "";
    const assistantMsgId = `m_${Date.now() + 1}`;
    setMessages((prev) => [
      ...prev,
      {
        messageId: assistantMsgId,
        conversationId: convId,
        role: "agent",
        content: "",
        createdAt: new Date().toISOString(),
        citations: []
      }
    ]);

    const res = await fetch("/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: convId, message: text, context: params?.context })
    });

    if (!res.ok || !res.body) {
      setStreaming(false);
      setError("Stream failed to start");
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseTextChunk(buffer);
      buffer = parsed.rest;

      for (const ev of parsed.events) {
        if (ev.event === "plan_update") setPlanSteps(ev.data.steps);

        if (ev.event === "assistant_delta") {
          assistantDraftRef.current += ev.data.delta;
          const draft = assistantDraftRef.current;
          setMessages((prev) => prev.map((m) => (m.messageId === assistantMsgId ? { ...m, content: draft } : m)));
        }

        if (ev.event === "tool_call" || ev.event === "tool_result") {
          setToolLogs((prev) => [...prev, ev.data]);

          if (ev.data.toolName === "getOrderDetail" && ev.data.status === "success") {
            const od = (ev.data.outputRedacted as any)?.orderDetail;
            if (od) setOrder(od);
          }
          if (ev.data.toolName === "getShipmentTracking" && ev.data.status === "success") {
            const sh = (ev.data.outputRedacted as any)?.shipment;
            if (sh?.shipmentId) setShipments((prev) => ({ ...prev, [sh.shipmentId]: sh }));
          }
        }

        if (ev.event === "need_choice") setPendingChoice(ev.data);
        if (ev.event === "need_confirm") setPendingConfirm(ev.data);
        if (ev.event === "export_ready") setExportReady(ev.data);
        if (ev.event === "sqlite_result") setSqliteResult(ev.data);
        if (ev.event === "error") setError(ev.data.message);
      }
    }

    setStreaming(false);
  }

  const streamingLabel = streaming ? "streaming" : "idle";

  return (
    <div className="h-screen bg-zinc-50">
      <div className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link
              to="/inbox"
              className="rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 shadow-sm hover:bg-zinc-50"
            >
              返回 Inbox
            </Link>
            <div>
              <div className="text-sm font-semibold text-zinc-900">Console</div>
              <div className="text-xs text-zinc-500">{convId}</div>
            </div>
          </div>
          <div className="text-xs text-zinc-500">
            <span
              className={
                streaming
                  ? "inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700"
                  : "inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 font-medium text-zinc-700"
              }
            >
              {streamingLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="mx-auto grid h-[calc(100vh-57px)] max-w-6xl grid-cols-1 overflow-hidden md:grid-cols-[1fr_380px]">
        <div className="min-h-0 border-r border-zinc-200 bg-white">
          <ChatPanel messages={messages} error={error} streaming={streaming} />
          <Composer value={input} onChange={setInput} onSend={() => void send()} disabled={streaming} />
        </div>

        <Sidebar
          order={order}
          shipments={shipments}
          linkedShipmentIds={linkedShipmentIds}
          planSteps={planSteps}
          toolLogs={toolLogs}
          streaming={streaming}
          exportReady={exportReady}
          sqliteResult={sqliteResult}
          onExport={() => {
            setMessages((prev) => [
              ...prev,
              {
                messageId: `m_${Date.now()}`,
                conversationId: convId,
                role: "cs",
                content: "（系统）导出会话（md）",
                createdAt: new Date().toISOString(),
                citations: []
              }
            ]);
            void send({ text: "/export md", silentUserMessage: true });
          }}
          onAudit={() => {
            setMessages((prev) => [
              ...prev,
              {
                messageId: `m_${Date.now()}`,
                conversationId: convId,
                role: "cs",
                content: "（系统）查看最近审计",
                createdAt: new Date().toISOString(),
                citations: []
              }
            ]);
            void send({ text: "/audit", silentUserMessage: true });
          }}
          onClearExport={() => setExportReady(null)}
          onClearSqlite={() => setSqliteResult(null)}
        />
      </div>

      <OrderChoiceModal
        open={Boolean(pendingChoice)}
        data={pendingChoice}
        onClose={() => setPendingChoice(null)}
        onChoose={({ orderId, orderNo }) => {
          setPendingChoice(null);
          setMessages((prev) => [
            ...prev,
            {
              messageId: `m_${Date.now()}`,
              conversationId: convId,
              role: "cs",
              content: `已选择订单：${orderNo}`,
              createdAt: new Date().toISOString(),
              citations: []
            }
          ]);
          void send({ text: lastUserMessage || "帮我查下物流", context: { orderId }, silentUserMessage: true });
        }}
      />

      <ConfirmModal
        open={Boolean(pendingConfirm)}
        data={pendingConfirm}
        onClose={() => setPendingConfirm(null)}
        onCancel={() => {
          setPendingConfirm(null);
          setMessages((prev) => [
            ...prev,
            {
              messageId: `m_${Date.now()}`,
              conversationId: convId,
              role: "cs",
              content: "已取消操作",
              createdAt: new Date().toISOString(),
              citations: []
            }
          ]);
        }}
        onConfirm={() => {
          const details = pendingConfirm?.details ?? {};
          const orderId = details.orderId as string | undefined;
          const reason = details.reason as string | undefined;
          setPendingConfirm(null);
          setMessages((prev) => [
            ...prev,
            {
              messageId: `m_${Date.now()}`,
              conversationId: convId,
              role: "cs",
              content: "已确认执行",
              createdAt: new Date().toISOString(),
              citations: []
            }
          ]);
          void send({
            text: "确认",
            context: { orderId, confirm: { action: "create_return_request", payload: { orderId, reason } } },
            silentUserMessage: true
          });
        }}
      />
    </div>
  );
}

