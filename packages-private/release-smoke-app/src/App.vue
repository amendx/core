<script setup>
import { inject, ref } from 'vue'
import { routes } from './router.js'

const onResolve = inject('smoke:resolved', () => {})
const clicks = ref(0)
const links = routes.map(r => r.meta?.smokePath ?? r.path)
</script>

<template>
  <header>
    <nav>
      <RouterLink v-for="link in links" :key="link" :to="link">{{
        link
      }}</RouterLink>
    </nav>
    <button data-smoke-action @click="clicks++">
      layout clicks: {{ clicks }}
    </button>
  </header>
  <main>
    <RouterView v-slot="{ Component, route }">
      <Suspense @resolve="onResolve">
        <component :is="Component" :key="route.path" />
      </Suspense>
    </RouterView>
  </main>
</template>

<style>
nav {
  display: flex;
  gap: 1em;
}
</style>
