<script setup>
import {
  defineAsyncComponent,
  hydrateOnIdle,
  hydrateOnInteraction,
  hydrateOnMediaQuery,
  hydrateOnVisible,
} from 'vue'

const loader = () => import('../components/LazyWidget.vue')
const lazy = hydrate => defineAsyncComponent({ loader, hydrate })

// a custom strategy: hydrate when the page dispatches `smoke:hydrate`
const onSmokeEvent = hydrate => {
  window.addEventListener('smoke:hydrate', hydrate, { once: true })
  return () => window.removeEventListener('smoke:hydrate', hydrate)
}

const OnIdle = lazy(hydrateOnIdle())
const OnInteraction = lazy(hydrateOnInteraction('click'))
const OnMediaQuery = lazy(hydrateOnMediaQuery('(max-width: 600px)'))
const OnCustom = lazy(onSmokeEvent)
const OnVisible = lazy(hydrateOnVisible())
</script>

<template>
  <section data-page="lazy">
    <h1>Lazy hydration</h1>
    <OnIdle strategy="idle" />
    <OnInteraction strategy="interaction" />
    <OnMediaQuery strategy="media-query" />
    <OnCustom strategy="custom" />
    <!-- keeps the visible-strategy widget out of the initial viewport -->
    <div class="spacer" />
    <OnVisible strategy="visible" />
  </section>
</template>

<style scoped>
.spacer {
  height: 300vh;
}
</style>
