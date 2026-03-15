import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Message, OrderDetail, Shipment, ToolCallLog } from "../api/types";
import { getConversation } from "../api/client";

type PlanStep = { stepId: string; title: string; status: "pending" | "running" | "done" };

type OrderChoiceOption = {
  orderId: string;
  orderNo: string;
  status: string;
  itemsSummary: string;
  paidAt: string;
  totalAmount: number;
  currency: string;
};

type NeedChoiceEvent = {
  traceId: string;
  choiceType: "order";
  prompt: string;
  options: OrderChoiceOption[];
};

type NeedConfirmEvent = {
  traceId: string;
  action: string;
  title: string;
  details: any;
};

type StreamEvent =
  | { event: "plan_update"; data: { traceId: string; steps: PlanStep[] } }
  | { event: "assistant_delta"; data: { traceId: string; delta: string } }
  | { event: "tool_call"; data: ToolCallLog }
  | { event: "tool_result"; data: ToolCallLog }
  | { event: "need_choice"; data: NeedChoiceEvent }
  | { event: "need_confirm"; data: NeedConfirmEvent }
  | { event: "final"; data: { traceId: string } }
  | { event: "error"; data: { traceId: string; message: string } };

function parseSseTextChunk(buffer: string) {
  const parts = buffer.split("\n\n");
  const complete = parts.slice(0, -1);
  const rest = parts.at(-1) ?? "";

  const events: StreamEvent[] = [];
  for (const raw of complete) {
    const lines = raw.split("\n").filter(Boolean);
    let eventName: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trim());
    }
    if (!eventName) continue;
    const dataText = dataLines.join("\n");
    try {
      const payload = JSON.parse(dataText);
      events.push({ event: eventName as StreamEvent["event"], data: payload } as StreamEvent);
    } catch {
      continue;
    }
  }
  return { events, rest };
}

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
    let assistantMsgId = `m_${Date.now() + 1}`;
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
          setMessages((prev) =>
            prev.map((m) => (m.messageId === assistantMsgId ? { ...m, content: draft } : m))
          );
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

        if (ev.event === "need_choice") {
          setPendingChoice(ev.data);
        }

        if (ev.event === "need_confirm") {
          setPendingConfirm(ev.data);
        }

        if (ev.event === "error") setError(ev.data.message);
      }
    }

    setStreaming(false);
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", fontFamily: "ui-sans-serif, system-ui" }}>
      <div style={{ padding: 12, borderBottom: "1px solid #eee", display: "flex", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <Link to="/inbox" style={{ textDecoration: "none" }}>
            ← Inbox
          </Link>
          <div style={{ fontWeight: 700 }}>Console</div>
          <div style={{ color: "#666" }}>{convId}</div>
        </div>
        <div style={{ color: streaming ? "#0a7" : "#666" }}>{streaming ? "streaming..." : "idle"}</div>
      </div>

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1fr 360px", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateRows: "1fr auto", minHeight: 0 }}>
          <div style={{ padding: 12, overflow: "auto", borderRight: "1px solid #eee" }}>
            {messages.map((m) => (
              <div key={m.messageId} style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: "#666" }}>
                  {m.role} · {new Date(m.createdAt).toLocaleString()}
                </div>
                <div style={{ whiteSpace: "pre-wrap" }}>{m.content}</div>
              </div>
            ))}
            {error ? <div style={{ color: "#b00020" }}>{error}</div> : null}
          </div>

          <div style={{ padding: 12, borderTop: "1px solid #eee", display: "flex", gap: 8 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如：我一直没收到货，帮我查下物流；或者：物流异常滞留怎么处理？"
              style={{ flex: 1, padding: 10, borderRadius: 8, border: "1px solid #ddd" }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={streaming}
            />
            <button
              onClick={() => void send()}
              disabled={streaming}
              style={{ padding: "10px 14px", borderRadius: 8, border: "1px solid #ddd", cursor: "pointer" }}
            >
              发送
            </button>
          </div>
        </div>

        <div style={{ padding: 12, overflow: "auto" }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>订单侧栏</div>
          {order ? (
            <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div style={{ fontWeight: 700 }}>{order.orderNo}</div>
                <div style={{ color: "#666" }}>{order.status}</div>
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>
                收货：{order.receiver.receiverNameMasked} · {order.receiver.receiverPhoneMasked}
              </div>
              <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>{order.receiver.addressMasked}</div>
              <div style={{ marginTop: 8, fontSize: 12 }}>
                金额：{order.totalAmount} {order.currency}（优惠 {order.discountAmount}，运费 {order.shippingFee}）
              </div>
              <div style={{ marginTop: 8, fontSize: 12, color: "#666" }}>包裹：{order.shipmentIds.join(", ") || "-"}</div>
            </div>
          ) : (
            <div style={{ color: "#666" }}>暂无订单上下文（可在对话中通过订单号或手机号后四位定位）</div>
          )}

          <div style={{ marginTop: 12, fontWeight: 700, marginBottom: 8 }}>物流轨迹</div>
          {linkedShipmentIds.length === 0 ? (
            <div style={{ color: "#666" }}>无包裹</div>
          ) : (
            linkedShipmentIds.map((id) => {
              const s = shipments[id];
              if (!s) return <div key={id} style={{ color: "#666" }}>{id}：未加载</div>;
              return (
                <div key={id} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10, marginBottom: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div style={{ fontWeight: 700 }}>{s.carrier}</div>
                    <div style={{ color: "#666" }}>{s.status}</div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>单号：{s.trackingNoMasked}</div>
                  <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                    {s.events.map((e) => (
                      <div key={e.time} style={{ fontSize: 12 }}>
                        <div style={{ color: "#666" }}>
                          {new Date(e.time).toLocaleString()} · {e.location}
                        </div>
                        <div>{e.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}

          <div style={{ marginTop: 12, fontWeight: 700, marginBottom: 8 }}>Plan</div>
          {planSteps.length === 0 ? (
            <div style={{ color: "#666" }}>等待 Agent 生成计划</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              {planSteps.map((s) => (
                <div
                  key={s.stepId}
                  style={{
                    border: "1px solid #ddd",
                    borderRadius: 8,
                    padding: 8,
                    display: "flex",
                    justifyContent: "space-between"
                  }}
                >
                  <div>{s.title}</div>
                  <div style={{ color: s.status === "done" ? "#0a7" : s.status === "running" ? "#06c" : "#666" }}>
                    {s.status}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div style={{ marginTop: 12, fontWeight: 700, marginBottom: 8 }}>工具日志</div>
          {toolLogs.length === 0 ? (
            <div style={{ color: "#666" }}>暂无</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {toolLogs.slice().reverse().map((t) => (
                <div key={t.toolCallId} style={{ border: "1px solid #ddd", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <div style={{ fontWeight: 700 }}>{t.toolName}</div>
                    <div style={{ color: t.status === "success" ? "#0a7" : "#b00020" }}>
                      {t.status} · {t.latencyMs}ms
                    </div>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: "#666" }}>step：{t.stepId}</div>
                  <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: "pointer" }}>input/output（脱敏）</summary>
                    <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
{JSON.stringify({ input: t.inputRedacted, output: t.outputRedacted, error: t.error }, null, 2)}
                    </pre>
                  </details>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {pendingChoice ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16
          }}
          onClick={() => setPendingChoice(null)}
        >
          <div
            style={{
              width: 720,
              maxWidth: "100%",
              background: "#fff",
              borderRadius: 12,
              border: "1px solid #ddd",
              padding: 14
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div style={{ fontWeight: 800 }}>{pendingChoice.prompt}</div>
              <button
                onClick={() => setPendingChoice(null)}
                style={{ border: "1px solid #ddd", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}
              >
                关闭
              </button>
            </div>

            <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
              {pendingChoice.options.map((o) => (
                <button
                  key={o.orderId}
                  onClick={() => {
                    setPendingChoice(null);
                    setMessages((prev) => [
                      ...prev,
                      {
                        messageId: `m_${Date.now()}`,
                        conversationId: convId,
                        role: "cs",
                        content: `已选择订单：${o.orderNo}`,
                        createdAt: new Date().toISOString(),
                        citations: []
                      }
                    ]);
                    void send({
                      text: lastUserMessage || "帮我查下物流",
                      context: { orderId: o.orderId },
                      silentUserMessage: true
                    });
                  }}
                  style={{
                    textAlign: "left",
                    border: "1px solid #ddd",
                    borderRadius: 10,
                    padding: 12,
                    cursor: "pointer",
                    background: "#fff"
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <div>
                      <div style={{ fontWeight: 800 }}>{o.orderNo}</div>
                      <div style={{ marginTop: 4, fontSize: 12, color: "#666" }}>{o.itemsSummary}</div>
                      <div style={{ marginTop: 4, fontSize: 12, color: "#666" }}>
                        支付时间：{o.paidAt}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 12, color: "#666" }}>状态：{o.status}</div>
                      <div style={{ marginTop: 6, fontWeight: 800 }}>
                        {o.totalAmount} {o.currency}
                      </div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {pendingConfirm ? (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.35)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16
          }}
          onClick={() => setPendingConfirm(null)}
        >
          <div
            style={{
              width: 640,
              maxWidth: "100%",
              background: "#fff",
              borderRadius: 12,
              border: "1px solid #ddd",
              padding: 14
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div style={{ fontWeight: 800 }}>{pendingConfirm.title}</div>
              <button
                onClick={() => setPendingConfirm(null)}
                style={{ border: "1px solid #ddd", borderRadius: 8, padding: "6px 10px", cursor: "pointer" }}
              >
                关闭
              </button>
            </div>

            <div style={{ marginTop: 10, border: "1px solid #eee", borderRadius: 10, padding: 10 }}>
              <div style={{ fontSize: 12, color: "#666" }}>action：{pendingConfirm.action}</div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8 }}>
{JSON.stringify(pendingConfirm.details, null, 2)}
              </pre>
            </div>

            <div style={{ marginTop: 12, display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button
                onClick={() => {
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
                style={{ border: "1px solid #ddd", borderRadius: 8, padding: "8px 12px", cursor: "pointer" }}
              >
                取消
              </button>
              <button
                onClick={() => {
                  const details = pendingConfirm.details ?? {};
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
                style={{
                  border: "1px solid #0a7",
                  background: "#0a7",
                  color: "#fff",
                  borderRadius: 8,
                  padding: "8px 12px",
                  cursor: "pointer"
                }}
              >
                确认
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
