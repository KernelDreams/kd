import { describe, it, expect } from 'vitest'
import {
  derivedText,
  matchToolPair,
  isTextPart,
  isToolUsePart,
  isKnownPart,
  isKnownRunEvent,
  isRunEvent,
  serializeRunEvent,
  parseRunEvent,
  parseSSEStream,
  KNOWN_PART_TYPES,
  KNOWN_RUN_EVENT_TYPES,
} from '../src/index.js'
import type {
  AnyPart,
  AnyRunEvent,
  Message,
  Part,
  RunEvent,
} from '../src/index.js'

// ────────────────────────────────────────────────────────────────────────────
// Фикстура: по одному экземпляру каждого RunEvent (§5.2)
// ────────────────────────────────────────────────────────────────────────────

const ALL_EVENTS: RunEvent[] = [
  { type: 'run_start', runId: 'r1' },
  { type: 'message_start', runId: 'r1', message: { id: 'm1', role: 'assistant', name: 'Bot' } },
  { type: 'message_start', runId: 'r1', message: { id: 'm2', role: 'assistant', meta: { personaId: 'mara', speech: { speaker: 'mara', voice: 'voice_1', instruct: 'angrily' } } } },
  { type: 'part_start', runId: 'r1', messageId: 'm1', part: 0, partType: 'text', meta: { x: 1 } },
  { type: 'part_delta', runId: 'r1', messageId: 'm1', part: 0, delta: 'hello', mode: 'append' },
  {
    type: 'part_end',
    runId: 'r1',
    messageId: 'm1',
    part: 1,
    payload: { type: 'tool_use', data: { q: 1 }, meta: { callId: 'c1', name: 'bash' } },
  },
  {
    type: 'message_end',
    runId: 'r1',
    message: { id: 'm1', role: 'assistant', parts: [{ type: 'text', text: 'hi' }] },
  },
  { type: 'ask', runId: 'r1', askId: 'a1', kind: 'permission', payload: { tool: 'bash', input: {} } },
  { type: 'ask_end', runId: 'r1', askId: 'a1' },
  { type: 'activity', runId: 'r1', kind: 'subagent', payload: { stage: 'thinking' } },
  { type: 'session_update', runId: 'r1', fields: ['meta', 'worldState'] },
  {
    type: 'run_end',
    runId: 'r1',
    status: 'done',
    usage: { input: 10, output: 20 },
    version: 'v2',
  },
]

