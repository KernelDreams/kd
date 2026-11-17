import { describe, expect, it } from 'vitest'
import { commandLine, filterNames, formatList, formatRun, parseList } from '../src/node/runz/format.js'
import { splitArgs } from '../src/node/runz/argv.js'
import type { RunOutcome } from '../src/node/runz/run.js'

const outcome = (over: Partial<RunOutcome> = {}): RunOutcome => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  truncated: false,
  stdoutChars: 0,
  stderrChars: 0,
  timedOut: false,
  aborted: false,
  durationMs: 12,
  ...over,
})

describe('formatRun', () => {
  it('шапка с командой и exit, потоки раздельно', () => {
    const text = formatRun(['runz', 'skills', 'view', 'a b'], outcome({ exitCode: 2, stdout: 'out\n', stderr: 'err\n', stdoutChars: 4, stderrChars: 4 }), 1000)
    expect(text).toBe("$ runz skills view 'a b'  (exit 2, 12 ms)\n\nout\n\n[stderr]\nerr")
  })

  it('обрезка — первой строкой [truncated: N of M chars]', () => {
    const text = formatRun(['runz', 'x'], outcome({ stdout: 'tail', stdoutChars: 1000, stderr: 'e', stderrChars: 1, truncated: true }), 1000)
    expect(text.split('\n')[0]).toBe('[truncated: 5 of 1001 chars]')
  })

  it('таймаут, отмена, пустой вывод', () => {
    expect(formatRun(['runz', 'x'], outcome({ exitCode: null, signal: 'SIGTERM', timedOut: true }), 300_000)).toBe(
      '$ runz x  (killed: timeout after 300s, 12 ms)\n\n(no output)',
    )
    expect(formatRun(['runz', 'x'], outcome({ exitCode: null, aborted: true }), 1000)).toContain('killed: aborted')
  })

  it('commandLine экранирует пустые и с кавычками', () => {
    expect(commandLine(['runz', '', "it's", '--k=v'])).toBe(`runz '' 'it'\\''s' --k=v`)
  })
})

describe('список', () => {
  it('parseList + filterNames без учёта регистра', () => {
    const names = parseList('alpha\r\nBeta\n\n  gamma \n')
    expect(names).toEqual(['alpha', 'Beta', 'gamma'])
    expect(filterNames(names, 'be')).toEqual(['Beta'])
    expect(filterNames(names, '  ')).toEqual(names)
  })

  it('formatList', () => {
    expect(formatList(['a', 'b'], undefined)).toBe('2 runz scripts:\na\nb')
    expect(formatList([], 'zz')).toBe('No runz scripts matching "zz".')
  })
})

describe('splitArgs', () => {
  it.each([
    ['nr site show 12', ['nr', 'site', 'show', '12']],
    ['  skills   view  x ', ['skills', 'view', 'x']],
    [`a 'b c' "d \\"e\\"" f\\ g`, ['a', 'b c', 'd "e"', 'f g']],
    [`x --msg="hello world" ''`, ['x', '--msg=hello world', '']],
    [`"a\\nb"`, ['a\\nb']],
    ['', []],
  ])('%s', (input, expected) => {
    expect(splitArgs(input)).toEqual(expected)
  })

  it('незакрытая кавычка — ошибка', () => {
    expect(splitArgs(`a 'b`)).toBeInstanceOf(Error)
    expect(splitArgs(`a "b`)).toBeInstanceOf(Error)
  })
})
