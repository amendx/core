import { renderToString } from 'vue/server-renderer'
import { createApp } from './main.js'

export { routes } from './router.js'

export async function render(url, manifest) {
  const { app, router } = createApp()
  await router.push(url)
  await router.isReady()

  const ctx = {}
  const html = await renderToString(app, ctx)

  return {
    html,
    teleports: ctx.teleports?.['#teleports'] ?? '',
    preloadLinks: renderPreloadLinks(ctx.modules, manifest),
    status: router.currentRoute.value.meta.status ?? 200,
  }
}

function renderPreloadLinks(modules, manifest) {
  const seen = new Set()
  let links = ''
  for (const id of modules ?? []) {
    for (const file of manifest[id] ?? []) {
      if (seen.has(file)) continue
      seen.add(file)
      if (file.endsWith('.js')) {
        links += `<link rel="modulepreload" crossorigin href="${file}">`
      } else if (file.endsWith('.css')) {
        links += `<link rel="stylesheet" href="${file}">`
      }
    }
  }
  return links
}
