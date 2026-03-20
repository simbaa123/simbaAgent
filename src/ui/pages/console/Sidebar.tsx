import type { OrderDetail, Shipment, ToolCallLog } from "../../api/types";
import type { ExportReadyEvent, PlanStep, SqliteResultEvent } from "./sse";

function statusPill(status: string) {
  const s = status.toLowerCase();
  if (s.includes("exception") || s.includes("fail")) return "bg-red-50 text-red-700";
  if (s.includes("running") || s.includes("in_progress")) return "bg-blue-50 text-blue-700";
  if (s.includes("done") || s.includes("success") || s.includes("delivered") || s.includes("completed"))
    return "bg-emerald-50 text-emerald-700";
  return "bg-zinc-100 text-zinc-700";
}

export default function Sidebar(props: {
  order: OrderDetail | null;
  shipments: Record<string, Shipment>;
  linkedShipmentIds: string[];
  planSteps: PlanStep[];
  toolLogs: ToolCallLog[];
  streaming: boolean;
  exportReady: ExportReadyEvent | null;
  sqliteResult: SqliteResultEvent | null;
  onExport: () => void;
  onAudit: () => void;
  onClearExport: () => void;
  onClearSqlite: () => void;
}) {
  const {
    order,
    shipments,
    linkedShipmentIds,
    planSteps,
    toolLogs,
    streaming,
    exportReady,
    sqliteResult,
    onExport,
    onAudit,
    onClearExport,
    onClearSqlite
  } = props;

  return (
    <div className="h-full overflow-y-auto border-l border-zinc-200 bg-zinc-50 p-4">
      <div className="space-y-4">
        <section>
          <div className="mb-2 text-xs font-semibold text-zinc-600">订单</div>
          {order ? (
            <div className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-zinc-900">{order.orderNo}</div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPill(order.status)}`}>
                      {order.status}
                    </span>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPill(order.aftersaleStatus)}`}>
                      aftersale: {order.aftersaleStatus}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-xs text-zinc-500">金额</div>
                  <div className="mt-1 text-sm font-semibold text-zinc-900">
                    {order.totalAmount} {order.currency}
                  </div>
                </div>
              </div>
              <div className="mt-3 text-xs text-zinc-600">
                收货：{order.receiver.receiverNameMasked} · {order.receiver.receiverPhoneMasked}
              </div>
              <div className="mt-1 text-xs text-zinc-600">{order.receiver.addressMasked}</div>
              <div className="mt-3 text-xs text-zinc-500">
                优惠 {order.discountAmount} · 运费 {order.shippingFee}
              </div>
              <div className="mt-2 text-xs text-zinc-500">包裹：{order.shipmentIds.join(", ") || "-"}</div>
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600">
              暂无订单上下文，可在对话中通过订单号或手机号后四位定位。
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 text-xs font-semibold text-zinc-600">物流轨迹</div>
          {linkedShipmentIds.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600">无包裹</div>
          ) : (
            <div className="space-y-3">
              {linkedShipmentIds.map((id) => {
                const s = shipments[id];
                if (!s)
                  return (
                    <div key={id} className="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
                      {id}：未加载
                    </div>
                  );
                return (
                  <div key={id} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-zinc-900">{s.carrier}</div>
                        <div className="mt-1 text-xs text-zinc-500">单号：{s.trackingNoMasked}</div>
                      </div>
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPill(s.status)}`}>
                        {s.status}
                      </span>
                    </div>

                    <div className="mt-3 space-y-3">
                      {s.events.map((e) => (
                        <div key={e.time} className="relative pl-4">
                          <div className="absolute left-0 top-2 h-2 w-2 rounded-full bg-zinc-300" />
                          <div className="absolute left-[3px] top-4 h-full w-px bg-zinc-200" />
                          <div className="text-xs text-zinc-500">
                            {new Date(e.time).toLocaleString()} · {e.location}
                          </div>
                          <div className="text-sm text-zinc-900">{e.description}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 text-xs font-semibold text-zinc-600">MCP 快捷操作</div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={onExport}
              disabled={streaming}
              className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              导出会话
            </button>
            <button
              onClick={onAudit}
              disabled={streaming}
              className="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              查看最近审计
            </button>
          </div>

          {exportReady ? (
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-sm font-semibold">导出结果</div>
                <div className="text-xs text-zinc-500">{exportReady.format}</div>
              </div>
              <div className="mt-2 break-all text-xs text-zinc-600">{exportReady.path}</div>
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={() => void navigator.clipboard.writeText(exportReady.path)}
                  className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
                >
                  复制路径
                </button>
                <button
                  onClick={onClearExport}
                  className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
                >
                  清除
                </button>
              </div>
            </div>
          ) : null}

          {sqliteResult ? (
            <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div className="flex items-baseline justify-between gap-3">
                <div className="text-sm font-semibold">SQLite 结果</div>
                <div className="text-xs text-zinc-500">{sqliteResult.rows.length} 行</div>
              </div>
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-zinc-600 hover:text-zinc-900">SQL</summary>
                <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-zinc-50 p-3 text-xs text-zinc-800">
{sqliteResult.query}
                </pre>
              </details>

              <div className="mt-3 overflow-auto rounded-xl border border-zinc-100">
                {sqliteResult.rows.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-zinc-600">无数据</div>
                ) : (
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-zinc-50 text-zinc-600">
                      <tr>
                        {Object.keys(sqliteResult.rows[0] ?? {})
                          .slice(0, 10)
                          .map((k) => (
                            <th key={k} className="whitespace-nowrap px-3 py-2 font-medium">
                              {k}
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {sqliteResult.rows.slice(0, 30).map((row, idx) => (
                        <tr key={idx} className="bg-white">
                          {Object.keys(sqliteResult.rows[0] ?? {})
                            .slice(0, 10)
                            .map((k) => (
                              <td key={k} className="px-3 py-2 align-top text-zinc-800">
                                <div className="break-words">{String((row as any)?.[k] ?? "")}</div>
                              </td>
                            ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>

              <div className="mt-3 flex justify-end">
                <button
                  onClick={onClearSqlite}
                  className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
                >
                  清除
                </button>
              </div>
            </div>
          ) : null}
        </section>

        <section>
          <div className="mb-2 text-xs font-semibold text-zinc-600">Plan</div>
          {planSteps.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600">
              等待 Agent 生成计划
            </div>
          ) : (
            <div className="space-y-2">
              {planSteps.map((s) => (
                <div key={s.stepId} className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm text-zinc-900">{s.title}</div>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${statusPill(s.status)}`}>
                      {s.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div className="mb-2 text-xs font-semibold text-zinc-600">工具日志</div>
          {toolLogs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600">暂无</div>
          ) : (
            <div className="space-y-2">
              {toolLogs
                .slice()
                .reverse()
                .slice(0, 20)
                .map((t) => (
                  <div key={t.toolCallId} className="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-zinc-900">{t.toolName}</div>
                        <div className="mt-1 text-xs text-zinc-500">step：{t.stepId}</div>
                      </div>
                      <div className="text-right">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            t.status === "success" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                          }`}
                        >
                          {t.status}
                        </span>
                        <div className="mt-1 text-xs text-zinc-500">{t.latencyMs}ms</div>
                      </div>
                    </div>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-xs text-zinc-600 hover:text-zinc-900">input/output（脱敏）</summary>
                      <pre className="mt-2 whitespace-pre-wrap break-words rounded-xl bg-zinc-50 p-3 text-xs text-zinc-800">
{JSON.stringify({ input: t.inputRedacted, output: t.outputRedacted, error: t.error }, null, 2)}
                      </pre>
                    </details>
                  </div>
                ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

