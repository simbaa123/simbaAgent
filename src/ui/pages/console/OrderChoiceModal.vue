<template>
  <div
    v-if="open && data"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="dialog"
    aria-modal="true"
    @click="emit('close')"
  >
    <div class="w-full max-w-3xl rounded-2xl border border-zinc-200 bg-white shadow-xl" @click.stop>
      <div class="flex items-center justify-between gap-3 border-b border-zinc-200 px-5 py-4">
        <div>
          <div class="text-sm font-semibold text-zinc-900">{{ data.prompt }}</div>
          <div class="mt-1 text-xs text-zinc-500">请选择要继续处理的订单</div>
        </div>
        <button
          class="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
          @click="emit('close')"
        >
          关闭
        </button>
      </div>

      <div class="max-h-[70vh] overflow-y-auto p-5">
        <div class="grid gap-3">
          <button
            v-for="o in data.options"
            :key="o.orderId"
            class="rounded-2xl border border-zinc-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-[1px] hover:border-zinc-300 hover:shadow"
            @click="emit('choose', { orderId: o.orderId, orderNo: o.orderNo })"
          >
            <div class="flex items-start justify-between gap-4">
              <div>
                <div class="text-sm font-semibold text-zinc-900">{{ o.orderNo }}</div>
                <div class="mt-1 text-xs text-zinc-500">{{ o.itemsSummary }}</div>
                <div class="mt-2 text-xs text-zinc-500">支付时间：{{ o.paidAt }}</div>
              </div>
              <div class="text-right">
                <div class="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                  {{ o.status }}
                </div>
                <div class="mt-2 text-sm font-semibold text-zinc-900">{{ o.totalAmount }} {{ o.currency }}</div>
              </div>
            </div>
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

const emit = defineEmits(["close", "choose"]);
</script>
