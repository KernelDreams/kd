import { describe, expect, it } from 'vitest'
import { NotSupportedError, NOT_SUPPORTED_CODE, canSessionCwd, isAbsolutePath, mergeSessionMeta, sessionCwdOf } from '../src/index.js'

describe('v1.20 — рабочий каталог сессии', () => {
  it('canSessionCwd — только perSession: true', () => {
    expect(canSessionCwd({})).toBe(false)
    expect(canSessionCwd({ workspace: {} })).toBe(false)
    expect(canSessionCwd({ workspace: { perSession: false } })).toBe(false)
    expect(canSessionCwd({ workspace: { perSession: true } })).toBe(true)
  })

  it('sessionCwdOf читает workspace.cwd', () => {
    expect(sessionCwdOf(undefined)).toBeUndefined()
    expect(sessionCwdOf({})).toBeUndefined()
    expect(sessionCwdOf({ workspace: { cwd: '' } })).toBeUndefined()
    expect(sessionCwdOf({ workspace: { cwd: 42 } })).toBeUndefined()
    expect(sessionCwdOf({ workspace: { cwd: '/tmp/a' } })).toBe('/tmp/a')
  })

  it('isAbsolutePath — POSIX, диск Windows, UNC', () => {
    for (const p of ['/a', 'C:\\x', 'd:/y', '\\\\host\\share']) expect(isAbsolutePath(p)).toBe(true)
    for (const p of ['a', './a', '~/a', 'C:x', '']) expect(isAbsolutePath(p)).toBe(false)
  })

  it('патч меты: workspace заменяется целиком, null — снимает', () => {
    const a = mergeSessionMeta({ notes: 'n' }, { workspace: { cwd: '/a' } })
    expect(a).toEqual({ notes: 'n', workspace: { cwd: '/a' } })
    expect(mergeSessionMeta(a, { workspace: { cwd: '/b' } }).workspace).toEqual({ cwd: '/b' })
    expect(mergeSessionMeta(a, { workspace: null }).workspace).toBeUndefined()
  })
})

describe('NotSupportedError — instanceof по форме', () => {
  it('чужой класс с тем же name и code — instanceof', () => {
    class Foreign extends Error {
      readonly code = NOT_SUPPORTED_CODE
      constructor(m: string) {
        super(m)
        this.name = 'NotSupportedError'
      }
    }
    expect(new Foreign('x') instanceof NotSupportedError).toBe(true)
    expect(new NotSupportedError('op') instanceof NotSupportedError).toBe(true)
    expect(new Error('x') instanceof NotSupportedError).toBe(false)
    const coded = Object.assign(new Error('x'), { code: NOT_SUPPORTED_CODE })
    expect(coded instanceof NotSupportedError).toBe(false)
  })
})
