// @ts-check
// Starts a built release-smoke app's production server and verifies that every
// route server-renders and hydrates in Chromium with an empty browser console.
//
//   node scripts/release-smoke/check-app.js <built-app-dir>
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pico from 'picocolors'
import { chromium } from 'playwright'

/**
 * @typedef {{ name: string, path: string, status: number }} SmokeRoute
 */

/**
 * @param {string} appDir
 * @returns {Promise<boolean>} whether every route passed
 */
export async function checkApp(appDir) {
  const routes = await loadRoutes(appDir)
  const server = await startServer(appDir)
  const browser = await chromium.launch()
  let failed = 0
  try {
    for (const route of routes) {
      const problems = [
        ...(await checkServerRender(server.url, route)),
        ...(await checkHydration(browser, server.url, route)),
      ]
      if (problems.length) {
        failed++
        console.log(pico.red(`✗ ${route.path} (${route.name})`))
        for (const p of problems) console.log(pico.red(`    ${p}`))
      } else {
        console.log(pico.green(`✓ ${route.path} (${route.name})`))
      }
    }
  } finally {
    await browser.close()
    server.stop()
  }
  if (server.stderr()) {
    console.log(pico.red(`server stderr:\n${server.stderr()}`))
    return false
  }
  return failed === 0
}

/**
 * Every route record in the app must be covered, so read them from the
 * built server bundle rather than keeping a separate list here.
 * @param {string} appDir
 * @returns {Promise<SmokeRoute[]>}
 */
async function loadRoutes(appDir) {
  const entry = path.join(appDir, 'dist/server/entry-server.js')
  /** @type {{ routes: any[] }} */
  const { routes } = await import(pathToFileURL(entry).href)
  return routes.map(record => {
    const routePath = record.meta?.smokePath ?? record.path
    if (/[:*(]/.test(routePath)) {
      throw new Error(
        `route "${record.path}" has params, give it a meta.smokePath`,
      )
    }
    return {
      name: String(record.name),
      path: routePath,
      status: record.meta?.status ?? 200,
    }
  })
}

/**
 * @param {string} appDir
 */
async function startServer(appDir) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // also on process.exit() from a signal handler, where finally doesn't run
  const stop = () => child.kill()
  process.on('exit', stop)
  let stderr = ''
  child.stderr.on('data', chunk => (stderr += chunk))
  /** @type {string} */
  const url = await new Promise((resolve, reject) => {
    let stdout = ''
    child.stdout.on('data', chunk => {
      stdout += chunk
      const match = stdout.match(/listening on (http:\/\/\S+)/)
      if (match) resolve(match[1])
    })
    child.on('exit', code =>
      reject(new Error(`app server exited with ${code}:\n${stderr}`)),
    )
  })
  return {
    url,
    stderr: () => stderr.trim(),
    stop: () => {
      process.off('exit', stop)
      stop()
    },
  }
}

/**
 * @param {string} baseUrl
 * @param {SmokeRoute} route
 */
async function checkServerRender(baseUrl, route) {
  const problems = []
  const res = await fetch(baseUrl + route.path)
  const html = await res.text()
  if (res.status !== route.status) {
    problems.push(`SSR status ${res.status}, expected ${route.status}`)
  }
  if (html.includes('<!--app-html-->') || html.includes('<!--teleports-->')) {
    problems.push('SSR left a template placeholder unfilled')
  }
  const app = html.match(
    /<div id="app">([\s\S]*)<\/div>\s*<div id="teleports">/,
  )
  if (!app || !app[1].includes(`data-page="${route.name}"`)) {
    problems.push(`SSR output has no data-page="${route.name}" inside #app`)
  }
  return problems
}

/**
 * @param {import('playwright').Browser} browser
 * @param {string} baseUrl
 * @param {SmokeRoute} route
 */
async function checkHydration(browser, baseUrl, route) {
  /** @type {string[]} */
  const problems = []
  const page = await browser.newPage()
  const url = baseUrl + route.path
  page.on('console', msg => {
    // Chromium logs the document's own non-2xx status (e.g. the 404 route).
    // That line comes from the browser, not the app, and only that is exempt.
    const isExpectedDocumentStatus =
      route.status >= 400 &&
      msg.location().url === url &&
      msg
        .text()
        .startsWith(
          `Failed to load resource: the server responded with a status of ${route.status} (`,
        )
    if (!isExpectedDocumentStatus) {
      problems.push(`console.${msg.type()}: ${msg.text()}`)
    }
  })
  page.on('pageerror', err => problems.push(`uncaught: ${err.message}`))
  page.on('requestfailed', req =>
    problems.push(`request failed: ${req.url()} ${req.failure()?.errorText}`),
  )
  page.on('response', res => {
    if (res.status() >= 400 && res.request().resourceType() !== 'document') {
      problems.push(`HTTP ${res.status()}: ${res.url()}`)
    }
  })

  try {
    await page.goto(url)
    await page.waitForFunction(
      () => /** @type {any} */ (window).__SMOKE__?.hydrated,
      null,
      { timeout: 10_000 },
    )
    if ((await page.locator(`[data-page="${route.name}"]`).count()) !== 1) {
      problems.push(`expected one [data-page="${route.name}"] after hydration`)
    }
    // Teleported content must be hydrated in place, not duplicated
    const teleported = page.locator('[data-teleported]')
    for (const name of await teleported.evaluateAll(els =>
      els.map(el => el.getAttribute('data-teleported')),
    )) {
      const count = await page.locator(`[data-teleported="${name}"]`).count()
      if (count !== 1) problems.push(`teleport "${name}" rendered ${count}x`)
    }
    // A click that updates the DOM proves listeners were attached by
    // hydration, including inside async components and teleports.
    const actions = page.locator('[data-smoke-action]')
    const count = await actions.count()
    if (!count) problems.push('no [data-smoke-action] elements to click')
    for (let i = 0; i < count; i++) {
      const action = actions.nth(i)
      const before = await action.textContent()
      await action.click()
      await page
        .waitForFunction(
          ([el, text]) => el?.textContent !== text,
          /** @type {const} */ ([await action.elementHandle(), before]),
          { timeout: 5_000 },
        )
        .catch(() => problems.push(`click had no effect: "${before?.trim()}"`))
    }
    await page.waitForLoadState('networkidle')
  } catch (/** @type {any} */ e) {
    problems.push(e.message.split('\n')[0])
  } finally {
    await page.close()
  }
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appDir = process.argv[2]
  if (!appDir) {
    console.error('usage: node scripts/release-smoke/check-app.js <app-dir>')
    process.exit(1)
  }
  process.exitCode = (await checkApp(path.resolve(appDir))) ? 0 : 1
}
