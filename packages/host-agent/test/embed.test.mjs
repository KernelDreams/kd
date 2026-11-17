// Агент как модуль своего процесса (nr-mcp): сессии независимы, корни машины режут пути.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgent, AGENT_VERSION } from '../embed.js'

test('корни: внутри — да, снаружи и через exec cwd — forbidden; сессии не делят правила', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nr-embed-')))
  const root = join(base, 'root')
  mkdirSync(root)
  writeFileSync(join(root, 'a.txt'), 'hi')
  writeFileSync(join(base, 'out.txt'), 'no')
  try {
    const events = []
    const a = createAgent({ roots: [root], emit: (m) => events.push(m) })
    assert.equal(a.hello.version, AGENT_VERSION)
    assert.deepEqual(a.hello.roots, [root])
    assert.equal((await a.call({ id: 1, op: 'init', args: { deny: [] } })).ok, true)
    const ok = await a.call({ id: 2, op: 'stat', args: { path: join(root, 'a.txt') } })
    assert.equal(ok.ok, true)
    const out = await a.call({ id: 3, op: 'read', args: { path: join(base, 'out.txt') } })
    assert.equal(out.ok, false)
    assert.equal(out.code, 'forbidden')
    const ex = await a.call({ id: 4, op: 'exec', args: { cmd: 'pwd', cwd: base } })
    assert.equal(ex.ok, false)
    const ls = await a.call({ id: 5, op: 'list', args: { path: root } })
    assert.deepEqual(ls.result.map((e) => e.name), ['a.txt'])
    // вторая сессия без init — отказ, первая не задела её
    const b = createAgent({ emit: () => {} })
    assert.equal((await b.call({ id: 1, op: 'stat', args: { path: root } })).ok, false)
    // handle строкой — ответ в emit
    await a.handle(JSON.stringify({ id: 9, op: 'ping' }))
    assert.equal(events.at(-1).id, 9)
    a.close()
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('слежение через свой watchDir', async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'nr-embed-')))
  try {
    const events = []
    let fire
    let closed = false
    const a = createAgent({
      emit: (m) => events.push(m),
      watchDir: (_p, _r, onName) => {
        fire = onName
        return { close: () => (closed = true) }
      },
    })
    await a.call({ op: 'init', args: { deny: [] } })
    const w = await a.call({ op: 'watch', args: { path: base } })
    fire('x.txt')
    await new Promise((r) => setTimeout(r, 300))
    assert.deepEqual(events.at(-1), { event: 'update', watch: w.result.watch, paths: [join(base, 'x.txt')] })
    a.close()
    assert.equal(closed, true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
