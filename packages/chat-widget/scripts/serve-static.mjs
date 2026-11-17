// Статика пакета для демо и e2e: `node scripts/serve-static.mjs [порт]` (default 7820).
// Корень — каталог пакета: /demo/index.html, /dist/nr-chat.js.
// Демо `local`: /local-backend/* — сборка бэкенда страницы из NR_CHAT_LOCAL_BACKEND_DIST (её виджет не везёт;
// нет — 404). skillbox страница зовёт напрямую — у него CORS.
import { createReadStream, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const localBackend = process.env.NR_CHAT_LOCAL_BACKEND_DIST ?? ''
const port = Number(process.argv[2] ?? process.env.PORT ?? 7820)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json', '.css': 'text/css', '.json': 'application/json' }

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = decodeURIComponent(url.pathname)
  const isLocal = path.startsWith('/local-backend/')
  if (isLocal && !localBackend) return void res.writeHead(404).end('NR_CHAT_LOCAL_BACKEND_DIST не задан — бэкенда страницы нет')
  const base = isLocal ? localBackend : root
  const rel = isLocal ? path.slice('/local-backend/'.length) : path === '/' ? 'demo/index.html' : path
  const file = normalize(join(base, rel))
  if (!file.startsWith(normalize(base))) return void res.writeHead(403).end()
  try {
    if (!statSync(file).isFile()) throw new Error('dir')
  } catch {
    return void res.writeHead(404).end('not found')
  }
  res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
}).listen(port, '127.0.0.1', () => console.log(`nr-chat demo: http://127.0.0.1:${port}/demo/index.html · local: /demo/local.html`))
