import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  apiMismatch,
  choosePlugin,
  copyToUser,
  dirManifest,
  fileManifest,
  installFromGit,
  latestTag,
  mdzHeader,
  normalizeRegistries,
  publishEntry,
  readLayer,
  readLock,
  removePlugin,
  resolvePlugins,
  rollbackPlugin,
  satisfies,
  scaffoldRegistry,
  seedRegistry,
  syncRegistries,
  updatePlugin,
} from '../src/index.js'

const root = mkdtempSync(join(tmpdir(), 'nr-plugins-test-'))
const sh = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()

/** Рабочая репа + голая «удалённая» рядом; ссылка — file://. */
function repo(name: string, files: Record<string, string>): { work: string; url: string; commit: (files: Record<string, string>, tag?: string) => void } {
  const work = join(root, 'src', name)
  const bare = join(root, 'remote', `${name}.git`)
  mkdirSync(work, { recursive: true })
  mkdirSync(bare, { recursive: true })
  sh(['init', '--quiet', '--bare', '-b', 'main'], bare)
  sh(['init', '--quiet', '-b', 'main'], work)
  sh(['remote', 'add', 'origin', bare], work)
  const commit = (next: Record<string, string>, tag?: string): void => {
    for (const [p, text] of Object.entries(next)) {
      mkdirSync(join(work, p, '..'), { recursive: true })
      writeFileSync(join(work, p), text)
    }
    sh(['add', '-A'], work)
    sh(['commit', '--quiet', '-m', tag ?? 'c'], work)
    if (tag) sh(['tag', tag], work)
    sh(['push', '--quiet', '--tags', 'origin', 'main'], work)
  }
  commit(files)
  return { work, url: `file://${bare}`, commit }
}

const form = (title: string, extra = ''): string => `$title: ${title}\n$places: command\n$handles: image\n${extra}\n## $form\n$x: number // X\n`

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('semver', () => {
  it('диапазоны как у npm', () => {
    expect(satisfies('1.2.3', '^1.0')).toBe(true)
    expect(satisfies('2.0.0', '^1.0')).toBe(false)
    expect(satisfies('1.4.0', '~1.3')).toBe(false)
    expect(satisfies('1.3.9', '~1.3')).toBe(true)
    expect(satisfies('0.3.0', '^0.2')).toBe(false)
    expect(satisfies('1.5.0', '>=1.2 <2')).toBe(true)
    expect(satisfies('3.0.0', '1.x || >=3')).toBe(true)
    expect(satisfies('1.0.0', '*')).toBe(true)
    expect(satisfies('1.0.0', '1.0.0 - 1.2.0')).toBe(true)
  })
  it('причина несовместимости словами', () => {
    expect(apiMismatch('1.0.0', '^1')).toBeNull()
    expect(apiMismatch('1.0.0', undefined)).toBeNull()
    expect(apiMismatch('1.0.0', '^2.0')).toBe('нужен Plugin API ^2.0, у хоста 1.0.0')
    expect(apiMismatch('1.0.0', 'abc')).toMatch(/кривой диапазон/)
  })
  it('самый новый тег-версия', () => {
    expect(latestTag(['v1.0.0', 'v1.10.0', 'v1.9.1', 'latest'])).toBe('v1.10.0')
    expect(latestTag(['main'])).toBeNull()
  })
})

describe('манифест', () => {
  it('шапка mdz до первой секции', () => {
    expect(mdzHeader('$title: A\n$api: ^1\n```\n$x: no\n```\n## $form\n$y: z')).toEqual({ title: 'A', api: '^1' })
  })
  it('три веса', () => {
    const d = join(root, 'm')
    mkdirSync(join(d, 'code', 'dist'), { recursive: true })
    writeFileSync(join(d, 'code', 'package.json'), JSON.stringify({ version: '0.2.0', nrchat: { id: 'acme.code', api: '^1' } }))
    writeFileSync(join(d, 'code', 'dist', 'index.js'), 'export default {id:"acme.code"}')
    mkdirSync(join(d, 'art'), { recursive: true })
    writeFileSync(join(d, 'art', 'meta.mdz'), '$title: Арт\n$api: ^1\n$places: panel\n')
    writeFileSync(join(d, 'one.mdz'), form('Один'))
    expect(dirManifest(join(d, 'code'))).toMatchObject({ id: 'acme.code', weight: 'code', api: '^1', built: true, version: '0.2.0' })
    expect(dirManifest(join(d, 'art'))).toMatchObject({ id: 'art', weight: 'artifact', title: 'Арт', places: ['panel'] })
    expect(fileManifest(join(d, 'one.mdz'))).toMatchObject({ id: 'one', weight: 'file', places: ['command'], handles: ['image'] })
  })
})

