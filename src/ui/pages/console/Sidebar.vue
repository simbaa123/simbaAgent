<template>
  <div class="h-full overflow-y-auto border-l border-zinc-200 bg-zinc-50 p-4">
    <div class="space-y-4">
      <section>
        <div class="mb-2 text-xs font-semibold text-zinc-600">订单</div>
        <div v-if="order" class="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div class="flex items-start justify-between gap-3">
            <div>
              <div class="text-sm font-semibold text-zinc-900">{{ order.orderNo }}</div>
              <div class="mt-2 flex flex-wrap items-center gap-2">
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  :class="statusPill(order.status)"
                >
                  {{ order.status }}
                </span>
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  :class="statusPill(order.aftersaleStatus)"
                >
                  aftersale: {{ order.aftersaleStatus }}
                </span>
              </div>
            </div>
            <div class="text-right">
              <div class="text-xs text-zinc-500">金额</div>
              <div class="mt-1 text-sm font-semibold text-zinc-900">{{ order.totalAmount }} {{ order.currency }}</div>
            </div>
          </div>
          <div class="mt-3 text-xs text-zinc-600">
            收货：{{ order.receiver.receiverNameMasked }} · {{ order.receiver.receiverPhoneMasked }}
          </div>
          <div class="mt-1 text-xs text-zinc-600">{{ order.receiver.addressMasked }}</div>
          <div class="mt-3 text-xs text-zinc-500">优惠 {{ order.discountAmount }} · 运费 {{ order.shippingFee }}</div>
          <div class="mt-2 text-xs text-zinc-500">包裹：{{ order.shipmentIds.join(", ") || "-" }}</div>
        </div>
        <div
          v-else
          class="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600"
        >
          暂无订单上下文，可在对话中通过订单号或手机号后四位定位。
        </div>
      </section>

      <section>
        <div class="mb-2 text-xs font-semibold text-zinc-600">物流轨迹</div>
        <div
          v-if="linkedShipmentIds.length === 0"
          class="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600"
        >
          无包裹
        </div>
        <div v-else class="space-y-3">
          <template v-for="id in linkedShipmentIds" :key="id">
            <div v-if="!shipments[id]" class="rounded-2xl border border-zinc-200 bg-white p-4 text-sm text-zinc-600">
              {{ id }}：未加载
            </div>
            <div v-else class="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
              <div class="flex items-start justify-between gap-3">
                <div>
                  <div class="text-sm font-semibold text-zinc-900">{{ shipments[id].carrier }}</div>
                  <div class="mt-1 text-xs text-zinc-500">单号：{{ shipments[id].trackingNoMasked }}</div>
                </div>
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  :class="statusPill(shipments[id].status)"
                >
                  {{ shipments[id].status }}
                </span>
              </div>

              <div class="mt-3 space-y-3">
                <div v-for="e in shipments[id].events" :key="e.time" class="relative pl-4">
                  <div class="absolute left-0 top-2 h-2 w-2 rounded-full bg-zinc-300" />
                  <div class="absolute left-[3px] top-4 h-full w-px bg-zinc-200" />
                  <div class="text-xs text-zinc-500">{{ new Date(e.time).toLocaleString() }} · {{ e.location }}</div>
                  <div class="text-sm text-zinc-900">{{ e.description }}</div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </section>

      <section>
        <div class="mb-2 text-xs font-semibold text-zinc-600">MCP 快捷操作</div>
        <div class="flex flex-wrap gap-2">
          <button
            class="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="streaming"
            @click="emit('export')"
          >
            导出会话
          </button>
          <button
            class="rounded-2xl border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-800 shadow-sm hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="streaming"
            @click="emit('audit')"
          >
            查看最近审计
          </button>
        </div>

        <div v-if="exportReady" class="mt-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div class="flex items-baseline justify-between gap-3">
            <div class="text-sm font-semibold">导出结果</div>
            <div class="text-xs text-zinc-500">{{ exportReady.format }}</div>
          </div>
          <div class="mt-2 break-all text-xs text-zinc-600">{{ exportReady.path }}</div>
          <div class="mt-3 flex justify-end gap-2">
            <button
              class="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
              @click="copy(exportReady.path)"
            >
              复制路径
            </button>
            <button
              class="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
              @click="emit('clearExport')"
            >
              清除
            </button>
          </div>
        </div>

        <div v-if="sqliteResult" class="mt-3 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <div class="flex items-baseline justify-between gap-3">
            <div class="text-sm font-semibold">SQLite 结果</div>
            <div class="text-xs text-zinc-500">{{ sqliteResult.rows.length }} 行</div>
          </div>

          <details class="mt-2">
            <summary class="cursor-pointer text-xs text-zinc-600 hover:text-zinc-900">SQL</summary>
            <pre class="mt-2 whitespace-pre-wrap break-words rounded-xl bg-zinc-50 p-3 text-xs text-zinc-800">{{ sqliteResult.query }}</pre>
          </details>

          <div class="mt-3 overflow-auto rounded-xl border border-zinc-100">
            <div v-if="sqliteResult.rows.length === 0" class="px-3 py-4 text-sm text-zinc-600">无数据</div>
            <table v-else class="min-w-full text-left text-xs">
              <thead class="bg-zinc-50 text-zinc-600">
                <tr>
                  <th v-for="k in sqliteColumns" :key="k" class="whitespace-nowrap px-3 py-2 font-medium">{{ k }}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-zinc-100">
                <tr v-for="(row, idx) in sqliteResult.rows.slice(0, 30)" :key="idx" class="bg-white">
                  <td v-for="k in sqliteColumns" :key="k" class="px-3 py-2 align-top text-zinc-800">
                    <div class="break-words">{{ String(row?.[k] ?? "") }}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="mt-3 flex justify-end">
            <button
              class="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
              @click="emit('clearSqlite')"
            >
              清除
            </button>
          </div>
        </div>
      </section>

      <section v-if="kbHits.length">
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="text-xs font-semibold text-zinc-600">引用（KB 命中）</div>
          <button
            class="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
            @click="emit('clearHits')"
          >
            清除
          </button>
        </div>
        <div class="space-y-2">
          <div v-for="h in kbHits.slice(0, 5)" :key="h.articleId" class="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-sm font-semibold text-zinc-900">{{ h.title }}</div>
                <div class="mt-1 text-xs text-zinc-500">条款引用：{{ h.articleId }}</div>
              </div>
              <button
                class="rounded-xl border border-zinc-200 px-3 py-1.5 text-xs text-zinc-700 hover:bg-zinc-50"
                @click="copy(h.articleId)"
              >
                复制引用
              </button>
            </div>
            <div class="mt-3 text-sm leading-6 text-zinc-800">{{ h.snippet }}</div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <span v-for="t in (h.tags ?? []).slice(0, 6)" :key="t" class="inline-flex items-center rounded-full bg-zinc-100 px-2 py-0.5 text-[11px] font-medium text-zinc-700">
                {{ t }}
              </span>
              <span class="text-[11px] text-zinc-500">{{ h.updatedAt }}</span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="mb-2 text-xs font-semibold text-zinc-600">Plan</div>
        <div
          v-if="planSteps.length === 0"
          class="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600"
        >
          等待 Agent 生成计划
        </div>
        <div v-else class="space-y-2">
          <div v-for="s in planSteps" :key="s.stepId" class="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
            <div class="flex items-center justify-between gap-3">
              <div class="text-sm text-zinc-900">{{ s.title }}</div>
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium" :class="statusPill(s.status)">
                {{ s.status }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <section>
        <div class="mb-2 text-xs font-semibold text-zinc-600">工具日志</div>
        <div
          v-if="toolLogs.length === 0"
          class="rounded-2xl border border-dashed border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-600"
        >
          暂无
        </div>
        <div v-else class="space-y-2">
          <div
            v-for="t in toolLogs.slice().reverse().slice(0, 20)"
            :key="t.toolCallId"
            class="rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm"
          >
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="text-sm font-semibold text-zinc-900">{{ t.toolName }}</div>
                <div class="mt-1 text-xs text-zinc-500">step：{{ t.stepId }}</div>
              </div>
              <div class="text-right">
                <span
                  class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                  :class="t.status === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'"
                >
                  {{ t.status }}
                </span>
                <div class="mt-1 text-xs text-zinc-500">{{ t.latencyMs }}ms</div>
              </div>
            </div>
            <details class="mt-3">
              <summary class="cursor-pointer text-xs text-zinc-600 hover:text-zinc-900">input/output（脱敏）</summary>
              <pre class="mt-2 whitespace-pre-wrap break-words rounded-xl bg-zinc-50 p-3 text-xs text-zinc-800">{{
                JSON.stringify({ input: t.inputRedacted, output: t.outputRedacted, error: t.error }, null, 2)
              }}</pre>
            </details>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";

const props = defineProps({
  order: { type: Object, default: null },
  shipments: { type: Object, default: () => ({}) },
  linkedShipmentIds: { type: Array, default: () => [] },
  planSteps: { type: Array, default: () => [] },
  kbHits: { type: Array, default: () => [] },
  toolLogs: { type: Array, default: () => [] },
  streaming: { type: Boolean, default: false },
  exportReady: { type: Object, default: null },
  sqliteResult: { type: Object, default: null }
});

const emit = defineEmits(["export", "audit", "clearExport", "clearSqlite", "clearHits"]);

function statusPill(status) {
  const s = status.toLowerCase();
  if (s.includes("exception") || s.includes("fail")) return "bg-red-50 text-red-700";
  if (s.includes("running") || s.includes("in_progress")) return "bg-blue-50 text-blue-700";
  if (s.includes("done") || s.includes("success") || s.includes("delivered") || s.includes("completed"))
    return "bg-emerald-50 text-emerald-700";
  return "bg-zinc-100 text-zinc-700";
}

async function copy(text) {
  await navigator.clipboard.writeText(text);
}

const sqliteColumns = computed(() => Object.keys(props.sqliteResult?.rows?.[0] ?? {}).slice(0, 10));
</script>
