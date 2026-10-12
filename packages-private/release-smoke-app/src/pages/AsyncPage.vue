<script setup>
import { defineAsyncComponent, hydrateOnInteraction } from 'vue'

// suspensible: the root Suspense waits for it during hydration
const AsyncWidget = defineAsyncComponent(
  () => import('../components/AsyncWidget.vue'),
)
// lazily hydrated: the first click triggers hydration and is replayed
const LazyWidget = defineAsyncComponent({
  loader: () => import('../components/AsyncWidget.vue'),
  hydrate: hydrateOnInteraction('click'),
})
</script>

<template>
  <section data-page="async">
    <h1>Async components</h1>
    <AsyncWidget label="eager" />
    <LazyWidget label="lazy" />
  </section>
</template>
