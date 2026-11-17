/**
 * Кит UI для артефактов: `__kit/…` из папки встраивающего, `@kerneldreams/kit` в import map, скины стенда
 * (`__kit/skins.json`, `__kit/skins/<имя>.css`), прямая ссылка `open/?ref=` (переход на страницу сессии без темы,
 * через бэкенд — тем же ответом), шаблон `stand` компилируется с голым импортом кита.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArtifactHost } from '../src/host.js'
import type { ArtifactHost } from '../src/host.js'
import { compileJsx, initArtifact } from '../src/index.js'

let tmp: string
let host: ArtifactHost
let bare: ArtifactHost

const SKIN = `/* @skin
 * name: boxy
 * description: проба стенда
 * mode: both
 */
[data-skin="boxy"] { --nr-node-border-w: 2px; }
[data-skin="boxy"][data-mode="light"] { --nr-bg: #fff; --nr-surface: #eee; --nr-raised: #fff; --nr-fg: #111; --nr-muted: #555; --nr-line: #999; --nr-accent: #36c; --nr-ok: #393; --nr-error: #c33; }
[data-skin="boxy"][data-mode="dark"] { --nr-bg: #111; --nr-surface: #222; --nr-raised: #333; --nr-fg: #eee; --nr-muted: #aaa; --nr-line: #555; --nr-accent: #69f; --nr-ok: #6c6; --nr-error: #f66; }
`

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'artifacts-kit-'))
  const kitDir = join(tmp, 'kit')
  mkdirSync(kitDir)
  writeFileSync(join(kitDir, 'nr-kit.js'), 'export const kitVersion = "test"\n')
  writeFileSync(join(kitDir, 'nr-kit.css'), '.nr-node{}\n')
  writeFileSync(join(kitDir, 'version.txt'), '0.1.0+abc\n')
  mkdirSync(join(tmp, 'ws', 'skins'), { recursive: true })
  writeFileSync(join(tmp, 'ws', 'skins', 'boxy.skin.css'), SKIN)
  mkdirSync(join(tmp, 'ws', '.nr', 'artifacts', 'mock'), { recursive: true })
  writeFileSync(join(tmp, 'ws', '.nr', 'artifacts', 'mock', 'meta.mdz'), '$title: Mock\n$uses: $[]\n')
  writeFileSync(join(tmp, 'ws', '.nr', 'artifacts', 'mock', 'index.html'), '<!doctype html><html><head></head><body>m</body></html>')
  const base = { root: join(tmp, 'ws'), dataRoot: join(tmp, 'data'), configFile: join(tmp, 'none.md'), warn: () => {} }
  host = createArtifactHost({ ...base, kit: { dir: kitDir } })
  bare = createArtifactHost({ ...base, dataRoot: join(tmp, 'data2') })
})
afterEach(async () => {
  await host.close()
  await bare.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('кит для артефактов (ABC-816)', () => {
  it('файлы кита по __kit/, кит в import map страницы', async () => {
    const origin = await host.origin
    const js = await fetch(`${origin}/__kit/nr-kit.js`)
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toMatch(/javascript/)
    expect(await js.text()).toMatch(/kitVersion/)
    expect((await fetch(`${origin}/__kit/nr-kit.css`)).headers.get('content-type')).toMatch(/text\/css/)
    expect((await (await fetch(`${origin}/__kit/version.txt`)).text()).trim()).toBe('0.1.0+abc')
    expect((await fetch(`${origin}/__kit/../package.json`)).status).toBe(404)
    expect((await fetch(`${origin}/__kit/other.js`)).status).toBe(404)
    const o = await host.open('ws/mock')
    const html = await (await fetch(o.url)).text()
    expect(html).toMatch(/"@kerneldreams\/kit":"\.\.\/\.\.\/__kit\/nr-kit\.js"/)
  })

  it('без кита у встраивающего — 404 словами и без записи в import map', async () => {
    const r = await fetch(`${await bare.origin}/__kit/nr-kit.js`)
    expect(r.status).toBe(404)
    expect(await r.text()).toMatch(/кита нет/)
    const o = await bare.open('ws/mock')
    expect(await (await fetch(o.url)).text()).not.toMatch(/@kerneldreams\/kit/)
  })

  it('скины стенда: список и CSS скина', async () => {
    const origin = await host.origin
    const list = (await (await fetch(`${origin}/__kit/skins.json`)).json()) as Array<{ name: string; mode?: string; description?: string }>
    expect(list.find((s) => s.name === 'boxy')).toMatchObject({ mode: 'both', description: 'проба стенда' })
    const css = await (await fetch(`${origin}/__kit/skins/boxy.css`)).text()
    expect(css).toMatch(/\[data-skin="boxy"\]/)
    expect(css).toMatch(/--nr-node-border-w: 2px/)
    expect((await fetch(`${origin}/__kit/skins/nope.css`)).status).toBe(404)
  })

  it('прямая ссылка open/?ref= — переход на страницу сессии, параметры едут дальше; через бэкенд — тот же переход', async () => {
    const origin = await host.origin
    const r = await fetch(`${origin}/open/?ref=ws/mock&skin=boxy&mode=dark`, { redirect: 'manual' })
    expect(r.status).toBe(302)
    const loc = r.headers.get('location') ?? ''
    expect(loc).toMatch(/^\.\.\/a\/[0-9a-f]{20}\/\?skin=boxy&mode=dark$/)
    const page = await fetch(new URL(loc, `${origin}/open/`))
    expect(page.status).toBe(200)
    expect(await page.text()).toMatch(/__NR_ARTIFACT__/)
    const via = await host.http({ path: '/open/', query: '?ref=ws/mock' })
    expect(via.status).toBe(302)
    expect(via.headers.location).toMatch(/^\.\.\/a\/[0-9a-f]{20}\/$/)
    expect((await fetch(`${origin}/open/`, { redirect: 'manual' })).status).toBe(400)
    expect((await fetch(`${origin}/open/?ref=nope`, { redirect: 'manual' })).status).toBe(404)
  })

  it('шаблон stand: голый импорт @kerneldreams/kit компилируется (внешний), прочие голые — ошибка', async () => {
    const init = initArtifact({ configFile: join(tmp, 'none.md'), collection: join(tmp, 'coll'), name: 'Стенд', template: 'stand' })
    const code = await compileJsx(init.dir)
    expect(code).toMatch(/from\s*["']@kerneldreams\/kit["']/)
  })
})
