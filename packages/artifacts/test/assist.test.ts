import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { llmRequestOf, sayOptsOf } from '../src/assist.js'
import { checkAccess, checkArtifact, parseManifest } from '../src/index.js'

const manifest = (text: string) => {
  const r = parseManifest(text)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('speak / llm (ABC-472)', () => {
  it('llm.complete: строка — вопрос; объект — system + messages + prompt; без user — ошибка', () => {
    expect(llmRequestOf('привет')).toEqual({ messages: [{ role: 'user', content: 'привет' }] })
    const r = llmRequestOf({ system: 'кратко', messages: [{ role: 'assistant', content: 'a' }, { role: 'x', content: 'b' }], prompt: 'c', model: 'm', json: true })
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'assistant', 'user', 'user'])
    expect(r.model).toBe('m')
    expect(r.json).toBe(true)
    expect(() => llmRequestOf({ system: 'только system' })).toThrow(/prompt или messages/)
    expect(() => llmRequestOf('  ')).toThrow(/пустой/)
  })

  it('speak.say: скорость в пределах 0.25–4, голос строкой', () => {
    expect(sayOptsOf({ voice: 'Leda', speed: 9 })).toEqual({ voice: 'Leda', speed: 4 })
    expect(sayOptsOf(null)).toEqual({})
  })

  it('статика: __host.speak.* / __host.llm.* требуют своих прав, выдумки — ошибка', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artifacts-assist-check-'))
    try {
      writeFileSync(join(tmp, 'index.html'), '<script src="./app.js"></script>')
      writeFileSync(join(tmp, 'app.js'), 'await __host.speak.play(t)\nawait __host.speak.record()\nawait __host.llm.complete(q)\n__host.speak.sing(t)\n')
      const without = checkArtifact(tmp, manifest('$title: A\n$uses: $[file]\n'))
      const errs = without.errors.join('\n')
      expect(errs).toMatch(/__host\.speak\.play требует право "speak"/)
      expect(errs).toMatch(/__host\.llm\.complete требует право "llm"/)
      expect(errs).toMatch(/__host\.speak\.sing не существует/)
      const withIt = checkArtifact(tmp, manifest('$title: A\n$uses: $[speak, llm]\n'))
      expect(withIt.errors.filter((e) => /требует/.test(e))).toEqual([])
      expect(withIt.used).toEqual(expect.arrayContaining(['speak', 'llm']))
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('статика: index.html без <script> при app.js рядом — ошибка', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'artifacts-noscript-'))
    try {
      writeFileSync(join(tmp, 'index.html'), '<!doctype html><body><div id="x"></div></body>')
      writeFileSync(join(tmp, 'app.js'), 'document.getElementById("x")\n')
      expect(checkArtifact(tmp, manifest('$title: A\n$uses: $[]\n')).errors.join('\n')).toMatch(/не подключает ни одного скрипта.*app\.js/)
      writeFileSync(join(tmp, 'index.html'), '<!doctype html><body><script type="module" src="./app.js"></script></body>')
      expect(checkArtifact(tmp, manifest('$title: A\n$uses: $[]\n')).errors.join('\n')).not.toMatch(/не подключает/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('рантайм: speak.say без права — отказ, с правом — пропуск', () => {
    const env = { artifactDir: '/a', dataDir: '/d', workspace: null, selected: new Set<string>(), fileDir: null }
    expect(checkAccess(manifest('$title: A\n$uses: $[file]\n'), 'speak.say', [], env as never).ok).toBe(false)
    expect(checkAccess(manifest('$title: A\n$uses: $[speak]\n'), 'speak.say', [], env as never).ok).toBe(true)
  })
})
