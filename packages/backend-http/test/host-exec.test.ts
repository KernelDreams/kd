/** Exec хаба: контракт `RemoteHost.exec`, закрытый cwd, окружение, код выхода. */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createLocalExec } from '../src/host-exec.js'

let home: string
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'hexec-'))
  await mkdir(join(home, 'repo'))
  await mkdir(join(home, '.ssh'))
})
afterAll(() => rm(home, { recursive: true, force: true }))

describe('createLocalExec', () => {
  it('вывод, код, cwd и окружение', async () => {
    const exec = createLocalExec({ home })
    const r = await exec(process.execPath, ['-e', 'process.stdout.write(process.cwd() + "|" + process.env.X); process.stderr.write("e"); process.exit(3)'], { cwd: join(home, 'repo'), env: { X: 'y' } })
    expect(r.code).toBe(3)
    expect(r.stdout).toMatch(/repo\|y$/)
    expect(r.stderr).toBe('e')
  })

  it('закрытый cwd — forbidden; нет команды — код не 0', async () => {
    const exec = createLocalExec({ home })
    await expect(exec('ls', [], { cwd: '~/.ssh' })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(exec('ls', [], { cwd: 'rel' })).rejects.toMatchObject({ code: 'bad_request' })
    const r = await exec('nr-no-such-cmd-xyz', [])
    expect(r.code).not.toBe(0)
  })
})
