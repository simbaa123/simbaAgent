<template>
  <div class="relative min-h-0 h-full overflow-hidden">
    <div ref="containerRef" class="h-full overflow-y-auto px-6 py-5" @scroll="onScroll">
      <div class="mx-auto max-w-3xl space-y-4">
        <div v-for="(m, idx) in messages" :key="m.messageId" :class="`flex ${alignClass(m.role)}`">
          <div class="max-w-[92%] sm:max-w-[78%]">
            <div class="mb-1 flex items-center gap-2 text-[11px] text-zinc-500">
              <span class="font-medium">{{ roleLabel(m.role) }}</span>
              <span class="text-zinc-400">·</span>
              <span>{{ new Date(m.createdAt).toLocaleString() }}</span>
            </div>
            <div :class="`rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm ${bubbleClass(m.role)}`">
              <div class="whitespace-pre-wrap">{{ m.content }}</div>
              <div v-if="streaming && idx === messages.length - 1 && m.role === 'agent'" class="mt-2 text-[11px] text-zinc-500">
                正在生成…
              </div>
            </div>
          </div>
        </div>

        <div v-if="error" class="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {{ error }}
        </div>
      </div>
    </div>

    <div v-if="locked" class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center">
      <button
        class="pointer-events-auto rounded-full border border-zinc-200 bg-white/90 px-3 py-1.5 text-xs text-zinc-700 shadow-sm backdrop-blur transition hover:bg-white"
        @click="scrollToBottom"
      >
        回到底部
      </button>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from "vue";
// 定义属性
const props = defineProps({
  messages: { type: Array, default: () => [] },
  error: { type: String, default: null },
  streaming: { type: Boolean, default: false }
});

const containerRef = ref(null);
const locked = ref(false);

function roleLabel(role) {
  if (role === "user") return "用户";
  if (role === "agent") return "Agent";
  return "客服";
}

function bubbleClass(role) {
  if (role === "user") return "bg-emerald-600 text-white";
  if (role === "agent") return "bg-white text-zinc-900 border border-zinc-200";
  return "bg-zinc-100 text-zinc-900 border border-zinc-200";
}

function alignClass(role) {
  if (role === "user") return "justify-end";
  if (role === "agent") return "justify-start";
  return "justify-center";
}

function onScroll() {
  const el = containerRef.value;
  if (!el) return;
  const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
  locked.value = dist > 240;
}

function scrollToBottom() {
  const el = containerRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
  locked.value = false;
}

async function maybeAutoScroll() {
  if (locked.value) return;
  await nextTick();
  const el = containerRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

onMounted(() => void maybeAutoScroll());
watch(
  () => [props.messages.length, props.streaming],
  () => void maybeAutoScroll()
);
</script>
