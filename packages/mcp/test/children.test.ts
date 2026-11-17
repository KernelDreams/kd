import type { ToolDef } from '@kerneldreams/tools'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { attachChildren, childSpecs } from '../src/children.js'
import { parseConfig } from '../src/config.js'

const fixture = fileURLToPath(new URL('./fixtures/echo-mcp.mjs', import.meta.url))
const ctx = { signal: new AbortController().signal, sessionId: 's', callId: '1', cwd: '/', ask: () => Promise.reject(new Error('no')) }

describe('дочерние MCP по stdio (ABC-554)', () => {
  it('$stdio_<имя> конфига → спеки', () => {
    expect(childSpecs({ stdio_macbeth: '/bin/node /x/macbeth.mjs', token: 't' })).toEqual([{ name: 'macbeth', command: '/bin/node', args: ['/x/macbeth.mjs'] }])
    expect(parseConfig('$token: t\n$stdio_a: cmd -v').children).toEqual([{ name: 'a', command: 'cmd', args: ['-v'] }])
    expect(parseConfig('$token: t').children).toEqual([])
  })

  it('тулы ребёнка — в список машины, вызов и картинка доходят, занятое имя не перебивается', async () => {
    const tools: ToolDef[] = [{ name: 'shot', description: 'своя', schema: {}, executor: 'backend', execute: async () => ({ text: 'своя' }) }]
    const logs: string[] = []
    const stop = attachChildren(tools, [{ name: 'echo', command: process.execPath, args: [fixture] }], (m) => logs.push(m))
    try {
      await expect.poll(() => tools.length, { timeout: 5000 }).toBe(2)
      const echo = tools.find((t) => t.name === 'echo')!
      expect(await echo.execute({ x: 42 }, ctx as never)).toEqual({ text: 'echo 42' })
      expect(tools.find((t) => t.name === 'shot')!.description).toBe('своя')
      expect(logs.join('\n')).toContain('echo: тулы echo')
    } finally {
      stop()
    }
  })

  it('нет команды — лог и повтор, тулы машины целы', async () => {
    const tools: ToolDef[] = []
    const logs: string[] = []
    const stop = attachChildren(tools, [{ name: 'nope', command: '/nonexistent/bin', args: [] }], (m) => logs.push(m), 60_000)
    try {
      await expect.poll(() => logs.join('\n'), { timeout: 5000 }).toContain('повтор')
      expect(tools).toEqual([])
    } finally {
      stop()
    }
  })
})
