import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listConversations } from "../api/client";
import type { Conversation } from "../api/types";

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    setLoading(true);
    listConversations()
      .then((data) => {
        setConversations(data);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed"))
      .finally(() => setLoading(false));
  }, []);

  const filtered = conversations.filter((c) => {
    const t = q.trim();
    if (!t) return true;
    const hay = `${c.conversationId} ${c.status} ${c.channel} ${c.linkedOrderId ?? ""}`.toLowerCase();
    return hay.includes(t.toLowerCase());
  });

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">售后工单 Inbox</h1>
            <p className="mt-2 text-sm text-zinc-600">点击进入 Console，体验 Agent 流式链路、工具日志与 MCP 操作。</p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-right shadow-sm">
            <div className="text-xs text-zinc-500">会话数</div>
            <div className="text-base font-semibold">{conversations.length}</div>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:max-w-md">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索会话（id / status / channel / order）"
              className="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none ring-0 transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
            />
          </div>
          <div className="text-xs text-zinc-500">
            {q.trim() ? `命中 ${filtered.length} / ${conversations.length}` : `共 ${conversations.length} 条`}
          </div>
        </div>

        {error ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className="mt-6 grid gap-3">
          {loading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-[76px] animate-pulse rounded-2xl border border-zinc-200 bg-white" />
            ))
          ) : filtered.length === 0 ? (
            <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-10 text-center">
              <div className="text-sm font-medium">没有匹配的会话</div>
              <div className="mt-1 text-xs text-zinc-500">换个关键词试试（例如 open / c_9001）。</div>
            </div>
          ) : (
            filtered.map((c) => (
              <Link
                key={c.conversationId}
                to={`/console/${encodeURIComponent(c.conversationId)}`}
                className="group rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:-translate-y-[1px] hover:border-zinc-300 hover:shadow"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-semibold text-zinc-900">{c.conversationId}</div>
                      <span
                        className={
                          c.status === "open"
                            ? "inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700"
                            : "inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700"
                        }
                      >
                        {c.status}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                        {c.channel}
                      </span>
                    </div>
                    <div className="mt-2 text-xs text-zinc-500">createdAt：{c.createdAt}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs text-zinc-500">order</div>
                    <div className="mt-1 text-sm font-medium text-zinc-800">{c.linkedOrderId ?? "-"}</div>
                  </div>
                </div>
                <div className="mt-3 text-xs text-zinc-500 opacity-0 transition group-hover:opacity-100">
                  进入 Console →
                </div>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
