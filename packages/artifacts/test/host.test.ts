import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createArtifactHost, fileUrlPath } from '../src/host.js'
import type { ArtifactHost, HostEvent } from '../src/host.js'
import { awaitRuntimeCheck, checkRuntime, finalizeArtifact, newCheckId, readRuntimeErrors, requestOpen } from '../src/index.js'

let tmp: string
let host: ArtifactHost

function artifact(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'artifacts-host-'))
  // Фальшивый runz: печатает ScriptResult с аргументами.
  const fake = join(tmp, 'fake-runz.mjs')
  writeFileSync(fake, `const args = process.argv.slice(2); console.log(JSON.stringify({ output: args.join(' '), exitCode: 0, outputs: [{ type: 'file', path: '${tmp}/out.png' }] }))\n`)
  writeFileSync(join(tmp, 'out.png'), 'png')
  host = createArtifactHost({
    root: join(tmp, 'ws'),
    dataRoot: join(tmp, 'data'),
    configFile: join(tmp, 'none.md'),
    runz: [process.execPath, fake],
    dialog: async () => join(tmp, 'picked.txt'),
    warn: () => {},
  })
  mkdirSync(join(tmp, 'ws'), { recursive: true })
})
afterEach(async () => {
  await host.close()
  rmSync(tmp, { recursive: true, force: true })
})

describe('host: файл окна ($handles, open-spec §7)', () => {
  it('list отдаёт $handles; open с file → getContext.file/kinds, грант {user-selected} на чтение и запись', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'comfy'), {
      'meta.mdz': '$title: Comfy\n$uses: $[file]\n$handles: comfy-image, ext:json\n',
      'index.html': '<!doctype html><html><body>c</body></html>',
    })
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'plain'), { 'meta.mdz': '$title: P\n$uses: $[]\n', 'index.html': 'p' })
    const items = host.list(join(tmp, 'ws'))
    expect(items.find((a) => a.id === 'ws/comfy')?.handles).toEqual(['comfy-image', 'ext:json'])
    expect(items.find((a) => a.id === 'ws/plain')?.handles).toEqual([])

    const pics = join(tmp, 'pics')
    mkdirSync(pics, { recursive: true })
    writeFileSync(join(pics, 'a.png'), 'A')
    writeFileSync(join(pics, 'b.png'), 'B')
    const o = await host.open('ws/comfy', { file: join(pics, 'a.png'), kinds: ['comfy-image', 'image', '*'], instance: 'w1' })
    const ctx = await host.bridge(o.key, 'getContext', [])
    expect(ctx).toMatchObject({ ok: true, value: { file: join(pics, 'a.png'), kinds: ['comfy-image', 'image', '*'] } })
    // Файл окна — вне рабочей области, но выбран пользователем: чтение и запись.
    expect(await host.bridge(o.key, 'readFile', [join(pics, 'a.png')])).toEqual({ ok: true, value: 'A' })
    expect((await host.bridge(o.key, 'writeFile', [join(pics, 'a.png'), 'A2'])).ok).toBe(true)
    expect(readFileSync(join(pics, 'a.png'), 'utf8')).toBe('A2')
    // Соседний файл не выбран — нельзя.
    expect((await host.bridge(o.key, 'readFile', [join(pics, 'b.png')])).ok).toBe(false)

    // Смена файла окна: новый файл в контексте и в гранте.
    expect(host.setFile(o.key, join(pics, 'b.png'), ['image', '*'])).toMatchObject({ ok: true })
    expect(await host.bridge(o.key, 'getContext', [])).toMatchObject({ ok: true, value: { file: join(pics, 'b.png'), kinds: ['image', '*'] } })
    expect(await host.bridge(o.key, 'readFile', [join(pics, 'b.png')])).toEqual({ ok: true, value: 'B' })
    expect(host.setFile('nope', null).ok).toBe(false)
  })

  it('instance — свой ключ на окно: два окна одного артефакта не делят файл', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'comfy'), {
      'meta.mdz': '$title: Comfy\n$uses: $[file]\n$handles: image\n',
      'index.html': 'c',
    })
    const a = await host.open('ws/comfy', { file: join(tmp, 'a.png'), kinds: ['image'], instance: 'w1' })
    const b = await host.open('ws/comfy', { file: join(tmp, 'b.png'), kinds: ['image'], instance: 'w2' })
    const plain = await host.open('ws/comfy')
    expect(new Set([a.key, b.key, plain.key]).size).toBe(3)
    expect(await host.bridge(a.key, 'getContext', [])).toMatchObject({ value: { file: join(tmp, 'a.png') } })
    expect(await host.bridge(b.key, 'getContext', [])).toMatchObject({ value: { file: join(tmp, 'b.png') } })
    expect(await host.bridge(plain.key, 'getContext', [])).toMatchObject({ value: { file: null, kinds: [] } })
  })
})

