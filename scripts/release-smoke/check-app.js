// @ts-check
// Starts a built release-smoke app's production server and verifies that every
// route server-renders and hydrates in Chromium with an empty browser console.
//
//   node scripts/release-smoke/check-app.js <built-app-dir>
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import pico from 'picocolors'
import { chromium } from 'playwright'

/**
 * @typedef {{ name: string, path: string, status: number }} SmokeRoute
 * @typedef {import('playwright').Page} Page
 */

/**
 * Every lazy hydration strategy the app must cover, in the order they are
 * triggered, with what makes each one hydrate. A `[data-lazy]` widget with a
 * strategy missing here fails, and so does a strategy no route uses.
 * @type {Record<string, ((page: Page, widget: import('playwright').Locator) => Promise<unknown>) | null>}
 */
const LAZY_TRIGGERS = {
  // hydrates by itself once the browser is idle
  idle: null,
  // the click is both the trigger and an event that must be replayed
  interaction: (page, widget) => widget.locator('[data-lazy-action]').click(),
  // the widget's query is (max-width: 600px)
  'media-query': page => page.setViewportSize({ width: 500, height: 720 }),
  custom: page =>
    page.evaluate(() => window.dispatchEvent(new Event('smoke:hydrate'))),
  visible: (page, widget) => widget.scrollIntoViewIfNeeded(),
}

/**
 * @param {string} appDir
 * @returns {Promise<boolean>} whether every route passed
 */
export async function checkApp(appDir) {
  const routes = await loadRoutes(appDir)
  if (!checkMismatchDetails(appDir)) return false
  const server = await startServer(appDir)
  const browser = await chromium.launch()
  /** @type {Set<string>} */
  const lazyCovered = new Set()
  let failed = 0
  try {
    for (const route of routes) {
      const problems = [
        ...(await checkServerRender(server.url, route)),
        ...(await checkHydration(browser, server.url, route, lazyCovered)),
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
  const uncovered = Object.keys(LAZY_TRIGGERS).filter(s => !lazyCovered.has(s))
  if (uncovered.length) {
    console.log(
      pico.red(`✗ lazy hydration not covered: ${uncovered.join(', ')}`),
    )
    return false
  }
  return failed === 0
}

/**
 * The detailed mismatch warnings only exist in a prod bundle built with
 * __VUE_PROD_HYDRATION_MISMATCH_DETAILS__; without them a mismatch would only
 * show up as the generic "Hydration completed but contains mismatches."
 * @param {string} appDir
 */
function checkMismatchDetails(appDir) {
  const assets = path.join(appDir, 'dist/client/assets')
  const enabled = fs
    .readdirSync(assets)
    .filter(file => file.endsWith('.js'))
    .some(file =>
      fs
        .readFileSync(path.join(assets, file), 'utf-8')
        .includes('Hydration node mismatch'),
    )
  if (!enabled) {
    console.log(
      pico.red(
        '✗ client bundle was built without prod hydration mismatch details',
      ),
    )
  }
  return enabled
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
 * @param {Set<string>} lazyCovered
 */
async function checkHydration(browser, baseUrl, route, lazyCovered) {
  /** @type {string[]} */
  const problems = []
  const page = await browser.newPage()
  const url = baseUrl + route.path
  // Tag the server-rendered lazy widgets once parsing is done and before any
  // module script runs, so hydration can be told apart from a client re-render
  // (which would replace the tagged nodes).
  await page.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive') return
      for (const el of document.querySelectorAll('[data-lazy]')) {
        ;/** @type {any} */ (el).__smokeServerRendered = true
      }
    })
  })
  /** @type {Promise<unknown>[]} */
  const pendingConsole = []
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
      pendingConsole.push(
        describeConsoleMessage(msg).then(text =>
          problems.push(`console.${msg.type()}: ${text}`),
        ),
      )
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
    problems.push(...(await checkLazyHydration(page, lazyCovered)))
    // A click that updates the DOM proves listeners were attached by
    // hydration, including inside async components and teleports.
    const actions = page.locator('[data-smoke-action]')
    const count = await actions.count()
    if (!count) problems.push('no [data-smoke-action] elements to click')
    for (let i = 0; i < count; i++) {
      const action = actions.nth(i)
      const before = await action.textContent()
      await action.click()
      if (!(await textChanges(action, before))) {
        problems.push(`click had no effect: "${before?.trim()}"`)
      }
    }
    await page.waitForLoadState('networkidle')
  } catch (/** @type {any} */ e) {
    problems.push(e.message.split('\n')[0])
  } finally {
    await Promise.all(pendingConsole)
    await page.close()
  }
  return problems
}

