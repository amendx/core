<script setup>
import { ref } from 'vue'
import { useRoute } from 'vue-router'

const route = useRoute()
const user = await new Promise(resolve =>
  setTimeout(
    () => resolve({ id: route.params.id, name: `User ${route.params.id}` }),
    10,
  ),
)
const follows = ref(0)
</script>

<template>
  <section data-page="user">
    <h1>{{ user.name }}</h1>
    <p>id: {{ user.id }}</p>
    <button data-smoke-action @click="follows++">follows: {{ follows }}</button>
  </section>
</template>
