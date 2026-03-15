import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { listConversations } from "../api/client";
import type { Conversation } from "../api/types";

export default function InboxPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listConversations()
      .then(setConversations)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed"));
  }, []);

  return (
    <div style={{ padding: 16, fontFamily: "ui-sans-serif, system-ui" }}>
      <h2 style={{ margin: 0 }}>售后工单 Inbox（里程碑1）</h2>
      <div style={{ marginTop: 12, color: "#666" }}>
        点击进入 Console，体验“查物流/政策问答”流式链路与工具日志。
      </div>

      {error ? (
        <div style={{ marginTop: 12, color: "#b00020" }}>{error}</div>
      ) : null}

      <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
        {conversations.map((c) => (
          <Link
            key={c.conversationId}
            to={`/console/${encodeURIComponent(c.conversationId)}`}
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: 12,
              textDecoration: "none",
              color: "inherit"
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
              <div>
                <div style={{ fontWeight: 600 }}>{c.conversationId}</div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                  createdAt：{c.createdAt}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 12, color: "#666" }}>status：{c.status}</div>
                <div style={{ fontSize: 12, color: "#666", marginTop: 4 }}>
                  order：{c.linkedOrderId ?? "-"}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

