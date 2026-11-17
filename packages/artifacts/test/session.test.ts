import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { checkAccess, checkArtifact, metaHash, parseManifest, stableHash } from '../src/index.js'
import type { AccessEnv } from '../src/index.js'
import { createArtifactHost } from '../src/host.js'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'artifacts-session-'))
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

const m = (text: string) => {
  const r = parseManifest(text)
  if (!r.ok) throw new Error(r.error)
  return r.value
}
const env: AccessEnv = { artifactDir: '/a', dataDir: '/d', workspace: '/ws', selected: new Set(), artifactId: 'demo/persona-editor' }

function check(files: Record<string, string>) {
  const dir = join(tmp, 'c', String(Math.random()).slice(2))
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), text)
  }
  return checkArtifact(dir, m(files['meta.mdz']!))
}
const INDEX = '<!doctype html><html><body><script type="module" src="./app.js"></script></body></html>'

describe('манифест: $session-read / $session-write', () => {
  it('скоупы разбираются, без ключей — null (умолчание)', () => {
    const a = m('$title: A\n$uses: $[session]\n$session-read: meta, personas, history\n$session-write: personas\n')
    expect(a.uses).toEqual(['session'])
    expect(a.sessionRead).toEqual(['meta', 'personas', 'history'])
    expect(a.sessionWrite).toEqual(['personas'])
    const b = m('$title: A\n$uses: $[session]\n')
    expect(b.sessionRead).toBe(null)
    expect(b.sessionWrite).toBe(null)
  })
})

describe('права session в рантайме', () => {
  it('без права — capability not declared с подсказкой', () => {
    const r = checkAccess(m('$title: A\n$uses: $[file]\n'), 'session.meta.get', [], env)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/^capability not declared: session — добавь в \$uses/)
  })
  it('умолчание: чтение всего, запись ничего', () => {
    const man = m('$title: A\n$uses: $[session]\n')
    expect(checkAccess(man, 'session.meta.get', ['prompt.pre'], env)).toEqual({ ok: true, args: { path: ['prompt', 'pre'] } })
    expect(checkAccess(man, 'session.personas.list', [], env).ok).toBe(true)
    expect(checkAccess(man, 'session.history.list', [{ limit: 5 }], env)).toEqual({ ok: true, args: { limit: 5 } })
    expect(checkAccess(man, 'session.meta.set', ['notes', 'x'], env)).toEqual({ ok: false, error: 'session scope not declared: $session-write: meta' })
    expect(checkAccess(man, 'session.personas.set', [{ id: 'u', kind: 'user', name: 'Я' }], env)).toEqual({
      ok: false,
      error: 'session scope not declared: $session-write: personas',
    })
  })
  it('скоупы чтения сужают: history без $session-read: history — отказ', () => {
    const man = m('$title: A\n$uses: $[session]\n$session-read: meta\n')
    expect(checkAccess(man, 'session.history.list', [], env)).toEqual({ ok: false, error: 'session scope not declared: $session-read: history' })
    expect(checkAccess(man, 'session.personas.get', ['user'], env)).toEqual({ ok: false, error: 'session scope not declared: $session-read: personas' })
  })
  it('meta.set: путь, значение, ifHash; tools/effectivePrompt — не через meta.set', () => {
    const man = m('$title: A\n$uses: $[session]\n$session-write: meta\n')
    expect(checkAccess(man, 'session.meta.set', ['prompt.pre', 'Ты — бард', { ifHash: 'abc' }], env)).toEqual({
      ok: true,
      args: { path: ['prompt', 'pre'], value: 'Ты — бард', ifHash: 'abc' },
    })
    expect(checkAccess(man, 'session.meta.set', ['notes', null], env)).toEqual({ ok: true, args: { path: ['notes'], value: null } })
    expect((checkAccess(man, 'session.meta.set', ['', {}], env) as { error: string }).error).toMatch(/нужен путь/)
    expect((checkAccess(man, 'session.meta.set', ['tools', []], env) as { error: string }).error).toMatch(/session\.tools\.register/)
    expect((checkAccess(man, 'session.meta.set', ['effectivePrompt', 'x'], env) as { error: string }).error).toMatch(/только для чтения/)
  })
  it('personas.set: одна персона или документ; битые — отказ', () => {
    const man = m('$title: A\n$uses: $[session]\n$session-write: personas\n')
    expect(checkAccess(man, 'session.personas.set', [{ id: 'u', kind: 'user', name: 'Аня' }], env)).toEqual({
      ok: true,
      args: { persona: { id: 'u', kind: 'user', name: 'Аня' } },
    })
    const doc = [
      { id: 'u', kind: 'user', name: 'Аня' },
      { id: 'c', kind: 'char', name: 'Бот' },
    ]
    expect(checkAccess(man, 'session.personas.set', [doc, 'u'], env)).toEqual({ ok: true, args: { personas: doc, userId: 'u' } })
    expect((checkAccess(man, 'session.personas.set', [[doc[0], doc[0]]], env) as { error: string }).error).toMatch(/повторяется/)
    expect((checkAccess(man, 'session.personas.set', [{ id: 'x', kind: 'npc', name: 'X' }], env) as { error: string }).error).toMatch(/kind/)
    expect((checkAccess(man, 'session.personas.set', [doc, 'nobody'], env) as { error: string }).error).toMatch(/userId/)
  })
  it('tools.register: декларация → executor frontend + artifactId; кривое имя — отказ', () => {
    const man = m('$title: A\n$uses: $[session]\n')
    expect(checkAccess(man, 'session.tools.register', [{ name: 'persona_summary', description: 'кто игрок', schema: { type: 'object' } }], env)).toEqual({
      ok: true,
      args: { name: 'persona_summary', description: 'кто игрок', schema: { type: 'object' }, executor: 'frontend', artifactId: 'demo/persona-editor' },
    })
    expect(checkAccess(man, 'session.tools.register', [{ name: 'плохое имя' }], env).ok).toBe(false)
    expect(checkAccess(man, 'session.tools.unregister', ['persona_summary'], env)).toEqual({ ok: true, args: { name: 'persona_summary' } })
  })
  it('без $uses — легаси: можно всё', () => {
    expect(checkAccess(m('$title: A\n'), 'session.meta.set', ['notes', 'x'], env).ok).toBe(true)
  })
})

