import { describe, expect, it } from 'vitest'
import { canPageHistory, canPageSessions, historyWindow, matchSessionQuery, pageSessions } from '../src/index.js'

describe('v1.57 окна (ABC-542)', () => {
  const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `msg${i}` }))
  it('historyWindow: хвост, before, без опций', () => {
    expect(historyWindow(msgs, undefined)).toEqual({ messages: msgs, more: false, total: 10 })
    const tail = historyWindow(msgs, { limit: 3 })
    expect(tail.messages.map((m) => m.id)).toEqual(['msg7', 'msg8', 'msg9'])
    expect(tail.more).toBe(true)
    const up = historyWindow(msgs, { limit: 3, before: 'msg7' })
    expect(up.messages.map((m) => m.id)).toEqual(['msg4', 'msg5', 'msg6'])
    expect(historyWindow(msgs, { limit: 50, before: 'msg2' })).toMatchObject({ more: false, messages: [{ id: 'msg0' }, { id: 'msg1' }] })
  })
  it('matchSessionQuery и pageSessions', () => {
    const rows = [
      { id: 'a1', title: 'Тормоза nrchat', tags: ['perf'] },
      { id: 'b2', title: 'Голос', botName: 'Carol', tags: ['voice/rp'] },
      { id: 'c3', title: 'Тормоза голоса' },
    ]
    expect(pageSessions(rows, { query: 'тормоза' }).map((r) => r.id)).toEqual(['a1', 'c3'])
    expect(pageSessions(rows, { query: '#voice' }).map((r) => r.id)).toEqual(['b2'])
    expect(pageSessions(rows, { query: 'carol голос' }).map((r) => r.id)).toEqual(['b2'])
    expect(pageSessions(rows, { offset: 1, limit: 1 }).map((r) => r.id)).toEqual(['b2'])
    expect(matchSessionQuery(rows[0]!, '  ')).toBe(true)
    expect(canPageHistory({ history: { page: true } })).toBe(true)
    expect(canPageSessions({})).toBe(false)
  })
})
