/**
 * Окно `kd ui` (kd-cli-spec §9): `serveBackend` бэкенда на свободном порту loopback и одна страница
 * с виджетом `<nr-chat>` и формой вопросов (ящик `inbox/`: вопрос агента и недостающие поля — поля
 * строятся схемой форм `@kerneldreams/forms`). Открывается браузером в режиме приложения; оболочки
 * (помощник, KD Pix) открывают тот же адрес у себя. Tauri в kd нет, артефактов в окне нет.
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createRequire } from 'node:module'
import type { ProtocolBackend } from '@kerneldreams/ui-protocol'
import { answerQuestion, listQuestions, registerFace } from './inbox.js'

export interface WindowHandle {
  /** Адрес страницы. */
  url: string
  /** Адрес API бэкенда. */
  api: string
  close(): Promise<void>
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)

function page(o: { api: string; auth: string; session?: string; title: string; cwd: string }): string {
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>${esc(o.title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{color-scheme:light dark;--bg:Canvas;--fg:CanvasText}
html,body{margin:0;height:100%;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--fg)}
.app{display:grid;grid-template-rows:auto 1fr auto;height:100%}
header{display:flex;gap:12px;align-items:center;padding:8px 14px;border-bottom:1px solid color-mix(in srgb,var(--fg) 14%,transparent)}
header b{font-weight:600}
header .cwd{opacity:.6;font-family:ui-monospace,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left;min-width:0;flex:1}
nr-chat{min-height:0;height:100%;border-radius:0;border-left:0;border-right:0}
#asks:empty{display:none}
#asks{border-top:1px solid color-mix(in srgb,var(--fg) 14%,transparent);padding:10px 14px;display:grid;gap:10px;max-height:40vh;overflow:auto}
.ask{display:grid;gap:6px}
.ask .q{font-weight:600}
.ask .row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.ask input{flex:1;min-width:200px;padding:6px 8px;border-radius:6px;border:1px solid color-mix(in srgb,var(--fg) 25%,transparent);background:transparent;color:inherit;font:inherit}
.ask button{padding:6px 10px;border-radius:6px;border:1px solid color-mix(in srgb,var(--fg) 25%,transparent);background:color-mix(in srgb,var(--fg) 6%,transparent);color:inherit;font:inherit;cursor:pointer}
.ask button.def{border-color:AccentColor}
.ask .meta{opacity:.6;font-size:12px}
</style></head>
<body><div class="app">
<header><b>kd</b><span>${esc(o.title)}</span><span class="cwd" title="${esc(o.cwd)}"><bdi>${esc(o.cwd)}</bdi></span></header>
<nr-chat backend="${esc(o.api)}" auth="${esc(o.auth)}"${o.session ? ` session="${esc(o.session)}"` : ''} lang="ru"></nr-chat>
<div id="asks"></div>
</div>
<script type="module" src="/nr-chat.js"></script>
<script type="module">
const box = document.getElementById('asks')
let shown = ''
async function poll() {
  try {
    const list = await (await fetch('/inbox')).json()
    const key = JSON.stringify(list.map((q) => q.id))
    if (key !== shown) {
      shown = key
      box.replaceChildren(...list.map(render))
    }
  } catch {}
  setTimeout(poll, 1000)
}
function render(q) {
  const el = document.createElement('form')
  el.className = 'ask'
  const left = Math.max(0, Math.round((Date.parse(q.deadline) - Date.now()) / 1000))
  el.innerHTML = '<div class="q"></div><div class="row"></div><div class="meta"></div>'
  el.querySelector('.q').textContent = q.question
  el.querySelector('.meta').textContent = (q.from ? q.from + ' · ' : '') + 'без ответа через ' + left + ' с возьмётся: ' + q.default
  const row = el.querySelector('.row')
  const send = async (answer) => {
    await fetch('/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: q.id, answer }) })
    el.remove()
  }
  for (const o of q.options) {
    const b = document.createElement('button')
    b.type = 'button'
    b.textContent = o
    if (o === q.default) b.className = 'def'
    b.onclick = () => send(o)
    row.append(b)
  }
  const input = document.createElement('input')
  input.placeholder = q.options.length ? 'или свой ответ' : 'ответ'
  row.append(input)
  el.onsubmit = (e) => { e.preventDefault(); send(input.value.trim() || q.default) }
  return el
}
poll()
</script>
</body></html>`
}

/** Поднять окно над бэкендом. */
export async function openWindow(backend: ProtocolBackend, o: { home: string; title: string; cwd: string; session?: string; open?: boolean }): Promise<WindowHandle> {
  const { serveBackend } = await import('@kerneldreams/backend-http')
  const auth = randomBytes(18).toString('base64url')
  const api = await serveBackend(backend, { port: 0, host: '127.0.0.1', basePath: '/api', cors: true, authKey: auth })
  const widget = readFileSync(createRequire(import.meta.url).resolve('@kerneldreams/chat-widget'), 'utf8')
  const html = page({ api: api.url, auth, title: o.title, cwd: o.cwd, ...(o.session ? { session: o.session } : {}) })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(html)
    } else if (url.pathname === '/nr-chat.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(widget)
    } else if (url.pathname === '/inbox' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(listQuestions(o.home)))
    } else if (url.pathname === '/inbox' && req.method === 'POST') {
      let body = ''
      req.on('data', (c: Buffer) => (body += c.toString('utf8')))
      req.on('end', () => {
        try {
          const { id, answer } = JSON.parse(body) as { id: string; answer: string }
          const ok = answerQuestion(o.home, String(id), String(answer ?? ''))
          res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok }))
        } catch {
          res.writeHead(400)
          res.end()
        }
      })
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const url = `http://127.0.0.1:${port}/`
  const unface = registerFace(o.home, 'ui')
  if (o.open !== false) openApp(url)
  return {
    url,
    api: api.url,
    async close() {
      unface()
      await new Promise<void>((r) => server.close(() => r()))
      await api.close()
    },
  }
}

/** Браузер в режиме приложения; нет графики — только адрес (его печатает вызывающий). */
export function openApp(url: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.KD_NO_OPEN === '1') return
  const tryRun = (cmd: string, args: string[]): void => {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true })
    p.on('error', () => {})
    p.unref()
  }
  if (process.platform === 'darwin') {
    tryRun('open', ['-na', 'Google Chrome', '--args', `--app=${url}`])
  } else if (process.platform === 'win32') {
    tryRun('cmd', ['/c', 'start', '', 'msedge', `--app=${url}`])
  } else if (env.DISPLAY || env.WAYLAND_DISPLAY) {
    for (const b of ['chromium', 'chromium-browser', 'google-chrome']) {
      const p = spawn(b, [`--app=${url}`], { stdio: 'ignore', detached: true })
      let failed = false
      p.on('error', () => (failed = true))
      p.unref()
      if (!failed) return
    }
    tryRun('xdg-open', [url])
  }
}
