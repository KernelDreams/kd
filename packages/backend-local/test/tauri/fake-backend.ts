/**
 * КОПИЯ backend-http/test/fake-backend.ts — эталонный fake для loopback (backends-spec §3.3).
 * Провода разные, эталон один: расхождение с оригиналом — повод синхронизировать.
 */

/**
 * Fake-бэкенд: in-memory ProtocolBackend со скриптованными ранами.
 *
 * Эталон для loopback (backends-spec §3.3): что он отдал — то клиент обязан
 * получить. Скриптованность (а не «настоящая» логика) намеренна: тест меряет
 * провод, а не бэкенд.
 */

import { NotSupportedError } from '@kerneldreams/ui-protocol'
import type {
  AnyRunEvent,
  Persona,
  Capabilities,
  HistoryPage,
  Message,
  MessageAppendOpts,
  MessageEditPatch,
  ModelInfo,
  CatalogExtension,
  CatalogSkill,
  CatalogTool,
  Part,
  ProfileDoc,
  ProfileInfo,
  ProtocolBackend,
  RunStartInput,
  SessionCreateOpts,
  SessionInfo,
  SessionModel,
  SwipeTo,
  WorkspaceInfo,
} from '@kerneldreams/ui-protocol'

/** Шаг сценария рана: событие либо пауза/действие. */
export type ScriptStep =
  | { emit: AnyRunEvent }
  /** Ждать, пока тест/клиент что-то сделает (respond, cancel, обрыв). */
  | { await: () => Promise<void> }
  /** Швырнуть из итератора: транспортная/фатальная авария (§2). */
  | { throw: Error }

export interface FakeBackendOpts {
  capabilities?: Capabilities
  sessions?: SessionInfo[]
  history?: Record<string, HistoryPage>
  /** Урезать поверхность: проверка «незаявленная операция → NotSupported». */
  omit?: Array<
    | 'sessions.fork'
    | 'sessions.rename'
    | 'respond'
    | 'messages'
    | 'messages.append'
    | 'messages.edit'
    | 'messages.delete'
    | 'messages.hide'
    | 'messages.swipe'
    | 'catalog'
    | 'catalog.asset'
    | 'models'
    | 'models.set'
    | 'workspace'
    | 'workspace.switch'
    | 'profiles'
    | 'profiles.set'
    | 'profiles.edit'
    | 'catalogs'
    | 'catalogs.extensions'
    | 'personas'
    | 'meta'
    | 'attachments'
  >
}

export interface FakeBackend extends ProtocolBackend {
  /** Скрипт следующего run() данной сессии. */
  script(sid: string, steps: ScriptStep[]): void
  /** Всё, что бэкенд реально отдал в стрим — эталон сравнения. */
  emitted: AnyRunEvent[]
  /** Вызовы операций: ['capabilities', 'sessions.list', ...]. */
  calls: string[]
  /** Резолвится, когда итератор рана честно доиграл до конца. */
  runFinished(sid: string): Promise<void>
  /** Ответы, доехавшие respond'ом. */
  answers: Array<{ sid: string; askId: string; answer: unknown }>
  /** Отмены, доехавшие cancel'ом. */
  cancels: Array<{ sid: string; runId: string }>
  /** Правки, доехавшие messages.*. */
  edits: Array<{ op: string; sid: string; mid: string; arg: unknown }>
  /** Мета, доехавшая meta.patch. */
  metaPatches: Array<{ sid: string; patch: unknown }>
  /** Ассеты, доехавшие attachments.put. */
  attaches: Array<{ sid: string; name: string; data: Uint8Array; mime?: string }>
  /** Выборы модели, доехавшие models.set. */
  modelSets: Array<{ sid: string; model: SessionModel }>
  /** Смены профиля, доехавшие profiles.set. */
  profileSets: Array<{ sid: string; id: string; doc?: ProfileDoc }>
  /** Правки каталога профилей: save — документ, delete/duplicate — id. */
  profileEdits: Array<{ op: 'save' | 'delete' | 'duplicate'; arg: unknown }>
  /** Опции, доехавшие sessions.create. */
  createOpts: SessionCreateOpts[]
}

