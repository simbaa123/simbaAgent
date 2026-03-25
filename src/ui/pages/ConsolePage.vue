<template>
  <div class="h-screen bg-zinc-50">
    <div class="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 backdrop-blur">
      <div class="mx-auto flex max-w-6xl items-center justify-between gap-6 px-6 py-3">
        <div class="flex items-center gap-3">
          <RouterLink
            to="/inbox"
            class="rounded-xl border border-zinc-200 bg-white px-3 py-1.5 text-sm text-zinc-700 shadow-sm hover:bg-zinc-50"
          >
            返回 Inbox
          </RouterLink>
          <div>
            <div class="text-sm font-semibold text-zinc-900">Console</div>
            <div class="text-xs text-zinc-500">{{ convId }}</div>
          </div>
        </div>
        <div class="text-xs text-zinc-500">
          <span
            class="inline-flex items-center rounded-full px-2 py-0.5 font-medium"
            :class="streaming ? 'bg-emerald-50 text-emerald-700' : 'bg-zinc-100 text-zinc-700'"
          >
            {{ streaming ? "streaming" : "idle" }}
          </span>
        </div>
      </div>
    </div>

    <div class="mx-auto grid h-[calc(100vh-57px)] max-w-6xl grid-cols-1 overflow-hidden md:grid-cols-[1fr_380px]">
      <div class="min-h-0 border-r border-zinc-200 bg-white flex flex-col">
        <div class="min-h-0 flex-1">
          <ChatPanel :messages="messages" :error="error" :streaming="streaming" />
        </div>
        <Composer v-model:value="input" :disabled="streaming" @send="send()" />
      </div>

      <Sidebar
        :order="order"
        :shipments="shipments"
        :linkedShipmentIds="linkedShipmentIds"
        :planSteps="planSteps"
        :kbHits="kbHits"
        :toolLogs="toolLogs"
        :streaming="streaming"
        :exportReady="exportReady"
        :sqliteResult="sqliteResult"
        @export="onExport"
        @audit="onAudit"
        @clearHits="kbHits = []"
        @clearExport="exportReady = null"
        @clearSqlite="sqliteResult = null"
      />
    </div>

    <OrderChoiceModal
      :open="Boolean(pendingChoice)"
      :data="pendingChoice"
      @close="pendingChoice = null"
      @choose="onChooseOrder"
    />

    <ConfirmModal
      :open="Boolean(pendingConfirm)"
      :data="pendingConfirm"
      @close="pendingConfirm = null"
      @cancel="onCancelConfirm"
      @confirm="onConfirmAction"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { getConversation } from "../api/client.js";
import ChatPanel from "./console/ChatPanel.vue";
import Composer from "./console/Composer.vue";
import ConfirmModal from "./console/ConfirmModal.vue";
import OrderChoiceModal from "./console/OrderChoiceModal.vue";
import Sidebar from "./console/Sidebar.vue";
import { parseSseTextChunk } from "./console/sse.js";

const route = useRoute();
const convId = computed(() => String(route.params.conversationId ?? ""));

const messages = ref([]);
const input = ref("");
const planSteps = ref([]);
const kbHits = ref([]);
const toolLogs = ref([]);
const order = ref(null);
const shipments = ref({});
const error = ref(null);
const streaming = ref(false);
const pendingChoice = ref(null);
const pendingConfirm = ref(null);
const lastUserMessage = ref("");
const exportReady = ref(null);
const sqliteResult = ref(null);

const linkedShipmentIds = computed(() => order.value?.shipmentIds ?? []);
// 加载对话 并更新状态
async function loadConversation() {

  const id = convId.value;
  if (!id) return;
  try {

    const res = await getConversation(id);
    messages.value = res.messages ?? [];
    order.value = res.orderDetail ?? null;
    const shipmentMap = {};
    for (const s of res.shipments ?? []) shipmentMap[s.shipmentId] = s;
    shipments.value = shipmentMap;
    kbHits.value = [];
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed";
  }
}

