import { describe, expect, it } from 'vitest'
import { canAttachRun, canEngines, canSetEngine, engineItems, localEngineOf, sessionEngineOf, switchTargets, engineCaps } from '../src/index.js'
import type { Capabilities } from '../src/index.js'

// v1.29 — движки хаба (users-spec §1).
const hub: Pick<Capabilities, 'engines'> = {
  engines: { list: [{ id: 'nr', local: true, available: true }, { id: 'acp', name: 'Claude Code', available: false }], default: 'nr', switch: true },
}

describe('движки хаба', () => {
  it('гейты: нет engines — не хаб; switch — смена исполнителя', () => {
    expect(canEngines(hub)).toBe(true)
    expect(canSetEngine(hub)).toBe(true)
    expect(canEngines({})).toBe(false)
    expect(canEngines(null)).toBe(false)
    expect(canSetEngine({ engines: { ...hub.engines!, switch: false } })).toBe(false)
  })

  it('движок сессии: поле, иначе встроенный; не хаб — нет', () => {
    expect(localEngineOf(hub)).toBe('nr')
    expect(sessionEngineOf(hub, { engine: 'acp' })).toBe('acp')
    expect(sessionEngineOf(hub, {})).toBe('nr')
    expect(sessionEngineOf({}, { engine: 'acp' })).toBeUndefined()
  })

  it('каталог глазами движка: непомеченное — встроенного', () => {
    const items = [{ id: 'a' }, { id: 'b', engine: 'acp' }, { id: 'c', engine: 'nr' }]
    expect(engineItems(items, 'acp', 'nr').map((i) => i.id)).toEqual(['b'])
    expect(engineItems(items, 'nr', 'nr').map((i) => i.id)).toEqual(['a', 'c'])
    expect(engineItems(items, undefined, 'nr').map((i) => i.id)).toEqual(['a', 'c'])
    expect(engineItems(items, 'acp', undefined)).toHaveLength(3)
  })
})

// v1.31 — цели смены исполнителя, подхват рана.
describe('v1.31', () => {
  it('switchTargets: без .mds (switch: false) — не цель; без switch хаба — пусто', () => {
    const caps: Pick<Capabilities, 'engines'> = {
      engines: { list: [{ id: 'nr', local: true, available: true }, { id: 'acp', available: true }, { id: 'pi', available: true, switch: false }], default: 'nr', switch: true },
    }
    expect(switchTargets(caps).map((e) => e.id)).toEqual(['nr', 'acp'])
    expect(switchTargets({ engines: { ...caps.engines!, switch: false } })).toEqual([])
    expect(switchTargets(null)).toEqual([])
  })

  it('canAttachRun — по capability sessions.attach', () => {
    expect(canAttachRun({ sessions: { attach: true } })).toBe(true)
    expect(canAttachRun({ sessions: {} })).toBe(false)
    expect(canAttachRun({})).toBe(false)
  })
})

// v1.33 (П-8) — capabilities по движку сессии.
describe('v1.33', () => {
  it('engineCaps: поля движка поверх стенда; встроенный, без отличий, не хаб — стенд как есть', () => {
    const caps: Capabilities = {
      attachments: { maxBytes: 25 * 1024 * 1024 },
      models: { select: true },
      engines: {
        list: [
          { id: 'nr', local: true, available: true, caps: { attachments: { maxBytes: 1 } } },
          { id: 'acp', available: true, caps: { attachments: { maxBytes: 2 * 1024 * 1024 }, models: { select: true, thinking: true } } },
          { id: 'pi', available: true },
        ],
        default: 'nr',
      },
    } as Capabilities
    expect(engineCaps(caps, 'acp')).toMatchObject({ attachments: { maxBytes: 2 * 1024 * 1024 }, models: { thinking: true } })
    expect(engineCaps(caps, 'nr')).toBe(caps)
    expect(engineCaps(caps, 'pi')).toBe(caps)
    expect(engineCaps(caps, undefined)).toBe(caps)
    expect(engineCaps(null, 'acp')).toBeNull()
  })
})
