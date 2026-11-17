/**
 * `runz`/`runz_list` родными ToolDef: те же argv, cwd, тексты и
 * `data`, что у pi-обёртки `pi-ext-runz` (её тесты — там).
 */

import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRunzTools, type RunzToolsDeps } from '../src/node/index.js'
import type { ToolContext, ToolDef, ToolResult } from '../src/types.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-runz.mjs', import.meta.url))

function harness(deps: RunzToolsDeps = {}) {
  const tools = new Map<string, ToolDef>(createRunzTools({ command: () => [process.execPath, FAKE], catalog: () => ['alpha', 'beta'], ...deps }).map((t) => [t.name, t]))
  const cwd = mkdtempSync(join(tmpdir(), 'nr-tools-runz-'))
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ signal: new AbortController().signal, sessionId: 's', callId: 'c', ask: () => Promise.reject(new Error('no ask')), cwd, ...over })
  return {
    tools,
    cwd,
    call: async (name: string, args: Record<string, unknown>, over: Partial<ToolContext> = {}) => (await tools.get(name)!.execute(args, ctx(over))) as ToolResult,
  }
}

describe('createRunzTools', () => {
  it('runz и runz_list; описание с каталогом; optIn по флагу', () => {
    const h = harness()
    expect([...h.tools.keys()]).toEqual(['runz', 'runz_list'])
    expect(h.tools.get('runz')!.description).toContain('Available scripts: alpha, beta.')
    expect(h.tools.get('runz')!.schema.required).toEqual(['script'])
    expect(h.tools.get('runz')!.optIn).toBeUndefined()
    expect(createRunzTools({ catalog: () => undefined, optIn: true }).every((t) => t.optIn === true)).toBe(true)
  })

  it('runz: cwd вызова, относительный cwd — от него; data — исход и каталог', async () => {
    const h = harness()
    const out = await h.call('runz', { script: 'echo', args: ['a b'] })
    expect(out.text.split('\n')[0]).toMatch(/^\$ runz echo 'a b' {2}\(exit 0, \d+ ms\)$/)
    expect(out.isError).toBeUndefined()
    const data = out.data as { exitCode: number; stdout: string; cwd: string }
    expect(data.cwd).toBe(h.cwd)
    expect(realpathSync((JSON.parse(data.stdout) as { cwd: string }).cwd)).toBe(realpathSync(h.cwd))
    mkdirSync(join(h.cwd, 'sub'))
    expect(((await h.call('runz', { script: 'echo', cwd: 'sub' })).data as { cwd: string }).cwd).toBe(join(h.cwd, 'sub'))
  })

  it('ABC-738: id сессии вызова — NR_SESSION в окружении runz; без сессии — без унаследованного', async () => {
    const h = harness({ env: () => ({ ...process.env, NR_SESSION: 'чужая' }) })
    const r = await h.call('runz', { script: 'echo' }, { sessionId: 'sess-1' })
    expect(JSON.parse((r.data as { stdout: string }).stdout).session).toBe('sess-1')
    const none = await h.call('runz', { script: 'echo' }, { sessionId: '' })
    expect(JSON.parse((none.data as { stdout: string }).stdout).session).toBeNull()
  })

  it('нет ctx.cwd — deps.cwd', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-tools-runz-base-'))
    const h = harness({ cwd: dir })
    const out = await h.call('runz', { script: 'echo' }, { cwd: undefined })
    expect((out.data as { cwd: string }).cwd).toBe(dir)
  })

  it('ошибки — результатом с isError и data.error', async () => {
    const h = harness()
    const empty = await h.call('runz', { script: ' ' })
    expect(empty.isError).toBe(true)
    expect((empty.data as { error: { code: string } }).error.code).toBe('bad_request')
    const spawnFail = await harness({ command: () => ['/nonexistent/runz-bin'] }).call('runz', { script: 'x' })
    expect(spawnFail.isError).toBe(true)
    expect(spawnFail.text).toContain('PI_EXT_RUNZ_BIN')
  })

  it('runz_list: имена с фильтром', async () => {
    const h = harness()
    const all = await h.call('runz_list', {})
    expect((all.data as { names: string[] }).names).toEqual(['alpha', 'beta', 'bots'])
    const some = await h.call('runz_list', { filter: 'B' })
    expect((some.data as { names: string[] }).names).toEqual(['beta', 'bots'])
  })

  it('runz_list: описание рядом с именем, фильтр и по описанию (ABC-551)', async () => {
    const h = harness()
    const all = await h.call('runz_list', {})
    expect(all.text).toContain('alpha — первый скрипт')
    expect(all.text).toMatch(/\nbeta\n/)
    const byAbout = await h.call('runz_list', { filter: 'ботов' })
    expect((byAbout.data as { names: string[] }).names).toEqual(['bots'])
  })
})