describe('статическая проверка session', () => {
  it('session.* покрыт $uses: session и скоупами', () => {
    const r = check({
      'meta.mdz': '$title: A\n$uses: $[session]\n$session-write: meta, personas\n',
      'index.html': INDEX,
      'app.js': "await __host.session.meta.get()\nawait __host.session.personas.set({id:'u',kind:'user',name:'x'})\n__host.session.tools.register({name:'t'}, () => 'ok')\n",
    })
    expect(r.errors).toEqual([])
    expect(r.used).toContain('session')
  })
  it('обращение к __host.session без права — ошибка с подсказкой про скоупы', () => {
    const r = check({ 'meta.mdz': '$title: A\n$uses: $[file]\n', 'index.html': INDEX, 'app.js': 'await __host.session.meta.get()\n' })
    expect(r.errors.join('\n')).toMatch(/app\.js:1: __host\.session\.meta требует право "session" — добавь в \$uses \(и скоупы \$session-read/)
  })
  it('запись без $session-write — ошибка с номером строки', () => {
    const r = check({ 'meta.mdz': '$title: A\n$uses: $[session]\n', 'index.html': INDEX, 'app.js': "\nawait __host.session.meta.set('notes', 'x')\n" })
    expect(r.errors).toEqual(['app.js:2: __host.session.meta.set требует $session-write: meta'])
  })
  it('скоупы write без read — ошибка; неизвестный скоуп — ошибка; скоупы без права — ошибка', () => {
    const a = check({ 'meta.mdz': '$title: A\n$uses: $[session]\n$session-read: meta\n$session-write: meta, personas\n', 'index.html': INDEX, 'app.js': '__host.session.meta.get()\n' })
    expect(a.errors.join('\n')).toMatch(/\$session-write: personas без \$session-read: personas/)
    const b = check({ 'meta.mdz': '$title: A\n$uses: $[session]\n$session-read: lorebook\n', 'index.html': INDEX, 'app.js': '__host.session.meta.get()\n' })
    expect(b.errors.join('\n')).toMatch(/неизвестный скоуп "lorebook"/)
    const c = check({ 'meta.mdz': '$title: A\n$uses: $[file]\n$session-read: meta\n', 'index.html': INDEX, 'app.js': "__host.readFile('./x')\n" })
    expect(c.errors.join('\n')).toMatch(/без права session/)
  })
  it('выдуманный метод сессии — с подсказкой, что есть', () => {
    const r = check({ 'meta.mdz': '$title: A\n$uses: $[session]\n', 'index.html': INDEX, 'app.js': '__host.session.meta.patch({})\n__host.session.chat.send("x")\n' })
    expect(r.errors.join('\n')).toMatch(/__host\.session\.meta\.patch не существует — есть meta\.get, meta\.on, meta\.set/)
    expect(r.errors.join('\n')).toMatch(/__host\.session\.chat не существует/)
  })
})

describe('хост: session.* — проверка у хоста, исполнение у фронта', () => {
  it('bridge отдаёт {delegate, value} с нормализованными аргументами; без права — отказ; getContext.sessionAccess', async () => {
    const coll = join(tmp, 'coll')
    const dir = join(coll, 'ed')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.mdz'), '$title: Ed\n$uses: $[session]\n$session-write: meta\n')
    writeFileSync(join(dir, 'index.html'), INDEX)
    writeFileSync(join(dir, 'app.js'), '')
    const host = createArtifactHost({ root: tmp, dataRoot: join(tmp, 'data'), configFile: join(tmp, 'none.md'), warn: () => {} })
    try {
      const o = await host.open(dir)
      expect(await host.bridge(o.key, 'session.meta.set', ['prompt.post', 'кратко'])).toEqual({
        ok: true,
        delegate: 'session.meta.set',
        value: { path: ['prompt', 'post'], value: 'кратко' },
      })
      expect(await host.bridge(o.key, 'session.personas.set', [{ id: 'u', kind: 'user', name: 'Я' }])).toEqual({
        ok: false,
        error: 'session scope not declared: $session-write: personas',
      })
      const reg = (await host.bridge(o.key, 'session.tools.register', [{ name: 'persona_summary' }])) as { value: { artifactId: string } }
      expect(reg.value.artifactId).toBe(o.id)
      const ctx = (await host.bridge(o.key, 'getContext', [])) as { value: { sessionAccess: boolean } }
      expect(ctx.value.sessionAccess).toBe(true)
    } finally {
      await host.close()
    }
  })
})

describe('версия меты', () => {
  it('hash стабилен к порядку ключей и не видит effectivePrompt/tools/pageContext', () => {
    expect(stableHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(stableHash({ b: { d: [1, 2], c: 2 }, a: 1 }))
    const base = { prompt: { pre: 'x' } }
    expect(metaHash({ ...base, effectivePrompt: 'y', tools: [{ name: 't' }], pageContext: 1 })).toBe(metaHash(base))
    expect(metaHash({ prompt: { pre: 'z' } })).not.toBe(metaHash(base))
  })
})

describe('тулы агента (сервисная конвенция tools/tool, ABC-227)', () => {
  it('init jsx → finalize без ошибок (runtime не проверен) → list видит; незнакомый тул — ошибка', async () => {
    const { AGENT_TOOLS, runAgentTool } = await import('../src/index.js')
    // Очередь open — своя: живой nrchat машины не должен получить запрос теста.
    const prevData = process.env.NR_ARTIFACTS_DATA
    process.env.NR_ARTIFACTS_DATA = join(tmp, 'data')
    expect(AGENT_TOOLS.map((t) => t.name)).toEqual(['artifact_init', 'artifact_finalize', 'artifact_open', 'artifact_list', 'artifact_errors', 'artifact_revert', 'skin_check', 'skin_save', 'skin_convert', 'artifact_profile'])
    const registry = { workspace: tmp, demoDir: null, configFile: join(tmp, 'none.md') }
    const opts = { registry, profile: 'PROFILE', checkTimings: { ackMs: 50, resultMs: 50 } }
    const init = await runAgentTool('artifact_init', { name: 'Persona editor', template: 'jsx' }, opts)
    expect(init.error).toBeUndefined()
    expect(init.text).toMatch(/создан артефакт/)
    expect(init.text).toMatch(/PROFILE$/)
    const id = (init.data as { id: string }).id
    const fin = await runAgentTool('artifact_finalize', { id }, opts)
    expect(fin.text).toMatch(/^✓ .*версия 1/)
    expect(fin.text).toMatch(/не проверено/)
    expect((await runAgentTool('artifact_list', {}, opts)).text).toMatch(/Persona editor · v1 · uses: session/)
    expect(await runAgentTool('artifact_nope', {}, opts)).toMatchObject({ error: true })
    if (prevData === undefined) delete process.env.NR_ARTIFACTS_DATA
    else process.env.NR_ARTIFACTS_DATA = prevData
  })
})