describe('установка по ссылке, замок, обновление, откат', () => {
  const layer = join(root, 'layer')
  let gray: ReturnType<typeof repo>
  beforeAll(() => {
    gray = repo('nrp-gray', { 'gray.mdz': form('Серый v1', '$api: ^1') })
    sh(['tag', 'v1.0.0'], gray.work)
    sh(['push', '--quiet', '--tags', 'origin'], gray.work)
    gray.commit({ 'gray.mdz': form('Серый v1.1', '$api: ^1') }, 'v1.1.0')
  })

  it('ставит закреплённый тег и пишет замок и $plugins', () => {
    const r = installFromGit(layer, `${gray.url}#v1.0.0`)
    expect(r.id).toBe('gray')
    expect(r.manifest.weight).toBe('file')
    expect(readFileSync(join(layer, 'gray', 'gray.mdz'), 'utf8')).toContain('Серый v1\n')
    const e = readLock(layer).plugins.gray!
    expect(e).toMatchObject({ url: gray.url, tag: 'v1.0.0', weight: 'file', history: [] })
    expect(e.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(readLayer(layer).plugins).toEqual(['gray'])
    const res = resolvePlugins(layer)
    expect(res.forms).toEqual([join(layer, 'gray', 'gray.mdz')])
    expect(res.items.find((i) => i.id === 'gray')).toMatchObject({ active: true, source: 'git', installed: { tag: 'v1.0.0' } })
  })

  it('обновление на новый тег и откат на прошлую запись', () => {
    const u = updatePlugin(layer, 'gray')
    expect(u.entry.tag).toBe('v1.1.0')
    expect(u.entry.history.map((h) => h.tag)).toEqual(['v1.0.0'])
    expect(readFileSync(join(layer, 'gray', 'gray.mdz'), 'utf8')).toContain('Серый v1.1')
    const b = rollbackPlugin(layer, 'gray')
    expect(b.entry.tag).toBe('v1.0.0')
    expect(b.entry.history).toEqual([])
    expect(readFileSync(join(layer, 'gray', 'gray.mdz'), 'utf8')).toContain('Серый v1\n')
    expect(() => rollbackPlugin(layer, 'gray')).toThrow(/откатывать некуда/)
  })

  it('без тега — самый новый', () => {
    const l2 = join(root, 'layer2')
    expect(installFromGit(l2, gray.url).entry.tag).toBe('v1.1.0')
  })

  it('свои правки в клоне не затираются обновлением', () => {
    writeFileSync(join(layer, 'gray', 'gray.mdz'), 'правка')
    expect(() => updatePlugin(layer, 'gray', 'v1.1.0')).toThrow(/свои правки/)
    sh(['checkout', '--', 'gray.mdz'], join(layer, 'gray'))
    // Трассы прогонов runz рядом с файлом (неотслеживаемые) — не правка.
    mkdirSync(join(layer, 'gray', '.runz', 'runs'), { recursive: true })
    writeFileSync(join(layer, 'gray', '.runz', 'runs', 'trace.jsonl'), '{}')
    expect(updatePlugin(layer, 'gray', 'v1.1.0').entry.tag).toBe('v1.1.0')
    rollbackPlugin(layer, 'gray')
  })

  it('плагин со сборкой без dist — отказ «не собран», ничего не ставится', () => {
    const raw = repo('nrp-raw', { 'package.json': JSON.stringify({ nrchat: { id: 'raw' } }), 'src/index.tsx': 'x' })
    expect(() => installFromGit(layer, raw.url)).toThrow(/плагин не собран/)
    expect(existsSync(join(layer, 'raw'))).toBe(false)
  })

  it('не плагин — отказ словами', () => {
    const junk = repo('junk', { 'README.md': '# hi' })
    expect(() => installFromGit(layer, junk.url)).toThrow(/не плагин/)
  })

  it('удаление — папка, замок, $plugins', () => {
    removePlugin(layer, 'gray')
    expect(existsSync(join(layer, 'gray'))).toBe(false)
    expect(readLock(layer).plugins.gray).toBeUndefined()
    expect(readLayer(layer).plugins).toEqual([])
  })
})

describe('реестры', () => {
  const layer = join(root, 'reg-layer')
  let open: ReturnType<typeof repo>
  let priv: ReturnType<typeof repo>
  beforeAll(() => {
    open = repo('nr-plugins', {
      'registry.mdz': '$title: NR Plugins\n$schema: 1\n',
      'plugins/rotate.mdz': form('Повернуть'),
      'plugins/hist/meta.mdz': '$title: Гистограмма\n$places: panel\n',
      'plugins/hist/index.html': '<p>h</p>',
      'plugins/same.mdz': form('Одинаковый из открытого'),
    })
    priv = repo('nr-plugins-private', {
      'registry.mdz': '$title: NR Plugins Private\n',
      'entries/gray.mdz': '$url: file:///nowhere/gray.git\n$tag: v1.0.0\n$title: Серый\n$weight: file\n',
      'plugins/same.mdz': form('Одинаковый из закрытого'),
    })
  })

  it('список из настройки — строки и объекты', () => {
    expect(normalizeRegistries(['https://git.x/alice/nr-plugins.git', { url: 'https://git.x/a/b', title: 'B' }])).toEqual([
      { id: 'nr-plugins', url: 'https://git.x/alice/nr-plugins.git' },
      { id: 'b', url: 'https://git.x/a/b', title: 'B' },
    ])
  })

  it('клон, каскад, запись реестра без установки, конфликт одинакового id', () => {
    const r = syncRegistries(layer, normalizeRegistries([open.url, priv.url]))
    expect(r.map((x) => x.status)).toEqual(['cloned', 'cloned'])
    const res = resolvePlugins(layer)
    expect(res.registries.map((x) => x.title)).toEqual(['NR Plugins', 'NR Plugins Private'])
    expect(res.forms).toEqual([join(layer, '.registries', 'nr-plugins', 'plugins', 'rotate.mdz')])
    expect(res.items.find((i) => i.id === 'hist')).toMatchObject({ active: true, weight: 'artifact', source: 'registry:nr-plugins' })
    expect(res.items.find((i) => i.id === 'gray')).toMatchObject({ active: false, entry: { url: 'file:///nowhere/gray.git', registry: 'nr-plugins-private' } })
    const same = res.items.find((i) => i.id === 'same')!
    expect(same.active).toBe(false)
    expect(same.candidates!.map((c) => c.source)).toEqual(['registry:nr-plugins', 'registry:nr-plugins-private'])
    choosePlugin(layer, 'same', 'registry:nr-plugins-private')
    const after = resolvePlugins(layer)
    expect(after.items.find((i) => i.id === 'same')).toMatchObject({ active: true, chosen: 'registry:nr-plugins-private' })
    expect(after.forms).toContain(join(layer, '.registries', 'nr-plugins-private', 'plugins', 'same.mdz'))
  })

  it('не чаще раза в N часов; force — сразу', () => {
    expect(syncRegistries(layer, normalizeRegistries([open.url, priv.url])).map((x) => x.status)).toEqual(['fresh', 'fresh'])
  })

  it('правка = копия: переживает обновление реестра и перекрывает его', () => {
    const src = join(layer, '.registries', 'nr-plugins', 'plugins', 'rotate.mdz')
    const { path } = copyToUser(layer, src)
    writeFileSync(path, form('Повернуть (моя правка)'))
    const hist = copyToUser(layer, join(layer, '.registries', 'nr-plugins', 'plugins', 'hist'))
    open.commit({ 'plugins/rotate.mdz': form('Повернуть v2 реестра') })
    syncRegistries(layer, normalizeRegistries([open.url, priv.url]), { force: true })
    expect(readFileSync(join(layer, '.registries', 'nr-plugins', 'plugins', 'rotate.mdz'), 'utf8')).toContain('v2 реестра')
    expect(readFileSync(path, 'utf8')).toContain('моя правка')
    const res = resolvePlugins(layer)
    expect(res.items.find((i) => i.id === 'rotate')).toMatchObject({ active: true, edited: true, shadows: 'registry:nr-plugins', source: 'user', title: 'Повернуть (моя правка)' })
    expect(res.forms).toContain(path)
    expect(res.forms).not.toContain(src)
    expect(res.artifacts.hidden).toContain(join(layer, '.registries', 'nr-plugins', 'plugins', 'hist'))
    expect(res.artifacts.collections).toContain(layer)
    expect(hist.existed).toBe(false)
  })

  it('отключённый реестр снимается', () => {
    syncRegistries(layer, normalizeRegistries([open.url]))
    expect(existsSync(join(layer, '.registries', 'nr-plugins-private'))).toBe(false)
    expect(resolvePlugins(layer).items.find((i) => i.id === 'gray')).toBeUndefined()
  })

  it('без сети — снимок комплекта', () => {
    const l = join(root, 'snap-layer')
    const snap = join(root, 'snapshot')
    scaffoldRegistry(snap, 'Снимок')
    writeFileSync(join(snap, 'plugins', 'atlas.mdz'), form('Атлас'))
    const r = syncRegistries(l, [{ id: 'nr-plugins', url: 'file:///nowhere/nr-plugins.git', snapshot: snap }])
    expect(r[0]!.status).toBe('failed')
    expect(resolvePlugins(l).items.find((i) => i.id === 'atlas')).toMatchObject({ active: true, source: 'registry:nr-plugins' })
    expect(resolvePlugins(l).registries[0]).toMatchObject({ snapshot: true })
  })

  it('снимок комплекта: seedRegistry кладёт папку и подключает первым; потом сеть есть — клон вместо снимка', () => {
    const l = join(root, 'seed-layer')
    const snap = join(root, 'snapshot2')
    scaffoldRegistry(snap, 'Снимок 2')
    writeFileSync(join(snap, 'plugins', 'mirror.mdz'), form('Зеркало'))
    expect(seedRegistry(l, { id: 'nr-plugins', url: open.url, snapshot: snap })).toBe('seeded')
    expect(resolvePlugins(l).items.find((i) => i.id === 'mirror')).toMatchObject({ active: true })
    expect(resolvePlugins(l).registries[0]).toMatchObject({ id: 'nr-plugins', snapshot: true })
    const r = syncRegistries(l, normalizeRegistries([open.url]))
    expect(r[0]!.status).toBe('cloned')
    expect(resolvePlugins(l).items.find((i) => i.id === 'mirror')).toBeUndefined()
    expect(resolvePlugins(l).items.find((i) => i.id === 'rotate')).toBeDefined()
    expect(seedRegistry(l, { id: 'nr-plugins', url: open.url, snapshot: snap })).toBe('kept')
  })

  it('publish: запись entries/ по ссылке и плагин-файл копией — коммит и push', () => {
    const tool = repo('nrp-tool', { 'tool.mdz': form('Инструмент', '$api: ^1') }, )
    tool.commit({ 'tool.mdz': form('Инструмент 1.0', '$api: ^1') }, 'v1.0.0')
    const p = publishEntry({ registry: priv.url, source: `${tool.url}#v1.0.0` })
    expect(p).toMatchObject({ id: 'tool', pushed: true })
    const local = join(root, 'm', 'one.mdz')
    publishEntry({ registry: priv.url, source: local })
    const l = join(root, 'pub-layer')
    syncRegistries(l, normalizeRegistries([priv.url]))
    const res = resolvePlugins(l)
    expect(res.items.find((i) => i.id === 'tool')).toMatchObject({ active: false, entry: { url: tool.url, tag: 'v1.0.0', api: '^1', weight: 'file' } })
    expect(res.items.find((i) => i.id === 'one')).toMatchObject({ active: true })
    // запись ставится по ссылке и помнит реестр
    const inst = installFromGit(l, `${tool.url}#v1.0.0`, { registry: 'nr-plugins-private' })
    expect(inst.entry.registry).toBe('nr-plugins-private')
    expect(resolvePlugins(l).items.find((i) => i.id === 'tool')).toMatchObject({ active: true, installed: { tag: 'v1.0.0' }, entry: { registry: 'nr-plugins-private' } })
  })
})
