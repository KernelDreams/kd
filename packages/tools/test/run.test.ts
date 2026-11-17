/**
 * Запуск против фейкового runz (`fixtures/fake-runz.mjs`) настоящими
 * процессами: раздельные потоки, обрезка и флаг, таймаут, отмена, ошибки запуска.
 */

import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcess, STDERR_MAX_CHARS, TailBuffer, type RunOutcome, type RunSpec } from '../src/node/runz/run.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-runz.mjs', import.meta.url))

async function run(args: string[], spec: Partial<RunSpec> = {}): Promise<RunOutcome> {
  const res = await runProcess({ argv: [process.execPath, FAKE, ...args], cwd: process.cwd(), maxChars: 400_000, timeoutMs: 10_000, ...spec })
  if (!res.ok) throw res.error
  return res.value
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('TailBuffer', () => {
  it('держит хвост и полный счёт', () => {
    const b = new TailBuffer(5)
    for (const chunk of ['abc', 'def', 'ghijkl', 'mn']) b.push(chunk)
    expect(b.value()).toBe('jklmn')
    expect(b.total).toBe(14)
    expect(b.truncated).toBe(true)
  })

  it('в пределах лимита — без обрезки', () => {
    const b = new TailBuffer(5)
    b.push('abcde')
    expect([b.value(), b.truncated]).toEqual(['abcde', false])
  })

  it('не начинает хвост с половинки суррогатной пары', () => {
    const b = new TailBuffer(3)
    b.push('x😀yz')
    expect(b.value()).toBe('yz')
  })
})

describe('runProcess', () => {
  it('stdout и stderr раздельно, exit code как есть', async () => {
    const r = await run(['split'])
    expect(r).toMatchObject({ exitCode: 3, signal: null, stdout: 'OUT\n', stderr: 'ERR\n', truncated: false, timedOut: false, aborted: false })
    expect(r.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('argv без шелла, cwd и окружение доезжают до процесса', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-ext-runz-cwd-'))
    const r = await run(['echo', 'a b', '--x=1', '$HOME'], { cwd: dir, env: { ...process.env, PI_EXT_RUNZ_PROBE: 'p1' } })
    const seen = JSON.parse(r.stdout) as { args: string[]; cwd: string; probe: string }
    expect(seen.args).toEqual(['a b', '--x=1', '$HOME'])
    expect(realpathSync(seen.cwd)).toBe(realpathSync(dir))
    expect(seen.probe).toBe('p1')
  })

  it('stdin уходит в процесс', async () => {
    const r = await run(['stdin'], { stdin: 'hello\nworld' })
    expect(r.stdout).toBe('got:hello\nworld')
  })

  it('stdout режется с головы до maxChars, хвост цел, флаг и полная длина', async () => {
    const r = await run(['big', '100000'], { maxChars: 1000 })
    expect(r.stdout.length).toBe(1000)
    expect(r.stdout.endsWith('TAIL!')).toBe(true)
    expect(r).toMatchObject({ truncated: true, stdoutChars: 100_000, exitCode: 0 })
  })

  it('без превышения — ничего не режется', async () => {
    const r = await run(['big', '100000'])
    expect(r.stdout.length).toBe(100_000)
    expect(r.truncated).toBe(false)
  })

  it(`stderr — не больше ${STDERR_MAX_CHARS} даже при большом maxChars`, async () => {
    const r = await run(['stderr-big', '30000'])
    expect(r.stderr.length).toBe(STDERR_MAX_CHARS)
    expect(r.stderr.endsWith('TAIL!')).toBe(true)
    expect(r).toMatchObject({ truncated: true, stderrChars: 30_000 })
  })

  it('stderr под maxChars, когда он меньше 20 К', async () => {
    const r = await run(['stderr-big', '3000'], { maxChars: 500 })
    expect(r.stderr.length).toBe(500)
  })

  it('таймаут убивает процесс вместе с детьми', async () => {
    const r = await run(['sleep'], { timeoutMs: 500 })
    expect(r).toMatchObject({ timedOut: true, exitCode: null, signal: 'SIGTERM' })
    const pid = Number(/grandchild:(\d+)/.exec(r.stdout)?.[1])
    expect(pid).toBeGreaterThan(0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(alive(pid)).toBe(false)
  })

  it('отмена через AbortSignal', async () => {
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 300)
    const r = await run(['sleep'], { signal: ac.signal })
    expect(r).toMatchObject({ aborted: true, timedOut: false, exitCode: null })
  })

  it('нет бинаря — ошибка spawn значением, не исключением', async () => {
    const res = await runProcess({ argv: ['pi-ext-runz-no-such-binary'], cwd: process.cwd(), maxChars: 10, timeoutMs: 1000 })
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.error.code).toBe('spawn')
      expect(res.error.message).toContain('ENOENT')
    }
  })

  it('нет каталога — bad_request', async () => {
    const res = await runProcess({ argv: [process.execPath], cwd: join(tmpdir(), 'pi-ext-runz-missing-dir-xyz'), maxChars: 10, timeoutMs: 1000 })
    expect(res.ok ? undefined : res.error.code).toBe('bad_request')
  })

  it('неизвестный скрипт — обычный результат с exit 1 и stderr', async () => {
    const r = await run(['nope'])
    expect(r).toMatchObject({ exitCode: 1, stderr: 'runz: script not found: nope\n' })
  })
})

describe('spawnArgv (ABC-496)', () => {
  it('Windows .cmd — через cmd.exe /d /s /c, аргументы в кавычках; прочее — как есть', async () => {
    const { spawnArgv } = await import('../src/node/runz/run.js')
    expect(spawnArgv('/usr/bin/runz', ['web', '--q=a b'], false)).toEqual({ file: '/usr/bin/runz', args: ['web', '--q=a b'], verbatim: false })
    expect(spawnArgv('runz.exe', ['x'], true).verbatim).toBe(false)
    const w = spawnArgv('S:\\bin\\runz.cmd', ['web', '--q={"a":1}'], true)
    expect(w.file).toMatch(/cmd\.exe$/i)
    expect(w.args).toEqual(['/d', '/s', '/c', '""S:\\bin\\runz.cmd" "web" "--q={""a"":1}""'])
    expect(w.verbatim).toBe(true)
  })
})