/**
 * msg.text() prints DOM arguments as "JSHandle@node", which hides what a
 * hydration mismatch warning points at; render them as markup instead.
 * @param {import('playwright').ConsoleMessage} msg
 */
async function describeConsoleMessage(msg) {
  const parts = await Promise.all(
    msg.args().map(arg =>
      arg
        .evaluate(value => {
          if (value instanceof Element) return value.outerHTML.slice(0, 160)
          if (value instanceof Node) return JSON.stringify(value.textContent)
          if (typeof value === 'object' && value !== null) {
            return JSON.stringify(value)?.slice(0, 160) ?? String(value)
          }
          return String(value)
        })
        .catch(() => arg.toString()),
    ),
  )
  return parts.length ? parts.join(' ').replace(/\s*\n\s*/g, ' ') : msg.text()
}

/**
 * Each lazily hydrated widget must have been server-rendered, stay
 * unhydrated until its own trigger fires (except idle), and then hydrate: its
 * onMounted runs (data-hydrated), the server-rendered node is kept, and its
 * click handler works.
 * @param {Page} page
 * @param {Set<string>} lazyCovered
 */
async function checkLazyHydration(page, lazyCovered) {
  /** @type {string[]} */
  const problems = []
  /** @type {string[]} */
  const present = await page
    .locator('[data-lazy]')
    .evaluateAll(els => els.map(el => el.getAttribute('data-lazy') ?? ''))
  if (!present.length) return problems
  for (const strategy of present) {
    if (!(strategy in LAZY_TRIGGERS)) {
      problems.push(`lazy widget "${strategy}" has no trigger in check-app.js`)
    }
  }

  const widget = (/** @type {string} */ strategy) =>
    page.locator(`[data-lazy="${strategy}"]`)
  const isHydrated = (/** @type {string} */ strategy) =>
    widget(strategy).evaluate(el => el.hasAttribute('data-hydrated'))
  const clicksText = (/** @type {string} */ strategy) =>
    widget(strategy).locator('[data-lazy-action]').textContent()

  // give anything that would hydrate too early the chance to do so
  await page.waitForTimeout(500)
  const pending = Object.keys(LAZY_TRIGGERS).filter(s => present.includes(s))
  /** @type {Set<string>} */
  const early = new Set()
  while (pending.length) {
    const strategy = /** @type {string} */ (pending.shift())
    const trigger = LAZY_TRIGGERS[strategy]
    // nothing still waiting for its trigger may have hydrated yet
    for (const other of trigger ? [strategy, ...pending] : pending) {
      if (!early.has(other) && (await isHydrated(other))) {
        early.add(other)
        problems.push(`lazy "${other}" hydrated before its trigger`)
      }
    }

    const before = await clicksText(strategy)
    if (trigger) await trigger(page, widget(strategy))
    const hydrated = await widget(strategy)
      .and(page.locator('[data-hydrated]'))
      .waitFor({ timeout: 10_000 })
      .then(() => true)
      .catch(() => false)
    if (!hydrated) {
      problems.push(`lazy "${strategy}" never hydrated`)
      continue
    }
    if (
      !(await widget(strategy).evaluate(
        el => /** @type {any} */ (el).__smokeServerRendered === true,
      ))
    ) {
      problems.push(
        `lazy "${strategy}" replaced its server-rendered DOM instead of hydrating it`,
      )
    }
    const action = widget(strategy).locator('[data-lazy-action]')
    if (strategy === 'interaction') {
      // the triggering click must have been replayed after hydration
      if (!(await textChanges(action, before))) {
        problems.push(`lazy "${strategy}" did not replay the triggering click`)
      }
    } else {
      await action.click()
      if (!(await textChanges(action, before))) {
        problems.push(`lazy "${strategy}" ignores clicks after hydrating`)
      }
    }
    lazyCovered.add(strategy)
  }
  return problems
}

/**
 * @param {import('playwright').Locator} locator
 * @param {string | null} before
 */
async function textChanges(locator, before) {
  const el = await locator.elementHandle()
  return el
    ?.evaluate(
      (node, text) =>
        new Promise(resolve => {
          const deadline = Date.now() + 5_000
          const poll = () => {
            if (node.textContent !== text) resolve(true)
            else if (Date.now() > deadline) resolve(false)
            else requestAnimationFrame(poll)
          }
          poll()
        }),
      before,
    )
    .catch(() => false)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appDir = process.argv[2]
  if (!appDir) {
    console.error('usage: node scripts/release-smoke/check-app.js <app-dir>')
    process.exit(1)
  }
  process.exitCode = (await checkApp(path.resolve(appDir))) ? 0 : 1
}
