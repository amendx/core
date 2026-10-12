// @ts-check
// Seeds the local registry with every third-party package the smoke app can
// install, taken from what `pnpm install` already put in the workspace (so the
// repo's supply-chain policies apply). Nothing is fetched from the network:
// each installed package directory is packed into a tarball and published
// through the same registry API `npm publish` uses.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/**
 * @typedef {{ name: string, version: string, dir: string, manifest: any }} SeedPackage
 */

/**
 * Walks the installed dependency graph from the app the way npm would install
 * it (dependencies, installed optionalDependencies, non-optional peers), going
 * through released workspace packages to reach their third-party deps.
 * @param {string} appDir
 * @param {Set<string>} releasedNames
 * @returns {SeedPackage[]}
 */
export function collectSeedPackages(appDir, releasedNames) {
  /** @type {Map<string, SeedPackage>} */
  const found = new Map()
  const visited = new Set()

  /**
   * @param {string} dir
   * @param {boolean} isApp
   */
  const visit = (dir, isApp) => {
    const real = fs.realpathSync(dir)
    if (visited.has(real)) return
    visited.add(real)
    const manifest = JSON.parse(
      fs.readFileSync(path.join(real, 'package.json'), 'utf-8'),
    )
    if (!isApp && !releasedNames.has(manifest.name)) {
      found.set(`${manifest.name}@${manifest.version}`, {
        name: manifest.name,
        version: manifest.version,
        dir: real,
        manifest,
      })
    }

    const peers = Object.keys(manifest.peerDependencies ?? {}).filter(
      dep => !manifest.peerDependenciesMeta?.[dep]?.optional,
    )
    /** @type {[string, boolean][]} [name, required] */
    const deps = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...(isApp ? Object.keys(manifest.devDependencies ?? {}) : []),
      ...peers,
    ].map(dep => [dep, true])
    // only the current platform's optional deps are installed
    for (const dep of Object.keys(manifest.optionalDependencies ?? {})) {
      deps.push([dep, false])
    }
    for (const [dep, required] of deps) {
      const depDir = resolveInstalled(real, dep)
      if (depDir) {
        visit(depDir, false)
      } else if (required) {
        throw new Error(
          `${dep}, needed by ${manifest.name}, is not installed. Run pnpm install.`,
        )
      }
    }
  }

  visit(appDir, true)
  return [...found.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`),
  )
}

/**
 * Node's lookup: <ancestor>/node_modules/<name> for each ancestor directory.
 * @param {string} fromDir
 * @param {string} name
 */
function resolveInstalled(fromDir, name) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', name)
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate
    }
    if (path.dirname(dir) === dir) return null
  }
}

/**
 * @param {import('./registry.js').Registry} registry
 * @param {SeedPackage[]} packages
 */
export async function seedRegistry(registry, packages) {
  for (const pkg of packages) {
    const tarball = packDir(pkg)
    const encoded = pkg.name.replace('/', '%2f')
    const file = `${pkg.name.split('/').pop()}-${pkg.version}.tgz`
    const manifest = {
      ...pkg.manifest,
      _id: `${pkg.name}@${pkg.version}`,
      dist: {
        integrity:
          'sha512-' +
          crypto.createHash('sha512').update(tarball).digest('base64'),
        shasum: crypto.createHash('sha1').update(tarball).digest('hex'),
        tarball: `${registry.url}${pkg.name}/-/${file}`,
      },
    }
    const res = await fetch(registry.url + encoded, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${registry.token}`,
      },
      body: JSON.stringify({
        _id: pkg.name,
        name: pkg.name,
        'dist-tags': { latest: pkg.version },
        versions: { [pkg.version]: manifest },
        _attachments: {
          [file]: {
            content_type: 'application/octet-stream',
            data: tarball.toString('base64'),
            length: tarball.length,
          },
        },
      }),
    })
    if (!res.ok) {
      throw new Error(
        `seeding ${pkg.name}@${pkg.version} failed: ${res.status} ${await res.text()}`,
      )
    }
  }
}

/**
 * Packs an installed package directory into an npm-style tarball (files under
 * `package/`). node_modules is left out except for bundled dependencies.
 * @param {SeedPackage} pkg
 */
function packDir(pkg) {
  const bundled =
    pkg.manifest.bundleDependencies ?? pkg.manifest.bundledDependencies ?? []
  /** @type {Buffer[]} */
  const blocks = []
  /**
   * @param {string} dir
   * @param {string} rel
   */
  const walk = (dir, rel) => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const relPath = rel ? `${rel}/${entry.name}` : entry.name
      if (relPath === 'node_modules') {
        for (const dep of bundled) {
          walk(path.join(abs, dep), `node_modules/${dep}`)
        }
      } else if (entry.isDirectory()) {
        walk(abs, relPath)
      } else if (entry.isFile()) {
        const { mode } = fs.statSync(abs)
        const data = fs.readFileSync(abs)
        blocks.push(tarHeader(`package/${relPath}`, data.length, mode))
        blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512))
      } else {
        throw new Error(`cannot pack ${abs}: not a regular file`)
      }
    }
  }
  walk(pkg.dir, '')
  blocks.push(Buffer.alloc(1024))
  return zlib.gzipSync(Buffer.concat(blocks))
}

/**
 * ustar header for a regular file.
 * @param {string} name
 * @param {number} size
 * @param {number} mode
 */
function tarHeader(name, size, mode) {
  let prefix = ''
  if (Buffer.byteLength(name) > 100) {
    // split at the first `/` that leaves a name of at most 100 bytes
    let i = name.indexOf('/')
    while (i !== -1 && Buffer.byteLength(name.slice(i + 1)) > 100) {
      i = name.indexOf('/', i + 1)
    }
    if (i === -1 || Buffer.byteLength(name.slice(0, i)) > 155) {
      throw new Error(`path too long to pack: ${name}`)
    }
    prefix = name.slice(0, i)
    name = name.slice(i + 1)
  }
  const header = Buffer.alloc(512)
  /** @type {(value: string, offset: number, length: number) => void} */
  const field = (value, offset, length) =>
    void header.write(value, offset, length, 'utf-8')
  /** @type {(value: number, offset: number, length: number) => void} */
  const octal = (value, offset, length) =>
    field(value.toString(8).padStart(length - 1, '0') + '\0', offset, length)
  field(name, 0, 100)
  octal(mode & 0o111 ? 0o755 : 0o644, 100, 8)
  octal(0, 108, 8) // uid
  octal(0, 116, 8) // gid
  octal(size, 124, 12)
  octal(499162500, 136, 12) // fixed mtime (1985-10-26), like npm
  header.fill(' ', 148, 156) // checksum is computed with spaces here
  field('0', 156, 1) // regular file
  field('ustar\0', 257, 6)
  field('00', 263, 2)
  field(prefix, 345, 155)
  let sum = 0
  for (const byte of header) sum += byte
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return header
}
