import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { readTextWithIncludes } from '../../src/node/includes.js'
import { loadProgram } from '../../src/node/program.js'
import { IncludeCycleError } from '../../src/md/index.js'

let dir: string
function put(rel: string, text: string): string {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
  return p
}

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'nrd-incl-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('readTextWithIncludes — baseDir по цепочке (ABC-80)', () => {
  it('вложенный инклюд двух уровней с .. резолвится от включающего файла', () => {
    const root = put('root.mdz', 'root\n$[[a/b/mid.mdz]]\n')
    put('a/b/mid.mdz', 'mid\n$[[../../sys/s.mdz]]\n$[[c/leaf.md]]')
    put('sys/s.mdz', 'SYS')
    put('a/b/c/leaf.md', 'LEAF')
    expect(readTextWithIncludes(root)).toBe('root\nmid\nSYS\nLEAF\n')
  })

  it('инклюд без расширения находит .mdz / .md / .mdd / .mds', () => {
    const root = put('root.mdz', '$[[a/b/mid]]|$[[p]]|$[[d]]|$[[s]]')
    put('a/b/mid.mdz', 'M($[[../../sys/s]])')
    put('sys/s.mdz', 'S')
    put('p.md', 'P')
    put('d.mdd', 'D')
    put('s.mds', 'X')
    expect(readTextWithIncludes(root)).toBe('M(S)|P|D|X')
  })

  it('файл без расширения с точным именем важнее подстановки', () => {
    const root = put('root.mdz', '$[[LICENSE]]')
    put('LICENSE', 'exact')
    put('LICENSE.md', 'ext')
    expect(readTextWithIncludes(root)).toBe('exact')
  })

  it('цикл — IncludeCycleError с цепочкой, не переполнение стека', () => {
    const root = put('root.mdz', '$[[x/a]]')
    put('x/a.mdz', '$[[../y/b.mdz]]')
    put('y/b.mdz', '$[[../x/./a]]')
    let err: unknown
    try { readTextWithIncludes(root) } catch (e) { err = e }
    expect(err).toBeInstanceOf(IncludeCycleError)
    const chain = (err as IncludeCycleError).chain.map((p) => p.slice(dir.length))
    expect(chain.map((p) => p.replace(/\\/g, '/'))).toEqual(['/x/a.mdz', '/y/b.mdz', '/x/a.mdz'])
  })

  it('инклюд самого себя — цикл', () => {
    const root = put('root.mdz', 'r $[[root]]')
    expect(() => readTextWithIncludes(root)).toThrow(/include cycle/)
  })

  it('не найденный инклюд остаётся как есть', () => {
    const root = put('root.mdz', 'a $[[nope/x]] b')
    expect(readTextWithIncludes(root)).toBe('a $[[nope/x]] b')
  })

  it('loadProgram разворачивает вложенные инклюды от включающего файла', () => {
    const root = put('session.mdz', '# session\n$[[campaign/c]]\n')
    put('campaign/c.mdz', '$[[../system/sys]]\n$who: campaign\n')
    put('system/sys.mdz', '$rules: strict\n')
    const prog = loadProgram(root)
    expect(prog.source).toContain('$rules: strict')
    expect(prog.source).toContain('$who: campaign')
    expect(prog.source).not.toContain('$[[')
  })
})
