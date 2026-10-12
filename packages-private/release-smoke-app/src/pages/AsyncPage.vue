<script setup>
import { defineAsyncComponent } from 'vue'

// suspensible: the root Suspense waits for it during hydration
const AsyncWidget = defineAsyncComponent(
  () => import('../components/AsyncWidget.vue'),
)
</script>

<template>
  <section data-page="async">
    <h1>Async components</h1>
    <AsyncWidget label="eager" />
  </section>
</template>
