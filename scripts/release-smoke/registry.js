// @ts-check
// Runs verdaccio, taken from its official Docker image, as a throwaway local
// registry on the host's Node. It has no uplinks: anything not published into
// it does not exist.
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureVerdaccio } from './verdaccio-image.js'

const cacheDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../temp/release-smoke/verdaccio',
)

/**
 * @param {string} storageDir
 */
const config = storageDir => `\
storage: ${JSON.stringify(path.join(storageDir, 'data'))}
auth:
  htpasswd:
    file: ${JSON.stringify(path.join(storageDir, 'htpasswd'))}
uplinks: {}
packages:
  '**':
    access: $all
    publish: $authenticated
web:
  enable: false
max_body_size: 200mb
log: { type: stdout, format: pretty, level: warn }
`

/**
 * @typedef {{
 *   url: string
 *   token: string
 *   stop: () => void
 * }} Registry
 */

/**
 * @param {string} storageDir
 * @returns {Promise<Registry>}
 */
export async function startRegistry(storageDir) {
  const verdaccioDir = await ensureVerdaccio(cacheDir)

  fs.mkdirSync(storageDir, { recursive: true })
  const confDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-smoke-conf-'))
  const configFile = path.join(confDir, 'config.yaml')
  fs.writeFileSync(configFile, config(path.resolve(storageDir)))

  const port = await freePort()
  const url = `http://127.0.0.1:${port}/`
  const child = spawn(
    process.execPath,
    [
      path.join(verdaccioDir, 'bin/verdaccio'),
      '--config',
      configFile,
      '--listen',
      `127.0.0.1:${port}`,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  let output = ''
  child.stdout.on('data', chunk => (output += chunk))
  child.stderr.on('data', chunk => (output += chunk))

  const stop = () => {
    process.off('exit', stop)
    child.kill()
    fs.rmSync(confDir, { recursive: true, force: true })
  }
  // also on process.exit() from a signal handler
  process.on('exit', stop)

  try {
    await waitForPing(url, child, () => output)
    const token = await createUser(url)
    return { url, token, stop }
  } catch (e) {
    stop()
    throw e
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = /** @type {net.AddressInfo} */ (server.address())
      server.close(() => resolve(port))
    })
  })
}

/**
 * @param {string} url
 * @param {import('node:child_process').ChildProcess} child
 * @param {() => string} output
 */
async function waitForPing(url, child, output) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && child.exitCode === null) {
    try {
      if ((await fetch(url + '-/ping')).ok) return
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error(`verdaccio did not become ready at ${url}\n${output()}`)
}

/**
 * @param {string} url
 */
async function createUser(url) {
  const name = `smoke-${crypto.randomBytes(4).toString('hex')}`
  const res = await fetch(`${url}-/user/org.couchdb.user:${name}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name,
      password: crypto.randomBytes(16).toString('hex'),
    }),
  })
  /** @type {{ token?: string }} */
  const body = await res.json()
  if (!res.ok || !body.token) {
    throw new Error(`could not create registry user: ${JSON.stringify(body)}`)
  }
  return body.token
}

/**
 * npm-style config pointing every install/publish at the local registry.
 * @param {Registry} registry
 * @param {{ auth?: boolean }} [options]
 */
export function npmrcFor(registry, { auth = false } = {}) {
  const host = registry.url.replace(/^https?:/, '')
  return (
    `registry=${registry.url}\n` +
    (auth ? `${host}:_authToken=${registry.token}\n` : '')
  )
}
