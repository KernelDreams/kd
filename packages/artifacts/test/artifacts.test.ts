import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  agentCatalog,
  checkAccess,
  checkArtifact,
  finalizeArtifact,
  historyVersions,
  initArtifact,
  listArtifacts,
  listCollections,
  parseManifest,
  readArtifact,
  requestOpen,
  openQueueFile,
  resolveArtifact,
  revertArtifact,
  runAllowed,
  setManifestVersion,
} from '../src/index.js'
import type { AccessEnv } from '../src/index.js'

let tmp: string
const noConfig = (): string => join(tmp, 'no-config.md')

function artifact(dir: string, files: Record<string, string>): string {
  mkdirSync(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return dir
}

const GOOD = {
  'meta.mdz': '$title: Good\n$uses: $[file]\n',
  'index.html': '<!doctype html><html><head></head><body><script type="module" src="./app.js"></script></body></html>',
  'app.js': "const r = await window.__host.readFile('./data.txt')\nconsole.log(r)\n",
}

function check(files: Record<string, string>) {
  const dir = artifact(join(tmp, 'c', String(Math.random()).slice(2)), files)
  const m = parseManifest(files['meta.mdz'] ?? '')
  return checkArtifact(dir, m.ok ? m.value : null)
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'artifacts-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('manifest', () => {
  it('скоупы в синтаксисе спеки, версия, умолчания', () => {
    const r = parseManifest('$title: A\n$uses: $[file, run, clipboard, service]\n$fs-read:  {artifact}, {workspace}, {user-selected}\n$fs-write: {artifact}\n$run-allow: comfy, vision, ./templates/*.md\n$version: 4\n')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.uses).toEqual(['file', 'run', 'clipboard', 'service'])
    expect(r.value.fsRead).toEqual(['{artifact}', '{workspace}', '{user-selected}'])
    expect(r.value.fsWrite).toEqual(['{artifact}'])
    expect(r.value.runAllow).toEqual(['comfy', 'vision', './templates/*.md'])
    expect(r.value.version).toBe(4)
  })
  it('без $uses — null (легаси); неизвестное право — в unknownUses', () => {
    const a = parseManifest('$title: A\n')
    expect(a.ok && a.value.uses).toBe(null)
    const b = parseManifest('$title: A\n$uses: $[file, git]\n')
    expect(b.ok && b.value.unknownUses).toEqual(['git'])
  })
  it('ошибка разбора — с номером строки', () => {
    const r = parseManifest('$title: A\n$uses: $[file]\n$window: {w: }\n')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.line).toBe(3)
  })
  it('setManifestVersion заменяет или дописывает после $title', () => {
    expect(setManifestVersion('$title: A\n$uses: $[file]\n', 1)).toBe('$title: A\n$version: 1\n$uses: $[file]\n')
    expect(setManifestVersion('$title: A\n$version: 3\n', 4)).toBe('$title: A\n$version: 4\n')
  })
})

describe('статическая проверка (§8 п.3)', () => {
  it('чистый артефакт проходит', () => {
    expect(check(GOOD).errors).toEqual([])
  })
  it('ловит отсутствие $uses', () => {
    const r = check({ ...GOOD, 'meta.mdz': '$title: Good\n' })
    expect(r.errors.join('\n')).toMatch(/нет \$uses/)
  })
  it('ловит вызов незадекларированного метода', () => {
    const r = check({ ...GOOD, 'app.js': "await window.__host.run('comfy', {})\n" })
    expect(r.errors.join('\n')).toMatch(/app\.js:1: __host\.run требует право "run"/)
  })
  it('ловит несуществующий API с подсказкой', () => {
    const r = check({ ...GOOD, 'app.js': "await window.__host.exec('ls')\n" })
    expect(r.errors.join('\n')).toMatch(/__host\.exec не существует — команды/)
  })
  it('ловит голый импорт', () => {
    const r = check({ ...GOOD, 'app.js': "import _ from 'lodash'\nimport { useState } from 'react'\nimport { x } from './x.js'\n" })
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toMatch(/app\.js:1: голый импорт "lodash"/)
  })
  it('ловит абсолютный путь', () => {
    const r = check({ ...GOOD, 'app.js': "window.__host.readFile('/Users/user/x.txt')\nwindow.__host.readFile('C:\\\\data\\\\y.txt')\n" })
    expect(r.errors.filter((e) => e.includes('абсолютный путь'))).toHaveLength(2)
  })
  it('ловит navigator.clipboard и два входа', () => {
    const r = check({ ...GOOD, 'index.jsx': 'x', 'app.js': 'navigator.clipboard.readText()\n' })
    expect(r.errors.join('\n')).toMatch(/два входа/)
    expect(r.errors.join('\n')).toMatch(/navigator\.clipboard/)
  })
  it('комментарии не считаются кодом', () => {
    const r = check({ ...GOOD, 'app.js': "// window.__host.run('x')\n/* import a from 'lodash' */\n" })
    expect(r.errors).toEqual([])
  })
})

