/**
 * След прогона `run.trace.jsonl` (pipeline-run-spec §2.1): блокнот, `helpers.run`,
 * `helpers.step` с частями, `llm` с шагом, `$out`, ротация, прогон без шагов — без следа.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '@kerneldreams/runz-runtime'
import type { TraceEvent } from '@kerneldreams/runz-runtime'

// vitest.config выключает след всем тестам — этому он нужен.
delete process.env.RUNZ_TRACE

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'trace')
const temps: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true })
})

const read = (file: string): TraceEvent[] => fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as TraceEvent)
const run = (doc: string, args: Record<string, unknown>) =>
  execute({ script: path.join(FIX, doc), args: { provider: 'mock', ...args } as never, cwd: FIX, env: {} })

describe('след прогона', () => {
  it('блокнот: шаги со своими иконками, llm внутри шага, run.start/end', async () => {
    const out = tmp()
    await run('notebook.mdz', { out })
    const ev = read(path.join(out, 'run.trace.jsonl'))
    expect(ev.map((e) => `${e.ev}:${e.step ?? ''}`)).toEqual([
      'run.start:', 'step.start:one', 'llm:one', 'step.end:one', 'step.start:two', 'step.end:two', 'run.end:',
    ])
    expect(ev[0].doc).toBe(path.join(FIX, 'notebook.mdz'))
    expect(ev[1]).toMatchObject({ icon: '🔍', title: 'Разбор' })
    expect(ev[2]).toMatchObject({ model: 'mock/a' })
    expect(ev[3]).toMatchObject({ ok: true })
    expect(typeof ev[3].ms).toBe('number')
    expect(ev[6]).toMatchObject({ ok: true })
  })

  it('handler: helpers.run — шаг, helpers.step — части и функция; верхний fn шагом не пишется', async () => {
    const out = tmp()
    await run('handler.mdz', { out })
    const ev = read(path.join(out, 'run.trace.jsonl'))
    expect(ev.map((e) => `${e.ev}:${e.step ?? ''}:${e.part ?? ''}`)).toEqual([
      'run.start::',
      'step.start:dossier:',
      'step.start:dossier:Анна', 'llm:dossier:Анна', 'step.end:dossier:Анна',
      'step.start:dossier:Элли', 'llm:dossier:Элли', 'step.end:dossier:Элли',
      'step.start:check:', 'step.end:check:',
      'step.end:dossier:',
      'run.end::',
    ])
    expect(ev[1]).toMatchObject({ icon: '📚' })
    expect(ev[4]).toMatchObject({ out: 'Анна.md' })
    expect(ev[8]).toMatchObject({ icon: '✅' })
  })

  it('повторный прогон в ту же папку — прошлый след переименован', async () => {
    const out = tmp()
    await run('notebook.mdz', { out })
    await new Promise((r) => setTimeout(r, 1100))
    await run('notebook.mdz', { out })
    const files = fs.readdirSync(out).filter((f) => f.startsWith('run.trace'))
    expect(files.length).toBe(2)
    expect(files).toContain('run.trace.jsonl')
  })

  it('прогон без шагов и моделей следа не оставляет; без $out — .runz/runs у документа', async () => {
    const runs = path.join(FIX, '.runz')
    fs.rmSync(runs, { recursive: true, force: true })
    await run('handler.mdz', { run: 'help' })
    expect(fs.existsSync(runs)).toBe(false)
    await run('notebook.mdz', {})
    const dirs = fs.readdirSync(path.join(runs, 'runs'))
    expect(dirs.length).toBe(1)
    expect(fs.existsSync(path.join(runs, 'runs', dirs[0], 'run.trace.jsonl'))).toBe(true)
    fs.rmSync(runs, { recursive: true, force: true })
  })
})