describe('host: папка файла окна ($file-dir) и fileUrl с именем (ABC-193)', () => {
  it('$file-dir: соседи и подпапки — чтение/запись/список, `..` за папку — отказ; dir в getContext', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'ed'), {
      'meta.mdz': '$title: Ed\n$uses: $[file, watch]\n$fs-read: {artifact}, $file-dir\n$fs-write: {artifact}, $file-dir\n$handles: ext:svg\n',
      'index.html': 'e',
    })
    const scenes = join(tmp, 'scenes')
    mkdirSync(join(scenes, 'art'), { recursive: true })
    writeFileSync(join(scenes, 'game.svg'), '<svg/>')
    writeFileSync(join(scenes, 'game.gml.svg'), '<svg gml/>')
    writeFileSync(join(scenes, 'art', 'btn.png'), 'PNG')
    writeFileSync(join(tmp, 'secret.txt'), 's')
    const o = await host.open('ws/ed', { file: join(scenes, 'game.svg'), kinds: ['ext:svg'], instance: 'w1' })
    expect(await host.bridge(o.key, 'getContext', [])).toMatchObject({ ok: true, value: { file: join(scenes, 'game.svg'), dir: scenes, kinds: ['ext:svg'] } })
    expect(await host.bridge(o.key, 'readFile', [join(scenes, 'game.gml.svg')])).toEqual({ ok: true, value: '<svg gml/>' })
    expect(await host.bridge(o.key, 'readFile', [join(scenes, 'art', 'btn.png')])).toEqual({ ok: true, value: 'PNG' })
    const list = (await host.bridge(o.key, 'listDir', [scenes])) as { ok: true; value: { name: string }[] }
    expect(list.value.map((e) => e.name).sort()).toEqual(['art', 'game.gml.svg', 'game.svg'])
    expect((await host.bridge(o.key, 'writeFile', [join(scenes, 'other.svg'), '<svg o/>'])).ok).toBe(true)
    expect(readFileSync(join(scenes, 'other.svg'), 'utf8')).toBe('<svg o/>')
    // `..` за папку файла — отказ (и чтение, и запись)
    const up = await host.bridge(o.key, 'readFile', [`${scenes}/../secret.txt`])
    expect(up).toMatchObject({ ok: false, error: expect.stringMatching(/path not allowed by \$fs-read/) })
    expect((await host.bridge(o.key, 'writeFile', [`${scenes}/art/../../secret.txt`, 'x'])).ok).toBe(false)
    // смена файла окна — скоуп едет за папкой
    const other = join(tmp, 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'b.svg'), 'B')
    writeFileSync(join(other, 'n.txt'), 'N')
    expect(host.setFile(o.key, join(other, 'b.svg'), ['ext:svg'])).toMatchObject({ ok: true, value: { dir: other } })
    expect(await host.bridge(o.key, 'readFile', [join(other, 'n.txt')])).toEqual({ ok: true, value: 'N' })
    expect((await host.bridge(o.key, 'readFile', [join(scenes, 'game.gml.svg')])).ok).toBe(false)
  })

  it('$file-dir без файла (док) — скоупа нет: capability not declared; {file-dir} — синоним', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'ed'), {
      'meta.mdz': '$title: Ed\n$uses: $[file]\n$fs-read: {artifact}, {file-dir}\n',
      'index.html': 'e',
    })
    writeFileSync(join(tmp, 'a.svg'), 'A')
    writeFileSync(join(tmp, 'n.txt'), 'N')
    const dock = await host.open('ws/ed')
    expect(await host.bridge(dock.key, 'getContext', [])).toMatchObject({ value: { file: null, dir: null } })
    expect(await host.bridge(dock.key, 'readFile', [join(tmp, 'n.txt')])).toMatchObject({ ok: false, error: expect.stringMatching(/^capability not declared: \$file-dir/) })
    const tab = await host.open('ws/ed', { file: join(tmp, 'a.svg'), kinds: ['ext:svg'], instance: 'w1' })
    expect(await host.bridge(tab.key, 'readFile', [join(tmp, 'n.txt')])).toEqual({ ok: true, value: 'N' })
  })

  it('fileUrl оканчивается именем файла; токен папки в пути; относительные — в той же папке; ?p= работает', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'ed'), {
      'meta.mdz': '$title: Ed\n$uses: $[file]\n$fs-read: {artifact}, $file-dir\n',
      'index.html': 'e',
    })
    const scenes = join(tmp, 'сцены')
    mkdirSync(join(scenes, 'art'), { recursive: true })
    writeFileSync(join(scenes, 'game.svg'), '<svg/>')
    writeFileSync(join(scenes, 'btn-green-wide.png'), 'PNG')
    writeFileSync(join(scenes, 'art', 'b c.png'), 'BC')
    writeFileSync(join(tmp, 'secret.txt'), 's')
    const o = await host.open('ws/ed', { file: join(scenes, 'game.svg'), kinds: ['ext:svg'], instance: 'w1' })
    const r = (await host.bridge(o.key, 'fileUrl', [join(scenes, 'btn-green-wide.png')])) as { ok: true; value: string }
    expect(r.value.startsWith(`${await host.origin}/f/${o.key}/`)).toBe(true)
    expect(r.value.endsWith('/btn-green-wide.png')).toBe(true)
    expect(r.value).not.toMatch(/\?/)
    expect(await (await fetch(r.value)).text()).toBe('PNG')
    expect((await fetch(r.value)).headers.get('content-type')).toBe('image/png')
    // относительная ссылка от URL файла — соседняя папка той же сцены
    expect(await (await fetch(new URL('art/b%20c.png', r.value))).text()).toBe('BC')
    // за папку — 403
    const outside = fileUrlPath(o.key, join(tmp, 'secret.txt'))
    expect((await fetch(`${await host.origin}${outside}`)).status).toBe(403)
    // путь хоста = путь prelude; через бэкенд (http) — тот же маршрут
    expect(fileUrlPath(o.key, join(scenes, 'btn-green-wide.png'))).toBe(r.value.slice((await host.origin).length))
    // бэкенд отдаёт сегменты декодированными (backend-http serve)
    const via = await host.http({ path: decodeURIComponent(fileUrlPath(o.key, join(scenes, 'art', 'b c.png'))) })
    expect(via.status).toBe(200)
    expect(via.body).toEqual({ __b64: Buffer.from('BC').toString('base64') })
    // старая форма ?p= (и обход артефактов с именем перед ?p=) — до мажора
    expect(await (await fetch(`${await host.origin}/f/${o.key}?p=${encodeURIComponent(join(scenes, 'game.svg'))}`)).text()).toBe('<svg/>')
    expect(await (await fetch(`${await host.origin}/f/${o.key}/game.svg?p=${encodeURIComponent(join(scenes, 'game.svg'))}`)).text()).toBe('<svg/>')
  })

  it('prelude строит тот же путь, что fileUrlPath', () => {
    const src = readFileSync(join(__dirname, '..', 'assets', 'prelude.js'), 'utf8')
    const body = /fileUrl: function \(path\) \{([\s\S]*?)\n    \},/.exec(src)![1]!
    const fn = new Function('cfg', 'path', body) as (cfg: { origin: string; key: string }, path: string) => string
    for (const p of ['/Users/x/сцены/btn-green-wide.png', 'rel.png', './a/b.png', '/root.png', '~/p q/x.png']) {
      expect(fn({ origin: 'http://h', key: 'k' }, p)).toBe(`http://h${fileUrlPath('k', p)}`)
    }
  })
})

