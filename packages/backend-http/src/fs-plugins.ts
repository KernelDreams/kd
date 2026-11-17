/**
 * createFsPlugins — внешние плагины фронта с диска (v1.24, core-boundary-spec §3).
 *
 * Папка плагина — его репа: `package.json` (id — `nrchat.id`, иначе имя папки) и
 * сборка в `dist/`: `index.js` (ESM, `export default NRChatPlugin`), опц.
 * `index.css` и `service.mjs`. Раздаётся только `dist/`; исходники наружу не идут.
 * Пересборку видно по mtime `dist/index.js`/`index.css` — опрос раз в секунду, пока
 * кто-то подписан: vite пересоздаёт `dist/`, и `fs.watch` на папке теряется.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, extname, join, resolve, sep } from 'node:path'
import type { ExternalPluginInfo, PluginChangedListener, PluginFile, PluginsSource } from '@kerneldreams/ui-protocol'

export interface FsPlugin {
  id: string
  /** Папка плагина (корень репы). */
  dir: string
  /** `dir/dist`. */
  dist: string
  /** Плагин проекта (v1.26): id проекта — `ExternalPluginInfo.workspace`. Нет — стенда. */
  workspace?: string
  /** Откуда папка (v1.71): `user` — слой пользователя (`$plugins_user`, установка по ссылке). */
  origin?: 'stand' | 'user' | 'contour'
}

/** Папка плагина: путь (стенд) или путь с проектом (`$plugins` проекта) и происхождением. */
export type FsPluginDir = string | { dir: string; workspace?: string; origin?: 'stand' | 'user' | 'contour' }

export interface FsPluginsOpts {
  /** Предупреждения (папка без `dist/index.js` и т.п.); default — молча. */
  warn?: (message: string) => void
  /** Период опроса mtime, мс. Default 1000. */
  pollMs?: number
}

export interface FsPlugins extends PluginsSource {
  /** Плагины по id — стенду: `service.mjs` уходит в хост сервисов. */
  readonly plugins: readonly FsPlugin[]
  /** `id` → `dist/service.mjs` тех, у кого он есть. */
  services(): Record<string, string>
}

const MIME: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  // статика внутри плагина (Ledger из VibeOffice в iframe)
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
}

const ID = /^[a-z0-9][a-z0-9.-]*$/

/** Диапазон Plugin API папки (`package.json` → `nrchat.api`, plugin-registry-spec §5); нет — `undefined`. */
export function pluginApiOf(dir: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { nrchat?: { api?: unknown } }
    return typeof pkg.nrchat?.api === 'string' && pkg.nrchat.api.trim() ? pkg.nrchat.api.trim() : undefined
  } catch {
    return undefined
  }
}

/** Id плагина папки: `package.json` → `nrchat.id`, иначе имя папки. */
export function pluginIdOf(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { nrchat?: { id?: unknown } }
    if (typeof pkg.nrchat?.id === 'string' && pkg.nrchat.id) return pkg.nrchat.id
  } catch {
    // нет package.json — имя папки
  }
  return basename(resolve(dir))
}

function versionOf(dist: string): string | undefined {
  try {
    const js = statSync(join(dist, 'index.js')).mtimeMs
    const css = existsSync(join(dist, 'index.css')) ? statSync(join(dist, 'index.css')).mtimeMs : 0
    return Math.max(js, css).toString(36).replace('.', '')
  } catch {
    return undefined
  }
}