onMounted(() => void loadConversation());
watch(convId, () => void loadConversation());
// 发送消息 并更新状态
async function send(params) {
  const id = convId.value;
  if (!id) return;
  const text = (params?.text ?? input.value).trim();
  if (!text) return;
  error.value = null;
  input.value = "";
  streaming.value = true;
  pendingChoice.value = null;
  pendingConfirm.value = null;
  lastUserMessage.value = text;

  if (!params?.silentUserMessage) {
    messages.value = [...messages.value, { messageId: `m_${Date.now()}`, conversationId: id, role: "user", content: text, createdAt: new Date().toISOString(), citations: [] }];
  }

  const assistantMsgId = `m_${Date.now() + 1}`;
  messages.value = [...messages.value, { messageId: assistantMsgId, conversationId: id, role: "agent", content: "", createdAt: new Date().toISOString(), citations: [] }];

  let assistantDraft = "";
  
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: id, message: text, context: params?.context })
  });

  if (!res.ok || !res.body) {
    streaming.value = false;
    error.value = "Stream failed to start";
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parsed = parseSseTextChunk(buffer);
    buffer = parsed.rest;

    for (const ev of parsed.events) {
      if (ev.event === "plan_update") planSteps.value = ev.data.steps;

      if (ev.event === "assistant_delta") {
        assistantDraft += ev.data.delta;
        const idx = messages.value.findIndex((m) => m.messageId === assistantMsgId);
        if (idx !== -1) messages.value[idx] = { ...messages.value[idx], content: assistantDraft };
      }

      if (ev.event === "tool_call" || ev.event === "tool_result") {
        toolLogs.value = [...toolLogs.value, ev.data];

        if (ev.data.toolName === "getOrderDetail" && ev.data.status === "success") {
          const od = ev.data?.outputRedacted?.orderDetail;
          if (od) order.value = od;
        }
        if (ev.data.toolName === "getShipmentTracking" && ev.data.status === "success") {
          const sh = ev.data?.outputRedacted?.shipment;
          if (sh?.shipmentId) shipments.value = { ...shipments.value, [sh.shipmentId]: sh };
        }
        if (ev.event === "tool_result" && ev.data.toolName === "kbSearch" && ev.data.status === "success") {
          const hits = ev.data?.outputRedacted?.hits;
          if (Array.isArray(hits)) kbHits.value = hits;
        }
      }

      if (ev.event === "need_choice") pendingChoice.value = ev.data;
      if (ev.event === "need_confirm") pendingConfirm.value = ev.data;
      if (ev.event === "export_ready") exportReady.value = ev.data;
      if (ev.event === "sqlite_result") sqliteResult.value = ev.data;
      if (ev.event === "error") error.value = ev.data.message;
    }
  }

  streaming.value = false;
}

function pushSystemMessage(content) {
  const id = convId.value;
  if (!id) return;
  messages.value = [...messages.value, { messageId: `m_${Date.now()}`, conversationId: id, role: "cs", content, createdAt: new Date().toISOString(), citations: [] }];
}

function onExport() {
  pushSystemMessage("（系统）导出会话（md）");
  void send({ text: "/export md", silentUserMessage: true });
}

function onAudit() {
  pushSystemMessage("（系统）查看最近审计");
  void send({ text: "/audit", silentUserMessage: true });
}

function onChooseOrder(params) {
  pendingChoice.value = null;
  pushSystemMessage(`已选择订单：${params.orderNo}`);
  void send({ text: lastUserMessage.value || "帮我查下物流", context: { orderId: params.orderId }, silentUserMessage: true });
}

function onCancelConfirm() {
  pendingConfirm.value = null;
  pushSystemMessage("已取消操作");
}

function onConfirmAction() {
  const action = pendingConfirm.value?.action;
  const details = pendingConfirm.value?.details ?? {};
  pendingConfirm.value = null;
  pushSystemMessage("已确认执行");
  void send({
    text: "确认",
    context: {
      orderId: details.orderId,
      confirm: {
        action: action,
        payload: details
      }
    },
    silentUserMessage: true
  });
}
</script>
