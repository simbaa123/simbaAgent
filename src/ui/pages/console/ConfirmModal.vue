<template>
  <div
    v-if="open && data"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    @click="emit('close')"
  >
    <div class="w-full max-w-2xl rounded-2xl border border-zinc-200 bg-white shadow-xl" @click.stop>
      <div class="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4">
        <div>
          <div class="text-sm font-semibold text-zinc-900">{{ data.title }}</div>
          <div class="mt-1 text-xs text-zinc-500">请确认后再执行关键动作</div>
        </div>
        <button
          class="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <div class="p-5">
        <div class="rounded-2xl border border-zinc-200 bg-zinc-50 p-4">
          <div class="text-xs text-zinc-500">action：{{ data.action }}</div>
          <pre class="mt-3 whitespace-pre-wrap break-words text-xs text-zinc-800">{{ JSON.stringify(data.details, null, 2) }}</pre>
        </div>

        <div class="mt-4 flex justify-end gap-2">
          <button
            class="rounded-2xl border border-zinc-200 bg-white px-4 py-2 text-sm text-zinc-700 hover:bg-zinc-50"
            @click="emit('cancel')"
          >
            取消
          </button>
          <button
            class="rounded-2xl bg-emerald-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700"
            @click="emit('confirm')"
          >
            确认执行
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  open: { type: Boolean, default: false },
  data: { type: Object, default: null }
});

const emit = defineEmits(["close", "cancel", "confirm"]);
</script>
