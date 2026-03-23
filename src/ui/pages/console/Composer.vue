<template>
  <div class="border-t border-zinc-200 bg-white px-6 py-4">
    <div class="mx-auto flex max-w-3xl items-end gap-3">
      <textarea
        ref="textareaRef"
        :value="value"
        :disabled="disabled"
        rows="1"
        placeholder="例如：我一直没收到货，帮我查下物流；或者：7天无理由退货运费谁承担？"
        class="min-h-[44px] flex-1 resize-none rounded-2xl border border-zinc-200 bg-white px-4 py-3 text-sm leading-6 text-zinc-900 outline-none transition focus:border-emerald-300 focus:ring-4 focus:ring-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
        @input="onInput"
        @keydown="onKeyDown"
      />
      <button
        class="inline-flex h-[44px] items-center justify-center rounded-2xl bg-emerald-600 px-4 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="disabled || !value.trim()"
        @click="emit('send')"
      >
        发送
      </button>
    </div>
    <div class="mx-auto mt-2 max-w-3xl text-xs text-zinc-500">Enter 发送，Shift+Enter 换行</div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, ref, watch } from "vue";

const props = defineProps({
  value: { type: String, default: "" },
  disabled: { type: Boolean, default: false }
});

const emit = defineEmits(["update:value", "send"]);

const textareaRef = ref(null);

function resize() {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = "0px";
  el.style.height = `${Math.min(180, el.scrollHeight)}px`;
}

function onInput(e) {
  const v = e.target.value;
  emit("update:value", v);
  void nextTick().then(resize);
}

function onKeyDown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (props.disabled) return;
    if (!props.value.trim()) return;
    emit("send");
  }
}

onMounted(() => resize());
watch(
  () => props.value,
  () => void nextTick().then(resize)
);
</script>