describe('права в рантайме (§8 п.4)', () => {
  const env = (dir: string): AccessEnv => ({ artifactDir: dir, dataDir: join(dir, '..', 'data'), workspace: '/ws', selected: new Set(['/picked/a.png']) })
  const m = (text: string) => {
    const r = parseManifest(text)
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  it('незадекларированный метод → capability not declared (как v1)', () => {
    expect(checkAccess(m('$title: A\n$uses: $[file]\n'), 'run', ['comfy'], env('/a'))).toEqual({ ok: false, error: 'capability not declared: run' })
    expect(checkAccess(m('$title: A\n$uses: $[file]\n'), 'clipboardRead', [], env('/a'))).toEqual({ ok: false, error: 'capability not declared: clipboard' })
  })
  it('скоупы путей: {artifact}, {workspace}, {user-selected}, запись только {artifact}', () => {
    const man = m('$title: A\n$uses: $[file]\n$fs-write: {artifact}\n')
    expect(checkAccess(man, 'readFile', ['./x.txt'], env('/a')).ok).toBe(true)
    expect(checkAccess(man, 'readFile', ['/ws/notes.md'], env('/a')).ok).toBe(true)
    expect(checkAccess(man, 'readFile', ['/picked/a.png'], env('/a')).ok).toBe(true)
    expect(checkAccess(man, 'readFile', ['/etc/hosts'], env('/a')).ok).toBe(false)
    expect(checkAccess(man, 'writeFile', ['/ws/notes.md', 'x'], env('/a')).ok).toBe(false)
    expect(checkAccess(man, 'writeFile', ['/a/out.txt', 'x'], env('/a')).ok).toBe(true)
  })
  it('без $uses — легаси: можно всё', () => {
    expect(checkAccess(m('$title: A\n'), 'readFile', ['/etc/hosts'], env('/a')).ok).toBe(true)
  })
  it('$run-allow: имена appz и глобы шаблонов', () => {
    expect(runAllowed('comfy', ['comfy', './t/*.md'], '/a')).toBe(true)
    expect(runAllowed('vision', ['comfy'], '/a')).toBe(false)
    expect(runAllowed('./t/x.md', ['./t/*.md'], '/a')).toBe(true)
    expect(runAllowed('./u/x.md', ['./t/*.md'], '/a')).toBe(false)
    expect(runAllowed('anything', [], '/a')).toBe(true)
  })
  it('незнакомый метод моста', () => {
    expect(checkAccess(null, 'exec', [], env('/a'))).toEqual({ ok: false, error: 'unknown bridge method: exec' })
  })
})

describe('коллекции (§8 п.8)', () => {
  it('реестровая, рабочей области и демо видны разом; init без указания — в рабочую область', () => {
    const reg = join(tmp, 'reg')
    artifact(join(reg, 'r1'), GOOD)
    writeFileSync(join(reg, 'collection.mdz'), '$title: Реестр\n$default: true\n')
    const cfg = join(tmp, 'config.md')
    writeFileSync(cfg, `$root: ${tmp}\n$artifacts: reg\n`)
    const ws = join(tmp, 'ws')
    artifact(join(ws, '.nr', 'artifacts', 'w1'), GOOD)
    const demo = artifact(join(tmp, 'demo', 'd1'), GOOD)
    const opts = { workspace: ws, demoDir: join(demo, '..'), configFile: cfg }
    const cs = listCollections(opts)
    expect(cs.map((c) => [c.id, c.kind])).toEqual([
      ['ws', 'workspace'],
      ['reg', 'registry'],
      ['demo', 'demo'],
    ])
    expect(listArtifacts(cs).map((a) => a.id)).toEqual(['ws/w1', 'reg/r1', 'demo/d1'])
    const init = initArtifact({ ...opts, name: 'Мой Тест' })
    expect(init.id).toBe('ws/moy-test')
    expect(existsSync(join(ws, '.nr', 'artifacts', 'moy-test', 'index.html'))).toBe(true)
    // без рабочей области — $default реестра
    expect(initArtifact({ configFile: cfg, name: 'x' }).id).toBe('reg/x')
    expect(initArtifact({ configFile: cfg, name: 'x', unique: true }).id).toBe('reg/x-2')
    expect(initArtifact({ configFile: cfg, name: 'x', unique: true }).id).toBe('reg/x-3')
  })
  it('голое имя папки — если однозначно по коллекциям', () => {
    const reg = join(tmp, 'reg')
    artifact(join(reg, 'only'), GOOD)
    artifact(join(tmp, 'demo', 'only2'), GOOD)
    const cs = listCollections({ configFile: noConfig(), extra: [reg], demoDir: join(tmp, 'demo') })
    expect(resolveArtifact('only', cs, '/')?.id).toBe('reg/only')
    artifact(join(tmp, 'demo', 'only'), GOOD)
    expect(resolveArtifact('only', cs, '/')).toBe(null)
  })

  it('ABC-840: слой плагинов — коллекции реестров со своими id, только чтение; скрытые папки не видны', () => {
    const reg = join(tmp, 'layer', '.registries', 'nr-plugins', 'plugins')
    const user = join(tmp, 'layer')
    artifact(join(reg, 'hist'), GOOD)
    artifact(join(reg, 'other'), GOOD)
    artifact(join(user, 'hist'), GOOD)
    const cs = listCollections({ configFile: noConfig(), plugins: { collections: [{ dir: reg, id: 'reg-nr-plugins', readonly: true }, { dir: user, id: 'plugins' }], hidden: [join(reg, 'hist')] } })
    expect(cs.map((c) => [c.id, c.readonly])).toEqual([['reg-nr-plugins', true], ['plugins', false]])
    expect(listArtifacts(cs).map((a) => a.id)).toEqual(['reg-nr-plugins/other', 'plugins/hist'])
  })

  it('голое имя: одноимённый каталог cwd без meta.mdz не заслоняет коллекцию (ABC-155)', () => {
    const reg = join(tmp, 'reg')
    artifact(join(reg, 'comfy'), GOOD)
    const cwd = join(tmp, 'envs')
    mkdirSync(join(cwd, 'comfy'), { recursive: true })
    const cs = listCollections({ configFile: noConfig(), extra: [reg] })
    expect(resolveArtifact('comfy', cs, cwd)?.id).toBe('reg/comfy')
    // артефакт в cwd — явный выбор, он и открывается
    artifact(join(cwd, 'comfy'), GOOD)
    expect(resolveArtifact('comfy', cs, cwd)?.dir).toBe(join(cwd, 'comfy'))
  })

  it('ad-hoc путь вне коллекций открывается как есть', () => {
    const dir = artifact(join(tmp, 'loose', 'a'), GOOD)
    const info = resolveArtifact(dir, listCollections({ configFile: noConfig() }))
    expect(info?.id).toBe(dir)
    expect(info?.title).toBe('Good')
  })
})

describe('finalize (§6, §8 п.5)', () => {
  const opts = (): { configFile: string } => ({ configFile: noConfig() })

  it('версия +1, снимок в .history, повтор без правок — changed:false', async () => {
    const dir = artifact(join(tmp, 'a'), GOOD)
    const r1 = await finalizeArtifact(dir, opts())
    expect(r1).toMatchObject({ changed: true, version: 1, errors: [] })
    expect(readFileSync(join(dir, 'meta.mdz'), 'utf8')).toMatch(/\$version: 1/)
    expect(historyVersions(dir)).toEqual([1])
    const r2 = await finalizeArtifact(dir, opts())
    expect(r2).toMatchObject({ changed: false, version: 1 })
    writeFileSync(join(dir, 'app.js'), "console.log('v2')\n")
    expect(await finalizeArtifact(dir, opts())).toMatchObject({ changed: true, version: 2 })
  })
  it('ошибки — версия не растёт', async () => {
    const dir = artifact(join(tmp, 'a'), { ...GOOD, 'app.js': 'import x from "lodash"\n' })
    const r = await finalizeArtifact(dir, opts())
    expect(r.changed).toBe(false)
    expect(r.version).toBe(0)
    expect(r.errors.join('\n')).toMatch(/lodash/)
    expect(readFileSync(join(dir, 'meta.mdz'), 'utf8')).not.toMatch(/\$version/)
  })
  it('синтаксическая ошибка JSX ловится смок-сборкой', async () => {
    const dir = artifact(join(tmp, 'j'), { 'meta.mdz': '$title: J\n$uses: $[]\n', 'index.jsx': 'const a = <div>\n' })
    const r = await finalizeArtifact(dir, opts())
    expect(r.errors.length).toBeGreaterThan(0)
    expect(r.errors[0]).toMatch(/index\.jsx:\d+/)
  })
  it('устаревший expectedVersion — отказ с текущей версией', async () => {
    const dir = artifact(join(tmp, 'a'), GOOD)
    await finalizeArtifact(dir, opts())
    writeFileSync(join(dir, 'app.js'), 'console.log(2)\n')
    const r = await finalizeArtifact(dir, { ...opts(), expectedVersion: 0 })
    expect(r.changed).toBe(false)
    expect(r.version).toBe(1)
    expect(r.errors[0]).toMatch(/expectedVersion 0 устарела: текущая версия 1/)
    expect(await finalizeArtifact(dir, { ...opts(), expectedVersion: 1 })).toMatchObject({ changed: true, version: 2 })
  })
  it('две параллельные finalize не затирают друг друга', async () => {
    const dir = artifact(join(tmp, 'a'), GOOD)
    await finalizeArtifact(dir, opts())
    writeFileSync(join(dir, 'app.js'), 'console.log(2)\n')
    const [a, b] = await Promise.all([finalizeArtifact(dir, { ...opts(), expectedVersion: 1 }), finalizeArtifact(dir, { ...opts(), expectedVersion: 1 })])
    const ok = [a, b].filter((r) => r.changed)
    const refused = [a, b].filter((r) => !r.changed)
    expect(ok).toHaveLength(1)
    expect(ok[0]!.version).toBe(2)
    expect(refused[0]!.errors[0]).toMatch(/текущая версия 2/)
    expect(readFileSync(join(dir, 'meta.mdz'), 'utf8')).toMatch(/\$version: 2/)
  })
  it('revert возвращает файлы версии новой версией', async () => {
    const dir = artifact(join(tmp, 'a'), GOOD)
    await finalizeArtifact(dir, opts())
    writeFileSync(join(dir, 'app.js'), 'console.log(2)\n')
    await finalizeArtifact(dir, opts())
    const r = await revertArtifact(dir, 1, opts())
    expect(r).toMatchObject({ changed: true, version: 3 })
    expect(readFileSync(join(dir, 'app.js'), 'utf8')).toBe(GOOD['app.js'])
  })
  it('демо только для чтения', async () => {
    const demo = artifact(join(tmp, 'demo', 'd1'), GOOD)
    await expect(finalizeArtifact('demo/d1', { configFile: noConfig(), demoDir: join(demo, '..') })).rejects.toThrow(/только для чтения/)
  })
  it('шаблоны init проходят finalize без правок', async () => {
    for (const template of ['html', 'jsx', 'jsx+service', 'stand'] as const) {
      const init = initArtifact({ configFile: noConfig(), collection: join(tmp, 'coll'), name: `t ${template}`, template })
      const r = await finalizeArtifact(init.dir, opts())
      expect(r.errors).toEqual([])
      expect(r.version).toBe(1)
    }
  })
})

describe('open', () => {
  it('artifact_open пишет строку в очередь', () => {
    const dir = artifact(join(tmp, 'a'), GOOD)
    requestOpen(dir, { configFile: noConfig(), root: tmp })
    const line = JSON.parse(readFileSync(openQueueFile(tmp), 'utf8').trim()) as { id: string }
    expect(line.id).toBe(dir)
    expect(readArtifact(dir, null).entry).toBe('html')
  })
})

describe('$icon (ABC-164)', () => {
  const SVG_MONO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path stroke="currentColor" d="M2 2h20"/></svg>'
  const SVG_COLOR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect fill="#e11" width="24" height="24"/></svg>'
  const meta = (icon: string) => `$title: Good\n$icon: ${icon}\n$uses: $[file]\n`

  it('lucide: известное имя проходит, незнакомое — ошибка finalize', () => {
    expect(check({ ...GOOD, 'meta.mdz': meta('wand-sparkles') }).errors).toEqual([])
    expect(check({ ...GOOD, 'meta.mdz': meta('no-such-icon') }).errors.join('\n')).toMatch(/lucide "no-such-icon"/)
  })

  it('файл: нет в папке / не тот формат / вне папки — ошибка', () => {
    expect(check({ ...GOOD, 'meta.mdz': meta('./icon.png') }).errors.join('\n')).toMatch(/файла \.\/icon\.png нет/)
    expect(check({ ...GOOD, 'meta.mdz': meta('./icon.gif'), 'icon.gif': 'x' }).errors.join('\n')).toMatch(/svg, \.png или \.webp/)
    expect(check({ ...GOOD, 'meta.mdz': meta('../x.svg') }).errors.join('\n')).toMatch(/вне папки/)
    expect(check({ ...GOOD, 'meta.mdz': meta('./icon.svg'), 'icon.svg': SVG_COLOR }).errors).toEqual([])
  })

  it('список: iconRef — lucide, моно-SVG (currentColor), цветной SVG, без поля — null', () => {
    const at = (icon: string | null, files: Record<string, string> = {}) =>
      readArtifact(artifact(join(tmp, 'i', String(Math.random()).slice(2)), { ...GOOD, ...files, 'meta.mdz': icon ? meta(icon) : GOOD['meta.mdz'] }), null).iconRef
    expect(at('Wand-Sparkles')).toEqual({ kind: 'lucide', name: 'wand-sparkles' })
    expect(at('./i.svg', { 'i.svg': SVG_MONO })).toMatchObject({ kind: 'image', mono: true, url: expect.stringMatching(/^data:image\/svg\+xml;base64,/) })
    expect(at('./i.svg', { 'i.svg': SVG_COLOR })).toMatchObject({ kind: 'image', mono: false })
    expect(at('./missing.png')).toBeNull()
    expect(at('no-such-icon')).toBeNull()
    expect(at(null)).toBeNull()
  })
})

describe('каталог артефактов для system (ABC-228)', () => {
  it('«id — название — описание — vN», правило «не читать чужие», бюджет с хвостом', () => {
    const ws = mkdtempSync(join(tmpdir(), 'art-cat-'))
    const none = join(ws, 'no-config.md')
    expect(agentCatalog({ workspace: ws, configFile: none })).toBe('')
    for (const n of ['Альфа', 'Бета', 'Гамма']) initArtifact({ workspace: ws, configFile: none, name: n })
    const full = agentCatalog({ workspace: ws, configFile: none })
    expect(full).toMatch(/do NOT read other artifacts/)
    expect(full).toMatch(/^- .*\/alfa — Альфа — v\d+$/m)
    expect(full.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3)
    const cut = agentCatalog({ workspace: ws, configFile: none }, full.length - 10)
    expect(cut).toMatch(/…и ещё 1 \(artifact_list\)$/)
  })
})

describe('$widget — виджет поля редактора (ABC-499)', () => {
  it('id, типы, props JSON, строгая песочница; без $widget — null', () => {
    const m = parseManifest('$title: Трек\n$widget: fate.stress-track-alt\n$types: boolean[]\n$props: \'{"type":"object","properties":{"boxes":{"type":"integer"}}}\'\n$widget-sandbox: strict\n')
    expect(m.ok && m.value.widget).toEqual({ id: 'fate.stress-track-alt', types: ['boolean[]'], props: { type: 'object', properties: { boxes: { type: 'integer' } } }, sandbox: 'strict' })
    const n = parseManifest('$title: Просто\n')
    expect(n.ok && n.value.widget).toBe(null)
  })
})
