/**
 * Пять путей входа документа (rz-merge §4, приёмка).
 *
 *   $type: <appz>   → хендлер по имени (как было);
 *   ## $handler     → тело внутри документа, через CodeLoader;
 *   $run: <id>      → именованный fn документа;
 *   блокнот         → `## $step` и `$shell` в порядке файла;
 *   пусто           → громкий отказ, не тихий ноль.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '@kerneldreams/runz-runtime'
import type { ScriptResult, Value } from '@kerneldreams/runz-runtime'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')
const fx = (name: string) => path.join(FIX, name)

async function run(file: string, args: Record<string, Value> = {}): Promise<ScriptResult> {
  const r = await execute({ script: file, args, cwd: FIX, env: {} })
  return r.result as ScriptResult
}

describe('(а) $type — appz-хендлер по имени', () => {
  it('документ уходит хендлеру, meta несёт doc и program', async () => {
    const res = await run(fx('typed.mdz'))
    expect(res.output).toBe('appz: appz / doc=да / program=да')
  })

  it('appz получает helpers хоста: llm на mock-провайдере, attr/list, run fn документа (ABC-92)', async () => {
    const res = await run(fx('helpers.mdz'))
    expect(res.exitCode ?? 0).toBe(0)
    expect(res.output).toBe(
      ['llm: ответ мока\n[echo] привет', 'attr: appz', 'list: a,b', 'run: fn документа'].join('\n'),
    )
  })

  it('CLI перебивает провайдер документа — helpers.llm идёт в тот же провайдер, что видит хендлер', async () => {
    const res = await run(fx('helpers.mdz'), { mock_reply: 'с CLI' })
    expect(res.output ?? '').toMatch(/^llm: с CLI\n/)
  })

  it('--type перебивает $type документа', async () => {
    const res = await run(fx('notebook.mdz'), { type: 'echo-handler' })
    expect(res.output).toMatch(/^appz: undefined \/ doc=да \/ program=да$/)
  })
})

describe('(б) ## $handler / $run — тело внутри документа', () => {
  it('mds: %handler исполняется без $type и без $run', async () => {
    const res = await run(fx('handler.mds'))
    expect(res.output).toBe('handler: лента / program есть')
  })

  it('$run: <id> в корне выбирает fn документа', async () => {
    const res = await run(fx('notebook.mdz'), { run: 'manual' })
    expect(res.output).toBe('вручную')
  })
})

describe('(в) блокнот — шаги в порядке документа', () => {
  it('$step и $shell исполняются по порядку, шаг видит предыдущий', async () => {
    const res = await run(fx('notebook.mdz'))
    expect(res.exitCode ?? 0).toBe(0)
    const lines = (res.output ?? '').split('\n').filter(Boolean)
    expect(lines[0]).toBe('шаг 1: привет')
    expect(lines[1].trim()).toBe('из-шелла')
    expect(lines[2]).toBe('шаг 2 видит: шаг 1: привет')
  })

  it('`## $fn` без auto шагом не считается', async () => {
    const res = await run(fx('notebook.mdz'))
    expect(res.output ?? '').not.toMatch(/вручную/)
  })

  it('--run=<id> исполняет один шаг', async () => {
    const res = await run(fx('notebook.mdz'), { run: 'two' })
    expect(res.output).toBe('шаг 2 видит: undefined')
  })

  it('нечего исполнять — громкий отказ, не тихий ноль', async () => {
    const res = await run(fx('empty.mdz'))
    expect(res.exitCode).toBe(1)
    expect(res.output ?? '').toMatch(/нечего исполнять/)
  })
})

describe('недоверие', () => {
  it('--untrusted: тело документа не исполняется', async () => {
    await expect(
      execute({ script: fx('handler.mds'), args: {}, cwd: FIX, env: {}, untrusted: true }),
    ).rejects.toThrow(/не исполняется в недоверенном звене/)
  })

  it('$nr-trusted: false в документе — то же самое', async () => {
    await expect(
      execute({ script: fx('handler.mds'), args: { 'nr-trusted': false }, cwd: FIX, env: {} }),
    ).rejects.toThrow(/не исполняется в недоверенном звене/)
  })
})
