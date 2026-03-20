import { useEffect, useRef } from "react";

export default function Composer(props: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
}) {
  const { value, onChange, onSend, disabled } = props;
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (disabled) return;
    ref.current?.focus();
  }, [disabled]);

  return (
    <div className="border-t border-zinc-200 bg-white px-4 py-3">
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <div className="flex-1">
          <textarea
            ref={ref}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="例如：我一直没收到货，帮我查下物流；或者：物流异常滞留怎么处理？"
            className="h-11 max-h-40 w-full resize-none rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm leading-5 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            disabled={disabled}
          />
          <div className="mt-1 px-1 text-[11px] text-zinc-500">Enter 发送，Shift+Enter 换行</div>
        </div>
        <button
          onClick={onSend}
          disabled={disabled}
          className="h-11 rounded-2xl bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          发送
        </button>
      </div>
    </div>
  );
}