export function createFsPlugins(dirs: readonly FsPluginDir[], opts: FsPluginsOpts = {}): FsPlugins {
  const warn = opts.warn ?? (() => {})
  const pollMs = opts.pollMs ?? 1000
  const plugins: FsPlugin[] = []
  for (const item of dirs) {
    const raw = typeof item === 'string' ? item : item.dir
    const workspace = typeof item === 'string' ? undefined : item.workspace
    const origin = typeof item === 'string' ? undefined : item.origin
    const dir = resolve(raw)
    const id = pluginIdOf(dir)
    if (!ID.test(id)) {
      warn(`plugins: "${id}" (${dir}) — id только [a-z0-9.-], пропущен`)
      continue
    }
    if (plugins.some((p) => p.id === id)) {
      warn(`plugins: "${id}" дважды (${dir}) — взят первый`)
      continue
    }
    if (!existsSync(join(dir, 'dist', 'index.js'))) warn(`plugins: "${id}" — нет ${join(dir, 'dist', 'index.js')} (npm run build в папке плагина)`)
    plugins.push({ id, dir, dist: join(dir, 'dist'), ...(workspace ? { workspace } : {}), ...(origin ? { origin } : {}) })
  }
  const byId = new Map(plugins.map((p) => [p.id, p]))

  const listeners = new Set<PluginChangedListener>()
  const versions = new Map<string, string | undefined>()
  // Версия-кандидат: сборка пишет `dist/` не атомарно (vite чистит папку, потом
  // пишет js и css), поэтому событие уходит, только когда новая версия устоялась
  // на двух опросах подряд, а пустой `dist/` посреди сборки не событие вовсе.
  const pending = new Map<string, string>()
  const poll = (p: FsPlugin) => () => {
    const next = versionOf(p.dist)
    if (!next || next === versions.get(p.id)) {
      pending.delete(p.id)
      return
    }
    if (pending.get(p.id) !== next) {
      pending.set(p.id, next)
      return
    }
    pending.delete(p.id)
    versions.set(p.id, next)
    for (const listener of listeners) {
      try {
        listener({ type: 'plugin_changed', id: p.id, ...(next ? { version: next } : {}) })
      } catch {
        // упавший подписчик — его дело
      }
    }
  }
  const pollers = new Map<string, () => void>()
  const timers = new Map<string, ReturnType<typeof setInterval>>()

  return {
    plugins,
    services() {
      const out: Record<string, string> = {}
      for (const p of plugins) {
        const file = join(p.dist, 'service.mjs')
        if (existsSync(file)) out[p.id] = file
      }
      return out
    },
    list(): ExternalPluginInfo[] {
      const out: ExternalPluginInfo[] = []
      for (const p of plugins) {
        const version = versionOf(p.dist)
        // Не собран — не в списке: фронт не тянет 404, предупреждение уже было.
        if (!version) continue
        const q = `?v=${version}`
        out.push({
          id: p.id,
          url: `plugins/${p.id}/index.js${q}`,
          ...(existsSync(join(p.dist, 'index.css')) ? { css: `plugins/${p.id}/index.css${q}` } : {}),
          version,
          ...(existsSync(join(p.dist, 'service.mjs')) ? { service: true } : {}),
          ...(p.workspace ? { workspace: p.workspace } : {}),
          // Манифест читается на каждый список: `api` правится вместе со сборкой.
          ...(pluginApiOf(p.dir) ? { api: pluginApiOf(p.dir)! } : {}),
          ...(p.origin ? { origin: p.origin } : {}),
        })
      }
      return out
    },
    async file(id: string, path: string): Promise<PluginFile | null> {
      const p = byId.get(id)
      if (!p) return null
      const file = resolve(p.dist, path)
      // Только внутри dist/ и не сервис: Node-половина клиенту не нужна.
      if (!file.startsWith(p.dist + sep) || basename(file) === 'service.mjs') return null
      try {
        const data = await readFile(file)
        return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), mime: MIME[extname(file)] ?? 'application/octet-stream' }
      } catch {
        return null
      }
    },
    watch(listener: PluginChangedListener): () => void {
      if (listeners.size === 0) {
        for (const p of plugins) {
          versions.set(p.id, versionOf(p.dist))
          const fn = poll(p)
          pollers.set(p.id, fn)
          const timer = setInterval(fn, pollMs)
          timer.unref?.()
          timers.set(p.id, timer)
        }
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        for (const timer of timers.values()) clearInterval(timer)
        timers.clear()
        pollers.clear()
        pending.clear()
      }
    },
  }
}
