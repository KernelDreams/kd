/**
 * Настройки по слоям (v1.40, settings-spec §1–3, §6): `createFsSettings` на файлах,
 * `serveBackend({settings})` — роуты, capability, стрим изменений; клиент — тот же
 * createHttpBackend.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { PersonasDoc, SessionMetaDoc, SessionMetaPatch, SettingsChangedEvent } from '@kerneldreams/ui-protocol'
import { createHttpBackend } from '../src/client.js'
import { createFsSettings, parseSettingsText, removeSettingsText, writeSettingsText } from '../src/settings.js'
import { serveBackend, type ServeHandle } from '../src/serve.js'
import { createStoreBackend } from '../src/store-backend.js'

let dir: string
let srv: ServeHandle | undefined
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nr-settings-'))
})
afterEach(async () => {
  await srv?.close()
  srv = undefined
  rmSync(dir, { recursive: true, force: true })
})

const SCOPES_ALL = ['session', 'bot', 'agent', 'project', 'space', 'user', 'stand'] as const

function metaPort() {
  const docs = new Map<string, SessionMetaDoc>()
  return {
    docs,
    get: async (id: string): Promise<SessionMetaDoc> => structuredClone(docs.get(id) ?? {}),
    patch: async (id: string, patch: SessionMetaPatch): Promise<SessionMetaDoc> => {
      const cur: Record<string, unknown> = { ...(docs.get(id) ?? {}) }
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) delete cur[k]
        else cur[k] = v
      }
      docs.set(id, cur as SessionMetaDoc)
      return cur as SessionMetaDoc
    },
  }
}

describe('файл слоя (mdz)', () => {
  it('список объектов (места pics, ABC-787) переживает запись и чтение; список строк — по-прежнему flow-записью', () => {
    const places = [{ path: '/Users/x/qa, [1]' }, { path: '~', host: 'pc', name: 'Кот: "да"' }]
    const text = writeSettingsText('', 'nrchat-collection', 'picsPlaces', places)
    expect(parseSettingsText(text)['nrchat-collection']!.picsPlaces).toEqual(places)
    expect(writeSettingsText('', 'p', 'k', ['a', 'b'])).toBe('## $settings p\n$k: $[a, b]\n')
    expect(parseSettingsText(writeSettingsText(text, 'nrchat-collection', 'picsPlaces', []))['nrchat-collection']!.picsPlaces).toEqual([])
  })

  it('читает блоки по плагинам и пишет точечно, не трогая чужое', () => {
    const src = '// мой файл\n$name: x\n\n## $settings theme\n$skin: tavern\n$scale: 1.5\n\n## $settings tabs\n$policy: obsidian\n'
    expect(parseSettingsText(src)).toEqual({ theme: { skin: 'tavern', scale: 1.5 }, tabs: { policy: 'obsidian' } })

    const next = writeSettingsText(src, 'theme', 'skin', 'parchment')
    expect(next).toContain('$skin: parchment')
    expect(next).toContain('// мой файл')
    expect(next).toContain('$policy: obsidian')

    const added = writeSettingsText(next, 'voice', 'rate', 1.2)
    expect(parseSettingsText(added).voice).toEqual({ rate: 1.2 })
    expect(parseSettingsText(removeSettingsText(added, 'theme', 'scale')).theme).toEqual({ skin: 'parchment' })
    // снятие ключа, которого нет, — текст без изменений
    expect(removeSettingsText(added, 'theme', 'nope')).toBe(added)
  })

  it('значения: флаг, число, строка, похожая на число, список, объект переживают круг', () => {
    let t = ''
    const cases: Array<[string, unknown]> = [
      ['flag', true],
      ['num', 2.5],
      ['text', 'hello world'],
      ['numlike', '1.5'],
      ['boollike', 'true'],
      ['list', ['a', 'b']],
      ['obj', { a: 1, b: 'x' }],
    ]
    for (const [k, v] of cases) t = writeSettingsText(t, 'p', k, v)
    const got = parseSettingsText(t).p!
    for (const [k, v] of cases) expect(got[k], k).toEqual(v)
  })
})

describe('createFsSettings', () => {
  const make = (extra: Partial<Parameters<typeof createFsSettings>[0]> = {}) => createFsSettings({ root: dir, owner: 'alice', ...extra })

  it('каскад: узкий слой перебивает широкий, происхождение — слой-победитель', async () => {
    const s = make()
    mkdirSync(join(dir, 'settings'), { recursive: true })
    writeFileSync(join(dir, 'settings', 'stand.mdz'), '## $settings theme\n$skin: parchment\n$mode: dark\n')
    await s.set({ plugin: 'theme', key: 'skin', value: 'tavern', layer: 'user', context: {} })
    await s.set({ plugin: 'theme', key: 'skin', value: 'scene', layer: 'space', context: { space: 'rp' } }, 'alice')

    const scopes = { theme: { skin: [...SCOPES_ALL], mode: ['user', 'stand'] as never } }
    const inRp = await s.get({ space: 'rp', scopes })
    expect(inRp.values.theme).toEqual({ skin: 'scene', mode: 'dark' })
    expect(inRp.origin.theme).toEqual({ skin: 'space', mode: 'stand' })

    const elsewhere = await s.get({ space: 'other', scopes })
    expect(elsewhere.values.theme!.skin).toBe('tavern')
    expect(elsewhere.origin.theme!.skin).toBe('user')
    expect(elsewhere.layers.space).toMatchObject({ present: true, values: {} })

    await s.reset({ plugin: 'theme', key: 'skin', layer: 'space', context: { space: 'rp' } })
    expect((await s.get({ space: 'rp', scopes })).values.theme!.skin).toBe('tavern')
  })

  it('ключ без пометки scopes живёт только в user и stand: узкий слой игнорируется', async () => {
    const s = make()
    await s.set({ plugin: 'tabs', key: 'policy', value: 'obsidian', layer: 'user', context: {} })
    await s.set({ plugin: 'tabs', key: 'policy', value: 'sneaky', layer: 'space', context: { space: 'rp' } })
    const snap = await s.get({ space: 'rp' })
    expect(snap.values.tabs).toEqual({ policy: 'obsidian' })
    expect(snap.layers.space!.values.tabs).toEqual({ policy: 'sneaky' }) // слой хранит, каскад — фильтрует
  })

  it('слой пользователя — свой у каждого; общие слои пишет только владелец', async () => {
    const s = make()
    await s.set({ plugin: 'theme', key: 'skin', value: 'a', layer: 'user', context: {} }, 'alice')
    await s.set({ plugin: 'theme', key: 'skin', value: 'b', layer: 'user', context: {} }, 'anna')
    expect((await s.get({}, 'alice')).values.theme!.skin).toBe('a')
    expect((await s.get({}, 'anna')).values.theme!.skin).toBe('b')
    expect(readFileSync(join(dir, 'users', 'anna', 'settings.mdz'), 'utf-8')).toContain('## $settings theme')

    await expect(s.set({ plugin: 'theme', key: 'skin', value: 'x', layer: 'stand', context: {} }, 'anna')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(s.set({ plugin: 'theme', key: 'skin', value: 'x', layer: 'space', context: { space: 'rp' } }, 'anna')).rejects.toMatchObject({ code: 'forbidden' })
    // бот без сессии — слоя нет
    await expect(s.set({ plugin: 'theme', key: 'skin', value: 'x', layer: 'bot', context: {} }, 'alice')).rejects.toMatchObject({ code: 'bad_request' })
    await expect(s.set({ plugin: 'theme', key: 'skin', value: 'x', layer: 'device' as never, context: {} })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(s.set({ plugin: '../x', key: 'skin', value: 'x', layer: 'user', context: {} })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(s.set({ plugin: 'theme', key: 'a.b', value: 'x', layer: 'user', context: {} })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(s.set({ plugin: 'theme', key: 'skin', value: 'x', layer: 'user', context: {} }, '../root')).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('слой репы: <корень>/.nr/settings.mdz; без корня слоя нет', async () => {
    const repo = join(dir, 'repo')
    mkdirSync(repo)
    const s = make({ projectRoot: (p) => (p === 'nrchat' ? repo : undefined) })
    const scopes = { theme: { skin: [...SCOPES_ALL] } }
    await s.set({ plugin: 'theme', key: 'skin', value: 'dev', layer: 'project', context: { project: 'nrchat' } })
    expect(readFileSync(join(repo, '.nr', 'settings.mdz'), 'utf-8')).toContain('$skin: dev')
    const snap = await s.get({ project: 'nrchat', scopes })
    expect(snap.origin.theme!.skin).toBe('project')
    expect(snap.layers.project!.file).toBe(join(repo, '.nr', 'settings.mdz'))
    expect((await s.get({ project: 'ghost', scopes })).layers.project).toBeUndefined()
    await expect(s.set({ plugin: 'theme', key: 'skin', value: 'x', layer: 'project', context: { project: 'ghost' } })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('слой сессии — %meta.settings; агент берётся из меты, слой агента — %meta файла .mds', async () => {
    const meta = metaPort()
    meta.docs.set('s1', { agent: 'chat' } as SessionMetaDoc)
    mkdirSync(join(dir, 'agents'))
    writeFileSync(join(dir, 'agents', 'chat.mds'), '%meta {name: "chat", model: "m"}\n%system\nТы собеседник.\n')
    const s = make({ meta })
    const scopes = { theme: { skin: [...SCOPES_ALL] } }

    await s.set({ plugin: 'theme', key: 'skin', value: 'tavern', layer: 'agent', context: { session: 's1' } })
    const mds = readFileSync(join(dir, 'agents', 'chat.mds'), 'utf-8')
    expect(mds).toContain("model: 'm'") // чужие ключи меты целы
    expect(mds).toContain('Ты собеседник.') // тело не тронуто
    const snap = await s.get({ session: 's1', scopes })
    expect(snap.origin.theme!.skin).toBe('agent')

    await s.set({ plugin: 'theme', key: 'skin', value: 'scene', layer: 'session', context: { session: 's1' } })
    expect(meta.docs.get('s1')!.settings).toEqual({ theme: { skin: 'scene' } })
    expect((await s.get({ session: 's1', scopes })).origin.theme!.skin).toBe('session')

    await s.reset({ plugin: 'theme', key: 'skin', layer: 'session', context: { session: 's1' } })
    expect(meta.docs.get('s1')!.settings).toBeUndefined()
    expect((await s.get({ session: 's1', scopes })).origin.theme!.skin).toBe('agent')
  })

  it('бот: настройки карты char-персоны; ключи без bot в scopes игнорируются', async () => {
    const personas: PersonasDoc = {
      personas: [
        { id: 'u', kind: 'user', name: 'Я' },
        { id: 'c', kind: 'char', name: 'Лис', card: { data: { name: 'Лис', extensions: { nrchat: { settings: { theme: { skin: 'tavern', model: 'evil' } } } } } } },
      ],
    } as PersonasDoc
    const s = make({ personas: { list: async () => personas } })
    await s.set({ plugin: 'theme', key: 'skin', value: 'parchment', layer: 'user', context: {} })
    const scopes = { theme: { skin: ['bot', 'user'] as never, model: ['user'] as never } }
    const snap = await s.get({ session: 's1', scopes })
    expect(snap.values.theme).toEqual({ skin: 'tavern' })
    expect(snap.origin.theme).toEqual({ skin: 'bot' })
    expect(snap.layers.bot).toMatchObject({ present: true, writable: false })
    expect(snap.layers.bot!.values.theme).toEqual({ skin: 'tavern', model: 'evil' })

    // «Без темы бота» (noBot): слой пропущен, побеждает пользователь.
    const off = await s.get({ session: 's1', scopes, noBot: true })
    expect(off.values.theme).toEqual({ skin: 'parchment' })
    expect(off.layers.bot).toBeUndefined()
  })

  it('персона игрока (CYOA, v1.47): между сессией и агентом; пишется в карту user-персоны', async () => {
    const meta = metaPort()
    meta.docs.set('s1', { agent: 'rp' } as SessionMetaDoc)
    mkdirSync(join(dir, 'agents'))
    writeFileSync(join(dir, 'agents', 'rp.mds'), '%meta {name: "rp", settings: {rp: {"impressSend": "draft", "cyoaCount": 3}}}\n%system\nGM.\n')
    let doc: PersonasDoc = { personas: [{ id: 'u', kind: 'user', name: 'Я', card: { description: 'путник' } }, { id: 'c', kind: 'char', name: 'Лис' }], userId: 'u' } as PersonasDoc
    const s = make({ meta, personas: { list: async () => structuredClone(doc), save: async (_sid, personas, userId) => (doc = { personas, ...(userId ? { userId } : {}) }) } })
    const scopes = { rp: { impressSend: ['session', 'persona', 'agent', 'stand'] as never, cyoaCount: ['session', 'persona', 'agent'] as never } }

    // без персоны и сессии — агент; стенд ниже агента
    await s.set({ plugin: 'rp', key: 'impressSend', value: 'turn', layer: 'stand', context: {} })
    expect((await s.get({ session: 's1', scopes })).origin.rp).toEqual({ impressSend: 'agent', cyoaCount: 'agent' })

    // персона перебивает агента
    await s.set({ plugin: 'rp', key: 'impressSend', value: 'send', layer: 'persona', context: { session: 's1' } })
    const card = doc.personas.find((p) => p.kind === 'user')!.card as Record<string, unknown>
    expect(card.description).toBe('путник')
    expect(card.extensions).toEqual({ nrchat: { settings: { rp: { impressSend: 'send' } } } })
    let snap = await s.get({ session: 's1', scopes })
    expect(snap.values.rp).toEqual({ impressSend: 'send', cyoaCount: 3 })
    expect(snap.origin.rp!.impressSend).toBe('persona')
    expect(snap.layers.persona).toMatchObject({ present: true, writable: true })

    // сессия перебивает персону
    await s.set({ plugin: 'rp', key: 'impressSend', value: 'draft', layer: 'session', context: { session: 's1' } })
    snap = await s.get({ session: 's1', scopes })
    expect(snap.origin.rp!.impressSend).toBe('session')

    // снять с персоны — карта чистая
    await s.reset({ plugin: 'rp', key: 'impressSend', layer: 'persona', context: { session: 's1' } })
    expect((doc.personas.find((p) => p.kind === 'user')!.card as Record<string, unknown>).extensions).toEqual({ nrchat: {} })

    // ключ без persona в scopes персону не видит
    const narrow = { rp: { impressSend: ['agent'] as never } }
    await s.set({ plugin: 'rp', key: 'impressSend', value: 'send', layer: 'persona', context: { session: 's1' } })
    expect((await s.get({ session: 's1', scopes: narrow })).origin.rp!.impressSend).toBe('agent')
  })

  it('бот в сессии (ABC-706): запись в карту char-персоны сессии, библиотечная и вторая сессия не видят', async () => {
    const meta = metaPort()
    meta.docs.set('s1', { agent: 'rp' } as SessionMetaDoc)
    meta.docs.set('s2', { agent: 'rp' } as SessionMetaDoc)
    mkdirSync(join(dir, 'agents'))
    writeFileSync(join(dir, 'agents', 'rp.mds'), '%meta {name: "rp", settings: {rp: {"cyoaCount": 3}}}\n%system\nGM.\n')
    const library = { data: { name: 'Лис', description: 'лис', extensions: { site: { id: 1 } } } }
    const docs = new Map<string, PersonasDoc>()
    for (const sid of ['s1', 's2']) docs.set(sid, { personas: [{ id: 'u', kind: 'user', name: 'Я', card: { description: 'путник' } }, { id: 'c', kind: 'char', name: 'Лис', card: structuredClone(library) }], userId: 'u' } as PersonasDoc)
    const s = make({ meta, personas: { list: async (sid) => structuredClone(docs.get(sid)!), save: async (sid, personas, userId) => { const d = { personas, ...(userId ? { userId } : {}) } as PersonasDoc; docs.set(sid, d); return d } } })
    const scopes = { rp: { cyoaCount: ['persona', 'bot', 'agent', 'stand'] as never } }

    expect((await s.get({ session: 's1', scopes })).layers.bot).toMatchObject({ present: true, writable: true })
    await s.set({ plugin: 'rp', key: 'cyoaCount', value: 4, layer: 'bot', context: { session: 's1' } })
    const card = docs.get('s1')!.personas.find((p) => p.kind === 'char')!.card as { data: Record<string, unknown> }
    // CCv3: в data.extensions, чужие расширения целы
    expect(card.data.extensions).toEqual({ site: { id: 1 }, nrchat: { settings: { rp: { cyoaCount: 4 } } } })
    expect(card.data.description).toBe('лис')
    expect(library.data.extensions).toEqual({ site: { id: 1 } })
    let snap = await s.get({ session: 's1', scopes })
    expect(snap.values.rp).toEqual({ cyoaCount: 4 })
    expect(snap.origin.rp).toEqual({ cyoaCount: 'bot' })
    // вторая сессия с тем же ботом — агент
    expect((await s.get({ session: 's2', scopes })).origin.rp).toEqual({ cyoaCount: 'agent' })
    // персона поверх бота
    await s.set({ plugin: 'rp', key: 'cyoaCount', value: 3, layer: 'persona', context: { session: 's1' } })
    snap = await s.get({ session: 's1', scopes })
    expect(snap.origin.rp).toEqual({ cyoaCount: 'persona' })
    // снять с бота
    await s.reset({ plugin: 'rp', key: 'cyoaCount', layer: 'bot', context: { session: 's1' } })
    expect((docs.get('s1')!.personas.find((p) => p.kind === 'char')!.card as { data: Record<string, unknown> }).data.extensions).toEqual({ site: { id: 1 }, nrchat: {} })
  })

  it('watch: правка файла слоя рукой доходит событием; своя запись — тоже', async () => {
    const s = make()
    mkdirSync(join(dir, 'settings'), { recursive: true })
    writeFileSync(join(dir, 'settings', 'stand.mdz'), '## $settings theme\n$skin: a\n')
    const events: SettingsChangedEvent[] = []
    const off = s.watch!((e) => events.push(e))
    await new Promise((r) => setTimeout(r, 50))
    writeFileSync(join(dir, 'settings', 'stand.mdz'), '## $settings theme\n$skin: b\n')
    await waitFor(() => events.some((e) => e.layer === 'stand'))
    await s.set({ plugin: 'theme', key: 'x', value: 1, layer: 'user', context: {} })
    await waitFor(() => events.some((e) => e.layer === 'user'))
    off()
  })
})

describe('serveBackend settings', () => {
  const backend = () =>
    createStoreBackend({
      store: createMemoryStore(),
      generate: async function* () {
        yield { type: 'text', text: 'ok' }
      },
    })

  it('capability, get/set/reset через клиент; без settings — not_supported', async () => {
    const settings = createFsSettings({ root: dir, owner: 'alice' })
    srv = await serveBackend(backend(), { settings, basePath: '/api' })
    const client = createHttpBackend(srv.url)
    const caps = await client.capabilities()
    expect(caps.settings).toEqual({ layers: ['session', 'persona', 'bot', 'agent', 'project', 'space', 'user', 'stand'], watch: true })
    expect(caps.services?.settings).toEqual({ methods: [], streams: ['changes'] })

    await client.settings!.set({ plugin: 'theme', key: 'skin', value: 'tavern', layer: 'user', context: {} })
    const snap = await client.settings!.get({ scopes: { theme: { skin: ['user'] } } })
    expect(snap.values.theme).toEqual({ skin: 'tavern' })
    expect(snap.origin.theme).toEqual({ skin: 'user' })
    await client.settings!.reset({ plugin: 'theme', key: 'skin', layer: 'user', context: {} })
    expect((await client.settings!.get({})).values).toEqual({})
    // `*` — слои всех ключей плагина без своей записи (сотни ручек скина не лезут в адрес).
    await client.settings!.set({ plugin: 'skin-x', key: 'glow', value: true, layer: 'stand', context: {} })
    expect((await client.settings!.get({ scopes: { 'skin-x': { '*': ['user'] } } })).values['skin-x']).toBeUndefined()
    expect((await client.settings!.get({ scopes: { 'skin-x': { '*': ['user'], glow: ['stand'] } } })).values['skin-x']).toEqual({ glow: true })
    await client.settings!.reset({ plugin: 'skin-x', key: 'glow', layer: 'stand', context: {} })
    await expect(client.settings!.set({ plugin: 'theme', key: 'skin', value: 1, layer: 'bot', context: { session: 's' } })).rejects.toMatchObject({ code: 'bad_request' })

    await srv.close()
    srv = await serveBackend(backend(), { basePath: '/api' })
    const bare = createHttpBackend(srv.url)
    expect((await bare.capabilities()).settings).toBeUndefined()
    await expect(bare.settings!.get({})).rejects.toMatchObject({ code: 'not_supported' })
  })

  it('стрим services/settings/changes: правка файла приходит кадром changed', async () => {
    const settings = createFsSettings({ root: dir, owner: 'alice' })
    srv = await serveBackend(backend(), { settings, basePath: '/api' })
    const client = createHttpBackend(srv.url)
    const it = client.services!.stream('settings', 'changes')[Symbol.asyncIterator]()
    const first = it.next()
    await new Promise((r) => setTimeout(r, 100))
    await client.settings!.set({ plugin: 'theme', key: 'skin', value: 'x', layer: 'user', context: {} })
    const got = await Promise.race([first, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('нет кадра')), 3000))])
    expect(got.value).toMatchObject({ name: 'changed', payload: { layer: 'user' } })
    await it.return?.()
  })
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('не дождались')
    await new Promise((r) => setTimeout(r, 25))
  }
}
