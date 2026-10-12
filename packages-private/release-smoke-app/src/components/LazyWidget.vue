<script setup>
import { onMounted, ref } from 'vue'

defineProps({ strategy: { type: String, required: true } })

// only becomes true on the client, once this component has hydrated
const hydrated = ref(false)
const clicks = ref(0)
onMounted(() => {
  hydrated.value = true
})
</script>

<template>
  <div
    class="lazy"
    :data-lazy="strategy"
    :data-hydrated="hydrated || undefined"
  >
    <button data-lazy-action @click="clicks++">
      {{ strategy }} clicks: {{ clicks }}
    </button>
  </div>
</template>
