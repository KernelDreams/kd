import { describe, it, expect } from 'vitest'
import { NotSupportedError, NOT_SUPPORTED_CODE } from '../src/index.js'
import type {
  Capabilities,
  ModelsOps,
  ProtocolBackend,
  SessionCreateOpts,
  SessionInfo,
  SessionModel,
  SessionUpdateEvent,
  WorkspaceInfo,
  WorkspaceOps,
} from '../src/index.js'

// ────────────────────────────────────────────────────────────────────────────
// NotSupportedError (backends-spec §2, §3.1)
// ────────────────────────────────────────────────────────────────────────────

describe('NotSupportedError', () => {
  it('несёт код not_supported и имя операции', () => {
    const err = new NotSupportedError('sessions.fork')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('NotSupportedError')
    expect(err.code).toBe(NOT_SUPPORTED_CODE)
    expect(err.code).toBe('not_supported')
    expect(err.operation).toBe('sessions.fork')
    expect(err.message).toContain('sessions.fork')
  })

  it('работает без аргументов и с явным сообщением', () => {
    expect(new NotSupportedError().operation).toBeUndefined()
    expect(new NotSupportedError('x', 'нельзя').message).toBe('нельзя')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// ProtocolBackend — контракт на уровне типов (компилируемость = тест)
// ────────────────────────────────────────────────────────────────────────────

describe('ProtocolBackend', () => {
  it('минимальное ядро реализуемо без единого опционального метода', async () => {
    const minimal: ProtocolBackend = {
      capabilities: async () => ({ protocol: 1, name: 'minimal' }),
      sessions: {
        list: async () => [],
        create: async () => ({ id: 's1' }),
        get: async (id) => ({ id }),
        delete: async () => {},
      },
      history: async () => ({ messages: [], version: 'v0' }),
      run: async function* () {
        yield { type: 'run_start' as const, runId: 'r1' }
        yield { type: 'run_end' as const, runId: 'r1', status: 'done' as const, version: 'v1' }
      },
      cancel: async () => {},
    }

    expect(minimal.sessions.fork).toBeUndefined()
    expect(minimal.messages).toBeUndefined()
    expect(minimal.close).toBeUndefined()

    const events = []
    for await (const ev of minimal.run('s1', {})) events.push(ev.type)
    expect(events).toEqual(['run_start', 'run_end'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// models (models-spec §2–§3) — контракт на уровне типов
// ────────────────────────────────────────────────────────────────────────────

describe('models', () => {
  it('модели опциональны: ядро без них — валидный бэкенд', () => {
    const minimal: ProtocolBackend = {
      capabilities: async () => ({ protocol: 1 }),
      sessions: { list: async () => [], create: async () => ({ id: 's1' }), get: async (id) => ({ id }), delete: async () => {} },
      history: async () => ({ messages: [], version: '' }),
      run: async function* () {},
      cancel: async () => {},
    }
    expect(minimal.models).toBeUndefined()
  })

  it('list без set — заявляется как models без select (только показ)', async () => {
    const caps: Capabilities = { protocol: 1, models: {} }
    const models: ModelsOps = { list: async () => [{ id: 'nr/glm-5.3-flash' }] }
    expect(caps.models?.select).toBeUndefined()
    expect(models.set).toBeUndefined()
    expect((await models.list())[0]!.id).toBe('nr/glm-5.3-flash')
  })

  it('set возвращает ПРИМЕНЁННОЕ: бэкенд вправе поправить thinking', async () => {
    const models: ModelsOps = {
      list: async () => [
        { id: 'nr/opus', name: 'Opus', provider: 'nr', tags: ['vision', 'reasoning'], thinking: ['off', 'high'], contextWindow: 200_000 },
      ],
      // модель уровней не тянет — применён 'off', а не запрошенный 'max'
      set: async (_sid, model) => ({ model: model.model, thinking: 'off' }),
    }
    const applied = await models.set!('s1', { model: 'nr/opus', thinking: 'max' })
    expect(applied).toEqual({ model: 'nr/opus', thinking: 'off' })
  })

  it('sessions.create принимает модель, SessionInfo её несёт', async () => {
    const chosen: SessionModel = { model: 'nr/opus', thinking: 'high' }
    const opts: SessionCreateOpts = { title: 'Новая', model: chosen }
    const info: SessionInfo = { id: 's1', title: opts.title, model: opts.model }
    expect(info.model).toEqual(chosen)
  })

  it('session_update{fields:["model"]} — смена не через клиента', () => {
    const ev: SessionUpdateEvent = { type: 'session_update', runId: 'r1', fields: ['model'] }
    expect(ev.fields).toContain('model')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// workspace (workspace-spec §2–3) — контракт на уровне типов
// ────────────────────────────────────────────────────────────────────────────

describe('workspace', () => {
  it('current/list без switch — пространство есть, переключать нельзя', async () => {
    const caps: Capabilities = { protocol: 1, workspace: {} }
    const here: WorkspaceInfo = { id: 'memory', name: 'memory' }
    const workspace: WorkspaceOps = { current: async () => here, list: async () => [here] }

    expect(caps.workspace).toBeDefined()
    expect(caps.workspace?.switch).toBeUndefined()
    expect(workspace.switch).toBeUndefined()
    expect(await workspace.list()).toEqual([here])
  })

  it('switch заявлен capability и возвращает новое текущее', async () => {
    const spaces: WorkspaceInfo[] = [
      { id: '/work/a', name: 'a', path: '/work/a', kind: 'directory' },
      { id: '/work/b', name: 'b', path: '/work/b', kind: 'directory' },
    ]
    let current = spaces[0]!
    const caps: Capabilities = { protocol: 1, workspace: { switch: true } }
    const workspace: WorkspaceOps = {
      current: async () => current,
      list: async () => spaces,
      switch: async (id) => {
        const next = spaces.find((w) => w.id === id)
        if (!next) throw new Error(`нет пространства ${id}`)
        current = next
        return next
      },
    }

    expect(caps.workspace?.switch).toBe(true)
    expect(await workspace.switch!('/work/b')).toEqual(spaces[1])
    expect((await workspace.current()).id).toBe('/work/b')
  })

  it('SessionInfo.workspace несёт id пространства сессии', () => {
    const info: SessionInfo = { id: 's1', workspace: '/work/a' }
    expect(info.workspace).toBe('/work/a')
  })

  it('бэкенд без пространства — capability нет, метода нет', async () => {
    const minimal: ProtocolBackend = {
      capabilities: async () => ({ protocol: 1 }),
      sessions: { list: async () => [], create: async () => ({ id: 's1' }), get: async (id) => ({ id }), delete: async () => {} },
      history: async () => ({ messages: [], version: '' }),
      run: async function* () {},
      cancel: async () => {},
    }
    expect(minimal.workspace).toBeUndefined()
    expect((await minimal.capabilities()).workspace).toBeUndefined()
  })
})
