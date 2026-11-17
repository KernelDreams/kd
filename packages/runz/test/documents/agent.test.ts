/**
 * helpers.agent: агент — слот расширения `agent` (runz-runtime extensions), в открытом ядре его нет.
 * Без расширения — понятная ошибка; полный ход агента проверяют тесты установки, которая слот заполняет.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '@kerneldreams/runz-runtime'
import type { ScriptResult, Value } from '@kerneldreams/runz-runtime'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'agent')

const temps: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runz-agent-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true })
})

async function run(args: Record<string, Value>): Promise<ScriptResult> {
  const r = await execute({ script: path.join(FIX, 'agent.mdz'), args, cwd: FIX, env: {} })
  return r.result as ScriptResult
}

describe('helpers.agent', () => {
  it('нет расширения agent — понятная ошибка', async () => {
    const was = { nr: process.env.RUNZ_BACKEND_NR, home: process.env.HOME }
    delete process.env.RUNZ_BACKEND_NR
    process.env.HOME = tmp() // ~/.runz/extensions машины не мешают
    try {
      await expect(run({ out: tmp() })).rejects.toThrow(/helpers\.agent: агент .* не установлен — нет расширения «agent»/)
    } finally {
      for (const [k, v] of [['RUNZ_BACKEND_NR', was.nr], ['HOME', was.home]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('RUNZ_BACKEND_NR на несуществующий пакет — понятная ошибка', async () => {
    const was = { nr: process.env.RUNZ_BACKEND_NR, home: process.env.HOME }
    process.env.RUNZ_BACKEND_NR = path.join(os.tmpdir(), 'нет-такого-агента')
    process.env.HOME = tmp() // an `agent` extension installed on the machine would win over the variable
    try {
      await expect(run({ out: tmp() })).rejects.toThrow(/helpers\.agent: RUNZ_BACKEND_NR=.* не загрузился/)
    } finally {
      for (const [k, v] of [['RUNZ_BACKEND_NR', was.nr], ['HOME', was.home]] as const) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})

describe('helpers.agent: веб-тулы (ABC-380)', () => {
  it('wantsWebTools: all или имена web_search/web_fetch в $tools профиля', async () => {
    const { wantsWebTools } = await import('@kerneldreams/runz-runtime/src/agent.ts')
    expect(wantsWebTools('all')).toBe(true)
    expect(wantsWebTools(['read', 'web_search'])).toBe(true)
    expect(wantsWebTools(['web_fetch'])).toBe(true)
    expect(wantsWebTools(['read', 'edit'])).toBe(false)
    expect(wantsWebTools('none')).toBe(false)
    expect(wantsWebTools(undefined)).toBe(false)
  })

  it('loadWebTools: web_search и web_fetch в форме тулов backend-nr', async () => {
    const { loadWebTools } = await import('@kerneldreams/runz-runtime/src/agent.ts')
    const lines: string[] = []
    const tools = (await loadWebTools((l) => lines.push(l))) as Array<{ name: string; executor: string; schema: unknown; execute: unknown }>
    if (tools.length === 0) return expect(lines.join('\n')).toMatch(/веб-тулы не загрузились/) // pi-ext-web не собран — без веба, не падение
    expect(tools.map((t) => t.name).sort()).toEqual(['web_fetch', 'web_search'])
    for (const t of tools) {
      expect(t.executor).toBe('backend')
      expect(typeof t.execute).toBe('function')
    }
  })
})
