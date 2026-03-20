import type { ToolCallLog } from "../../api/types";

export type PlanStep = { stepId: string; title: string; status: "pending" | "running" | "done" };

export type OrderChoiceOption = {
  orderId: string;
  orderNo: string;
  status: string;
  itemsSummary: string;
  paidAt: string;
  totalAmount: number;
  currency: string;
};

export type NeedChoiceEvent = {
  traceId: string;
  choiceType: "order";
  prompt: string;
  options: OrderChoiceOption[];
};

export type NeedConfirmEvent = {
  traceId: string;
  action: string;
  title: string;
  details: any;
};

export type ExportReadyEvent = {
  traceId: string;
  format: "md" | "json";
  path: string;
};

export type SqliteResultEvent = {
  traceId: string;
  query: string;
  rows: Record<string, unknown>[];
};

export type StreamEvent =
  | { event: "plan_update"; data: { traceId: string; steps: PlanStep[] } }
  | { event: "assistant_delta"; data: { traceId: string; delta: string } }
  | { event: "tool_call"; data: ToolCallLog }
  | { event: "tool_result"; data: ToolCallLog }
  | { event: "need_choice"; data: NeedChoiceEvent }
  | { event: "need_confirm"; data: NeedConfirmEvent }
  | { event: "export_ready"; data: ExportReadyEvent }
  | { event: "sqlite_result"; data: SqliteResultEvent }
  | { event: "final"; data: { traceId: string } }
  | { event: "error"; data: { traceId: string; message: string } };

export function parseSseTextChunk(buffer: string) {
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