describe('RunEvent SSE round-trip (§5.2 / §9)', () => {
  it('покрывает все известные типы событий', () => {
    const covered = new Set(ALL_EVENTS.map((e) => e.type))
    expect([...covered].sort()).toEqual([...KNOWN_RUN_EVENT_TYPES].sort())
  })

  for (const event of ALL_EVENTS) {
    it(`serialize→parse сохраняет ${event.type}`, () => {
      const frame = serializeRunEvent(event)
      expect(frame).toMatch(new RegExp(`^event: ${event.type}\\ndata: `))
      expect(frame.endsWith('\n\n')).toBe(true)

      const parsed = parseRunEvent(frame)
      expect(parsed).toEqual(event)
    })
  }

  it('парсит слитый стрим из всех событий', () => {
    const stream = ALL_EVENTS.map(serializeRunEvent).join('')
    const parsed = parseSSEStream(stream)
    expect(parsed).toEqual(ALL_EVENTS)
  })

  it('терпит CRLF и лишние пустые строки между кадрами', () => {
    const stream = ALL_EVENTS.map(serializeRunEvent)
      .join('\n')
      .replace(/\n/g, '\r\n')
    expect(parseSSEStream(stream)).toEqual(ALL_EVENTS)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Неизвестные типы: игнор, не throw (§1.2, §5.2)
// ────────────────────────────────────────────────────────────────────────────

describe('graceful degradation', () => {
  it('parseRunEvent не бросает на битом JSON, возвращает null', () => {
    expect(parseRunEvent('event: x\ndata: {not json')).toBeNull()
    expect(parseRunEvent('event: x\ndata: ')).toBeNull()
    expect(parseRunEvent(': keep-alive comment')).toBeNull()
    expect(parseRunEvent('')).toBeNull()
    expect(parseRunEvent('data: 42')).toBeNull() // не объект
    expect(parseRunEvent('data: {"no":"type"}')).toBeNull()
  })

  it('parseRunEvent пропускает событие неизвестного типа как opaque', () => {
    const frame = 'event: future_event\ndata: {"type":"future_event","runId":"r1","foo":9}'
    const parsed = parseRunEvent(frame)
    expect(parsed).not.toBeNull()
    expect(parsed!.type).toBe('future_event')
    expect(isKnownRunEvent(parsed!)).toBe(false)
  })

  it('parseSSEStream отбрасывает битые кадры, не роняя валидные', () => {
    const stream =
      serializeRunEvent(ALL_EVENTS[0]) +
      'event: junk\ndata: {broken\n\n' +
      serializeRunEvent(ALL_EVENTS[9])
    const parsed = parseSSEStream(stream)
    expect(parsed).toEqual([ALL_EVENTS[0], ALL_EVENTS[9]])
  })

  it('isKnownPart: opaque part неизвестного типа → false, не throw', () => {
    const opaque: AnyPart = { type: 'hologram', data: { spin: 1 } }
    expect(isKnownPart(opaque)).toBe(false)
    expect(isTextPart(opaque)).toBe(false)
  })

  it('isKnownPart: custom считается известным (escape hatch)', () => {
    const custom: Part = { type: 'custom', text: 'x', meta: { hint: 'nr.summary' } }
    expect(isKnownPart(custom)).toBe(true)
  })

  it('matchToolPair игнорит неизвестные part, не роняя матчинг', () => {
    const parts: AnyPart[] = [
      { type: 'hologram', data: {} },
      { type: 'tool_use', data: { a: 1 }, meta: { callId: 'c1', name: 'bash' } },
      { type: 'tool_result', text: 'ok', meta: { callId: 'c1' } },
    ]
    const pairs = matchToolPair(parts)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].callId).toBe('c1')
    expect(pairs[0].name).toBe('bash')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// derivedText (§2.2)
// ────────────────────────────────────────────────────────────────────────────

describe('derivedText', () => {
  it('конкатенирует только text-parts', () => {
    const msg: Message = {
      id: 'm1',
      role: 'assistant',
      parts: [
        { type: 'thinking', text: 'hmm' },
        { type: 'text', text: 'Hello' },
        { type: 'tool_use', data: {}, meta: { callId: 'c1', name: 'x' } },
        { type: 'text', text: ', world' },
        { type: 'image', meta: { url: 'u' } },
      ],
    }
    expect(derivedText(msg)).toBe('Hello, world')
  })

  it('пустые parts → пустая строка', () => {
    expect(derivedText({ parts: [] })).toBe('')
  })

  it('терпит opaque part среди text', () => {
    const parts: AnyPart[] = [
      { type: 'text', text: 'a' },
      { type: 'weird', text: 'IGNORED' },
      { type: 'text', text: 'b' },
    ]
    expect(derivedText({ parts: parts as Part[] })).toBe('ab')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// matchToolPair (§2.3)
// ────────────────────────────────────────────────────────────────────────────

describe('matchToolPair', () => {
  it('матчит use↔result по callId', () => {
    const parts: Part[] = [
      { type: 'tool_use', data: { cmd: 'ls' }, meta: { callId: 'c1', name: 'bash' } },
      { type: 'tool_result', text: 'file.txt', meta: { callId: 'c1' } },
    ]
    const pairs = matchToolPair(parts)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].use && isToolUsePart(pairs[0].use)).toBe(true)
    expect(pairs[0].result?.text).toBe('file.txt')
    expect(pairs[0].name).toBe('bash')
  })

  it('дырявая пара: только result (use в другом сообщении)', () => {
    const pairs = matchToolPair([
      { type: 'tool_result', data: { ok: true }, meta: { callId: 'c9', name: 'search', error: false } },
    ])
    expect(pairs).toHaveLength(1)
    expect(pairs[0].use).toBeUndefined()
    expect(pairs[0].result).toBeDefined()
    expect(pairs[0].name).toBe('search')
  })

  it('несколько тулов сохраняют порядок первого появления', () => {
    const parts: Part[] = [
      { type: 'tool_use', data: {}, meta: { callId: 'b', name: 'two' } },
      { type: 'tool_use', data: {}, meta: { callId: 'a', name: 'one' } },
      { type: 'tool_result', text: '', meta: { callId: 'a' } },
      { type: 'tool_result', text: '', meta: { callId: 'b' } },
    ]
    expect(matchToolPair(parts).map((p) => p.callId)).toEqual(['b', 'a'])
  })

  it('нет тулов → пустой массив', () => {
    expect(matchToolPair([{ type: 'text', text: 'hi' }])).toEqual([])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// guards / реестры
// ────────────────────────────────────────────────────────────────────────────

describe('type guards', () => {
  it('isRunEvent сужает по type', () => {
    const ev: AnyRunEvent = { type: 'part_delta', runId: 'r', messageId: 'm', part: 0, delta: 'x' }
    expect(isRunEvent(ev, 'part_delta')).toBe(true)
    expect(isRunEvent(ev, 'run_end')).toBe(false)
    if (isRunEvent(ev, 'part_delta')) {
      expect(ev.delta).toBe('x') // narrowing работает на уровне типов
    }
  })

  it('реестры перечисляют ровно ядро', () => {
    expect(KNOWN_PART_TYPES).toHaveLength(8)
    expect(KNOWN_RUN_EVENT_TYPES).toHaveLength(11)
  })
})

describe('v1.18 — команды рана и узел компакции', () => {
  it('canCommand — по списку run.commands', async () => {
    const { canCommand } = await import('../src/index.js')
    expect(canCommand({ run: { commands: ['compact'] } }, 'compact')).toBe(true)
    expect(canCommand({ run: { continue: true } }, 'compact')).toBe(false)
    expect(canCommand({}, 'compact')).toBe(false)
  })

  it('compactionOf — custom-часть pi.compaction, данные записи pi', async () => {
    const { compactionOf, COMPACTION_PART_HINT } = await import('../src/index.js')
    const msg = {
      role: 'system',
      parts: [{ type: 'custom' as const, text: 'S', data: { summary: 'S', firstKeptEntryId: 'k1', tokensBefore: 900, details: { readFiles: [] } }, meta: { hint: COMPACTION_PART_HINT } }],
    }
    expect(compactionOf(msg)).toEqual({ summary: 'S', firstKeptEntryId: 'k1', tokensBefore: 900, details: { readFiles: [] } })
    expect(compactionOf({ role: 'system', parts: [{ type: 'custom' as const, data: {}, meta: { hint: 'pi.model_change' } }] })).toBeUndefined()
    expect(compactionOf({ role: 'user', parts: [{ type: 'text' as const, text: 'x' }] })).toBeUndefined()
  })
})
