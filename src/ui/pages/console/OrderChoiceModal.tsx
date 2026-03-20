import type { NeedChoiceEvent } from "./sse";

export default function OrderChoiceModal(props: {
  open: boolean;
  data: NeedChoiceEvent | null;
  onClose: () => void;
  onChoose: (params: { orderId: string; orderNo: string }) => void;
}) {
  const { open, data, onClose, onChoose } = props;
  if (!open || !data) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-zinc-900">{data.prompt}</div>
            <div className="mt-1 text-xs text-zinc-500">请选择要继续处理的订单</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            关闭
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto p-5">
          <div className="grid gap-3">
            {data.options.map((o) => (
              <button
                key={o.orderId}
                className="rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-zinc-300 hover:shadow"
                onClick={() => onChoose({ orderId: o.orderId, orderNo: o.orderNo })}
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-sm font-semibold text-zinc-900">{o.orderNo}</div>
                    <div className="mt-1 text-xs text-zinc-500">{o.itemsSummary}</div>
                    <div className="mt-2 text-xs text-zinc-500">支付时间：{o.paidAt}</div>
                  </div>
                  <div className="text-right">
                    <div className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                      {o.status}
                    </div>
                    <div className="mt-2 text-sm font-semibold text-zinc-900">
                      {o.totalAmount} {o.currency}
                    </div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

