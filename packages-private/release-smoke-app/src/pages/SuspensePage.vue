<script setup>
import { ref } from 'vue'
import SlowStat from '../components/SlowStat.vue'

const greeting = await new Promise(resolve =>
  setTimeout(() => resolve('resolved after top-level await'), 20),
)
const n = ref(0)
</script>

<template>
  <section data-page="suspense">
    <h1>Suspense</h1>
    <p>{{ greeting }}</p>
    <SlowStat name="first" :delay="10" />
    <SlowStat name="second" :delay="30" />
    <button data-smoke-action @click="n++">suspense clicks: {{ n }}</button>
  </section>
</template>
