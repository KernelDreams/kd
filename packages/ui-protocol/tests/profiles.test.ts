/**
 * Профили сессии (profiles-spec §4) — контракт на уровне типов.
 *
 * Провод профилей узкий: каталог, смена, выбор при создании и поле сессии.
 * Сами настройки процесса (флаги, env) на провод не выходят — это проверяется
 * формой `ProfileInfo`: в ней только то, что показать в UI.
 */

import { describe, expect, it } from 'vitest'
import { INLINE_PROFILE_ID, isProfileDoc, isProfileId, profileInfoOf } from '../src/index.js'
import type {
  Capabilities,
  CatalogExtension,
  CatalogSkill,
  CatalogTool,
  CatalogsOps,
  ProfileDoc,
  ProfileInfo,
  ProfilesOps,
  ProtocolBackend,
  SessionCreateOpts,
  SessionInfo,
} from '../src/index.js'

describe('profiles', () => {
  it('профили опциональны: ядро без них — валидный бэкенд', () => {
    const minimal: ProtocolBackend = {
      capabilities: async () => ({ protocol: 1 }),
      sessions: { list: async () => [], create: async () => ({ id: 's1' }), get: async (id) => ({ id }), delete: async () => {} },
      history: async () => ({ messages: [], version: '' }),
      run: async function* () {},
      cancel: async () => {},
    }
    expect(minimal.profiles).toBeUndefined()
  })

  it('list без set — capability без switch: профиль выбирается только при создании', async () => {
    const caps: Capabilities = { protocol: 1, profiles: {} }
    const profiles: ProfilesOps = {
      list: async () => [{ id: 'default', name: 'default' }],
      get: async (id) => ({ id, name: id }),
    }
    expect(caps.profiles?.switch).toBeUndefined()
    expect(profiles.set).toBeUndefined()
    expect((await profiles.list())[0]!.id).toBe('default')
  })

  it('ProfileInfo несёт то, что показать в UI: тулы, скиллы, модель, режим промпта', () => {
    const chat: ProfileInfo = { id: 'chat', name: 'Chat', description: 'без тулов', tools: 'none', promptMode: 'replace' }
    const rp: ProfileInfo = { id: 'rp', name: 'RP', tools: 'none', skills: ['botcraft.skill'], model: 'nr/glm-5.3-flash' }
    const coder: ProfileInfo = { id: 'coder', name: 'Coder', tools: ['read', 'bash'] }
    expect([chat.tools, rp.tools, coder.tools]).toEqual(['none', 'none', ['read', 'bash']])
  })

  it('create принимает профиль, SessionInfo его несёт, set возвращает профиль сессии', async () => {
    const opts: SessionCreateOpts = { title: 'Новая', profile: 'chat' }
    const info: SessionInfo = { id: 's1', title: opts.title, profile: opts.profile as string }
    expect(info.profile).toBe('chat')

    const catalog: ProfileInfo[] = [
      { id: 'default', name: 'default' },
      { id: 'agent', name: 'Agent', tools: 'all' },
    ]
    const profiles: ProfilesOps = {
      list: async () => catalog,
      get: async (id) => catalog.find((p) => p.id === id)!,
      set: async (_sid, id) => catalog.find((p) => p.id === id)!,
    }
    expect(await profiles.set!('s1', 'agent')).toEqual({ id: 'agent', name: 'Agent', tools: 'all' })
  })
})

describe('profiles v2: конструктор (profile-editor-spec §2–3)', () => {
  it('ProfileDoc — документ целиком: модель, тулы, скиллы, расширения, промпты, extra', () => {
    const doc: ProfileDoc = {
      id: 'prompt-gen',
      name: 'Prompt Gen',
      description: 'генератор промптов под модель',
      model: 'nr/opus-5',
      thinking: 'high',
      tools: ['read'],
      skills: ['dev-skill', '/abs/other.skill'],
      extensions: ['pi-ext-web'],
      systemPrompt: 'Ты пишешь промпты.',
      prompt: { mode: 'replace', post: 'формат выдачи' },
      extra: { 'no-context-files': 'true' },
    }
    const all: ProfileDoc = { id: 'agent', name: 'Agent', tools: 'all' }
    const none: ProfileDoc = { id: 'chat', name: 'Chat', tools: 'none' }
    expect([doc.tools, all.tools, none.tools]).toEqual([['read'], 'all', 'none'])
  })

  it('get обязателен, правка — только под profiles.edit', async () => {
    const caps: Capabilities = { protocol: 1, profiles: { switch: true, edit: true } }
    const store = new Map<string, ProfileDoc>([['default', { id: 'default', name: 'default' }]])
    const profiles: ProfilesOps = {
      list: async () => [...store.values()].map((d) => ({ id: d.id, name: d.name })),
      get: async (id) => store.get(id)!,
      save: async (doc) => (store.set(doc.id, doc), doc),
      delete: async (id) => void store.delete(id),
      duplicate: async (id, newId) => {
        const copy = { ...store.get(id)!, id: newId }
        store.set(newId, copy)
        return copy
      },
    }
    expect(caps.profiles?.edit).toBe(true)
    await profiles.save!({ id: 'chat', name: 'Chat', tools: 'none' })
    expect((await profiles.duplicate!('chat', 'chat-2')).tools).toBe('none')
    await profiles.delete!('chat')
    expect((await profiles.list()).map((p) => p.id)).toEqual(['default', 'chat-2'])

    const readOnly: ProfilesOps = { list: async () => [], get: async (id) => ({ id, name: id }) }
    expect(readOnly.save).toBeUndefined()
  })

  it('каталоги: метод ⇔ флаг capability, у тула — источник', async () => {
    const caps: Capabilities = { protocol: 1, catalogs: { tools: true, skills: true } }
    const tools: CatalogTool[] = [
      { id: 'read', source: 'builtin', description: 'Read file' },
      { id: 'web_fetch', source: 'extension', extension: 'pi-ext-web' },
    ]
    const skills: CatalogSkill[] = [{ id: 'dev-skill', name: 'dev-skill', path: '/skills/dev-skill.dev' }]
    const extensions: CatalogExtension[] = [{ id: 'pi-ext-web', name: 'pi-ext-web', path: '/x/index.ts', enabled: true }]
    const catalogs: CatalogsOps = { tools: async () => tools, skills: async () => skills }
    const backend: Pick<ProtocolBackend, 'catalogs'> = { catalogs }

    expect(caps.catalogs?.extensions).toBeUndefined()
    expect(backend.catalogs?.extensions).toBeUndefined()
    expect((await backend.catalogs!.tools!()).map((t) => t.source)).toEqual(['builtin', 'extension'])
    expect(extensions[0]!.enabled).toBe(true)
  })
})

