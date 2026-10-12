// @ts-check
// Gets verdaccio out of its official Docker image without needing Docker
// (GitHub's arm64 macOS runners can't run it). The image is pulled by digest
// from Docker Hub's registry API, every manifest and layer is checked against
// its sha256, and only verdaccio's own directory is extracted. verdaccio is
// plain JavaScript, so it then runs on the host's Node on any OS.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const REPOSITORY = 'verdaccio/verdaccio'
// multi-arch index digest of verdaccio/verdaccio:6.10.4
const INDEX_DIGEST =
  'sha256:43c4067288b050422265407ea2fe747e511fcd0c407a85ec90ab9a326d9400cd'
export const VERDACCIO_IMAGE = `${REPOSITORY}:6.10.4@${INDEX_DIGEST}`
// The payload is platform independent; always extracting the same platform's
// layers keeps the bits identical on every host.
const PLATFORM = 'linux/amd64'
const VERDACCIO_DIR = 'usr/local/lib/node_modules/verdaccio'

/**
 * @param {string} cacheDir
 * @returns {Promise<string>} verdaccio package directory
 */
export async function ensureVerdaccio(cacheDir) {
  const dir = path.join(cacheDir, INDEX_DIGEST.replace(':', '-'))
  const packageDir = path.join(dir, VERDACCIO_DIR)
  if (fs.existsSync(path.join(dir, '.complete'))) return packageDir

  console.log(`Fetching verdaccio from ${VERDACCIO_IMAGE} (${PLATFORM})...`)
  const partial = `${dir}.partial-${process.pid}`
  fs.rmSync(partial, { recursive: true, force: true })
  fs.mkdirSync(partial, { recursive: true })

  const auth = await fetch(
    `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPOSITORY}:pull`,
  )
  if (!auth.ok) throw new Error(`Docker Hub auth failed: ${auth.status}`)
  /** @type {{ token: string }} */
  const { token } = await auth.json()

  /**
   * @param {'manifests' | 'blobs'} kind
   * @param {string} digest
   * @param {string} [accept]
   */
  const getVerified = async (kind, digest, accept = '*/*') => {
    const res = await fetch(
      `https://registry-1.docker.io/v2/${REPOSITORY}/${kind}/${digest}`,
      { headers: { authorization: `Bearer ${token}`, accept } },
    )
    if (!res.ok) throw new Error(`GET ${kind}/${digest}: ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    const actual =
      'sha256:' + crypto.createHash('sha256').update(data).digest('hex')
    if (actual !== digest) throw new Error(`digest mismatch for ${digest}`)
    return data
  }

  const index = JSON.parse(
    (
      await getVerified(
        'manifests',
        INDEX_DIGEST,
        'application/vnd.oci.image.index.v1+json',
      )
    ).toString(),
  )
  const entry = index.manifests.find(
    (/** @type {any} */ m) =>
      `${m.platform?.os}/${m.platform?.architecture}` === PLATFORM,
  )
  if (!entry) throw new Error(`${VERDACCIO_IMAGE} has no ${PLATFORM} image`)
  const manifest = JSON.parse(
    (
      await getVerified(
        'manifests',
        entry.digest,
        'application/vnd.oci.image.manifest.v1+json',
      )
    ).toString(),
  )
  for (const layer of manifest.layers) {
    if (!/tar\+gzip$|tar\.gzip$/.test(layer.mediaType)) {
      throw new Error(`unsupported layer type ${layer.mediaType}`)
    }
    const tar = zlib.gunzipSync(await getVerified('blobs', layer.digest))
    extractLayer(tar, partial)
  }

  if (!fs.existsSync(path.join(partial, VERDACCIO_DIR, 'package.json'))) {
    throw new Error(`${VERDACCIO_DIR} not found in ${VERDACCIO_IMAGE}`)
  }
  fs.writeFileSync(path.join(partial, '.complete'), '')
  fs.rmSync(dir, { recursive: true, force: true })
  fs.renameSync(partial, dir)
  return packageDir
}

/**
 * @param {string} p path inside the image
 */
const inScope = p => p === VERDACCIO_DIR || p.startsWith(VERDACCIO_DIR + '/')

/**
 * Applies one image layer to `root`, keeping only VERDACCIO_DIR. Handles the
 * tar features image layers use (pax and GNU long names, links) and OCI
 * whiteouts, which delete paths from earlier layers.
 * @param {Buffer} tar
 * @param {string} root
 */
function extractLayer(tar, root) {
  /** @type {Record<string, string>} */
  let pax = {}
  /** @type {string | undefined} */
  let longName
  /** @type {string | undefined} */
  let longLink
  let offset = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every(b => b === 0)) break
    const str = (/** @type {number} */ start, /** @type {number} */ len) => {
      const field = header.subarray(start, start + len)
      const end = field.indexOf(0)
      return field.subarray(0, end === -1 ? len : end).toString('utf-8')
    }
    const num = (/** @type {number} */ start, /** @type {number} */ len) =>
      parseInt(str(start, len).trim() || '0', 8)
    const size = num(124, 12)
    const type = header[156] ? String.fromCharCode(header[156]) : '0'
    const body = tar.subarray(offset + 512, offset + 512 + size)
    offset += 512 + Math.ceil(size / 512) * 512

    if (type === 'x') {
      pax = parsePax(body)
      continue
    }
    if (type === 'g') continue
    if (type === 'L' || type === 'K') {
      const value = body.toString('utf-8').replace(/\0+$/, '')
      if (type === 'L') longName = value
      else longLink = value
      continue
    }

    const ustarPrefix = str(257, 6) === 'ustar' ? str(345, 155) : ''
    let name =
      pax.path ??
      longName ??
      (ustarPrefix ? `${ustarPrefix}/${str(0, 100)}` : str(0, 100))
    const linkName = pax.linkpath ?? longLink ?? str(157, 100)
    pax = {}
    longName = longLink = undefined
    name = name.replace(/^\.?\//, '').replace(/\/$/, '')
    if (name.split('/').includes('..')) {
      throw new Error(`unsafe path in image layer: ${name}`)
    }

    const base = path.posix.basename(name)
    const parent = path.posix.dirname(name)
    if (base.startsWith('.wh.')) {
      const target =
        base === '.wh..wh..opq'
          ? parent
          : path.posix.join(parent, base.slice(4))
      // a whiteout on verdaccio's dir, inside it, or on one of its ancestors
      if (inScope(target) || VERDACCIO_DIR.startsWith(target + '/')) {
        const abs = path.join(root, target)
        if (base === '.wh..wh..opq') {
          for (const child of fs.existsSync(abs) ? fs.readdirSync(abs) : []) {
            fs.rmSync(path.join(abs, child), { recursive: true, force: true })
          }
        } else {
          fs.rmSync(abs, { recursive: true, force: true })
        }
      }
      continue
    }
    if (!inScope(name)) continue

    const out = path.join(root, name)
    if (type === '5') {
      fs.mkdirSync(out, { recursive: true })
      continue
    }
    fs.mkdirSync(path.dirname(out), { recursive: true })
    fs.rmSync(out, { force: true })
    if (type === '0' || type === '7') {
      fs.writeFileSync(out, body, { mode: num(100, 8) & 0o777 })
    } else if (type === '2') {
      fs.symlinkSync(linkName, out)
    } else if (type === '1') {
      const target = linkName.replace(/^\.?\//, '')
      if (!inScope(target)) {
        throw new Error(`hard link ${name} points outside ${VERDACCIO_DIR}`)
      }
      fs.copyFileSync(path.join(root, target), out)
    } else {
      throw new Error(`unsupported tar entry type "${type}" for ${name}`)
    }
  }
}

/**
 * @param {Buffer} body records of the form "<len> <key>=<value>\n"
 */
function parsePax(body) {
  /** @type {Record<string, string>} */
  const records = {}
  let i = 0
  while (i < body.length) {
    const space = body.indexOf(0x20, i)
    if (space === -1) break
    const len = parseInt(body.subarray(i, space).toString(), 10)
    if (!len) break
    const record = body.subarray(space + 1, i + len - 1).toString('utf-8')
    const eq = record.indexOf('=')
    records[record.slice(0, eq)] = record.slice(eq + 1)
    i += len
  }
  return records
}
