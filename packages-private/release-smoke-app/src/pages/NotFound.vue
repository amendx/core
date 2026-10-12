<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const n = ref(0)
</script>

<template>
  <section data-page="not-found">
    <h1>Not found</h1>
    <p>{{ route.path }}</p>
    <button data-smoke-action @click="n++">not found clicks: {{ n }}</button>
  </section>
</template>
