import type { NeedConfirmEvent } from "./sse";

export default function ConfirmModal(props: {
  open: boolean;
  data: NeedConfirmEvent | null;
  onClose: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { open, data, onClose, onCancel, onConfirm } = props;
  if (!open || !data) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4">
          <div>
            <div className="text-sm font-semibold text-zinc-900">{data.title}</div>
            <div className="mt-1 text-xs text-zinc-500">请确认后再执行关键动作</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          >
            关闭
          </button>
        </div>

        <div className="p-5">
          <div className="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
            <div className="text-xs text-zinc-500">action：{data.action}</div>
            <pre className="mt-3 whitespace-pre-wrap break-words text-xs text-zinc-800">
{JSON.stringify(data.details, null, 2)}
            </pre>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              onClick={onCancel}
              className="rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
            >
              取消
            </button>
            <button
              onClick={onConfirm}
              className="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
            >
              确认执行
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

