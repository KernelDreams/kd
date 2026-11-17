/**
 * Внешние плагины фронта (v1.24, core-boundary-spec §3): `createFsPlugins` над
 * папками, `serveBackend({plugins})` — capability, файлы бандла, SSE пересборок;
 * клиент делает адреса абсолютными и несёт ключ в `?auth=`.
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PluginChangedEvent } from '@kerneldreams/ui-protocol'
import { createFsPlugins } from '../src/fs-plugins.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'
import { createFakeBackend } from './fake-backend.js'

let srv: ServeHandle | undefined
const dirs: string[] = []
afterEach(async () => {
  await srv?.close()
  srv = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** Папка плагина: package.json + dist/ с бандлом. */
function pluginDir(name: string, files: Record<string, string>, pkg?: object): string {
  const root = mkdtempSync(join(tmpdir(), 'nr-plugins-'))
  dirs.push(root)
  const dir = join(root, name)
  mkdirSync(join(dir, 'dist'), { recursive: true })
  if (pkg) writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg))
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text)
  return dir
}

describe('createFsPlugins', () => {
  it('id — nrchat.id из package.json, иначе имя папки; без dist/index.js — не в списке, с предупреждением', () => {
    const a = pluginDir('nrchat-plugin-hello', { 'dist/index.js': 'export default {}', 'dist/service.mjs': 'export default {}' }, { nrchat: { id: 'hello' } })
    const b = pluginDir('bare', { 'dist/index.js': 'export default {}', 'dist/index.css': '.x{}' })
    const c = pluginDir('unbuilt', {})
    const warns: string[] = []
    const src = createFsPlugins([a, b, c], { warn: (m) => warns.push(m) })
    const list = src.list()
    expect(list.map((p) => p.id)).toEqual(['hello', 'bare'])
    expect(list[0]).toMatchObject({ url: expect.stringMatching(/^plugins\/hello\/index\.js\?v=/), service: true })
    expect(list[0]!.css).toBeUndefined()
    expect(list[1]).toMatchObject({ css: expect.stringMatching(/^plugins\/bare\/index\.css\?v=/) })
    expect(src.services()).toEqual({ hello: join(a, 'dist', 'service.mjs') })
    expect(warns.join('\n')).toMatch(/unbuilt.*npm run build/)
  })

  it('плагин проекта (ABC-287): {dir, workspace} — в списке с workspace; стенда — без', () => {
    const a = pluginDir('stand', { 'dist/index.js': 'export default {}' })
    const b = pluginDir('proj', { 'dist/index.js': 'export default {}' })
    const list = createFsPlugins([a, { dir: b, workspace: 'nrchat' }]).list()
    expect(list.map((p) => [p.id, p.workspace])).toEqual([['stand', undefined], ['proj', 'nrchat']])
  })

  it('ABC-840: api из nrchat.api и происхождение слоя пользователя; id издатель.имя', () => {
    const a = pluginDir('acme', { 'dist/index.js': 'export default {}' }, { nrchat: { id: 'acme.tool', api: '^2.0' } })
    const b = pluginDir('old', { 'dist/index.js': 'export default {}' })
    const list = createFsPlugins([{ dir: a, origin: 'user' }, b]).list()
    expect(list.map((p) => [p.id, p.api, p.origin])).toEqual([['acme.tool', '^2.0', 'user'], ['old', undefined, undefined]])
  })

  it('пустой dist/ посреди сборки — не событие; новая версия — одно событие, когда устоялась', async () => {
    const dir = pluginDir('hello', { 'dist/index.js': 'v1' })
    const src = createFsPlugins([dir], { pollMs: 15 })
    const events: string[] = []
    const stop = src.watch((e) => events.push(e.version ?? '—'))
    try {
      rmSync(join(dir, 'dist', 'index.js'))
      await new Promise((r) => setTimeout(r, 100))
      expect(events).toEqual([])
      writeFileSync(join(dir, 'dist', 'index.js'), 'v2')
      const later = new Date(Date.now() + 7000)
      utimesSync(join(dir, 'dist', 'index.js'), later, later)
      await new Promise((r) => setTimeout(r, 150))
      expect(events).toHaveLength(1)
    } finally {
      stop()
    }
  })

  it('файлы — только из dist/, без service.mjs и выхода наружу', async () => {
    const dir = pluginDir('hello', { 'dist/index.js': 'export default 1', 'dist/service.mjs': 'secret', 'package.json': '{}' })
    const src = createFsPlugins([dir])
    expect(new TextDecoder().decode((await src.file('hello', 'index.js'))!.data)).toBe('export default 1')
    expect((await src.file('hello', 'index.js'))!.mime).toMatch(/^text\/javascript/)
    expect(await src.file('hello', 'service.mjs')).toBeNull()
    expect(await src.file('hello', '../package.json')).toBeNull()
    expect(await src.file('nope', 'index.js')).toBeNull()
  })
})

describe('serveBackend({plugins})', () => {
  it('capability plugins, файл бандла с CORS и no-cache, 404 на чужое; клиент — абсолютные адреса с ключом', async () => {
    const dir = pluginDir('hello', { 'dist/index.js': 'export default {id:"x"}' })
    srv = await serveBackend(createFakeBackend(), { cors: true, authKey: 'k1', plugins: createFsPlugins([dir]) })
    const client = createHttpBackend(srv.url, { auth: 'k1' })
    const caps = await client.capabilities()
    expect(caps.plugins).toHaveLength(1)
    const url = new URL(caps.plugins![0]!.url)
    expect(url.href.startsWith(`${srv.url}/plugins/hello/index.js?v=`)).toBe(true)
    expect(url.searchParams.get('auth')).toBe('k1')

    // `import()` заголовка не ставит — ключ едет в query.
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/)
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(await res.text()).toBe('export default {id:"x"}')
    expect((await fetch(`${srv.url}/plugins/hello/index.js`)).status).toBe(401)
    expect((await fetch(`${srv.url}/plugins/hello/nope.js?auth=k1`)).status).toBe(404)
  })

  it('без источника — capability нет, /plugins — 404', async () => {
    srv = await serveBackend(createFakeBackend())
    expect((await createHttpBackend(srv.url).capabilities()).plugins).toBeUndefined()
    expect((await fetch(`${srv.url}/plugins/hello/index.js`)).status).toBe(404)
  })

  it('пересборка → plugin_changed по /plugins/events (backend.plugins.watch)', async () => {
    const dir = pluginDir('hello', { 'dist/index.js': 'v1' })
    srv = await serveBackend(createFakeBackend(), { plugins: createFsPlugins([dir], { pollMs: 20 }) })
    const client = createHttpBackend(srv.url)
    const events: PluginChangedEvent[] = []
    const stop = client.plugins!.watch((e) => events.push(e))
    try {
      await new Promise((r) => setTimeout(r, 150))
      writeFileSync(join(dir, 'dist', 'index.js'), 'v2')
      const later = new Date(Date.now() + 5000)
      utimesSync(join(dir, 'dist', 'index.js'), later, later)
      for (let i = 0; i < 100 && events.length === 0; i++) await new Promise((r) => setTimeout(r, 20))
      expect(events[0]).toMatchObject({ type: 'plugin_changed', id: 'hello', version: expect.any(String) })
    } finally {
      stop()
    }
  })
})
