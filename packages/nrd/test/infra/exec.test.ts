import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execShell, runFile, ExecError } from '../../src/node/exec.js'
import { isOk, isErr } from '../../src/infra/result.js'

describe('execShell', () => {
  it('echo → stdout', async () => {
    const r = await execShell('echo hello')
    expect(isOk(r)).toBe(true)
    if (isOk(r)) {
      expect(r.value.stdout.trim()).toBe('hello')
      expect(r.value.code).toBe(0)
    }
  })

  it('ненулевой код → err + stderr, ExecResult доступен', async () => {
    const r = await execShell(`"${process.execPath}" -e "console.error('boom'); process.exit(3)"`)
    expect(isErr(r)).toBe(true)
    if (isErr(r)) {
      expect(r.error).toBeInstanceOf(ExecError)
      expect(r.error.result.code).toBe(3)
      expect(r.error.result.stderr).toContain('boom')
    }
  })

  it('spawn-ошибка (ENOENT) → err, ExecResult доступен', async () => {
    const r = await execShell('definitely-no-such-binary-xyz', { shell: false })
    expect(isErr(r)).toBe(true)
    if (isErr(r)) {
      expect(r.error).toBeInstanceOf(ExecError)
      expect(r.error.result.code).toBe(-1)
      expect(r.error.result.stderr.length).toBeGreaterThan(0)
    }
  })

  it('env merge — доп. переменная видна процессу, process.env сохранён', async () => {
    const r = await runFile('-e', ['console.log(process.env.NR_TEST_VAR + "|" + (process.env.PATH ? "haspath" : "nopath"))'], {
      env: { NR_TEST_VAR: 'merged' },
    })
    expect(isOk(r)).toBe(true)
    if (isOk(r)) {
      expect(r.value.stdout.trim()).toBe('merged|haspath')
    }
  })

  it('cwd — процесс стартует в нужной директории', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nr-exec-cwd-'))
    try {
      const real = await fs.realpath(dir)
      const r = await runFile('-e', ['process.stdout.write(process.cwd())'], { cwd: dir })
      expect(isOk(r)).toBe(true)
      if (isOk(r)) {
        expect(await fs.realpath(r.value.stdout.trim())).toBe(real)
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  it('timeout — зависший процесс убит', async () => {
    const start = Date.now()
    const r = await runFile('-e', ['setInterval(() => {}, 1000)'], { timeout: 300 })
    const elapsed = Date.now() - start
    expect(isErr(r)).toBe(true)
    if (isErr(r)) {
      expect(r.error.message).toContain('timed out')
    }
    // убит около таймаута, не висел секунду+
    expect(elapsed).toBeLessThan(2000)
  })

  it('input — stdin прочитан', async () => {
    const r = await runFile(
      '-e',
      ['process.stdin.on("data", d => process.stdout.write(d))'],
      { input: 'piped-in' },
    )
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value.stdout.trim()).toBe('piped-in')
  })
})

describe('runFile', () => {
  it('node -e → stdout', async () => {
    const r = await runFile('-e', ['console.log(40 + 2)'])
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value.stdout.trim()).toBe('42')
  })

  describe('.js файл', () => {
    let dir: string
    let file: string
    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nr-exec-file-'))
      file = path.join(dir, 'script.js')
      await fs.writeFile(file, 'console.log("from file:" + process.argv[2])', 'utf-8')
    })
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('запуск файла с аргументом → stdout', async () => {
      const r = await runFile(file, ['arg1'])
      expect(isOk(r)).toBe(true)
      if (isOk(r)) expect(r.value.stdout.trim()).toBe('from file:arg1')
    })
  })
})
