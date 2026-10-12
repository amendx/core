<script setup>
const props = defineProps({
  name: { type: String, required: true },
  delay: { type: Number, required: true },
})

const value = await new Promise(resolve =>
  setTimeout(() => resolve(props.name.length * 7), props.delay),
)
</script>

<template>
  <p class="stat">{{ name }}: {{ value }}</p>
</template>
