import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { recordHue } from '@kerneldreams/ui-protocol'
import { createObjectsEngine, parseObjectType } from '../src/objects.js'
import { colorOf, coverStateOf, parseColorRule, parseCoverRule, type CoverJobRequest } from '../src/objects-cover.js'

const render = (tpl: string, data: Record<string, unknown>): string => tpl.replace(/<<\s*([\w.]+)\s*>>/g, (_m, k: string) => String(data[k] ?? ''))

const TYPE = `$type: object-type
$id: slot
$title: Слоты
$source: files
$paths: items
$format: mdz
$id_field: slug
$title_field: title
$color: provider
$palette: KND=200, BNG=--nr-ok

## $cover
$refs: shot, provider → provider
$style: flat
$preset: fixture
$auto: stale

icon for slot << title >> by << provider >>, accent << color_name >>
`

const PROVIDER = `$type: object-type
$id: provider
$source: files
$paths: providers
$format: mdz
$id_field: id
`

function setup(type = TYPE) {
  const root = mkdtempSync(join(tmpdir(), 'objects-cover-'))
  const types = join(root, 'types')
  const items = join(root, 'items')
  for (const d of [types, items, join(root, 'providers'), join(root, 'cover-styles')]) mkdirSync(d, { recursive: true })
  writeFileSync(join(types, 'slot.mdz'), type)
  writeFileSync(join(types, 'provider.mdz'), PROVIDER)
  writeFileSync(join(root, 'cover-styles', 'flat.mdz'), '$title: Плоский\n$prompt: flat vector, bold shapes\n')
  writeFileSync(join(root, 'cover-styles', 'oil.mdz'), '$title: Масло\n$prompt: oil painting\n')
  writeFileSync(join(items, 'coin.mdz'), '$slug: coin\n$title: Coin Dragon\n$provider: KND\n')
  writeFileSync(join(items, 'fish.mdz'), '$slug: fish\n$title: Happy Fish\n$provider: BNG\n$shot: shots/fish.png\n')
  mkdirSync(join(items, 'shots'), { recursive: true })
  writeFileSync(join(items, 'shots', 'fish.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
  writeFileSync(join(root, 'providers', 'KND.mdz'), '$id: KND\n')
  writeFileSync(join(root, 'providers', 'KND.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 2]))
  const calls: CoverJobRequest[] = []
  const engine = createObjectsEngine({
    typeDirs: () => [types],
    base: root,
    render,
    stateDir: join(root, 'state'),
    cover: (req) => {
      calls.push(req)
      return { job: `job-${calls.length}` }
    },
  })
  return { root, items, engine, calls }
}

/** То, что делает задача генерации: картинка, иконка, sidecar с хэшем. */
function finish(req: CoverJobRequest, bytes = [1, 2, 3]): void {
  mkdirSync(req.dir, { recursive: true })
  writeFileSync(join(req.dir, 'cover.png'), Buffer.from(bytes))
  writeFileSync(join(req.dir, 'icon.png'), Buffer.from(bytes))
  writeFileSync(join(req.dir, 'cover.json'), JSON.stringify({ hash: req.hash, model: 'fixture', prompt: req.prompt, date: new Date().toISOString() }))
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

describe('цвет записи $color (§19.1)', () => {
  it('по умолчанию hash по id, ступени', () => {
    const rule = parseColorRule({})
    if (typeof rule === 'string') throw new Error(rule)
    expect(rule).toEqual({ by: 'hash', steps: 12 })
    expect(colorOf(rule, 'coin', 'x')).toEqual({ hue: recordHue('coin', 12) })
  })
  it('поле + палитра: оттенок, токен; значение без палитры — свой оттенок по значению', () => {
    const rule = parseColorRule({ color: 'provider', palette: 'KND=200, BNG=--nr-ok' })
    if (typeof rule === 'string') throw new Error(rule)
    expect(colorOf(rule, 'a', 'KND')).toEqual({ hue: 200 })
    expect(colorOf(rule, 'a', 'BNG')).toEqual({ color: 'var(--nr-ok)' })
    expect(colorOf(rule, 'a', 'NetEnt')).toEqual({ hue: recordHue('NetEnt', 12) })
    expect(colorOf(rule, 'a', 'NetEnt')).toEqual(colorOf(rule, 'b', 'NetEnt'))
  })
  it('off и ошибки', () => {
    expect(parseColorRule({ color: 'off' })).toMatchObject({ by: 'off' })
    expect(typeof parseColorRule({ color_steps: '0' })).toBe('string')
    expect(typeof parseColorRule({ palette: 'oops' })).toBe('string')
  })
  it('строка: hue по id не меняется от переименования', () => {
    const { engine, items } = setup(TYPE.replace('$color: provider\n$palette: KND=200, BNG=--nr-ok\n', ''))
    const before = engine.list({ type: 'slot' }).rows.find((r) => r.id === 'coin')!
    expect(before.hue).toBe(recordHue('coin', 12))
    writeFileSync(join(items, 'coin.mdz'), '$slug: coin\n$title: Coin Dragon Deluxe\n$provider: KND\n')
    const after = engine.list({ type: 'slot' }).rows.find((r) => r.id === 'coin')!
    expect(after.title).toBe('Coin Dragon Deluxe')
    expect(after.hue).toBe(before.hue)
    const info = engine.types().types.find((t) => t.id === 'slot')!
    expect(info.color).toEqual({ by: 'hash', steps: 12 })
    expect('colorRule' in info).toBe(false)
  })
})

describe('обложка ## $cover (§19.2)', () => {
  it('правило: рефы, шаблон из текста секции, пресеты, ошибки', () => {
    const r = parseCoverRule(TYPE)
    if (!r || typeof r === 'string') throw new Error(String(r))
    expect(r.refs).toEqual([{ field: 'shot' }, { field: 'provider', type: 'provider' }])
    expect(r.prompt).toContain('<< title >>')
    expect(r.preset).toEqual(['fixture'])
    expect(r.styles).toEqual(['flat'])
    expect(typeof parseCoverRule('$type: object-type\n\n## $cover\n$wat: 1\n')).toBe('string')
    expect(typeof parseCoverRule('$type: object-type\n\n## $cover\n$refs: shot\n')).toBe('string')
    const svc = parseObjectType(TYPE.replace('$source: files', '$source: service\n$service: x'), '/t/slot.mdz', { codecs: ['mdz'] })
    expect('error' in svc && svc.error.message).toMatch(/только у файлового/)
  })
  it('нет обложки — missing; «недостающие» — запросы с рефами, стилем, оттенком; sidecar pending → queued', async () => {
    const { engine, calls } = setup()
    const rows = engine.list({ type: 'slot' }).rows
    expect(rows.map((r) => r.coverState)).toEqual(['missing', 'missing'])
    const res = engine.cover({ type: 'slot', mode: 'missing' })
    expect(res.queued.map((x) => x.id).sort()).toEqual(['coin', 'fish'])
    await flush()
    const coin = calls.find((c) => c.id === 'coin')!
    expect(coin.prompt).toMatch(/^icon for slot Coin Dragon by KND, accent cyan\n\nflat vector, bold shapes$/)
    expect(coin.refs.map((f) => f.split('/').pop())).toEqual(['KND.png'])
    expect(calls.find((c) => c.id === 'fish')!.refs.map((f) => f.split('/').pop())).toEqual(['fish.png'])
    expect(coin.style).toBe('flat')
    expect(coin.dir.endsWith('items/coin.assets')).toBe(true)
    const side = JSON.parse(readFileSync(join(coin.dir, 'cover.json'), 'utf-8'))
    expect(side.pending).toMatchObject({ hash: coin.hash, job: 'job-1' })
    expect(engine.list({ type: 'slot' }).rows.map((r) => r.coverState)).toEqual(['queued', 'queued'])
    // Повтор «недостающих» — в очереди уже, вторых задач нет.
    expect(engine.cover({ type: 'slot', mode: 'missing' }).queued).toEqual([])
  })
  it('готово → ready с обложкой и иконкой; правка поля шаблона → stale и сама в очередь', async () => {
    const { engine, calls, items } = setup()
    engine.cover({ type: 'slot', mode: 'missing' })
    await flush()
    for (const c of calls) finish(c)
    const rows = engine.list({ type: 'slot' }).rows
    expect(rows.map((r) => r.coverState)).toEqual(['ready', 'ready'])
    expect(rows[0]!.cover).toMatch(/^\/asset\/slot\/coin\/coin\.assets\/cover\.png\?v=\d+$/)
    expect(rows[0]!.icon).toMatch(/\/coin\.assets\/icon\.png\?v=/)
    expect(engine.asset('slot', 'coin', 'coin.assets/cover.png')?.mime).toBe('image/png')
    // Записи не плодятся из `.assets/cover.json`.
    expect(engine.list({ type: 'slot' }).total).toBe(2)
    const n = calls.length
    const doc = await engine.get({ type: 'slot', id: 'coin' })
    engine.save({ type: 'slot', id: 'coin', data: { ...doc.data, title: 'Coin Dragon II' } })
    await flush()
    expect(calls.length).toBe(n + 1)
    expect(calls.at(-1)!.prompt).toContain('Coin Dragon II')
    expect(engine.list({ type: 'slot' }).rows.find((r) => r.id === 'coin')!.coverState).toBe('queued')
    // Правка файла мимо save — список видит stale и ставит сам.
    finish(calls.at(-1)!)
    writeFileSync(join(items, 'fish.mdz'), '$slug: fish\n$title: Happy Fish 2\n$provider: BNG\n$shot: shots/fish.png\n')
    const m = calls.length
    expect(engine.list({ type: 'slot' }).rows.find((r) => r.id === 'fish')!.coverState).toBe('stale')
    await flush()
    expect(calls.length).toBe(m + 1)
    expect(calls.at(-1)!.id).toBe('fish')
  })
  it('реф поменялся содержимым — stale; touch без изменений — нет', async () => {
    const { engine, calls, items } = setup()
    engine.cover({ type: 'slot', mode: 'missing', ids: ['fish'] })
    await flush()
    finish(calls[0]!)
    writeFileSync(join(items, 'shots', 'fish.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]))
    expect(engine.list({ type: 'slot', filters: {} }).rows.find((r) => r.id === 'fish')!.coverState).toBe('ready')
    writeFileSync(join(items, 'shots', 'fish.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 9]))
    expect(engine.list({ type: 'slot' }).rows.find((r) => r.id === 'fish')!.coverState).toBe('stale')
  })
  it('ручная картинка и закреплённая не трогаются; «Перегенерировать» — ручную в корзину, замок снят', async () => {
    const { engine, calls, items } = setup()
    const dir = join(items, 'coin.assets')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'cover.png'), Buffer.from([7]))
    expect(engine.list({ type: 'slot' }).rows.find((r) => r.id === 'coin')!.coverState).toBe('manual')
    engine.cover({ type: 'slot', mode: 'all' })
    await flush()
    expect(calls.map((c) => c.id)).toEqual(['fish'])
    expect(readFileSync(join(dir, 'cover.png'))).toEqual(Buffer.from([7]))
    finish(calls[0]!)
    engine.coverLock({ type: 'slot', id: 'fish', locked: true })
    writeFileSync(join(items, 'fish.mdz'), '$slug: fish\n$title: Другое\n$provider: BNG\n$shot: shots/fish.png\n')
    expect(engine.list({ type: 'slot' }).rows.find((r) => r.id === 'fish')!.coverState).toBe('locked')
    engine.cover({ type: 'slot', mode: 'all' })
    await flush()
    expect(calls.length).toBe(1)
    engine.cover({ type: 'slot', mode: 'one', ids: ['coin'] })
    await flush()
    expect(calls.at(-1)!.id).toBe('coin')
    expect(existsSync(join(dir, 'cover.png'))).toBe(false)
    expect(existsSync(join(dir, '.nr-trash', 'cover.png'))).toBe(true)
  })
  it('ошибка генератора — в sidecar; авто её не повторяет', async () => {
    const root = setup()
    let fail = true
    const engine = createObjectsEngine({
      typeDirs: () => [join(root.root, 'types')],
      base: root.root,
      render,
      cover: () => {
        if (fail) throw new Error('comfy лёг')
        return {}
      },
    })
    engine.cover({ type: 'slot', mode: 'missing', ids: ['coin'] })
    await flush()
    const row = engine.list({ type: 'slot' }).rows.find((r) => r.id === 'coin')!
    expect(row.coverState).toBe('missing')
    expect(row.coverError).toBe('comfy лёг')
    fail = false
    expect(engine.cover({ type: 'slot', mode: 'one', ids: ['coin'] }).queued).toHaveLength(1)
  })
  it('стиль: у записи полем, у типа — в state; стили стенда списком', async () => {
    const { engine, calls } = setup()
    expect(engine.coverStyles({ type: 'slot' })).toEqual({ styles: [{ id: 'flat', title: 'Плоский' }, { id: 'oil', title: 'Масло' }], current: 'flat' })
    engine.coverStyle({ type: 'slot', style: 'oil', scope: 'type' })
    expect(engine.coverStyles({ type: 'slot' }).current).toBe('oil')
    engine.cover({ type: 'slot', mode: 'missing', ids: ['coin'] })
    await flush()
    expect(calls[0]!.prompt).toMatch(/oil painting$/)
    engine.coverStyle({ type: 'slot', id: 'fish', style: 'flat', scope: 'record' })
    expect((await engine.get({ type: 'slot', id: 'fish' })).data.cover_style).toBe('flat')
    expect(() => engine.coverStyle({ type: 'slot', style: 'nope', scope: 'type' })).toThrow(/нет стиля/)
  })
  it('без генератора — not_supported', () => {
    const { root } = setup()
    const engine = createObjectsEngine({ typeDirs: () => [join(root, 'types')], base: root, render })
    expect(() => engine.cover({ type: 'slot', mode: 'all' })).toThrow(/нет генератора/)
    expect(coverStateOf(join(root, 'none'), 'x').state).toBe('missing')
  })
})

describe('размер иконки обложки — $icon_size (icons-spec §3, ABC-682)', () => {
  const cover = (key: string): string => `$type: object-type\n$id: x\n$source: files\n\n## $cover\n$prompt: p\n${key}\n`
  it('$icon_size — без замечаний', () => {
    const r = parseCoverRule(cover('$icon_size: 128'))
    expect(typeof r).toBe('object')
    expect((r as { iconSize: number }).iconSize).toBe(128)
    expect((r as { warnings?: string[] }).warnings).toBeUndefined()
  })
  it('старый $icon читается с предупреждением', () => {
    const r = parseCoverRule(cover('$icon: 96')) as { iconSize: number; warnings?: string[] }
    expect(r.iconSize).toBe(96)
    expect(r.warnings?.join()).toMatch(/\$icon_size/)
  })
  it('по умолчанию 256; кривой размер — ошибка с именем ключа', () => {
    expect((parseCoverRule(cover('')) as { iconSize: number }).iconSize).toBe(256)
    expect(parseCoverRule(cover('$icon_size: 5'))).toMatch(/\$icon_size: 5/)
  })
})
