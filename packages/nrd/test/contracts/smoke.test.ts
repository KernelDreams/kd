import { describe, it, expect } from 'vitest'
import {
  ok,
  err,
  isOk,
  isErr,
  isScalar,
  isContext,
  isArray,
  isInterpolated,
  asText,
  noopLogger,
  isServiceResult,
  type CodeLoader,
  type IContext,
  type ScriptOutput,
  type SourceContext,
} from '../../src/contracts/index.js'

describe('Result constructors', () => {
  it('ok / err / guards', () => {
    const good = ok(42)
    const bad = err(new Error('x'))
    expect(good).toEqual({ ok: true, value: 42 })
    expect(isOk(good)).toBe(true)
    expect(isErr(bad)).toBe(true)
  })
})

describe('guards', () => {
  it('isScalar', () => {
    expect(isScalar('a')).toBe(true)
    expect(isScalar(1)).toBe(true)
    expect(isScalar(true)).toBe(true)
    expect(isScalar(null)).toBe(false)
    expect(isScalar({})).toBe(false)
  })

  it('isContext / isArray require cast', () => {
    const ctx: IContext = { get: () => undefined, func: () => undefined, cast: () => undefined }
    expect(isContext(ctx)).toBe(true)
    expect(isContext(new Map())).toBe(false)
    expect(isArray([])).toBe(false)
  })

  it('isInterpolated + asText', () => {
    const iv = { raw: 'hi ${x}', placeholders: [] }
    expect(isInterpolated(iv)).toBe(true)
    expect(asText(iv)).toBe('hi ${x}')
    expect(asText(7)).toBe('7')
    expect(asText('s')).toBe('s')
  })
})

describe('protocol', () => {
  it('noopLogger is silent', () => {
    expect(() => noopLogger.info('x')).not.toThrow()
  })

  it('isServiceResult discriminates', () => {
    const svc: ScriptOutput = { pid: 123 }
    const res: ScriptOutput = { output: 'hi' }
    expect(isServiceResult(svc)).toBe(true)
    expect(isServiceResult(res)).toBe(false)
  })
})

describe('CodeLoader (rz-merge §0.5)', () => {
  // Реализация без ФС и без require — контракт обязан её допускать (Workers).
  const memoryLoader: CodeLoader = {
    id: 'memory',
    async load(code, opts) {
      return { default: () => code, lang: opts?.lang ?? 'ts', where: opts?.baseDir }
    },
  }

  it('грузит код и отдаёт пространство имён модуля', async () => {
    const mod = await memoryLoader.load('export default 1', { lang: 'ts', baseDir: '/tmp' })
    expect(typeof mod.default).toBe('function')
    expect(mod.lang).toBe('ts')
    expect(mod.where).toBe('/tmp')
  })

  it('встаёт в SourceContext рядом со storage/executor', () => {
    const ctx: SourceContext = {
      baseDir: '.',
      params: {},
      log: noopLogger,
      codeLoader: memoryLoader,
    }
    expect(ctx.codeLoader?.id).toBe('memory')
  })
})

describe('image (image-gen-spec §1)', () => {
  it('imageError — Error с name из словаря и телом', async () => {
    const { imageError } = await import('../../src/contracts/index.js')
    const e = imageError('ModerationError', 'Content Moderated', '{"status":"Content Moderated"}')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('ModerationError')
    expect(e.message).toBe('Content Moderated')
    expect(e.body).toBe('{"status":"Content Moderated"}')
    expect(imageError('AuthError', 'x').body).toBeUndefined()
  })
})
