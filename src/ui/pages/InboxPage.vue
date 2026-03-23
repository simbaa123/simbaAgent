<template>
  <div class="min-h-screen bg-zinc-50">
    <div class="mx-auto max-w-5xl px-6 py-10">
      <div class="flex items-start justify-between gap-6">
        <div>
          <h1 class="text-lg font-semibold tracking-tight">售后工单 Inbox</h1>
          <p class="mt-2 text-sm text-zinc-600">点击进入 Console，体验 Agent 流式链路、工具日志与 MCP 操作。</p>
        </div>
        <div class="rounded-xl border border-zinc-200 bg-white px-3 py-2 text-right shadow-sm">
          <div class="text-xs text-zinc-500">会话数</div>
          <div class="text-base font-semibold">{{ conversations.length }}</div>
        </div>
      </div>

      <div class="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div class="relative w-full sm:max-w-md">
          <input
            v-model="q"
            placeholder="搜索会话（id / status / channel / order）"
            class="w-full rounded-xl border border-zinc-200 bg-white px-3 py-2 text-sm outline-none ring-0 transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100"
          />
        </div>
        <div class="text-xs text-zinc-500">
          {{ q.trim() ? `命中 ${filtered.length} / ${conversations.length}` : `共 ${conversations.length} 条` }}
        </div>
      </div>

      <div v-if="error" class="mt-4 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        {{ error }}
      </div>

      <div class="mt-6 grid gap-3">
        <template v-if="loading">
          <div v-for="i in 6" :key="i" class="h-[76px] animate-pulse rounded-2xl border border-zinc-200 bg-white" />
        </template>
        <div v-else-if="filtered.length === 0" class="rounded-2xl border border-zinc-200 bg-white px-4 py-10 text-center">
          <div class="text-sm font-medium">没有匹配的会话</div>
          <div class="mt-1 text-xs text-zinc-500">换个关键词试试（例如 open / c_9001）。</div>
        </div>
        <template v-else>
          <RouterLink
            v-for="c in filtered"
            :key="c.conversationId"
            :to="`/console/${encodeURIComponent(c.conversationId)}`"
            class="group rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm transition hover:-translate-y-[1px] hover:border-zinc-300 hover:shadow"
          >
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="flex items-center gap-2">
                  <div class="text-sm font-semibold text-zinc-900">{{ c.conversationId }}</div>
                  <span
                    :class="
                      c.status === 'open'
                        ? 'inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700'
                        : 'inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700'
                    "
                  >
                    {{ c.status }}
                  </span>
                  <span class="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                    {{ c.channel }}
                  </span>
                </div>
                <div class="mt-2 text-xs text-zinc-500">createdAt：{{ c.createdAt }}</div>
              </div>
              <div class="text-right">
                <div class="text-xs text-zinc-500">order</div>
                <div class="mt-1 text-sm font-medium text-zinc-800">{{ c.linkedOrderId ?? '-' }}</div>
              </div>
            </div>
            <div class="mt-3 text-xs text-zinc-500 opacity-0 transition group-hover:opacity-100">进入 Console →</div>
          </RouterLink>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { listConversations } from "../api/client.js";

const conversations = ref([]);
const error = ref(null);
const loading = ref(true);
const q = ref("");

onMounted(async () => {
  loading.value = true;
  try {
    const data = await listConversations();
    conversations.value = data;
    error.value = null;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "Failed";
  } finally {
    loading.value = false;
  }
});

const filtered = computed(() => {
  const t = q.value.trim().toLowerCase();
  if (!t) return conversations.value;
  return conversations.value.filter((c) => {
    const hay = `${c.conversationId} ${c.status} ${c.channel} ${c.linkedOrderId ?? ""}`.toLowerCase();
    return hay.includes(t);
  });
});
</script>