describe('host', () => {
  it('соседние .html папки — с темой и мостом, как index.html; вложенные — адреса глубже (ABC-666)', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'pages'), {
      'meta.mdz': '$title: P\n',
      'index.html': '<!doctype html><html><head></head><body>i</body></html>',
      'second.html': '<!doctype html><html><head><title>2</title></head><body>2</body></html>',
    })
    mkdirSync(join(tmp, 'ws', '.nr', 'artifacts', 'pages', 'sub'))
    writeFileSync(join(tmp, 'ws', '.nr', 'artifacts', 'pages', 'sub', 'third.html'), '<html><head></head><body>3</body></html>')
    const o = await host.open('ws/pages', { theme: { vars: { '--nr-bg': '#abcdef' }, mode: 'dark' } })
    const second = await (await fetch(`${o.url}second.html`)).text()
    expect(second).toMatch(/--nr-bg: #abcdef;/)
    expect(second).toMatch(/__NR_ARTIFACT__/)
    expect(second).toMatch(/src="\.\.\/\.\.\/__prelude\.js"/)
    expect(second).toMatch(/<title>2<\/title>/)
    const third = await (await fetch(`${o.url}sub/third.html`)).text()
    expect(third).toMatch(/--nr-bg: #abcdef;/)
    expect(third).toMatch(/src="\.\.\/\.\.\/\.\.\/__prelude\.js"/)
  })

  it('страница html-входа: prelude, import map, тема; относительные ассеты', async () => {
    const dir = artifact(join(tmp, 'ws', '.nr', 'artifacts', 'a'), {
      'meta.mdz': '$title: A\n$uses: $[file]\n',
      'index.html': '<!doctype html><html><head><title>A</title></head><body><script type="module" src="./app.js"></script></body></html>',
      'app.js': 'console.log(1)',
    })
    const o = await host.open('ws/a', { theme: { vars: { '--nr-bg': '#123456' }, mode: 'dark' } })
    expect(o.dir).toBe(dir)
    const html = await (await fetch(o.url)).text()
    expect(html).toMatch(/__NR_ARTIFACT__/)
    // адреса относительные: та же страница живёт и за бэкендом
    expect(html).toMatch(/src="\.\.\/\.\.\/__prelude\.js"/)
    expect(html).toMatch(/"react":"\.\.\/\.\.\/__vendor\/react\.js"/)
    expect(html).not.toMatch(/127\.0\.0\.1/)
    expect(o.path).toBe(`/a/${o.key}/`)
    expect(html).toMatch(/--nr-bg: #123456;/)
    expect(await (await fetch(`${o.url}app.js`)).text()).toBe('console.log(1)')
    expect((await fetch(`${o.url}../../f/nope`)).status).toBe(404)
    expect((await fetch((await host.origin) + '/__vendor/react.js')).status).toBe(200)
    expect((await fetch((await host.origin) + '/__prelude.js')).status).toBe(200)
  })

  it('роли кита — слоем nr-kit в странице, не в конфиге моста; `<` вырезан (ABC-806)', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'k'), {
      'meta.mdz': '$title: K\n$uses: $[]\n$places: panel\n$handles: image\n',
      'index.html': '<!doctype html><html><head></head><body>k</body></html>',
    })
    const kit = '.nr-toolbtn { color: var(--nr-muted); }</style><script>x</script>'
    const o = await host.open('ws/k', { theme: { vars: { '--nr-bg': '#000' }, mode: 'dark', kit } })
    const html = await (await fetch(o.url)).text()
    expect(html).toMatch(/<style id="nr-kit">@layer nr-kit \{\n\.nr-toolbtn \{ color: var\(--nr-muted\); \}/)
    expect(html).not.toMatch(/<\/style><script>x/)
    const cfg = /window\.__NR_ARTIFACT__ = (\{.*?\})<\/script>/.exec(html)?.[1] ?? ''
    expect(cfg).not.toMatch(/nr-toolbtn/)
    expect(host.list().find((a) => a.folder === 'k')?.places).toEqual(['panel'])
  })

  it('тема несёт базовый текст и веб-шрифты хоста (ABC-144); не-https шрифт не попадает', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 't'), {
      'meta.mdz': '$title: T\n$uses: $[]\n',
      'index.html': '<!doctype html><html><head></head><body>t</body></html>',
    })
    const fonts = ['https://fonts.googleapis.com/css2?family=Spline+Sans&display=swap', 'javascript:alert(1)']
    const o = await host.open('ws/t', {
      theme: { vars: { '--nr-root-size': '17.6px', '--nr-text-body': '0.875rem' }, mode: 'light', fonts },
    })
    const html = await (await fetch(o.url)).text()
    expect(html).toMatch(/--nr-root-size: 17\.6px;/)
    expect(html).toContain(':where(:root) { font-size: var(--nr-root-size, 100%); }')
    expect(html).toContain(':where(body) { font-family: var(--nr-font-body')
    expect(html).toContain('<link rel="stylesheet" data-nr-font href="https://fonts.googleapis.com/css2?family=Spline+Sans&amp;display=swap">')
    expect(html).not.toMatch(/href="javascript:/)
  })

  it('jsx-вход компилируется в __entry.js с вендорным react', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'j'), {
      'meta.mdz': '$title: J\n$uses: $[]\n',
      'index.jsx': "import { useState } from 'react'\nimport { B } from './B.jsx'\nexport const App = () => <B n={useState(1)[0]} />\n",
      'B.jsx': 'export const B = ({ n }) => <b>{n}</b>\n',
    })
    const o = await host.open('ws/j')
    const code = await (await fetch(`${o.url}__entry.js`)).text()
    expect(code).toMatch(/from "react"/)
    expect(code).toMatch(/react\/jsx-runtime/)
  })

  it('мост: единая проверка прав, скоупы, fileUrl, storage, диалог', async () => {
    const dir = artifact(join(tmp, 'ws', '.nr', 'artifacts', 'f'), {
      'meta.mdz': '$title: F\n$uses: $[file, dialog]\n$fs-write: {artifact}\n',
      'index.html': '<html></html>',
      'note.txt': 'hello',
    })
    const o = await host.open('ws/f')
    expect(await host.bridge(o.key, 'readFile', ['./note.txt'])).toEqual({ ok: true, value: 'hello' })
    expect(await host.bridge(o.key, 'run', ['comfy', {}])).toEqual({ ok: false, error: 'capability not declared: run' })
    expect((await host.bridge(o.key, 'readFile', ['/etc/hosts'])).ok).toBe(false)
    expect((await host.bridge(o.key, 'writeFile', [join(tmp, 'ws', 'x.txt'), 'x'])).ok).toBe(false)
    expect(await host.bridge(o.key, 'writeFile', ['./data/out.txt', { __b64: Buffer.from('bin').toString('base64') }])).toEqual({ ok: true, value: null })
    expect(readFileSync(join(dir, 'data', 'out.txt'), 'utf8')).toBe('bin')
    // fileUrl: проверка $fs-read на запросе
    const ok = await fetch(`${await host.origin}/f/${o.key}?p=${encodeURIComponent(join(dir, 'note.txt'))}`)
    expect(await ok.text()).toBe('hello')
    expect((await fetch(`${await host.origin}/f/${o.key}?p=${encodeURIComponent('/etc/hosts')}`)).status).toBe(403)
    // диалог добавляет {user-selected}
    writeFileSync(join(tmp, 'picked.txt'), 'picked')
    expect((await host.bridge(o.key, 'readFile', [join(tmp, 'picked.txt')])).ok).toBe(false)
    expect(await host.bridge(o.key, 'openDialog', [null])).toEqual({ ok: true, value: join(tmp, 'picked.txt') })
    expect(await host.bridge(o.key, 'readFile', [join(tmp, 'picked.txt')])).toEqual({ ok: true, value: 'picked' })
    // storage без права
    await host.bridge(o.key, 'storage.set', ['k', { a: 1 }])
    expect(await host.bridge(o.key, 'storage.get', ['k'])).toEqual({ ok: true, value: { a: 1 } })
    const ctx = (await host.bridge(o.key, 'getContext', [])) as { ok: true; value: Record<string, unknown> }
    expect(ctx.value).toMatchObject({ artifactId: 'ws/f', extName: 'f', workspace: join(tmp, 'ws') })
    expect(await host.bridge(o.key, 'clipboardRead', [])).toEqual({ ok: false, error: 'capability not declared: clipboard' })
  })

  it('viewer.open: право viewer, список нормализован, открывает оболочка (ABC-155)', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'v'), { 'meta.mdz': '$title: V\n$uses: $[viewer]\n', 'index.html': '<html></html>' })
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'nov'), { 'meta.mdz': '$title: N\n$uses: $[file]\n', 'index.html': '<html></html>' })
    const o = await host.open('ws/v')
    const imgs = ['http://127.0.0.1:1/c/k/view?filename=a.png', { url: 'data:image/png;base64,AA==', name: ' b.png ' }]
    expect(await host.bridge(o.key, 'viewer.open', [imgs, 5])).toEqual({
      ok: true,
      delegate: 'viewer.open',
      value: { images: [{ url: imgs[0] }, { url: 'data:image/png;base64,AA==', name: 'b.png' }], index: 1 },
    })
    expect(await host.bridge(o.key, 'viewer.open', [['javascript:alert(1)']])).toMatchObject({ ok: false, error: expect.stringMatching(/viewer\.open/) })
    expect(await host.bridge(o.key, 'viewer.open', [[]])).toMatchObject({ ok: false, error: expect.stringMatching(/нет картинок/) })
    const n = await host.open('ws/nov')
    expect(await host.bridge(n.key, 'viewer.open', [imgs])).toEqual({ ok: false, error: 'capability not declared: viewer' })
  })

  it('app.*: право app (ABC-380); run — стримом с событиями, log/pin — вызовом через обработчик встраивающего', async () => {
    const calls: unknown[] = []
    const withApp = createArtifactHost({
      root: join(tmp, 'ws'),
      dataRoot: join(tmp, 'data-app'),
      configFile: join(tmp, 'none.md'),
      warn: () => {},
      app: {
        async run(dir, values, _signal, onEvent) {
          calls.push(['run', dir, values])
          onEvent({ name: 'started', payload: { runId: 'r1' } })
          return { ok: true, value: { runId: 'r1', status: 'ok', outputs: [] } }
        },
        async log(dir, day) {
          calls.push(['log', dir, day])
          return { day: day ?? 'today', days: [], runs: [] }
        },
        async pin(_dir, runId, on) {
          calls.push(['pin', runId, on])
          return { runId, on }
        },
      },
    })
    try {
      artifact(join(tmp, 'ws', '.nr', 'artifacts', 'ap'), { 'meta.mdz': '$title: A\n$uses: $[app]\n', 'index.html': '<html></html>' })
      artifact(join(tmp, 'ws', '.nr', 'artifacts', 'noap'), { 'meta.mdz': '$title: N\n$uses: $[file]\n', 'index.html': '<html></html>' })
      const o = await withApp.open('ws/ap')
      expect(await withApp.bridge(o.key, 'app.log', ['2026-10-19'])).toEqual({ ok: true, value: { day: '2026-10-19', days: [], runs: [] } })
      expect(await withApp.bridge(o.key, 'app.pin', ['r1', true])).toEqual({ ok: true, value: { runId: 'r1', on: true } })
      expect(await withApp.bridge(o.key, 'app.pin', ['r1', false])).toEqual({ ok: true, value: { runId: 'r1', on: false } })
      expect(await withApp.bridge(o.key, 'app.pin', [''])).toMatchObject({ ok: false, error: expect.stringMatching(/нет id/) })
      expect(await withApp.bridge(o.key, 'app.run', [{}])).toMatchObject({ ok: false, error: expect.stringMatching(/стримом/) })
      const events: unknown[] = []
      const r = await withApp.appRun(o.key, { q: 1 }, new AbortController().signal, (e) => events.push(e))
      expect(r).toEqual({ ok: true, value: { runId: 'r1', status: 'ok', outputs: [] } })
      expect(events).toEqual([{ name: 'started', payload: { runId: 'r1' } }])
      expect(calls[0]).toEqual(['log', o.dir, '2026-10-19'])
      const n = await withApp.open('ws/noap')
      expect(await withApp.bridge(n.key, 'app.log', [])).toEqual({ ok: false, error: 'capability not declared: app' })
      expect(await withApp.appRun(n.key, {}, new AbortController().signal, () => {})).toEqual({ ok: false, error: 'capability not declared: app' })
      // без обработчика (хост без приложений) — понятная ошибка
      const o2 = await host.open('ws/ap')
      expect(await host.bridge(o2.key, 'app.log', [])).toMatchObject({ ok: false, error: expect.stringMatching(/приложений нет/) })
    } finally {
      await withApp.close()
    }
  })

  it('run: appz по имени и шаблон; $run-allow; результаты читаются', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'r'), {
      'meta.mdz': '$title: R\n$uses: $[run, file]\n$run-allow: hello, ./t.md\n',
      'index.html': '<html></html>',
      't.md': '$title: t\n$prompt: x\n',
    })
    const o = await host.open('ws/r')
    const ac = new AbortController()
    const r = (await host.run(o.key, 'hello', { name: 'exz', flag: true }, ac.signal)) as { ok: true; value: { output: string; outputs: unknown[] } }
    expect(r.ok).toBe(true)
    expect(r.value.output).toBe('hello --name=exz --flag --runz-json')
    expect((await host.run(o.key, 'vision', {}, ac.signal)).ok).toBe(false)
    const t = (await host.run(o.key, './t.md', { prompt: 'y' }, ac.signal)) as { ok: true; value: { output: string } }
    expect(t.ok).toBe(true)
    expect(t.value.output).toMatch(/\.t\.run-[0-9a-f]+\.md --runz-json$/)
    // файл-результат run читается гостем
    expect((await host.bridge(o.key, 'readFile', [join(tmp, 'out.png')])).ok).toBe(true)
  })

  it('job: задача по шаблону — $uses job, $run-allow, входы, лог attach до конца, результат читается (ABC-245)', async () => {
    const saved = { dir: process.env.RUNZ_JOBS_DIR, cfg: process.env.NR_RUNZ_CONFIG }
    process.env.RUNZ_JOBS_DIR = join(tmp, 'jobs')
    process.env.NR_RUNZ_CONFIG = join(tmp, 'none.md')
    try {
      artifact(join(tmp, 'ws', '.nr', 'artifacts', 'j'), {
        'meta.mdz': '$title: J\n$uses: $[job, file]\n$run-allow: ./t.md\n',
        'index.html': '<html></html>',
        't.md': '$title: t\n$prompt: x\n',
      })
      artifact(join(tmp, 'ws', '.nr', 'artifacts', 'nojob'), { 'meta.mdz': '$title: N\n$uses: $[run]\n', 'index.html': 'n' })
      const o = await host.open('ws/j')
      const r = (await host.bridge(o.key, 'job.start', ['./t.md', { prompt: 'y' }, { files: [{ name: 'notes.md', text: 'long' }] }])) as { ok: true; value: { id: string; status: string } }
      expect(r).toMatchObject({ ok: true, value: { status: 'running' } })
      expect(readFileSync(join(tmp, 'jobs', r.value.id, 'inputs', 'notes.md'), 'utf8')).toBe('long')
      expect((await host.bridge(o.key, 'job.start', ['vision', {}])).ok).toBe(false)
      const no = await host.open('ws/nojob')
      expect(await host.bridge(no.key, 'job.start', ['./t.md', {}])).toMatchObject({ ok: false, error: expect.stringContaining('capability not declared: job') })

      const frames: Array<{ kind: string; output?: string }> = []
      const ac = new AbortController()
      expect(await host.jobAttach(o.key, r.value.id, 0, ac.signal, (f) => frames.push(f as never))).toEqual({ ok: true, value: null })
      expect(frames.at(-1)).toMatchObject({ kind: 'end', status: 'done' })
      expect(frames.at(-1)!.output).toMatch(new RegExp(`\\.t\\.job-${r.value.id}\\.md --runz-json$`))
      const list = (await host.bridge(o.key, 'job.list', [{ target: './t.md' }])) as { ok: true; value: Array<{ id: string }> }
      expect(list.value.map((j) => j.id)).toEqual([r.value.id])
      expect(await host.bridge(o.key, 'job.get', [r.value.id])).toMatchObject({ ok: true, value: { status: 'done' } })
      // файл-результат задачи читается гостем
      expect((await host.bridge(o.key, 'readFile', [join(tmp, 'out.png')])).ok).toBe(true)
    } finally {
      process.env.RUNZ_JOBS_DIR = saved.dir
      process.env.NR_RUNZ_CONFIG = saved.cfg
      if (saved.dir === undefined) delete process.env.RUNZ_JOBS_DIR
      if (saved.cfg === undefined) delete process.env.NR_RUNZ_CONFIG
    }
  })

  it('service.ts v1 (meta.channel) в своём процессе: call, push, падение не валит хост', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 's'), {
      'meta.mdz': '$title: S\n$uses: $[service]\n',
      'index.html': '<html></html>',
      'service.ts': `import type { X } from '@exz/service'
export default async function (ctx: unknown, meta: any) {
  let n = 0
  const t = setInterval(() => meta.channel.emit('tick', { n: ++n }), 50)
  meta.channel.on('echo', (p: unknown) => ({ echo: p, dataDir: meta.dataDir }))
  meta.channel.on('boom', () => { throw new Error('boom') })
  meta.channel.on('crash', () => { process.exit(1) })
  await meta.channel.closed
  clearInterval(t)
}
`,
    })
    const o = await host.open('ws/s')
    expect(await host.bridge(o.key, 'service.call', ['echo', { a: 1 }, null])).toMatchObject({ ok: true, value: { echo: { a: 1 } } })
    expect(await host.bridge(o.key, 'service.call', ['boom', null, null])).toEqual({ ok: false, error: 'boom' })
    const ticks: unknown[] = []
    const states: unknown[] = []
    const ac = new AbortController()
    host.serviceEvents(o.key, 'tick', ac.signal, (p) => ticks.push(p))
    host.serviceEvents(o.key, '__state', ac.signal, (p) => states.push(p))
    await wait(300)
    expect(ticks.length).toBeGreaterThan(1)
    expect((await host.bridge(o.key, 'service.call', ['crash', null, { timeout: 2000 }])).ok).toBe(false)
    await wait(100)
    expect(states).toContainEqual({ state: 'crashed', code: 1 })
    // прозрачный респаун
    expect(await host.bridge(o.key, 'service.call', ['echo', 2, null])).toMatchObject({ ok: true, value: { echo: 2 } })
    ac.abort()
  })

  it('события: finalize → reload, artifact_open → open', async () => {
    const dir = artifact(join(tmp, 'ws', '.nr', 'artifacts', 'e'), {
      'meta.mdz': '$title: E\n$uses: $[]\n',
      'index.html': '<html></html>',
    })
    const events: HostEvent[] = []
    const ac = new AbortController()
    host.events({}, ac.signal, (e) => events.push(e))
    await wait(100)
    await finalizeArtifact(dir, { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md') })
    requestOpen('ws/e', { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md'), root: join(tmp, 'data') })
    await wait(600)
    ac.abort()
    expect(events).toContainEqual({ name: 'reload', payload: { id: 'ws/e', dir, version: 1 } })
    expect(events.some((e) => e.name === 'open' && e.payload.id === 'ws/e')).toBe(true)
  })

  it('коллекция рабочей области, созданная после подписки: finalize → reload', async () => {
    const events: HostEvent[] = []
    const ac = new AbortController()
    host.events({}, ac.signal, (e) => events.push(e))
    await wait(150)
    const dir = artifact(join(tmp, 'ws', '.nr', 'artifacts', 'late'), { 'meta.mdz': '$title: L\n$uses: $[]\n', 'index.html': '<html></html>' })
    await wait(400)
    await finalizeArtifact(dir, { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md') })
    await wait(500)
    writeFileSync(join(dir, 'index.html'), '<html>2</html>')
    await finalizeArtifact(dir, { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md') })
    await wait(600)
    ac.abort()
    expect(events).toContainEqual({ name: 'reload', payload: { id: 'ws/late', dir, version: 2 } })
  })

  it('http(): статика через бэкенд — страница, ассет, байты, 403 fileUrl, 404', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'h'), {
      'meta.mdz': '$title: H\n$uses: $[file]\n',
      'index.html': '<html><head></head><body>h</body></html>',
      'app.js': 'console.log(2)',
    })
    writeFileSync(join(tmp, 'ws', '.nr', 'artifacts', 'h', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const o = await host.open('ws/h')
    const page = await host.http({ path: o.path, query: '' })
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toMatch(/text\/html/)
    expect(page.body).toMatch(/__NR_ARTIFACT__/)
    expect((await host.http({ path: `${o.path}app.js` })).body).toBe('console.log(2)')
    const png = await host.http({ path: `${o.path}pic.png` })
    expect(typeof png.body === 'object' && [...Buffer.from(png.body.__b64, 'base64')]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect((await host.http({ path: `/f/${o.key}`, query: `?p=${encodeURIComponent('/etc/passwd')}` })).status).toBe(403)
    expect((await host.http({ path: '/__prelude.js' })).status).toBe(200)
    expect((await host.http({ path: '/a/nope/' })).status).toBe(404)
  })

  it('ошибки рантайма: reportErrors → журнал версии; мусор отброшен; новая версия журнал обнуляет', async () => {
    const dir = artifact(join(tmp, 'ws', '.nr', 'artifacts', 'r'), { 'meta.mdz': '$title: R\n$uses: $[]\n', 'index.html': '<html></html>' })
    const o = await host.open('ws/r')
    const err = { kind: 'error', message: "TypeError: Cannot read properties of null (reading 'addEventListener')", source: 'app.js', line: 21, stack: Array.from({ length: 40 }, (_, i) => `at f${i}`).join('\n') }
    expect(host.reportErrors(o.key, [err, { nope: 1 }, 'x'])).toEqual({ ok: true, value: 1 })
    const log = readRuntimeErrors(dir, join(tmp, 'data'))!
    expect(log.version).toBe(0)
    expect(log.errors).toHaveLength(1)
    expect(log.errors[0]).toMatchObject({ message: err.message, source: 'app.js', line: 21 })
    expect(log.errors[0]!.stack!.split('\n')).toHaveLength(20)
    expect(host.reportErrors('bad-key', [err]).ok).toBe(false)
    await finalizeArtifact(dir, { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md') })
    await host.open('ws/r')
    host.reportErrors(o.key, [{ message: 'new' }])
    expect(readRuntimeErrors(dir, join(tmp, 'data'))).toMatchObject({ version: 1, errors: [{ message: 'new' }] })
  })

  it('проверка после finalize: open{check} → ack + событие с check; checked → результат pi; без клиента — no-client', async () => {
    const dir = artifact(join(tmp, 'ws', '.nr', 'artifacts', 'c'), { 'meta.mdz': '$title: C\n$uses: $[]\n', 'index.html': '<html></html>' })
    const reg = { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md'), root: join(tmp, 'data') }

    // клиента нет — никто не подписан на events
    const lonely = newCheckId()
    requestOpen('ws/c', { ...reg, check: lonely })
    expect(await awaitRuntimeCheck(lonely, { root: reg.root, ackMs: 300, pollMs: 20 })).toEqual({ status: 'no-client' })

    const events: HostEvent[] = []
    const ac = new AbortController()
    host.events({}, ac.signal, (e) => events.push(e))
    await wait(100)
    const check = newCheckId()
    requestOpen('ws/c', { ...reg, check })
    const pending = awaitRuntimeCheck(check, { root: reg.root, ackMs: 2000, resultMs: 3000, pollMs: 20 })
    await wait(300)
    const ev = events.find((e) => e.name === 'open' && e.payload.check === check)
    expect(ev?.payload).toMatchObject({ id: 'ws/c', dir, check })
    // «вкладка» загрузилась, окно прошло — вот ошибки
    const o = await host.open('ws/c')
    expect(host.checked(check, o.key, [{ message: 'TypeError: x is null', source: 'app.js', line: 3 }])).toEqual({ ok: true, value: true })
    expect(host.checked(check, o.key, [])).toEqual({ ok: true, value: false }) // второе окно опоздало
    expect(await pending).toEqual({ status: 'checked', errors: [{ message: 'TypeError: x is null', source: 'app.js', line: 3 }] })
    expect(readRuntimeErrors(dir, reg.root)?.errors).toHaveLength(1)

    // ack есть, ответа нет — timeout
    const silent = newCheckId()
    requestOpen('ws/c', { ...reg, check: silent })
    expect(await awaitRuntimeCheck(silent, { root: reg.root, ackMs: 2000, resultMs: 300, pollMs: 20 })).toEqual({ status: 'timeout' })
    ac.abort()
  })

  it('checkRuntime: ошибки finalize — без проверки; нет nrchat — no-client; вкладка ответила — ошибки гостя', async () => {
    const dir = artifact(join(tmp, 'ws', '.nr', 'artifacts', 'v'), { 'meta.mdz': '$title: V\n$uses: $[]\n', 'index.html': '<html></html>' })
    const reg = { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md'), root: join(tmp, 'data') }
    const r = await finalizeArtifact(dir, reg)
    expect(await checkRuntime({ ...r, errors: ['bad'] }, reg)).toMatchObject({ ok: false, runtimeErrors: null })
    expect(await checkRuntime(r, reg, { ackMs: 200 })).toMatchObject({ ok: true, runtimeErrors: null, unchecked: 'no-client', note: 'нет открытого nrchat' })

    const events: HostEvent[] = []
    const ac = new AbortController()
    host.events({}, ac.signal, (e) => events.push(e))
    await wait(100)
    const pending = checkRuntime(r, reg, { ackMs: 2000, resultMs: 3000 })
    await wait(700)
    const ev = events.find((e) => e.name === 'open' && typeof e.payload.check === 'string')
    const o = await host.open('ws/v')
    host.checked(String(ev?.payload.check), o.key, [{ message: 'TypeError: boom' }])
    expect(await pending).toMatchObject({ ok: false, runtimeErrors: [{ message: 'TypeError: boom' }] })
    ac.abort()
  })
  it('окно одного артефакта (single): чужой open не приходит и не подтверждается, свой — open (ABC-158)', async () => {
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'a'), { 'meta.mdz': '$title: A\n$uses: $[]\n', 'index.html': '<html></html>' })
    artifact(join(tmp, 'ws', '.nr', 'artifacts', 'b'), { 'meta.mdz': '$title: B\n$uses: $[]\n', 'index.html': '<html></html>' })
    const reg = { workspace: join(tmp, 'ws'), configFile: join(tmp, 'none.md'), root: join(tmp, 'data') }
    const single: HostEvent[] = []
    const panel: HostEvent[] = []
    const ac = new AbortController()
    host.events({ single: 'ws/a' }, ac.signal, (e) => single.push(e))
    await wait(100)
    // Чужой finalize с проверкой: окно A молчит и не подтверждает — nrchat нет, значит no-client.
    const b = newCheckId()
    requestOpen('ws/b', { ...reg, check: b })
    expect(await awaitRuntimeCheck(b, { root: reg.root, ackMs: 900, resultMs: 300, pollMs: 20 })).toEqual({ status: 'no-client' })
    expect(single.filter((e) => e.name === 'open')).toEqual([])
    // Свой — по id и по папке.
    requestOpen('ws/a', reg)
    await wait(700)
    expect(single.filter((e) => e.name === 'open').map((e) => e.payload.id)).toEqual(['ws/a'])
    // Панель nrchat (без single) получает всё.
    host.events({}, ac.signal, (e) => panel.push(e))
    await wait(100)
    requestOpen('ws/b', reg)
    await wait(700)
    expect(panel.filter((e) => e.name === 'open').map((e) => e.payload.id)).toEqual(['ws/b'])
    expect(single.filter((e) => e.name === 'open').map((e) => e.payload.id)).toEqual(['ws/a'])
    ac.abort()
  })
})
