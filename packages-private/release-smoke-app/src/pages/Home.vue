<script setup>
import { computed, ref } from 'vue'

const color = ref('rgb(0, 128, 0)')
const items = ['ssr', 'hydration', 'router']
const count = ref(0)
const doubled = computed(() => count.value * 2)
</script>

<template>
  <section data-page="home" class="home" :class="{ even: count % 2 === 0 }">
    <h1 :style="{ fontWeight: 600 }">Home</h1>
    <ul>
      <li v-for="(item, i) in items" :key="item">{{ i }}: {{ item }}</li>
    </ul>
    <p v-if="count === 0">untouched</p>
    <p v-else>touched</p>
    <button data-smoke-action @click="count++">
      count {{ count }} / doubled {{ doubled }}
    </button>
  </section>
</template>

<style scoped>
/* comment delimiters inside strings must not hide the v-bind() below */
.home::before {
  content: '/* not a comment';
}
.home {
  color: v-bind(color);
}
</style>
