import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import * as path from 'node:path'
import { expandHome, resolvePath, parsePathList } from '../src/paths.ts'

const HOME = os.homedir()

describe('expandHome', () => {
  it('expands a leading ~/', () => {
    expect(expandHome('~/x')).toBe(path.join(HOME, 'x'))
    expect(expandHome('~/Studio/appz')).toBe(path.join(HOME, 'Studio', 'appz'))
  })

  it('expands a bare ~', () => {
    expect(expandHome('~')).toBe(HOME)
  })

  it.runIf(process.platform === 'win32')('expands a leading ~\\ (Windows-style config)', () => {
    expect(expandHome('~\\.runz\\scripts')).toBe(path.join(HOME, '.runz', 'scripts'))
  })

  it('leaves absolute paths alone', () => {
    expect(expandHome('/abs/x')).toBe('/abs/x')
    expect(expandHome('S:\\appz')).toBe('S:\\appz')
  })

  it('does not touch ~user or a ~ inside the string', () => {
    expect(expandHome('~alice/x')).toBe('~alice/x')
    expect(expandHome('~x')).toBe('~x')
    expect(expandHome('/tmp/~/x')).toBe('/tmp/~/x')
    expect(expandHome('a~/b')).toBe('a~/b')
  })
})

describe('resolvePath', () => {
  it('expands ~ and returns an absolute path', () => {
    expect(resolvePath('~/x', '/base')).toBe(path.resolve(HOME, 'x'))
  })

  it('resolves a relative path against the base', () => {
    expect(resolvePath('sub/x', path.resolve('/base'))).toBe(
      path.resolve('/base', 'sub/x'),
    )
  })

  it('keeps an absolute path absolute', () => {
    const abs = path.resolve('/abs/x')
    expect(resolvePath(abs, path.resolve('/base'))).toBe(abs)
  })
})

describe('parsePathList', () => {
  const base = path.resolve('/base')

  it('splits a comma-separated list and expands ~', () => {
    expect(parsePathList('~/a, ~/b', base)).toEqual([
      path.resolve(HOME, 'a'),
      path.resolve(HOME, 'b'),
    ])
  })

  it('accepts an array', () => {
    expect(parsePathList(['~/a', path.resolve('/abs/b')], base)).toEqual([
      path.resolve(HOME, 'a'),
      path.resolve('/abs/b'),
    ])
  })

  it('returns [] for empty values', () => {
    expect(parsePathList(undefined, base)).toEqual([])
    expect(parsePathList(null, base)).toEqual([])
    expect(parsePathList('  ,  ', base)).toEqual([])
  })
})