/** Каталог fake-бэкенда (models-spec §2): с уровнями и без. */
export const FAKE_MODELS: ModelInfo[] = [
  {
    id: 'nr/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    provider: 'nr',
    tags: ['vision'],
    contextWindow: 128_000,
  },
  {
    id: 'nr/opus',
    name: 'Opus',
    provider: 'nr',
    tags: ['reasoning'],
    thinking: ['off', 'low', 'high'],
    contextWindow: 200_000,
  },
]

/** Каталог профилей фейка (profiles-spec §4): штатный и «без тулов». */
export const FAKE_PROFILES: ProfileInfo[] = [
  { id: 'default', name: 'default' },
  { id: 'chat', name: 'Chat', description: 'без тулов', tools: 'none', promptMode: 'replace' },
]

/** Каталоги фейка (profile-editor-spec §3): встроенный и тул расширения, скилл, расширение. */
export const FAKE_CATALOGS: { tools: CatalogTool[]; skills: CatalogSkill[]; extensions: CatalogExtension[] } = {
  tools: [
    { id: 'read', source: 'builtin', description: 'Read a file' },
    { id: 'web_fetch', source: 'extension', extension: 'pi-ext-web', description: 'Fetch a page' },
  ],
  skills: [{ id: 'dev-skill', name: 'dev-skill', description: 'контекст-пакеты', path: '/skills/dev-skill.dev' }],
  extensions: [{ id: 'pi-ext-web', name: 'pi-ext-web', path: '/kd/packages/web-tools/src/index.ts', enabled: true }],
}

export const FULL_CAPABILITIES: Capabilities = {
  protocol: 1,
  name: 'fake',
  edits: { edit: true, delete: true, hide: true },
  swipes: true,
  fork: 'tree',
  cancel: true,
  ask: ['permission', 'select', 'text'],
  activity: true,
  attachments: true,
  catalog: true,
  personas: true,
  sessionMeta: true,
  collapsed: false,
  checkpoints: false,
  models: { select: true, thinking: true },
  workspace: { switch: true },
  profiles: { switch: true, edit: true },
  catalogs: { tools: true, skills: true, extensions: true },
}

/** Два пространства фейка: `switch` обязан переключать именно между ними. */
export const FAKE_WORKSPACES: WorkspaceInfo[] = [
  { id: '/work/alpha', name: 'alpha', path: '/work/alpha', kind: 'directory' },
  { id: '/work/beta', name: 'beta', path: '/work/beta', kind: 'project' },
]

