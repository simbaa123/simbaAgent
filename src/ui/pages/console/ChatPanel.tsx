import { useEffect, useRef, useState } from "react";
import type { Message } from "../../api/types";

function roleLabel(role: Message["role"]) {
  if (role === "user") return "用户";
  if (role === "agent") return "Agent";
  return "客服";
}

function bubbleClass(role: Message["role"]) {
  if (role === "user") return "bg-emerald-600 text-white";
  if (role === "agent") return "bg-white text-zinc-900 border border-zinc-200";
  return "bg-zinc-100 text-zinc-900 border border-zinc-200";
}

function alignClass(role: Message["role"]) {
  if (role === "user") return "justify-end";
  if (role === "agent") return "justify-start";
  return "justify-center";
}

export default function ChatPanel(props: {
  messages: Message[];
  error: string | null;
  streaming: boolean;
}) {
  const { messages, error, streaming } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [locked, setLocked] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    if (locked) return;
    el.scrollTop = el.scrollHeight;
  }, [locked, messages.length, streaming]);

  function onScroll() {
    const el = containerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    setLocked(dist > 240);
  }

  return (
    <div className="relative min-h-0 overflow-hidden">
      <div ref={containerRef} onScroll={onScroll} className="h-full overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-3xl space-y-4">
          {messages.map((m, idx) => (
            <div key={m.messageId} className={`flex ${alignClass(m.role)}`}>
              <div className="max-w-[92%] sm:max-w-[78%]">
                <div className="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
                  <span className="font-medium">{roleLabel(m.role)}</span>
                  <span className="text-zinc-400">·</span>
                  <span>{new Date(m.createdAt).toLocaleString()}</span>
                </div>
                <div className={`rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${bubbleClass(m.role)}`}>
                  <div className="whitespace-pre-wrap">{m.content}</div>
                  {streaming && idx === messages.length - 1 && m.role === "agent" ? (
                    <div className="mt-2 text-[11px] text-zinc-500">正在生成…</div>
                  ) : null}
                </div>
              </div>
            </div>
          ))}

          {error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          ) : null}
        </div>
      </div>

      {locked ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
          <button
            className="pointer-events-auto rounded-full border border-zinc-200 bg-white/90 px-3 py-1.5 text-xs text-zinc-700 shadow-sm backdrop-blur transition hover:bg-white"
            onClick={() => {
              const el = containerRef.current;
              if (!el) return;
              el.scrollTop = el.scrollHeight;
              setLocked(false);
            }}
          >
            回到底部
          </button>
        </div>
      ) : null}
    </div>
  );
}
