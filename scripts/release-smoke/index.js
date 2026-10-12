// @ts-check
// Smoke-tests the real release artifacts. Every package is published exactly
// the way the release workflow does it (`scripts/release.js --publishOnly`),
// but into a throwaway verdaccio registry (no uplinks). The app's
// third-party deps are seeded into it from the workspace's node_modules, so
// nothing touches npmjs. A fresh production SSR app
// (packages-private/release-smoke-app) then installs only from that registry,
// and every one of its routes must server-render and hydrate with an empty
// browser console.
//
//   pnpm release-smoke [version] [--skipBuild] [--keep]
//
// Without a version the current version is published, like the release
// workflow does. Passing one bakes it into the build like a version bump would;
// package.json files are restored afterwards either way.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import pico from 'picocolors'
import semver from 'semver'
import { checkApp } from './check-app.js'
import { npmrcFor, startRegistry } from './registry.js'
import { collectSeedPackages, seedRegistry } from './seed.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const appTemplate = path.join(root, 'packages-private/release-smoke-app')

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    skipBuild: { type: 'boolean' },
    keep: { type: 'boolean' },
  },
})

const readJson = (/** @type {string} */ file) =>
  JSON.parse(fs.readFileSync(file, 'utf-8'))
const writeJson = (/** @type {string} */ file, /** @type {any} */ data) =>
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n')
const step = (/** @type {string} */ msg) => console.log(pico.cyan(`\n${msg}`))

const currentVersion = readJson(path.join(root, 'package.json')).version
const version = positionals[0] ?? currentVersion
if (!semver.valid(version)) {
  throw new Error(`invalid version: ${version}`)
}

const packageDirs = fs
  .readdirSync(path.join(root, 'packages'))
  .filter(dir =>
    fs.existsSync(path.join(root, 'packages', dir, 'package.json')),
  )
/** names of every package a release publishes */
const releasedNames = new Set(
  packageDirs
    .map(dir => readJson(path.join(root, 'packages', dir, 'package.json')))
    .filter(pkg => !pkg.private)
    .map(pkg => pkg.name),
)

/** @type {Set<import('node:child_process').ChildProcess>} */
const children = new Set()
/** @type {(() => void)[]} */
const cleanups = []
const cleanup = () => {
  // release.js spawns pnpm, which spawns the build and publishes: take the
  // whole process group down before restoring files and stopping the registry
  for (const child of children) {
    try {
      process.kill(-(/** @type {number} */ (child.pid)), 'SIGTERM')
    } catch {}
  }
  while (cleanups.length) {
    try {
      cleanups.pop()?.()
    } catch (e) {
      console.error(e)
    }
  }
}
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    cleanup()
    process.exit(130)
  })
}

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {import('node:child_process').SpawnOptions} options
 * @returns {Promise<void>}
 */
function run(bin, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      stdio: 'inherit',
      detached: true,
      ...options,
    })
    children.add(child)
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      children.delete(child)
      if (code === 0) resolve()
      else
        reject(
          new Error(`${bin} ${args.join(' ')} exited with ${signal ?? code}`),
        )
    })
  })
}

async function main() {
  const seedPackages = collectSeedPackages(appTemplate, releasedNames)

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vue-release-smoke-'))
  cleanups.push(() => {
    if (args.keep) console.log(`Kept ${workDir}`)
    else fs.rmSync(workDir, { recursive: true, force: true })
  })

  step('Starting local registry...')
  const registry = await startRegistry(path.join(workDir, 'storage'))
  cleanups.push(registry.stop)
  console.log(`verdaccio at ${registry.url} (no uplinks)`)
  await seedRegistry(registry, seedPackages)
  console.log(
    `seeded ${seedPackages.length} third-party packages from node_modules`,
  )

  // Child processes only see npm config we wrote, never the user's ~/.npmrc,
  // a global npmrc, or npm_config_* vars injected by CI or a parent pnpm.
  const globalNpmrc = path.join(workDir, 'global.npmrc')
  fs.writeFileSync(globalNpmrc, '')
  /** @param {string} userconfig */
  const npmEnv = userconfig => ({
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^p?npm_config_/i.test(key),
      ),
    ),
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalNpmrc,
    // pnpm would otherwise auto-install (and may hit npmjs) on `pnpm run`
    // when release.js has bumped versions in the manifests
    pnpm_config_verify_deps_before_run: 'false',
  })
  const publishNpmrc = path.join(workDir, 'publish.npmrc')
  fs.writeFileSync(publishNpmrc, npmrcFor(registry, { auth: true }))
  const installNpmrc = path.join(workDir, 'install.npmrc')
  fs.writeFileSync(installNpmrc, npmrcFor(registry))

  step(`Publishing v${version} the way a release does...`)
  await publishRelease(registry.url, npmEnv(publishNpmrc))
  await verifyPublished(registry.url)

  step('Installing a fresh SSR app from the local registry...')
  const appDir = path.join(workDir, 'app')
  prepareApp(appDir)
  const installEnv = npmEnv(installNpmrc)
  await run(
    'npm',
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--cache',
      path.join(workDir, 'npm-cache'),
    ],
    { cwd: appDir, env: installEnv },
  )
  verifyInstall(appDir, registry.url)

  step('Building the app for production...')
  await run('npm', ['run', 'build'], { cwd: appDir, env: installEnv })

  step('Checking every route: SSR + hydration with an empty console...')
  if (!(await checkApp(appDir))) {
    throw new Error('release smoke test failed')
  }
  console.log(pico.green(`\nRelease artifacts for v${version} look good.`))
}