export function createFakeBackend(opts: FakeBackendOpts = {}): FakeBackend {
  const omit = new Set(opts.omit ?? [])
  const sessions = new Map<string, SessionInfo>(
    (opts.sessions ?? [{ id: 's1', title: 'Первая' }]).map((s) => [s.id, s]),
  )
  const histories: Record<string, HistoryPage> = opts.history ?? {}
  /** Индекс текущего пространства в FAKE_WORKSPACES — его двигает switch. */
  let current = 0
  const scripts = new Map<string, ScriptStep[]>()
  const finished = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  let seq = 0

  const emitted: AnyRunEvent[] = []
  const calls: string[] = []
  const answers: FakeBackend['answers'] = []
  const cancels: FakeBackend['cancels'] = []
  const edits: FakeBackend['edits'] = []
  const metaPatches: FakeBackend['metaPatches'] = []
  const attaches: FakeBackend['attaches'] = []
  const modelSets: FakeBackend['modelSets'] = []
  const profileSets: FakeBackend['profileSets'] = []
  const profileEdits: FakeBackend['profileEdits'] = []
  const createOpts: FakeBackend['createOpts'] = []

  const track = (name: string) => calls.push(name)

  const message = (id: string, role: string): Message => ({ id, role, parts: [] })

  const backend: FakeBackend = {
    emitted,
    calls,
    answers,
    cancels,
    edits,
    metaPatches,
    attaches,
    modelSets,
    profileSets,
    profileEdits,
    createOpts,

    script(sid, steps) {
      scripts.set(sid, steps)
      let resolve!: () => void
      const promise = new Promise<void>((r) => (resolve = r))
      finished.set(sid, { promise, resolve })
    },

    runFinished(sid) {
      return finished.get(sid)?.promise ?? Promise.resolve()
    },

    async capabilities() {
      track('capabilities')
      return opts.capabilities ?? FULL_CAPABILITIES
    },

    sessions: {
      async list() {
        track('sessions.list')
        return [...sessions.values()]
      },
      async create(opts_?: SessionCreateOpts) {
        track('sessions.create')
        createOpts.push(opts_ ?? {})
        const info: SessionInfo = {
          id: `s${++seq + 1}`,
          title: opts_?.title ?? 'Новая',
          botId: opts_?.botId,
          model: opts_?.model,
          createdAt: '2026-07-16T00:00:00.000Z',
        }
        // Встроенный профиль (bot-as-session-spec §1): документ → 'inline' + profileDoc.
        if (typeof opts_?.profile === 'string') info.profile = opts_.profile
        else if (opts_?.profile) Object.assign(info, { profile: 'inline', profileDoc: { ...opts_.profile, id: 'inline' } })
        sessions.set(info.id, info)
        return info
      },
      async get(id) {
        track('sessions.get')
        const info = sessions.get(id)
        if (!info) throw new Error(`No session ${id}`)
        return info
      },
      async delete(id) {
        track('sessions.delete')
        sessions.delete(id)
      },
      ...(omit.has('sessions.fork')
        ? {}
        : {
            async fork(id: string, atMessageId?: string) {
              track('sessions.fork')
              const info: SessionInfo = {
                id: `${id}-fork`,
                parentSessionId: id,
                forkMessageId: atMessageId,
              }
              sessions.set(info.id, info)
              return info
            },
          }),
      ...(omit.has('sessions.rename')
        ? {}
        : {
            async rename(id: string, title: string) {
              track('sessions.rename')
              const info = sessions.get(id)
              if (info) info.title = title
            },
          }),
    },

    async history(id) {
      track('history')
      return histories[id] ?? { messages: [message('m1', 'user')], version: 'v1' }
    },

    run(sid, _input: RunStartInput) {
      track('run')
      const steps = scripts.get(sid) ?? []
      const done = finished.get(sid)

      return {
        async *[Symbol.asyncIterator]() {
          try {
            for (const step of steps) {
              if ('emit' in step) {
                emitted.push(step.emit)
                yield step.emit
              } else if ('await' in step) {
                await step.await()
              } else {
                throw step.throw
              }
            }
          } finally {
            done?.resolve()
          }
        },
      }
    },

    async cancel(sid, runId) {
      track('cancel')
      cancels.push({ sid, runId })
    },

    ...(omit.has('respond')
      ? {}
      : {
          async respond(sid: string, askId: string, answer: unknown) {
            track('respond')
            answers.push({ sid, askId, answer })
          },
        }),

    ...(omit.has('messages')
      ? {}
      : {
          messages: {
            ...(omit.has('messages.append')
              ? {}
              : {
                  async append(sid: string, parts: Part[], appendOpts?: MessageAppendOpts): Promise<Message> {
                    track('messages.append')
                    edits.push({ op: 'append', sid, mid: '', arg: { parts, opts: appendOpts } })
                    return { id: 'm-appended', role: appendOpts?.role ?? 'user', parts, hash: 'h-app' }
                  },
                }),
            ...(omit.has('messages.edit')
              ? {}
              : {
                  async edit(sid: string, mid: string, patch: MessageEditPatch): Promise<Message> {
                    track('messages.edit')
                    edits.push({ op: 'edit', sid, mid, arg: patch })
                    return {
                      id: mid,
                      role: 'user',
                      parts: patch.parts ?? [{ type: 'text', text: patch.text ?? '' }],
                      hash: 'h2',
                    }
                  },
                }),
            ...(omit.has('messages.delete')
              ? {}
              : {
                  async delete(sid: string, mid: string) {
                    track('messages.delete')
                    edits.push({ op: 'delete', sid, mid, arg: null })
                  },
                }),
            ...(omit.has('messages.hide')
              ? {}
              : {
                  async hide(sid: string, mid: string, hidden: boolean) {
                    track('messages.hide')
                    edits.push({ op: 'hide', sid, mid, arg: hidden })
                  },
                }),
            ...(omit.has('messages.swipe')
              ? {}
              : {
                  async swipe(sid: string, mid: string, to: SwipeTo): Promise<Message> {
                    track('messages.swipe')
                    edits.push({ op: 'swipe', sid, mid, arg: to })
                    return {
                      id: mid,
                      role: 'assistant',
                      parts: [{ type: 'text', text: 'вариант 2' }],
                      swipes: { active: to.index ?? 1, count: 3 },
                    }
                  },
                }),
          },
        }),

    ...(omit.has('models')
      ? {}
      : {
          models: {
            async list() {
              track('models.list')
              return FAKE_MODELS
            },
            ...(omit.has('models.set')
              ? {}
              : {
                  async set(sid: string, model: SessionModel): Promise<SessionModel> {
                    track('models.set')
                    modelSets.push({ sid, model })
                    const info = sessions.get(sid)
                    if (info) info.model = model
                    return model
                  },
                }),
          },
        }),

    ...(omit.has('workspace')
      ? {}
      : {
          workspace: {
            async current() {
              track('workspace.current')
              return FAKE_WORKSPACES[current]!
            },
            async list() {
              track('workspace.list')
              return FAKE_WORKSPACES
            },
            ...(omit.has('workspace.switch')
              ? {}
              : {
                  async switch(id: string): Promise<WorkspaceInfo> {
                    track('workspace.switch')
                    const next = FAKE_WORKSPACES.findIndex((w) => w.id === id)
                    if (next < 0) throw new Error(`нет пространства ${id}`)
                    current = next
                    return FAKE_WORKSPACES[current]!
                  },
                }),
          },
        }),

    ...(omit.has('profiles')
      ? {}
      : {
          profiles: {
            async list() {
              track('profiles.list')
              return FAKE_PROFILES
            },
            ...(omit.has('profiles.set')
              ? {}
              : {
                  async set(sid: string, profile: string | ProfileDoc): Promise<ProfileInfo> {
                    track('profiles.set')
                    const info = sessions.get(sid)
                    if (typeof profile !== 'string') {
                      const doc = { ...profile, id: 'inline' }
                      profileSets.push({ sid, id: 'inline', doc })
                      if (info) Object.assign(info, { profile: 'inline', profileDoc: doc })
                      return { id: 'inline', name: doc.name }
                    }
                    const found = FAKE_PROFILES.find((p) => p.id === profile)
                    if (!found) throw Object.assign(new Error(`нет профиля ${profile}`), { code: 'bad_request' })
                    profileSets.push({ sid, id: profile })
                    if (info) {
                      info.profile = profile
                      delete info.profileDoc
                    }
                    return found
                  },
                }),
            async get(id: string): Promise<ProfileDoc> {
              track('profiles.get')
              const found = FAKE_PROFILES.find((p) => p.id === id)
              if (!found) throw Object.assign(new Error(`нет профиля ${id}`), { code: 'not_found' })
              return { id: found.id, name: found.name, ...(found.tools ? { tools: found.tools } : {}) }
            },
            ...(omit.has('profiles.edit')
              ? {}
              : {
                  async save(doc: ProfileDoc): Promise<ProfileDoc> {
                    track('profiles.save')
                    profileEdits.push({ op: 'save', arg: doc })
                    return doc
                  },
                  async delete(id: string): Promise<void> {
                    track('profiles.delete')
                    if (id === 'default') throw Object.assign(new Error('default не удаляется'), { code: 'bad_request' })
                    profileEdits.push({ op: 'delete', arg: id })
                  },
                  async duplicate(id: string, newId: string): Promise<ProfileDoc> {
                    track('profiles.duplicate')
                    if (FAKE_PROFILES.some((p) => p.id === newId)) {
                      throw Object.assign(new Error(`профиль ${newId} уже есть`), { code: 'conflict' })
                    }
                    profileEdits.push({ op: 'duplicate', arg: [id, newId] })
                    return { id: newId, name: id }
                  },
                }),
          },
        }),

    ...(omit.has('catalogs')
      ? {}
      : {
          catalogs: {
            async tools() {
              track('catalogs.tools')
              return FAKE_CATALOGS.tools
            },
            async skills() {
              track('catalogs.skills')
              return FAKE_CATALOGS.skills
            },
            ...(omit.has('catalogs.extensions')
              ? {}
              : {
                  async extensions() {
                    track('catalogs.extensions')
                    return FAKE_CATALOGS.extensions
                  },
                }),
          },
        }),

    ...(omit.has('catalog')
      ? {}
      : {
          catalog: {
            async bots() {
              track('catalog.bots')
              return [{ id: 'bot1', name: 'Бот' }]
            },
            async bot(id: string) {
              track('catalog.bot')
              return { id, name: 'Бот' }
            },
            ...(omit.has('catalog.asset')
              ? {}
              : {
                  async asset(botId: string, file: string) {
                    track('catalog.asset')
                    return {
                      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, botId.length, file.length]),
                      mime: 'image/png',
                    }
                  },
                }),
          },
        }),

    ...(omit.has('personas')
      ? {}
      : {
          personas: {
            async list(sid: string) {
              track('personas.list')
              return { personas: [{ id: 'p1', kind: 'user' as const, name: `владелец ${sid}` }], userId: 'p1' }
            },
            async save(sid: string, personas: Persona[], userId?: string) {
              track('personas.save')
              return { personas: personas.map((p) => ({ ...p, name: `${p.name} ${sid}` })), ...(userId ? { userId } : {}) }
            },
          },
        }),

    ...(omit.has('meta')
      ? {}
      : {
          meta: {
            async get(id: string) {
              track('meta.get')
              return { notes: `заметки ${id}` }
            },
            async patch(sid: string, patch: unknown) {
              track('meta.patch')
              metaPatches.push({ sid, patch })
              return { notes: 'обновлено', patch }
            },
          },
        }),

    ...(omit.has('attachments')
      ? {}
      : {
          attachments: {
            async put(sid: string, name: string, data: Uint8Array, mime?: string) {
              track('attachments.put')
              attaches.push({ sid, name, data, mime })
              const ref = `./${sid}.assets/${name}`
              return { ref, part: { type: 'image' as const, meta: { ref, mime } } }
            },
          },
        }),

    async close() {
      track('close')
    },
  }

  return backend
}

