import { createApp } from './main.js'

const { app, router } = createApp()

// read by the smoke runner: set once the root Suspense has resolved, i.e.
// hydration of the current route (including async deps) has finished
window.__SMOKE__ = { hydrated: false }
app.provide('smoke:resolved', () => {
  window.__SMOKE__.hydrated = true
})

router.isReady().then(() => app.mount('#app'))
