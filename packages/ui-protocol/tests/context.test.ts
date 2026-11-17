/**
 * Управляемый контекст (v1.32, front-context-spec §4): мета `context` и
 * заглушка с адресом; `canSkins(caps, 'user')` — user.css (§6).
 */

import { describe, expect, it } from 'vitest'
import { canSkins, clearedKeyOf, clearedStub, formatBytes, mergeSessionMeta, sessionContextOf, withSessionContext } from '../src/index.js'

describe('мета context', () => {
  it('sessionContextOf: только строковые списки без дублей; мусор — пусто', () => {
    expect(sessionContextOf(undefined)).toEqual({})
    expect(sessionContextOf({ context: 'x' })).toEqual({})
    expect(sessionContextOf({ context: { pinned: ['a', 'a', 1, ''], dropped: 'b', cleared: ['c'] } })).toEqual({ pinned: ['a'], cleared: ['c'] })
  })

  it('withSessionContext меняет один список, чужие целы; патч меты — объект целиком', () => {
    const meta = { context: { pinned: ['p1'], dropped: ['d1'] } }
    const next = withSessionContext(meta, 'cleared', ['d1', 'x'])
    expect(next).toEqual({ pinned: ['p1'], dropped: ['d1'], cleared: ['d1', 'x'] })
    expect(withSessionContext({ context: next }, 'cleared', [])).toEqual({ pinned: ['p1'], dropped: ['d1'] })
    expect(mergeSessionMeta(meta, { context: next }).context).toEqual(next)
  })
})

describe('заглушка с адресом', () => {
  it('ключ — file_path/path/command/pattern/url/query по порядку; размер B/KB', () => {
    expect(formatBytes(320)).toBe('320 B')
    expect(formatBytes(14540)).toBe('14.2 KB')
    expect(clearedKeyOf({ path: 'a.ts', file_path: '/abs/a.ts' })).toBe('/abs/a.ts')
    expect(clearedStub('Read', { file_path: '/w/SKILL.md' }, 14540)).toBe('[cleared: Read /w/SKILL.md, 14.2 KB — перечитай при нужде]')
    expect(clearedStub('bash', { command: 'ls\n  -la' }, 320)).toBe('[cleared: bash ls -la, 320 B — перечитай при нужде]')
    expect(clearedStub('mystery', { x: 1 }, 5)).toBe('[cleared: mystery, 5 B — перечитай при нужде]')
  })
})

describe('skins.user', () => {
  it('canSkins(caps, "user")', () => {
    expect(canSkins({ skins: { user: true } } as never, 'user')).toBe(true)
    expect(canSkins({ skins: { save: true } } as never, 'user')).toBe(false)
  })
})