// ────────────────────────────────────────────────────────────────────────────
// Сценарий полного рана: multi-message, tool-parts, ask, финал (§3.3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Ран из двух сообщений: assistant с text + tool_use, tool_result отдельным
 * сообщением, ask посередине, неизвестное событие (opaque) и run_end.
 */
export function fullRunScript(sid: string, hooks: { onAsk: () => Promise<void> }): ScriptStep[] {
  const runId = `run-${sid}`
  const e = (event: AnyRunEvent): ScriptStep => ({ emit: event })

  return [
    e({ type: 'run_start', runId }),

    // user-сообщение, добавленное run.start'ом, тоже едет событиями (§5.2)
    e({ type: 'message_start', runId, message: { id: 'u1', role: 'user' } }),
    e({
      type: 'message_end',
      runId,
      message: { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'посчитай 2+2' }] },
    }),

    // assistant: thinking → text → tool_use
    e({ type: 'message_start', runId, message: { id: 'a1', role: 'assistant', name: 'Бот' } }),
    e({ type: 'part_start', runId, messageId: 'a1', part: 0, partType: 'thinking' }),
    e({ type: 'part_delta', runId, messageId: 'a1', part: 0, delta: 'надо посчитать' }),
    e({
      type: 'part_end',
      runId,
      messageId: 'a1',
      part: 0,
      payload: { type: 'thinking', text: 'надо посчитать' },
    }),
    e({ type: 'part_start', runId, messageId: 'a1', part: 1, partType: 'text' }),
    e({ type: 'part_delta', runId, messageId: 'a1', part: 1, delta: 'Сейчас ' }),
    e({ type: 'part_delta', runId, messageId: 'a1', part: 1, delta: 'посчитаю.', mode: 'append' }),
    e({ type: 'part_end', runId, messageId: 'a1', part: 1, payload: { type: 'text', text: 'Сейчас посчитаю.' } }),
    e({
      type: 'part_start',
      runId,
      messageId: 'a1',
      part: 2,
      partType: 'tool_use',
      meta: { callId: 'c1', name: 'calc' },
    }),
    e({
      type: 'part_end',
      runId,
      messageId: 'a1',
      part: 2,
      payload: { type: 'tool_use', data: { expr: '2+2' }, meta: { callId: 'c1', name: 'calc' } },
    }),
    e({
      type: 'message_end',
      runId,
      message: {
        id: 'a1',
        role: 'assistant',
        name: 'Бот',
        parts: [
          { type: 'thinking', text: 'надо посчитать' },
          { type: 'text', text: 'Сейчас посчитаю.' },
          { type: 'tool_use', data: { expr: '2+2' }, meta: { callId: 'c1', name: 'calc' } },
        ],
        meta: { model: 'fake-1', usage: { input: 10, output: 20 } },
      },
    }),

    // ask: ран стоит, пока клиент не ответит respond'ом (§5.3)
    e({ type: 'ask', runId, askId: 'ask1', kind: 'permission', payload: { tool: 'calc', input: { expr: '2+2' } } }),
    { await: hooks.onAsk },
    e({ type: 'activity', runId, kind: 'tool.running', payload: { tool: 'calc' } }),

    // tool_result отдельным сообщением (§2.3: пара может жить в разных)
    e({ type: 'message_start', runId, message: { id: 't1', role: 'tool' } }),
    e({
      type: 'part_start',
      runId,
      messageId: 't1',
      part: 0,
      partType: 'tool_result',
      meta: { callId: 'c1', name: 'calc' },
    }),
    e({ type: 'part_delta', runId, messageId: 't1', part: 0, delta: '4' }),
    e({
      type: 'part_end',
      runId,
      messageId: 't1',
      part: 0,
      payload: { type: 'tool_result', data: { value: 4 }, text: '4', meta: { callId: 'c1', name: 'calc' } },
    }),
    e({
      type: 'message_end',
      runId,
      message: {
        id: 't1',
        role: 'tool',
        parts: [{ type: 'tool_result', data: { value: 4 }, text: '4', meta: { callId: 'c1', name: 'calc' } }],
      },
    }),

    // финальный assistant + session_update
    e({ type: 'session_update', runId, fields: ['meta'] }),
    e({ type: 'message_start', runId, message: { id: 'a2', role: 'assistant', name: 'Бот' } }),
    e({ type: 'part_start', runId, messageId: 'a2', part: 0, partType: 'text' }),
    e({ type: 'part_delta', runId, messageId: 'a2', part: 0, delta: 'Ответ: 4' }),
    e({ type: 'part_end', runId, messageId: 'a2', part: 0, payload: { type: 'text', text: 'Ответ: 4' } }),
    e({
      type: 'message_end',
      runId,
      message: { id: 'a2', role: 'assistant', name: 'Бот', parts: [{ type: 'text', text: 'Ответ: 4' }] },
    }),

    // событие вне ядра протокола — клиент обязан пропустить его opaque (§1.2)
    e({ type: 'fake.telemetry', runId, payload: { tokensPerSec: 42 } } as AnyRunEvent),

    e({ type: 'run_end', runId, status: 'done', usage: { input: 10, output: 24 }, version: 'v2' }),
  ]
}

/** NotSupportedError с конкретной операцией — для проверки трансляции кода. */
export const notSupported = (op: string) => new NotSupportedError(op)