/**
 * @param {string} registryUrl
 * @param {NodeJS.ProcessEnv} env
 */
async function publishRelease(registryUrl, env) {
  // release.js rewrites versions when given one and doesn't put them back
  const manifests = [
    path.join(root, 'package.json'),
    ...packageDirs.map(dir => path.join(root, 'packages', dir, 'package.json')),
  ]
  const originals = manifests.map(file => ({
    content: fs.readFileSync(file, 'utf-8'),
    stat: fs.statSync(file),
  }))
  // Only touch what changed, and keep the original mtimes: a newer manifest
  // makes pnpm re-install before the next `pnpm run`.
  const restore = () =>
    manifests.forEach((file, i) => {
      const { content, stat } = originals[i]
      if (fs.readFileSync(file, 'utf-8') === content) return
      fs.writeFileSync(file, content)
      fs.utimesSync(file, stat.atime, stat.mtime)
    })
  cleanups.push(restore)

  await run(
    process.execPath,
    [
      'scripts/release.js',
      '--publishOnly',
      ...(version === currentVersion ? [] : [version]),
      '--registry',
      registryUrl,
      '--skipGit',
      ...(args.skipBuild ? ['--skipBuild'] : []),
    ],
    { cwd: root, env },
  )
  restore()
}

/**
 * @param {string} registryUrl
 */
async function verifyPublished(registryUrl) {
  const problems = []
  for (const name of releasedNames) {
    const res = await fetch(registryUrl + name.replace('/', '%2f'))
    const doc = res.ok ? await res.json() : null
    const manifest = doc?.versions?.[version]
    if (!manifest) {
      problems.push(`${name}@${version} was not published`)
      continue
    }
    for (const field of [
      'dependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const [dep, spec] of Object.entries(manifest[field] ?? {})) {
        if (/^(workspace|catalog):/.test(String(spec))) {
          problems.push(`${name} was published with ${dep}@${spec}`)
        }
      }
    }
  }
  if (problems.length) throw new Error(problems.join('\n'))
  console.log(`${releasedNames.size} packages published at ${version}`)
}

/**
 * Copies the app out of the workspace as a standalone project: released
 * packages at the version just published, every other direct dependency
 * pinned to the version that was seeded. npm resolves the rest fresh.
 * @param {string} appDir
 */
function prepareApp(appDir) {
  fs.cpSync(appTemplate, appDir, {
    recursive: true,
    filter: src => !/[\\/](node_modules|dist)$/.test(src),
  })
  const pkgPath = path.join(appDir, 'package.json')
  const pkg = readJson(pkgPath)
  for (const field of ['dependencies', 'devDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      pkg[field][dep] = releasedNames.has(dep)
        ? version
        : readJson(path.join(appTemplate, 'node_modules', dep, 'package.json'))
            .version
    }
  }
  writeJson(pkgPath, pkg)
}

/**
 * @param {string} appDir
 * @param {string} registryUrl
 */
function verifyInstall(appDir, registryUrl) {
  const problems = []
  /** @type {Map<string, number>} */
  const copies = new Map()
  const lock = readJson(path.join(appDir, 'package-lock.json'))
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key || entry.link || entry.inBundle) continue
    if (entry.resolved && !entry.resolved.startsWith(registryUrl)) {
      problems.push(`${key} resolved from ${entry.resolved}`)
    }
    const name = packageName(key, entry)
    if (releasedNames.has(name)) {
      copies.set(name, (copies.get(name) ?? 0) + 1)
      if (entry.version !== version) {
        problems.push(`${key} is ${entry.version}, expected ${version}`)
      }
    }
  }
  for (const [name, count] of copies) {
    if (count > 1) problems.push(`${count} copies of ${name} installed`)
  }
  const installed = readJson(path.join(appDir, 'node_modules/vue/package.json'))
  if (installed.version !== version) {
    problems.push(`node_modules/vue is ${installed.version}`)
  }
  if (problems.length) throw new Error(problems.join('\n'))
  console.log(
    `${copies.size} vue packages installed at ${version}, all from the local registry`,
  )
}

/**
 * @param {string} key lockfile key, e.g. node_modules/a/node_modules/@b/c
 * @param {{ name?: string }} entry
 */
function packageName(key, entry) {
  return entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 13)
}

main()
  .catch(e => {
    console.error(pico.red(e.message ?? e))
    process.exitCode = 1
  })
  .finally(cleanup)
