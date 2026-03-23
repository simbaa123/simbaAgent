export async function listConversations() {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error("Failed to list conversations");
  return res.json();
}

export async function getConversation(conversationId) {
  const res = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}`);
  if (!res.ok) throw new Error("Failed to get conversation");
  return res.json();
}

export async function searchOrders(params) {
  const usp = new URLSearchParams();
  if (params?.orderNo) usp.set("orderNo", params.orderNo);
  if (params?.phoneLast4) usp.set("phoneLast4", params.phoneLast4);
  const res = await fetch(`/api/orders/search?${usp.toString()}`);
  if (!res.ok) throw new Error("Failed to search orders");
  return res.json();
}

export async function getOrderDetail(orderId) {
  const res = await fetch(`/api/orders/${encodeURIComponent(orderId)}`);
  if (!res.ok) throw new Error("Failed to get order detail");
  return res.json();
}

export async function getShipment(shipmentId) {
  const res = await fetch(`/api/shipments/${encodeURIComponent(shipmentId)}`);
  if (!res.ok) throw new Error("Failed to get shipment");
  return res.json();
}

