<script setup>
import { ref } from 'vue'

defineProps({ label: { type: String, required: true } })
const n = ref(0)
</script>

<template>
  <div class="widget">
    <button data-smoke-action @click="n++">{{ label }} widget: {{ n }}</button>
  </div>
</template>

<style scoped>
.widget {
  border: 1px solid currentColor;
}
</style>
