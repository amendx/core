// Production SSR server for the built app. Serves dist/client/assets and
// server-renders every other request.
import http from 'node:http'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.NODE_ENV = 'production'

const root = path.dirname(fileURLToPath(import.meta.url))
const clientDir = path.join(root, 'dist/client')
const template = await fs.readFile(path.join(clientDir, 'index.html'), 'utf-8')
const manifest = JSON.parse(
  await fs.readFile(path.join(clientDir, '.vite/ssr-manifest.json'), 'utf-8'),
)
const { render } = await import('./dist/server/entry-server.js')

const contentTypes = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (url.pathname.startsWith('/assets/')) {
      const file = path.join(clientDir, path.normalize(url.pathname))
      if (!file.startsWith(path.join(clientDir, 'assets') + path.sep)) {
        res.writeHead(403).end()
        return
      }
      const body = await fs.readFile(file).catch(() => null)
      if (!body) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-type':
          contentTypes[path.extname(file)] ?? 'application/octet-stream',
      })
      res.end(body)
      return
    }

    const result = await render(url.pathname + url.search, manifest)
    // function replacers, so `$&` and friends in rendered output stay literal
    const html = template
      .replace('<!--preload-links-->', () => result.preloadLinks)
      .replace('<!--app-html-->', () => result.html)
      .replace('<!--teleports-->', () => result.teleports)
    res.writeHead(result.status, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
  } catch (e) {
    console.error(e)
    res.writeHead(500).end('Internal Server Error')
  }
})

server.listen(Number(process.env.PORT) || 0, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${server.address().port}`)
})
