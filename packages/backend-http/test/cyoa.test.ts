/**
 * CYOA на хосте (v1.47): служебные команды `choices`/`editor` идут
 * параллельно ходу и пишут только мету ответа; `direction` реплики — `meta.direction`
 * и `picked` у варианта; правка меты сообщения клиентом — только ключи плагинов.
 */
import { describe, expect, it } from 'vitest'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'
import type { AnyRunEvent } from '@kerneldreams/ui-protocol'
import { createStoreBackend, type GenerateRequest } from '../src/store-backend.js'
import { serveBackend } from '../src/serve.js'
import { createHttpBackend } from '../src/client.js'

async function drain(it: AsyncIterable<AnyRunEvent>): Promise<AnyRunEvent[]> {
  const out: AnyRunEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

const CHOICES = { choices: [{ label: 'Отвлечь', intent: 'отвлечь стражника разговором', axis: 'social' }, { label: 'Ударить', intent: 'ударить первым', axis: 'bold' }] }

function setup(onGenerate?: (req: GenerateRequest) => void) {
  const store = createMemoryStore()
  let release: (() => void) | undefined
  const backend = createStoreBackend({
    store,
    name: 'fixture',
    commands: ['compact', 'choices', 'editor'],
    impersonate: true,
    generate: async function* (req) {
      onGenerate?.(req)
      if (req.command?.name === 'choices') {
        yield { type: 'node_meta', id: req.command.options!.messageId as string, patch: { choices: CHOICES } }
        return
      }
      if (req.command?.name === 'editor') {
        yield { type: 'node_meta', id: req.command.options!.messageId as string, patch: { editorNotes: ['Не повторяй жест.'] } }
        return
      }
      if (req.target?.kind === 'user') {
        yield { type: 'text', delta: 'Эй, как жена?' }
        return
      }
      // «долгий» ход: ждёт, пока тест его отпустит
      if (req.messages.at(-1)?.parts.some((p) => p.type === 'text' && p.text === 'долго')) await new Promise<void>((r) => (release = r))
      yield { type: 'text', delta: 'Стражник хмурится.' }
    },
  })
  return { store, backend, release: () => release?.() }
}

describe('служебные команды CYOA', () => {
  it('choices: мета ответа бота, кадр activity node_meta; сообщений не пишет', async () => {
    const seen: GenerateRequest[] = []
    const { store, backend } = setup((r) => seen.push(r))
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Подхожу к воротам.' }))
    const bot = (await backend.history(s.id)).messages.at(-1)!
    const events = await drain(backend.run(s.id, { command: { name: 'choices', options: { messageId: bot.id, count: 4 } } }))
    expect(events.find((e) => e.type === 'activity')).toMatchObject({ kind: 'node_meta', payload: { id: bot.id, patch: { choices: CHOICES } } })
    expect(events.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    const after = (await backend.history(s.id)).messages
    expect(after).toHaveLength(2)
    expect(after.at(-1)!.meta?.choices).toEqual(CHOICES)
    // контекст — путь до ответа, опции дошли
    expect(seen.at(-1)!.messages.at(-1)!.id).toBe(bot.id)
    expect(seen.at(-1)!.command!.options).toEqual({ messageId: bot.id, count: 4 })
    void store
  })

  it('идёт параллельно ходу той же сессии: busy не берёт', async () => {
    const { backend, release } = setup()
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Подхожу.' }))
    const bot = (await backend.history(s.id)).messages.at(-1)!
    // ход владельца висит, а редактор к прошлому ответу дорабатывает
    const turn = drain(backend.run(s.id, { userMessage: 'долго' }))
    await new Promise((r) => setTimeout(r, 20))
    const side = await drain(backend.run(s.id, { command: { name: 'editor', options: { messageId: bot.id } } }))
    expect(side.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    release()
    expect((await turn).at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    const msgs = (await backend.history(s.id)).messages
    expect(msgs.find((m) => m.id === bot.id)!.meta?.editorNotes).toEqual(['Не повторяй жест.'])
    expect(msgs).toHaveLength(4)
  })

  it('без messageId — bad_request; чужой id — not_found', async () => {
    const { backend } = setup()
    const s = await backend.sessions.create()
    await expect(drain(backend.run(s.id, { command: { name: 'choices' } }))).rejects.toMatchObject({ code: 'bad_request' })
    await expect(drain(backend.run(s.id, { command: { name: 'choices', options: { messageId: 'nope' } } }))).rejects.toThrow()
  })
})

describe('direction', () => {
  it('реплика по направлению — meta.direction и picked у варианта; без choice — picked нет', async () => {
    const { backend } = setup()
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Подхожу.' }))
    const bot = (await backend.history(s.id)).messages.at(-1)!
    await drain(backend.run(s.id, { command: { name: 'choices', options: { messageId: bot.id } } }))
    const direction = { intent: 'отвлечь стражника разговором', axis: 'social' as const, choice: { messageId: bot.id, index: 0 } }
    await drain(backend.run(s.id, { userMessage: 'Эй, как жена?', direction }))
    const msgs = (await backend.history(s.id)).messages
    expect(msgs[2]!.meta?.direction).toEqual(direction)
    expect(msgs[1]!.meta?.choices).toEqual({ ...CHOICES, picked: 0 })
  })

  it('выброшенный черновик (impersonate с direction) — ни записи, ни picked; direction дошёл до генерации', async () => {
    const seen: GenerateRequest[] = []
    const { backend } = setup((r) => seen.push(r))
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Подхожу.' }))
    const bot = (await backend.history(s.id)).messages.at(-1)!
    await drain(backend.run(s.id, { command: { name: 'choices', options: { messageId: bot.id } } }))
    await drain(backend.run(s.id, { target: { kind: 'user' }, direction: { intent: 'ударить первым', tone: ['зло'], choice: { messageId: bot.id, index: 1 } } }))
    expect(seen.at(-1)!.direction).toEqual({ intent: 'ударить первым', tone: ['зло'], choice: { messageId: bot.id, index: 1 } })
    const msgs = (await backend.history(s.id)).messages
    expect(msgs).toHaveLength(2)
    expect(msgs[1]!.meta?.choices).toEqual(CHOICES)
  })

  it('append с direction (impress.send = send): реплика без ответа бота', async () => {
    const { backend } = setup()
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Подхожу.' }))
    const bot = (await backend.history(s.id)).messages.at(-1)!
    await drain(backend.run(s.id, { command: { name: 'choices', options: { messageId: bot.id } } }))
    const m = await backend.messages!.append!(s.id, [{ type: 'text', text: 'Бью первым.' }], { direction: { intent: 'ударить первым', choice: { messageId: bot.id, index: 1 } } })
    expect(m.meta?.direction).toMatchObject({ intent: 'ударить первым' })
    const msgs = (await backend.history(s.id)).messages
    expect(msgs).toHaveLength(3)
    expect(msgs[1]!.meta?.choices).toMatchObject({ picked: 1 })
    await expect(backend.messages!.append!(s.id, [{ type: 'text', text: 'x' }], { direction: { intent: '' } })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('битое направление рана — bad_request', async () => {
    const { backend } = setup()
    const s = await backend.sessions.create()
    await expect(drain(backend.run(s.id, { userMessage: 'x', direction: { intent: 42 } as never }))).rejects.toMatchObject({ code: 'bad_request' })
  })
})

describe('правка меты сообщения (MessageEditPatch.meta)', () => {
  it('ключи плагинов — да, посреди хода тоже; прочие — bad_request; текст цел', async () => {
    const { backend, release } = setup()
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Подхожу.' }))
    const bot = (await backend.history(s.id)).messages.at(-1)!
    const turn = drain(backend.run(s.id, { userMessage: 'долго' }))
    await new Promise((r) => setTimeout(r, 20))
    const edited = await backend.messages!.edit!(s.id, bot.id, { meta: { editorNotes: ['Правка руками.'] } })
    expect(edited.meta?.editorNotes).toEqual(['Правка руками.'])
    expect(edited.parts).toEqual(bot.parts)
    await expect(backend.messages!.edit!(s.id, bot.id, { meta: { model: 'x' } })).rejects.toMatchObject({ code: 'bad_request' })
    release()
    await turn
    await backend.messages!.edit!(s.id, bot.id, { meta: { editorNotes: null } })
    expect((await backend.history(s.id)).messages.find((m) => m.id === bot.id)!.meta?.editorNotes).toBeUndefined()
  })
})

describe('провод: служебный ран рядом с ходом', () => {
  it('HTTP: editor идёт, пока ход висит (замок транспорта его не держит); живым раном сессии не числится', async () => {
    const { backend, release } = setup()
    const srv = await serveBackend(backend)
    try {
      const client = createHttpBackend(srv.url)
      const s = await client.sessions.create()
      await drain(client.run(s.id, { userMessage: 'Подхожу.' }))
      const bot = (await client.history(s.id)).messages.at(-1)!
      const turn = drain(client.run(s.id, { userMessage: 'долго' }))
      await new Promise((r) => setTimeout(r, 50))
      // второй обычный ран — busy, как и было
      await expect(drain(client.run(s.id, { userMessage: 'ещё' }))).rejects.toMatchObject({ code: 'busy' })
      const side = await drain(client.run(s.id, { command: { name: 'editor', options: { messageId: bot.id } } }))
      expect(side.find((e) => e.type === 'activity')).toMatchObject({ kind: 'node_meta' })
      expect(side.at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
      // ход сессии — по-прежнему тот, долгий
      const info = (await client.sessions.list()).find((x) => x.id === s.id)
      expect(info?.run).toBeDefined()
      release()
      expect((await turn).at(-1)).toMatchObject({ type: 'run_end', status: 'done' })
    } finally {
      await srv.close()
    }
  })
})

describe('чип переменных пресета (v1.67, ABC-723 §5)', () => {
  it('run.vars → meta.vars реплики игрока; кривое — bad_request', async () => {
    const seen: GenerateRequest[] = []
    const { backend } = setup((r) => seen.push(r))
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Привет.', vars: { language: 'ru', person: '' } }))
    const msgs = (await backend.history(s.id)).messages
    expect(msgs[0]!.meta?.vars).toEqual({ language: 'ru' })
    expect(seen.at(-1)!.messages.at(-1)!.meta?.vars).toEqual({ language: 'ru' })
    await expect(drain(backend.run(s.id, { userMessage: 'x', vars: 'ru' as never }))).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('свайп с чипом: vars — в мету реплики-родителя, генерация видит их', async () => {
    const seen: GenerateRequest[] = []
    const { backend } = setup((r) => seen.push(r))
    const s = await backend.sessions.create()
    await drain(backend.run(s.id, { userMessage: 'Привет.', vars: { language: 'ru' } }))
    const bot = (await backend.history(s.id)).messages.find((m) => m.role === 'assistant')!
    await drain(backend.run(s.id, { regenerate: { messageId: bot.id }, vars: { language: 'en', person: '1' } }))
    const user = (await backend.history(s.id)).messages.find((m) => m.role === 'user')!
    expect(user.meta?.vars).toEqual({ language: 'en', person: '1' })
    expect(seen.at(-1)!.messages.at(-1)!.meta?.vars).toEqual({ language: 'en', person: '1' })
  })
})
