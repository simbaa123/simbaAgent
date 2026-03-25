function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForPageVisible(timeoutMs = 2000) {
  if (typeof document === "undefined") return Promise.resolve();
  if (document.visibilityState === "visible") return Promise.resolve();

  return new Promise((resolve) => {
    const t = setTimeout(() => {
      document.removeEventListener("visibilitychange", onVis);
      resolve();
    }, timeoutMs);

    function onVis() {
      if (document.visibilityState !== "visible") return;
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVis);
      resolve();
    }

    document.addEventListener("visibilitychange", onVis);
  });
}

async function fetchJson(url, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      if (init?.signal) {
        if (init.signal.aborted) controller.abort();
        else init.signal.addEventListener("abort", () => controller.abort(), { once: true });
      }

      const res = await fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timeout));
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (typeof body?.error === "string") message = body.error;
          else if (typeof body?.message === "string") message = body.message;
        } catch {}
        throw new Error(message);
      }
      return await res.json();
    } catch (err) {
      const canRetry = attempt === 0;
      if (canRetry) {
        await waitForPageVisible(2000);
        await sleep(200);
        continue;
      }

      const original = err instanceof Error ? err.message : String(err);
      const timeoutHint =
        err && typeof err === "object" && "name" in err && err.name === "AbortError"
          ? "（请求超时或被取消）"
          : "";
      const e = new Error(
        `请求失败：${url}。可能是页面/网络被浏览器挂起（ERR_NETWORK_IO_SUSPENDED）或后端未启动。` +
          `请刷新页面并确认后端在 http://localhost:8787 运行。原始错误：${original}${timeoutHint}`
      );
      throw e;
    }
  }

  throw new Error(`请求失败：${url}`);
}

export async function listConversations() {
  return fetchJson("/api/conversations");
}

export async function getConversation(conversationId) {
  return fetchJson(`/api/conversations/${encodeURIComponent(conversationId)}`);
}

export async function searchOrders(params) {
  const usp = new URLSearchParams();
  if (params?.orderNo) usp.set("orderNo", params.orderNo);
  if (params?.phoneLast4) usp.set("phoneLast4", params.phoneLast4);
  return fetchJson(`/api/orders/search?${usp.toString()}`);
}

export async function getOrderDetail(orderId) {
  return fetchJson(`/api/orders/${encodeURIComponent(orderId)}`);
}

export async function getShipment(shipmentId) {
  return fetchJson(`/api/shipments/${encodeURIComponent(shipmentId)}`);
}
