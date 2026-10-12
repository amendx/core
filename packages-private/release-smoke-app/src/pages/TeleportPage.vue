<script setup>
import { ref } from 'vue'

const n = ref(0)
</script>

<template>
  <section data-page="teleport">
    <h1>Teleport</h1>
    <Teleport to="#teleports">
      <div class="modal" data-teleported="teleport">
        <p>teleported from /teleport</p>
        <button data-smoke-action @click="n++">
          teleported clicks: {{ n }}
        </button>
      </div>
    </Teleport>
    <Teleport to="#teleports" disabled>
      <p>disabled teleport renders in place: {{ n }}</p>
    </Teleport>
  </section>
</template>
