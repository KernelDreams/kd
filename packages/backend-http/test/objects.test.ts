import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ccv3Codec, createObjectsEngine, fieldsHash, loadObjectTypes, mdzCodec, parseObjectType, scoreText, stampIds } from '../src/objects.js'

const CODECS = ['ccv3', 'json', 'md']

const TYPE = `$type: object-type
$id: persona
$title: Персоны
$source: files
$paths: $personas
$format: ccv3
$id_field: id
$title_field: name
$subtitle: "<< description >>"
$badges: tags
$search: name^3, id^3, description
$filters: tags
$views: persona-card, inspector
$links: sessions.personas
`

function stand(): { root: string; types: string; personas: string } {
  const root = mkdtempSync(join(tmpdir(), 'objects-'))
  const types = join(root, 'types')
  const personas = join(root, 'personas')
  mkdirSync(types, { recursive: true })
  mkdirSync(personas, { recursive: true })
  writeFileSync(join(types, 'persona.mdz'), TYPE)
  const card = (name: string, description: string, tags: string[]): string =>
    JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name, description, tags, character_book: { entries: [{ keys: ['a'], content: 'x' }] } } })
  writeFileSync(join(personas, 'sol.json'), card('Сол', 'Северный ветер', ['ветер', 'север']))
  writeFileSync(join(personas, 'mira.json'), card('Мира', 'Хозяйка трактира', ['трактир']))
  writeFileSync(join(personas, 'sol.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  return { root, types, personas }
}

const render = (tpl: string, data: Record<string, unknown>): string => tpl.replace(/<<\s*([\w.]+)\s*>>/g, (_m, k: string) => String(k.split('.').reduce<unknown>((o, p) => (o as Record<string, unknown> | undefined)?.[p], data) ?? ''))

function engineOf(s: ReturnType<typeof stand>) {
  return createObjectsEngine({ typeDirs: () => [s.types], vars: (n) => (n === 'personas' ? s.personas : undefined), base: s.root, render })
}

describe('валидатор типа', () => {
  it('разбирает ключи, макрос $paths и веса поиска', () => {
    const r = parseObjectType(TYPE, '/x/persona.mdz', { vars: () => '/p', codecs: CODECS })
    expect('type' in r).toBe(true)
    if (!('type' in r)) return
    expect(r.type.dirs).toEqual(['/p'])
    expect(r.type.search).toEqual([{ field: 'name', weight: 3 }, { field: 'id', weight: 3 }, { field: 'description', weight: 1 }])
    expect(r.type.views).toEqual(['persona-card', 'inspector'])
    expect(r.type.subtitleTpl).toBe('<< description >>')
  })
  it.each([
    ['без $type', TYPE.replace('$type: object-type\n', '$type: nope\n'), 'object-type'],
    ['без $id_field', TYPE.replace('$id_field: id\n', ''), '$id_field'],
    ['неизвестный кодек', TYPE.replace('$format: ccv3', '$format: yaml'), 'кодека'],
    ['неизвестный ключ', TYPE + '$colour: red\n', '$colour'],
    ['плохой источник', TYPE.replace('$source: files', '$source: ftp'), 'files | service'],
    ['нет схемы', TYPE + '$schema: nope.json\n', 'нет схемы'],
  ])('%s — ошибка строкой', (_n, text, part) => {
    const r = parseObjectType(text, '/x/t.mdz', { codecs: CODECS })
    expect('error' in r && r.error.message).toContain(part)
  })
  it('битый тип не роняет остальные; стенд перебивает плагин по id', () => {
    const s = stand()
    writeFileSync(join(s.types, 'broken.mdz'), '$type: object-type\n$id: Bad Id\n')
    const plugin = join(s.root, 'plugin-types')
    mkdirSync(plugin)
    writeFileSync(join(plugin, 'persona.mdz'), TYPE.replace('$title: Персоны', '$title: Плагин'))
    const { types, errors } = loadObjectTypes([plugin, s.types], { vars: () => s.personas, codecs: CODECS })
    expect(types.get('persona')?.title).toBe('Персоны')
    expect(errors).toHaveLength(1)
    expect(errors[0]!.file).toContain('broken.mdz')
  })
})

describe('кодек ccv3', () => {
  it('туда-обратно: обёртка и чужие поля целы, _id проставлен и не теряется', () => {
    const src = Buffer.from(JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', foreign: 1, data: { name: 'Сол', character_book: { entries: [{ keys: ['a'] }, { keys: ['b'], _id: 'keep' }] } } }))
    const { data } = ccv3Codec.read(src)
    const entries = (data.character_book as { entries: Array<{ _id: string }> }).entries
    expect(entries[0]!._id).toMatch(/^[0-9a-f]{8}$/)
    expect(entries[1]!._id).toBe('keep')
    const out = JSON.parse(String(ccv3Codec.write({ ...data, description: 'новое' }, src)))
    expect(out.foreign).toBe(1)
    expect(out.spec).toBe('chara_card_v3')
    expect(out.data.description).toBe('новое')
    expect(out.data.character_book.entries.map((e: { _id: string }) => e._id)).toEqual([entries[0]!._id, 'keep'])
    const again = ccv3Codec.read(Buffer.from(JSON.stringify(out)))
    expect((again.data.character_book as { entries: Array<{ _id: string }> }).entries[0]!._id).toBe(entries[0]!._id)
  })
  it('v2 без обёртки data читается полями', () => {
    expect(ccv3Codec.read(Buffer.from(JSON.stringify({ name: 'Старый' }))).data.name).toBe('Старый')
  })
  it('stampIds не трогает массивы строк', () => {
    expect(stampIds({ tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] })
  })
})

describe('строки и поиск', () => {
  it('строки посчитаны бэкендом: заголовок, подзаголовок ntpl, аватар, бейджи', () => {
    const e = engineOf(stand())
    const { rows, facets, total } = e.list({ type: 'persona' })
    expect(total).toBe(2)
    expect(rows.map((r) => r.title)).toEqual(['Мира', 'Сол'])
    const sol = rows.find((r) => r.id === 'sol')!
    expect(sol.subtitle).toBe('Северный ветер')
    expect(sol.avatar).toMatch(/^\/asset\/persona\/sol\?v=\d+/)
    expect(sol.badges).toEqual(['ветер', 'север'])
    expect(facets.tags).toContainEqual(['трактир', 1])
  })
  it('«сол» по имени и sol по id; фасет сужает', () => {
    const e = engineOf(stand())
    expect(e.list({ type: 'persona', q: 'сол' }).rows.map((r) => r.id)).toEqual(['sol'])
    expect(e.list({ type: 'persona', q: 'sol' }).rows.map((r) => r.id)).toEqual(['sol'])
    expect(e.list({ type: 'persona', filters: { tags: ['трактир'] } }).rows.map((r) => r.id)).toEqual(['mira'])
  })
  it('scoreText: каждое слово обязано найтись, ё = е', () => {
    expect(scoreText([{ text: 'Ёлка', weight: 1 }], 'елка')).toBeGreaterThan(0)
    expect(scoreText([{ text: 'Сол', weight: 1 }], 'сол мира')).toBe(0)
  })
})

describe('CRUD', () => {
  it('create: обязательные id и имя, дубль id — ошибка поля; файл появился', () => {
    const s = stand()
    const e = engineOf(s)
    const empty = e.create({ type: 'persona', data: { name: '' } })
    expect('invalid' in empty && Object.keys(empty.invalid).sort()).toEqual(['id'])
    const dup = e.create({ type: 'persona', data: { id: 'sol', name: 'Ещё Сол' } })
    expect('invalid' in dup && dup.invalid.id).toContain('уже есть')
    const ok = e.create({ type: 'persona', data: { id: 'ren', name: 'Рен' } })
    expect('doc' in ok).toBe(true)
    const card = JSON.parse(readFileSync(join(s.personas, 'ren.json'), 'utf-8'))
    expect(card.data).toEqual({ name: 'Рен' })
  })
  it('save с чужим хэшем — conflict; remove — в .nr-trash вместе с картинкой', async () => {
    const s = stand()
    const e = engineOf(s)
    const doc = await e.get({ type: 'persona', id: 'sol' })
    writeFileSync(join(s.personas, 'sol.json'), readFileSync(join(s.personas, 'sol.json'), 'utf-8').replace('Северный', 'Южный'))
    const r = e.save({ type: 'persona', id: 'sol', data: { ...doc.data, description: 'моё' }, hash: doc.hash })
    expect('conflict' in r).toBe(true)
    expect(e.remove({ type: 'persona', ids: ['sol'] }).removed).toEqual(['sol'])
    expect(readdirSync(join(s.personas, '.nr-trash')).sort()).toEqual(['sol.json', 'sol.png'])
    expect(existsSync(join(s.personas, 'sol.json'))).toBe(false)
  })
  it('дублировать — копия со ссылкой на источник; правка оригинала — копия «отстала»', async () => {
    const s = stand()
    const e = engineOf(s)
    const r = e.duplicate({ type: 'persona', id: 'sol' })
    expect('doc' in r && r.doc.id).toBe('sol-copy')
    const card = JSON.parse(readFileSync(join(s.personas, 'sol-copy.json'), 'utf-8'))
    expect(card.data.extensions.nrchat.source).toMatchObject({ type: 'persona', id: 'sol' })
    expect(existsSync(join(s.personas, 'sol-copy.png'))).toBe(true)
    expect((await e.links({ type: 'persona', id: 'sol' })).map((l) => [l.id, l.stale ?? false])).toEqual([['sol-copy', false]])
    const doc = await e.get({ type: 'persona', id: 'sol' })
    e.save({ type: 'persona', id: 'sol', data: { ...doc.data, description: 'другое' } })
    expect((await e.links({ type: 'persona', id: 'sol' }))[0]!.stale).toBe(true)
  })
  it('документ несёт fieldsHash — тот же, что hash ссылки копии (v1.50)', async () => {
    const s = stand()
    const e = engineOf(s)
    const doc = await e.get({ type: 'persona', id: 'sol' })
    const r = e.duplicate({ type: 'persona', id: 'sol' })
    const copy = JSON.parse(readFileSync(join(s.personas, 'sol-copy.json'), 'utf-8'))
    expect('doc' in r).toBe(true)
    expect(doc.fieldsHash).toBe(copy.data.extensions.nrchat.source.hash)
    expect(doc.fieldsHash).toBe(fieldsHash(doc.data))
  })
  it('fieldsHash не зависит от _id и ссылки на источник', () => {
    expect(fieldsHash({ a: [{ _id: '1', k: 1 }] })).toBe(fieldsHash({ a: [{ _id: '2', k: 1 }], extensions: { nrchat: {} } }))
  })
})

describe('версии и mdz', () => {
  it('$version: старый объект читается по миграциям, при сохранении пишется новой версией', async () => {
    const s = stand()
    writeFileSync(join(s.types, 'persona.mdz'), TYPE + '$version: 2\n')
    mkdirSync(join(s.types, 'migrations'))
    writeFileSync(join(s.types, 'migrations', '1-2.json'), JSON.stringify({ rename: { description: 'summary' }, set: { kind: 'persona' } }))
    const e = engineOf(s)
    const doc = await e.get({ type: 'persona', id: 'sol' })
    expect(doc.data).toMatchObject({ summary: 'Северный ветер', kind: 'persona', extensions: { nrchat: { version: 2 } } })
    expect(doc.data.description).toBeUndefined()
    expect(JSON.parse(readFileSync(join(s.personas, 'sol.json'), 'utf-8')).data.description).toBe('Северный ветер')
    e.save({ type: 'persona', id: 'sol', data: doc.data })
    const card = JSON.parse(readFileSync(join(s.personas, 'sol.json'), 'utf-8'))
    expect(card.data).toMatchObject({ summary: 'Северный ветер', extensions: { nrchat: { version: 2 } } })
  })
  it('mdz: атрибуты корня — поля, секции целы, новый ключ — в конец, снятый уходит', () => {
    const src = Buffer.from('$title: Первая\n$tags: a, b\n## $body\nтекст\n')
    const { data } = mdzCodec.read(src)
    expect(data).toEqual({ title: 'Первая', tags: 'a, b' })
    const out = String(mdzCodec.write({ title: 'Вторая', n: 3 }, src))
    expect(out).toBe('$title: Вторая\n$n: 3\n## $body\nтекст\n')
  })
})

// ── карточки работ (objects-spec §15.1) ────────────────────────────

const SLOT_TYPE = `$type: object-type
$id: slot
$title: Слоты
$paths: $slot_dirs/*/CARD.mdz
$format: mdz
$id_from: dir
$id_field: slug
$title_field: title
$search: title^3, slug^3, aliases^2
$filters: customer
$columns: customer, provider, state
$index: INDEX.md
$index_columns: title, slug, state
$index_sort: -last_delivery
`

const ACC_TYPE = `$type: object-type
$id: acceptance
$title: На приёмку
$paths: $slot_dirs/*/acceptance/*.mdz
$format: mdz
$id_from: file
$id_field: task
$sort: priority
$states: ready → accepted | returned | postponed; accepted → sent; returned → ready; postponed → ready
$state_labels: accepted=Принять, returned=Вернуть, postponed=Отложить, sent=Отправлено
$state_args: returned=comment, postponed=until
$waiting: state=ready
`

const CHAT_TYPE = `$type: object-type
$id: chat-card
$paths: sessions/*/*.assets/card.mdz
$format: mdz
$id_from: field session
$id_field: session
`

function cardsStand() {
  const root = mkdtempSync(join(tmpdir(), 'cards-'))
  const types = join(root, 'types')
  const results = join(root, 'results')
  mkdirSync(types, { recursive: true })
  writeFileSync(join(types, 'slot.mdz'), SLOT_TYPE)
  writeFileSync(join(types, 'acceptance.mdz'), ACC_TYPE)
  writeFileSync(join(types, 'chat-card.mdz'), CHAT_TYPE)
  const slot = (slug: string, head: string, body: string): void => {
    mkdirSync(join(results, slug, 'acceptance'), { recursive: true })
    writeFileSync(join(results, slug, 'CARD.mdz'), `${head}\n${body}`)
    writeFileSync(join(results, slug, 'STATE.md'), '# не карточка\n')
  }
  slot('coin_dragon', '$slug: coin_dragon\n$title: Coin Dragon\n$customer: erin\n$state: review\n$aliases: [дракон, монета]\n$last_delivery: 2026-10-16\n', '# Coin Dragon\n\n![экран](shots/main.png)\n')
  slot('boom_gold', '$slug: boom_gold\n$title: "Boom! Boom! Gold!"\n$customer: erin\n$state: delivered\n$last_delivery: 2026-10-14\n', '# Boom\n')
  mkdirSync(join(results, 'coin_dragon', 'shots'), { recursive: true })
  writeFileSync(join(results, 'coin_dragon', 'shots', 'main.png'), Buffer.from([0x89, 0x50]))
  writeFileSync(join(results, 'secret.png'), Buffer.from([1]))
  writeFileSync(join(results, 'INDEX.md'), '# Слоты\n\nшапка\n\n| старое |\n|---|\n| x |\n\nхвост\n')
  const acc = (slug: string, task: string, state: string, priority: number, extra = ''): void =>
    writeFileSync(join(results, slug, 'acceptance', `${task}.mdz`), `$task: ${task}\n$slot: ${slug}\n$state: ${state}\n$priority: ${priority}\n${extra}\n## Просили\nчто-то\n`)
  acc('coin_dragon', 'DKS-1', 'ready', 2)
  acc('coin_dragon', 'DKS-2', 'ready', 1)
  acc('boom_gold', 'DKS-3', 'postponed', 3, '$until: 2020-01-01\n')
  acc('boom_gold', 'DKS-4', 'postponed', 4, '$until: 2999-01-01\n')
  const sess = join(root, 'sessions', 'nr')
  mkdirSync(join(sess, 's1.assets'), { recursive: true })
  writeFileSync(join(sess, 's1.mds'), '%meta {}\n')
  writeFileSync(join(sess, 's1.assets', 'card.mdz'), '$session: s1\n$title: Чат про DKS-1\n\n# Чат\n')
  const engine = createObjectsEngine({ typeDirs: () => [types], vars: (n) => (n === 'slot_dirs' ? results : undefined), base: root, render })
  return { root, results, engine }
}

describe('mdz-карточки (ABC-493)', () => {
  it('шапка построчно: несменённое как лежало, тело байт в байт, списки', () => {
    const src = Buffer.from('$title: "Boom! Gold"\n$tags: [a, b]\n$n: 1\n\n# Заголовок\n\n| t | x |\n|---|---|\n')
    const { data } = mdzCodec.read(src)
    expect(data.tags).toEqual(['a', 'b'])
    expect(data.text).toBe('# Заголовок\n\n| t | x |\n|---|---|')
    const out = String(mdzCodec.write({ ...data, n: 2, tags: ['a', 'b', 'c'], extra: 'x # y' }, src))
    expect(out).toBe('$title: "Boom! Gold"\n$tags: [a, b, c]\n$n: 2\n$extra: "x # y"\n\n# Заголовок\n\n| t | x |\n|---|---|\n')
    // заголовок из тела не становится полем
    const plain = Buffer.from('$a: 1\n\n# Title\n')
    expect(String(mdzCodec.write(mdzCodec.read(plain).data, plain))).toBe('$a: 1\n\n# Title\n')
  })
  it('маска и id: папка, файл, поле; STATE.md мимо', () => {
    const { engine } = cardsStand()
    expect(engine.types().errors).toEqual([])
    expect(engine.list({ type: 'slot' }).rows.map((r) => r.id).sort()).toEqual(['boom_gold', 'coin_dragon'])
    expect(engine.list({ type: 'acceptance' }).rows.map((r) => r.id)).toEqual(['DKS-2', 'DKS-1', 'DKS-3', 'DKS-4'])
    expect(engine.list({ type: 'chat-card' }).rows.map((r) => r.id)).toEqual(['s1'])
    expect(engine.list({ type: 'slot', q: 'дракон' }).rows.map((r) => r.id)).toEqual(['coin_dragon'])
    expect(engine.list({ type: 'slot', q: 'coin' }).rows.map((r) => r.id)).toEqual(['coin_dragon'])
  })
  it('postponed с прошедшим until — ready, файл цел; $waiting', async () => {
    const { engine, results } = cardsStand()
    const ready = engine.list({ type: 'acceptance', filters: { state: ['ready'] } })
    expect(ready.rows.map((r) => r.id).sort()).toEqual(['DKS-1', 'DKS-2', 'DKS-3'])
    expect(readFileSync(join(results, 'boom_gold', 'acceptance', 'DKS-3.mdz'), 'utf-8')).toContain('$state: postponed')
    const t = engine.types().types.find((x) => x.id === 'acceptance')!
    expect(t.waiting).toEqual({ state: ['ready'] })
    expect(t.states?.labels.accepted).toBe('Принять')
  })
  it('переходы $states: accept пишет state и decided_at; sent до accepted нельзя; returned требует comment', async () => {
    const { engine, results } = cardsStand()
    const bad = engine.setState({ type: 'acceptance', id: 'DKS-1', to: 'sent' })
    expect('invalid' in bad).toBe(true)
    const need = engine.setState({ type: 'acceptance', id: 'DKS-2', to: 'returned' })
    expect('invalid' in need && need.invalid.comment).toBeTruthy()
    const ok = engine.setState({ type: 'acceptance', id: 'DKS-1', to: 'accepted', input: { comment: 'ок' } })
    expect('doc' in ok).toBe(true)
    const text = readFileSync(join(results, 'coin_dragon', 'acceptance', 'DKS-1.mdz'), 'utf-8')
    expect(text).toMatch(/^\$task: DKS-1\n\$slot: coin_dragon\n\$state: accepted\n\$priority: 2\n/)
    expect(text).toMatch(/\$decided_at: \S+/)
    expect(text).toContain('$comment: ок')
    expect(text).toContain('## Просили\nчто-то\n')
    expect('doc' in engine.setState({ type: 'acceptance', id: 'DKS-1', to: 'sent' })).toBe(true)
    // виртуальный ready из postponed → accepted
    expect('doc' in engine.setState({ type: 'acceptance', id: 'DKS-3', to: 'accepted' })).toBe(true)
  })
  it('save слота: поле формы меняется, $slug и тело на месте; create по маске', () => {
    const { engine, results } = cardsStand()
    const r = engine.save({ type: 'slot', id: 'coin_dragon', data: { slug: 'coin_dragon', title: 'Coin Dragon', customer: 'erin', state: 'delivered', aliases: ['дракон', 'монета'], last_delivery: '2026-10-16', text: '# Coin Dragon\n\n![экран](shots/main.png)\n' } })
    expect('doc' in r).toBe(true)
    const text = readFileSync(join(results, 'coin_dragon', 'CARD.mdz'), 'utf-8')
    expect(text).toBe('$slug: coin_dragon\n$title: Coin Dragon\n$customer: erin\n$state: delivered\n$aliases: [дракон, монета]\n$last_delivery: 2026-10-16\n\n# Coin Dragon\n\n![экран](shots/main.png)\n')
    const c = engine.create({ type: 'slot', data: { slug: 'new_slot', title: 'New' } })
    expect('doc' in c).toBe(true)
    expect(existsSync(join(results, 'new_slot', 'CARD.mdz'))).toBe(true)
  })
  it('слот книгой (ABC-548): две маски — CARD.mdz Erin и *.book.mdz наших; create дописывает $defaults', () => {
    const root = mkdtempSync(join(tmpdir(), 'obj-book-'))
    const types = join(root, 'types')
    const erin = join(root, 'erin')
    const ours = join(root, 'ours')
    for (const d of [types, join(erin, 'lucky'), join(ours, 'cleo')]) mkdirSync(d, { recursive: true })
    writeFileSync(join(types, 'slot.mdz'), SLOT_TYPE.replace('$paths: $slot_dirs/*/CARD.mdz', '$paths: $slot_dirs/*/CARD.mdz, $slot_dirs/*/*.book.mdz\n$defaults: book=true, template=slot'))
    writeFileSync(join(erin, 'lucky', 'CARD.mdz'), '$book: true\n$template: slot\n$slug: lucky\n$title: Lucky\n$customer: erin\n\n# Lucky\n')
    writeFileSync(join(ours, 'cleo', 'cleo.book.mdz'), '$book: Cleo — паршит\n$template: slot\n$slug: cleo\n$title: Cleo\n$customer: acme\n\n## $source own\n$path: a.json\n')
    const engine = createObjectsEngine({ typeDirs: () => [types], vars: (n) => (n === 'slot_dirs' ? [erin, ours] : undefined), base: root })
    const rows = engine.list({ type: 'slot' }).rows
    expect(rows.map((r) => r.id).sort()).toEqual(['cleo', 'lucky'])
    expect(engine.types().types.find((t) => t.id === 'slot')).not.toHaveProperty('defaults')
    const c = engine.create({ type: 'slot', data: { slug: 'new_one', title: 'New One' } })
    expect('doc' in c).toBe(true)
    const text = readFileSync(join(erin, 'new_one', 'CARD.mdz'), 'utf-8')
    expect(text).toMatch(/^\$book: true$/m)
    expect(text).toMatch(/^\$template: slot$/m)
    // Сохранение полей книги не трогает её разделы.
    const s = engine.save({ type: 'slot', id: 'cleo', data: { slug: 'cleo', title: 'Cleo', customer: 'acme', state: 'dev', book: 'Cleo — паршит', template: 'slot' } })
    expect('doc' in s).toBe(true)
    expect(readFileSync(join(ours, 'cleo', 'cleo.book.mdz'), 'utf-8')).toContain('## $source own\n$path: a.json')
    rmSync(root, { recursive: true, force: true })
  })
  it('срезы типа (ABC-548, v1.58): ## $slice → title, icon, q и фасеты f.<поле>; плохой id — ошибка типа', () => {
    const text = SLOT_TYPE + '\n## $slice erin\n$title: Слоты Erin\n$icon: gem\n$customer: erin\n$template: slot\n\n## $slice ours\n$title: Наши\n$customer: [acme, digicode]\n$q: wheel\n'
    const t = parseObjectType(text, '/x/slot.mdz', { codecs: ['mdz'] })
    expect('type' in t && t.type.slices).toEqual([
      { id: 'erin', title: 'Слоты Erin', icon: 'gem', params: { 'f.customer': 'erin', 'f.template': 'slot' } },
      { id: 'ours', title: 'Наши', params: { 'f.customer': 'acme,digicode', q: 'wheel' } },
    ])
    expect('error' in parseObjectType(SLOT_TYPE + '\n## $slice Bad Id\n$title: x\n', '/x/slot.mdz', { codecs: ['mdz'] })).toBe(true)
  })
  it('картинка по относительному пути — только внутри папки объекта', () => {
    const { engine } = cardsStand()
    expect(engine.asset('slot', 'coin_dragon', 'shots/main.png')?.mime).toBe('image/png')
    expect(engine.asset('slot', 'coin_dragon', '../secret.png')).toBeNull()
    expect(engine.asset('slot', 'coin_dragon', '../../results/secret.png')).toBeNull()
  })
  it('оглавление: таблица заменена, текст вокруг цел, свежие сверху', () => {
    const { engine, results } = cardsStand()
    const r = engine.index({ type: 'slot' })
    expect(r.rows).toBe(2)
    const text = readFileSync(join(results, 'INDEX.md'), 'utf-8')
    expect(text).toBe('# Слоты\n\nшапка\n\n| title | slug | state | карточка |\n|---|---|---|---|\n| Coin Dragon | coin_dragon | review | [CARD.mdz](coin_dragon/CARD.mdz) |\n| Boom! Boom! Gold! | boom_gold | delivered | [CARD.mdz](boom_gold/CARD.mdz) |\n\nхвост\n')
  })
  it('валидатор: плохие $states и $id_from — ошибка строкой', () => {
    expect('error' in parseObjectType(ACC_TYPE.replace('ready → accepted', 'ready accepted'), '/x/a.mdz', { codecs: ['mdz'] })).toBe(true)
    expect('error' in parseObjectType(SLOT_TYPE.replace('$id_from: dir', '$id_from: folder'), '/x/s.mdz', { codecs: ['mdz'] })).toBe(true)
  })
})

describe('сортировка', () => {
  it('-поле — по убыванию, числа — как числа', () => {
    const { engine } = cardsStand()
    expect(engine.list({ type: 'slot', sort: '-last_delivery' }).rows.map((r) => r.id)).toEqual(['coin_dragon', 'boom_gold'])
    expect(engine.list({ type: 'slot', sort: 'last_delivery' }).rows.map((r) => r.id)).toEqual(['boom_gold', 'coin_dragon'])
    engine.create({ type: 'slot', data: { slug: 'nodate', title: 'Без даты' } })
    // пустое — в конец в обе стороны
    expect(engine.list({ type: 'slot', sort: '-last_delivery' }).rows.map((r) => r.id)).toEqual(['coin_dragon', 'boom_gold', 'nodate'])
    expect(engine.list({ type: 'slot', sort: 'last_delivery' }).rows.map((r) => r.id)).toEqual(['boom_gold', 'coin_dragon', 'nodate'])
  })
})

describe('редакторы типа (v1.52, ABC-499)', () => {
  it('$views: sheet=fate — вид sheet, текст editors/fate.editor.mdz; нет файла — editorErrors, тип жив', () => {
    const s = stand()
    writeFileSync(join(s.types, 'persona.mdz'), TYPE.replace('$views: persona-card, inspector', '$views: sheet=fate-sheet, card=nope, inspector'))
    mkdirSync(join(s.types, 'editors'))
    writeFileSync(join(s.types, 'editors', 'fate-sheet.editor.mdz'), '$editor: 1\n$id: fate-sheet\n$title: "Лист Fate"\n\n## $section main\n')
    const { types, errors } = loadObjectTypes([s.types], { codecs: CODECS, vars: () => s.personas })
    expect(errors).toEqual([])
    const t = types.get('persona')!
    expect(t.views).toEqual(['sheet', 'card', 'inspector'])
    expect(t.editors).toEqual([expect.objectContaining({ id: 'fate-sheet', view: 'sheet', title: 'Лист Fate', format: 'mdz' })])
    expect(t.editors![0]!.text).toContain('## $section main')
    expect(t.editorErrors).toEqual(['вид card: нет редактора editors/nope.editor.mdz'])
    const info = createObjectsEngine({ typeDirs: () => [s.types], vars: () => s.personas, base: s.root }).types().types[0]!
    expect(info.editors?.[0]?.view).toBe('sheet')
    expect('editorRefs' in info).toBe(false)
  })
  it('битая запись вида — ошибка типа', () => {
    const r = parseObjectType(TYPE.replace('$views: persona-card, inspector', '$views: sheet=, inspector'), '/x/persona.mdz', { vars: () => '/p', codecs: CODECS })
    expect('error' in r && r.error.message).toContain('$views')
  })
})

describe('не-файловые типы, $parent, $discuss (v1.53, ABC-507)', () => {
  const SVC = '$type: object-type\n$id: agent\n$source: service\n$service: agents\n$id_field: id\n$title_field: name\n'
  it('service: нужен $service, путей и формата не нужно', () => {
    const r = parseObjectType(SVC, '/x/agent.mdz', { codecs: CODECS })
    expect('type' in r && r.type.service).toBe('agents')
    const bad = parseObjectType(SVC.replace('$service: agents\n', ''), '/x/agent.mdz', { codecs: CODECS })
    expect('error' in bad && bad.error.message).toContain('$service')
  })
  it('$parent и $discuss по заказчику', () => {
    const text = `${SVC.replace('service', 'files').replace('$service: agents\n', '$format: mdz\n$paths: /r\n')}$parent: slot -> slot\n$discuss.erin.agent: erin-slots\n$discuss.erin.skills: erin-games, slot-math\n$discuss.erin.space: DUK\n`
    const r = parseObjectType(text, '/x/a.mdz', { codecs: ['mdz'] })
    if (!('type' in r)) throw new Error(r.error.message)
    expect(r.type.parent).toEqual({ field: 'slot', type: 'slot' })
    expect(r.type.discuss).toEqual({ erin: { agent: 'erin-slots', skills: ['erin-games', 'slot-math'], space: 'DUK' } })
    expect('error' in parseObjectType(text.replace('slot -> slot', 'slot'), '/x/a.mdz', { codecs: ['mdz'] })).toBe(true)
  })
})

describe('хранилища типа (rp-build-spec §13.1)', () => {
  /** Вид `folder`: папка с `bot.md`, первая строка — имя; картинка — `avatar.png`. */
  const folder = {
    scan: (root: string) => readdirSync(root).filter((d) => existsSync(join(root, d, 'bot.md'))).map((d) => ({ id: d, file: join(root, d, 'bot.md') })),
    read: (file: string) => ({ name: readFileSync(file, 'utf-8').split('\n')[0]!, tags: ['фабрика'] }),
    avatar: (file: string) => (existsSync(join(file, '..', 'avatar.png')) ? join(file, '..', 'avatar.png') : null),
  }
  function stores() {
    const s = stand()
    const factory = join(s.root, 'factory')
    mkdirSync(join(factory, 'rin'), { recursive: true })
    writeFileSync(join(factory, 'rin', 'bot.md'), 'Рин\n')
    writeFileSync(join(factory, 'rin', 'avatar.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    mkdirSync(join(factory, 'sol'), { recursive: true })
    writeFileSync(join(factory, 'sol', 'bot.md'), 'Сол фабрики\n')
    const value = [
      { id: 'lib', path: s.personas, title: 'Библиотека' },
      { id: 'mine', path: factory, layout: 'folder', title: 'Фабрика', group: 'свои' },
      { id: 'pc', source: 'service:bots-archive', title: 'Архив' },
      { id: 'far', host: 'some-other-host-xyz', path: '/nope' },
      { id: 'gone', path: join(s.root, 'nope') },
    ]
    const engine = createObjectsEngine({ typeDirs: () => [s.types], vars: (n) => (n === 'personas' ? value : undefined), base: s.root, render, layouts: { folder } })
    return { s, engine, factory }
  }
  it('блоки `$personas <id>` — полки типа: путь, вид, сервис, машина, нет папки', () => {
    const { engine } = stores()
    const t = engine.types().types.find((x) => x.id === 'persona')!
    expect(t.stores?.map((x) => x.id)).toEqual(['lib', 'mine', 'pc', 'far', 'gone'])
    const by = Object.fromEntries((t.stores ?? []).map((x) => [x.id, x]))
    expect(by.mine).toMatchObject({ layout: 'folder', readonly: true, group: 'свои' })
    expect(by.mine!.offline).toBeUndefined()
    expect(by.pc).toMatchObject({ service: 'bots-archive', readonly: true })
    expect(by.far!.offline).toMatch(/some-other-host-xyz/)
    expect(by.gone!.offline).toMatch(/нет папки/)
  })
  it('list {store}: записи своей полки; id вида — с префиксом хранилища, slug не перекрывает библиотеку', () => {
    const { engine } = stores()
    expect(engine.list({ type: 'persona' }).total).toBe(4)
    const mine = engine.list({ type: 'persona', store: 'mine' })
    expect(mine.rows.map((r) => r.id).sort()).toEqual(['mine/rin', 'mine/sol'])
    expect(mine.rows.every((r) => r.store === 'mine')).toBe(true)
    expect(mine.rows.find((r) => r.id === 'mine/rin')!.avatar).toMatch(/^\/asset\/persona\/mine%2Frin/)
    expect(engine.list({ type: 'persona', store: 'lib' }).rows.map((r) => r.id).sort()).toEqual(['mira', 'sol'])
    expect(engine.list({ type: 'persona', store: 'pc' }).total).toBe(0)
    expect(engine.asset('persona', 'mine/rin')?.mime).toBe('image/png')
  })
  it('хранилище вида только читается; копия — в библиотеку со ссылкой {store, type, id, hash}', async () => {
    const { engine } = stores()
    expect(() => engine.save({ type: 'persona', id: 'mine/rin', data: { name: 'x' } })).toThrow(/только для чтения/)
    expect(() => engine.remove({ type: 'persona', ids: ['mine/rin'] })).toThrow(/только для чтения/)
    const doc = await engine.get({ type: 'persona', id: 'mine/rin' })
    const r = engine.duplicate({ type: 'persona', id: 'mine/rin' })
    if (!('doc' in r)) throw new Error('нет копии')
    expect(r.doc.id).toBe('rin')
    expect(r.doc.row.store).toBe('lib')
    expect(r.doc.row.source).toEqual({ store: 'mine', type: 'persona', id: 'mine/rin', hash: doc.fieldsHash })
    expect(existsSync(join(r.doc.path!, '..', 'rin.png'))).toBe(true)
  })
  it('$readonly у папки карточек: создание идёт в первое хранилище, куда можно писать', () => {
    const s = stand()
    const other = join(s.root, 'other')
    mkdirSync(other)
    const engine = createObjectsEngine({
      typeDirs: () => [s.types],
      vars: (n) => (n === 'personas' ? { ro: { path: s.personas, readonly: 'true' }, rw: { path: other } } : undefined),
      base: s.root,
      render,
    })
    const r = engine.create({ type: 'persona', data: { id: 'neo', name: 'Нео' } })
    if (!('doc' in r)) throw new Error(r.message)
    expect(r.doc.path).toBe(join(other, 'neo.json'))
    expect(() => engine.save({ type: 'persona', id: 'sol', data: { name: 'x' } })).toThrow(/только для чтения/)
  })
})

describe('хранилища: свежая запись снаружи', () => {
  it('файл, положенный мимо движка, находится сразу (кэш обхода не мешает)', async () => {
    const s = stand()
    const factory = join(s.root, 'factory')
    mkdirSync(factory)
    const layout = { scan: () => [], read: () => ({}) }
    const engine = createObjectsEngine({ typeDirs: () => [s.types], vars: (n) => (n === 'personas' ? [{ id: 'lib', path: s.personas }, { id: 'f', path: factory, layout: 'x' }] : undefined), base: s.root, render, layouts: { x: layout } })
    expect(engine.list({ type: 'persona' }).total).toBe(2)
    writeFileSync(join(s.personas, 'neo.json'), JSON.stringify({ spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Нео' } }))
    expect((await engine.get({ type: 'persona', id: 'neo' })).row.store).toBe('lib')
  })
})
