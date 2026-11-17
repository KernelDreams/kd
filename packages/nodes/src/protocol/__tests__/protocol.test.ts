import { describe, expect, it } from 'vitest'
import { EVENT_TYPES, fromTraceText, initialRunState, notifyEvent, parseEvent, reduceRun, request } from '../index.js'

const TRACE = [
  { t: '2026-11-16T10:00:00Z', ev: 'run.start', doc: 'fix.mdz', run: 'r1' },
  { t: '2026-11-16T10:00:01Z', ev: 'step.start', step: 'portrait', part: 'robin', title: 'Портрет' },
  { t: '2026-11-16T10:00:02Z', ev: 'llm', step: 'portrait', model: 'glm', tokens_in: 10, tokens_out: 5 },
  { t: '2026-11-16T10:00:03Z', ev: 'step.end', step: 'portrait', part: 'robin', ms: 2000, ok: true, out: 'out/robin.png' },
  { t: '2026-11-16T10:00:04Z', ev: 'step.start', step: 'lore' },
  { t: '2026-11-16T10:00:05Z', ev: 'step.end', step: 'lore', ms: 900, ok: false, error: 'таймаут' },
  { t: '2026-11-16T10:00:06Z', ev: 'run.end', ms: 6000, ok: false, error: 'шаг lore' },
]
  .map((r) => JSON.stringify(r))
  .join('\n')

describe('след runz → события протокола', () => {
  it('шаг — сущность, ветка — экземпляр; выход и завершение — разные события', () => {
    const ev = fromTraceText(TRACE + '\n{битая строка\n')
    expect(ev.map((e) => e.type)).toEqual(['log', 'node.started', 'log', 'node.value', 'node.completed', 'node.started', 'node.failed', 'run.failed', 'log'])
    expect(ev.every((e) => e.runId === 'r1')).toBe(true)
    expect(ev.map((e) => e.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(ev[1]).toMatchObject({ at: { entity: 'portrait', instance: ['robin'] }, title: 'Портрет' })
    expect(ev[3]).toMatchObject({ type: 'node.value', artifact: { artifact: 'out/robin.png' } })
    expect(ev[8]).toMatchObject({ type: 'log', level: 'debug' })
  })

  it('состояние прогона сворачивается из событий', () => {
    const s = fromTraceText(TRACE).reduce(reduceRun, initialRunState())
    expect(s.status).toBe('failed')
    expect(s.nodes['portrait@robin']).toMatchObject({ status: 'done', ms: 2000, artifact: { artifact: 'out/robin.png' } })
    expect(s.nodes.lore).toMatchObject({ status: 'failed', error: 'таймаут' })
  })
})

describe('провод', () => {
  it('незнакомое событие — unknown, не throw', () => {
    expect(parseEvent({ type: 'node.started', runId: 'r', sequence: 1 }).type).toBe('node.started')
    expect(parseEvent({ type: 'robot.danced', runId: 'r', sequence: 2 })).toMatchObject({ type: 'unknown', runId: 'r', sequence: 2 })
    expect(parseEvent(null).type).toBe('unknown')
    expect(parseEvent({ type: 'node.started' }).type).toBe('unknown')
    expect(reduceRun(initialRunState(), parseEvent('x')).unknown).toBe(1)
  })

  it('JSON-RPC 2.0: запрос и уведомление-событие', () => {
    expect(request(1, 'run.start', { graph: { ref: 'a.mdz' }, mode: 'graph' })).toEqual({ jsonrpc: '2.0', id: 1, method: 'run.start', params: { graph: { ref: 'a.mdz' }, mode: 'graph' } })
    expect(notifyEvent({ type: 'run.cancelled', runId: 'r', sequence: 3 }).method).toBe('event')
    expect(EVENT_TYPES).toContain('interaction.requested')
  })
})