describe('isProfileId / profileInfoOf', () => {
  it('id — имя файла из [a-z0-9-], не с дефиса', () => {
    for (const ok of ['default', 'prompt-gen', 'bot2']) expect(isProfileId(ok)).toBe(true)
    for (const bad of ['', '-x', 'Chat', 'a b', 'a/b', '../x', 'чат', 42, undefined]) expect(isProfileId(bad)).toBe(false)
  })

  it('витрина: пустое имя → id, пустые списки и промпт без режима не выходят', () => {
    expect(profileInfoOf({ id: 'x', name: '', skills: [], prompt: { pre: 'a' } })).toEqual({ id: 'x', name: 'x' })
    expect(
      profileInfoOf({
        id: 'rp',
        name: 'RP',
        description: 'ролевой',
        tools: 'none',
        skills: ['botcraft'],
        model: 'nr/glm',
        thinking: 'off',
        systemPrompt: 'в витрину не едет',
        prompt: { mode: 'replace' },
        extra: { a: 'b' },
      }),
    ).toEqual({ id: 'rp', name: 'RP', description: 'ролевой', tools: 'none', skills: ['botcraft'], model: 'nr/glm', promptMode: 'replace' })
  })

  it('витрина несёт voice агента (v1.39, LLM-12); пустой — не выходит', () => {
    expect(profileInfoOf({ id: 'sw', name: 'Storywriter', card: 'alice', voice: { mode: 'verbatim', refine: 'always' } })).toEqual({
      id: 'sw',
      name: 'Storywriter',
      card: 'alice',
      voice: { mode: 'verbatim', refine: 'always' },
    })
    expect(profileInfoOf({ id: 'a', name: 'A', voice: {} })).toEqual({ id: 'a', name: 'A' })
  })
})

describe('бот = сессия (bot-as-session-spec §1)', () => {
  it('inline зарезервирован: каталожный профиль так не называется', () => {
    expect(INLINE_PROFILE_ID).toBe('inline')
    expect(isProfileId('inline')).toBe(false)
    expect(isProfileId('inline-2')).toBe(true)
  })

  it('isProfileDoc отличает документ от id', () => {
    expect(isProfileDoc({ id: 'x', name: 'RP' })).toBe(true)
    expect(isProfileDoc({ name: '' })).toBe(true)
    expect(isProfileDoc('rp')).toBe(false)
    expect(isProfileDoc({ id: 'rp' })).toBe(false)
    expect(isProfileDoc(null)).toBe(false)
    expect(isProfileDoc(['x'])).toBe(false)
  })

  it('create/set принимают документ, append — assistant и swipeOf, SessionInfo несёт profileDoc', () => {
    const doc = { id: 'inline', name: 'Ирис', prompt: { mode: 'replace' as const } }
    const create: import('../src/index.js').SessionCreateOpts = { title: 'Ирис', profile: doc }
    const append: import('../src/index.js').MessageAppendOpts = { role: 'assistant', swipeOf: 'm1' }
    const info: import('../src/index.js').SessionInfo = { id: 's1', profile: INLINE_PROFILE_ID, profileDoc: doc }
    type SetArg = Parameters<NonNullable<import('../src/index.js').ProfilesOps['set']>>[1]
    const byId: SetArg = 'rp'
    const byDoc: SetArg = doc
    expect([create.profile, append.role, info.profileDoc, byId, byDoc]).toEqual([doc, 'assistant', doc, 'rp', doc])
  })
})
