/**
 * Документ как программа — перенос приёмки rz (rz-merge §3.5, §4).
 *
 * Пять путей входа, все через `execute` (тот же путь, что и CLI):
 *   .mds / .mdd / .mdz без `$type` — блокнот и `$run`;
 *   с `$type: <appz>` — appz-хендлер;
 *   с `## $handler` — тело внутри документа.
 *
 * LLM — встроенный мок (`--provider=mock`): приёмка не ходит в сеть.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execute } from '@kerneldreams/runz-runtime'
import type { ScriptResult, Value } from '@kerneldreams/runz-runtime'
import { MOCK_REPLY } from '@kerneldreams/runz-runtime/src/provider.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')
const fx = (name: string) => path.join(FIX, name)

const temps: string[] = []
function tmp(inRepo = false): string {
  const base = inRepo ? path.join(FIX, '.tmp') : os.tmpdir()
  fs.mkdirSync(base, { recursive: true })
  const dir = fs.mkdtempSync(path.join(base, 'doc-'))
  temps.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of temps) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  // Общий `.tmp` не сносим: тестовые файлы идут параллельно и делят его.
})

async function run(file: string, args: Record<string, Value> = {}): Promise<ScriptResult> {
  const r = await execute({
    script: file,
    args: { provider: 'mock', ...args },
    cwd: FIX,
    env: {},
  })
  return r.result as ScriptResult
}

describe('регресс на живых файлах (бывший appz/rz)', () => {
  it('pipeline.mdz — batch через LLM, шаг extract', async () => {
    const db = tmp()
    const res = await run(fx('pipeline.mdz'), { run: 'extract', db_dir: db })
    expect(res.exitCode ?? 0).toBe(0)
    expect(res.output ?? '').toMatch(/Extract: done=2 skip=0/)
    expect(fs.readFileSync(path.join(db, 'fight-club.md'), 'utf-8')).toBe(MOCK_REPLY)
    expect(fs.readFileSync(path.join(db, 'breaking-bad.md'), 'utf-8')).toBe(MOCK_REPLY)
  })

  it('pipeline.mdz — оба шага подряд ($run: all в корне, helpers.run между ними)', async () => {
    const db = tmp()
    const profiles = tmp()
    const res = await run(fx('pipeline.mdz'), { db_dir: db, profiles_dir: profiles })
    expect(res.exitCode ?? 0).toBe(0)
    expect(res.output ?? '').toMatch(/Pipeline complete/)
    // describe разобрал сгенерённый mdd (`## @char`) и разложил профили по папкам
    expect(
      fs.readFileSync(path.join(profiles, 'fight-club', 'mock-character.md'), 'utf-8'),
    ).toBe(MOCK_REPLY)
  })

  it('sim.mdz — стор и персистентность (мок-провайдер)', async () => {
    const dir = tmp(true)
    fs.copyFileSync(fx('sim.mdz'), path.join(dir, 'sim.mdz'))
    const res = await run(path.join(dir, 'sim.mdz'), {
      run_file: './runs/erosion-test.mds',
      turns: 2,
    })
    expect(res.exitCode ?? 0).toBe(0)
    const runFile = fs.readFileSync(path.join(dir, 'runs', 'erosion-test.mds'), 'utf-8')
    expect(runFile).toMatch(/%meta \{"id":"erosion-test"/)
    expect(runFile.split('\n%user ').length - 1).toBe(1)
    expect(runFile.split('\n%assistant').length - 1).toBe(2)
    expect(res.output?.includes('2/2')).toBe(true)
  })

  it('conv.mdz — утилита без LLM, тело импортит пакет из окружения runz', async () => {
    const out = path.join(tmp(), 'data.toon')
    const res = await run(fx('conv.mdz'), { in: fx('data.json'), out })
    expect(res.exitCode ?? 0).toBe(0)
    expect(fs.readFileSync(out, 'utf-8')).toMatch(/title: rz smoke/)
  })
})

describe('$outputs блокнота (mdz-приложение, ABC-380)', () => {
  it('имена выходов → ScriptResult.outputs: текст шага или его артефакты с именем; шага нет — выхода нет', async () => {
    const res = await run(fx('outputs.mdz'))
    expect(res.outputs).toEqual([
      { type: 'text', text: 'куплет', name: 'lyrics' },
      { type: 'text', text: 'рок, быстрый темп', name: 'style' },
      { type: 'image', path: '/tmp/a.png', name: 'pic' },
      { type: 'text', text: 'доп', name: 'extra' },
      { type: 'text', text: '[]', name: '_trace' },
    ])
  })

  it('без $outputs — outputs нет', async () => {
    const res = await run(fx('notebook.mdz'))
    expect(res.outputs).toBeUndefined()
  })
})

describe('тот же сценарий лентой mds', () => {
  it('%source + %fn + %template дают результат mdz-версии', async () => {
    const mdzDb = tmp()
    const mdsDb = tmp()

    await run(fx('pipeline.mdz'), { run: 'extract', db_dir: mdzDb })
    const res = await run(fx('pipeline.mds'), { db_dir: mdsDb })

    expect(res.exitCode ?? 0).toBe(0)
    expect(fs.readFileSync(path.join(mdsDb, 'fight-club.md'), 'utf-8')).toBe(
      fs.readFileSync(path.join(mdzDb, 'fight-club.md'), 'utf-8'),
    )
  })

  it('${} в мете источника резолвится (мост)', async () => {
    const res = await run(fx('pipeline.mds'), { db_dir: tmp(), slug: 'fight-club' })
    expect(res.exitCode ?? 0).toBe(0)

    await expect(run(fx('pipeline.mds'), { db_dir: tmp(), slug: 'нет-такого' })).rejects.toThrow(
      /ресурс не найден.*нет-такого\.md/s,
    )
  })
})

describe('вход и команды', () => {
  it('файл, который нечем исполнить, — громкая ошибка', async () => {
    await expect(run(fx('data.json'))).rejects.toThrow(/не знаю, как исполнить/)
  })

  it('--as перебивает расширение', async () => {
    // Копия рядом с фикстурами: относительные пути документа (`./mdd/...`)
    // резолвятся от его директории.
    const feed = fx('feed-as.txt')
    fs.copyFileSync(fx('pipeline.mds'), feed)
    try {
      const res = await run(feed, { as: 'mds', cmd: 'debug' })
      expect(res.output ?? '').toMatch(/## \$fn extract/)
      await expect(run(feed, { cmd: 'debug' })).rejects.toThrow(/не знаю, как исполнить/)
    } finally {
      fs.rmSync(feed, { force: true })
    }
  })

  it('--cmd=debug — дамп документа, mds и mdz одинаково', async () => {
    const mds = await run(fx('pipeline.mds'), { cmd: 'debug' })
    expect(mds.output ?? '').toMatch(/## \$source row/)
    expect(mds.output ?? '').toMatch(/## \$fn extract/)

    const mdz = await run(fx('pipeline.mdz'), { cmd: 'debug' })
    expect(mdz.output ?? '').toMatch(/## \$prompt extract/)
    expect(mdz.output ?? '').toMatch(/## \$action all/)
  })

  it('--cmd=tpl рендерит шаблон, --cmd=tpl_inspect даёт карту путей', async () => {
    const tpl = await run(fx('pipeline.mds'), { cmd: 'tpl', template: 'extract', title: 'X' })
    expect(tpl.output ?? '').toMatch(/%system/)

    const map = await run(fx('pipeline.mds'), { cmd: 'tpl_inspect' })
    expect(map.output ?? '').toMatch(/Доступные пути/)
  })

  it('неизвестная команда — отказ', async () => {
    const res = await run(fx('pipeline.mds'), { cmd: 'нет-такой' })
    expect(res.exitCode).toBe(1)
    expect(res.output ?? '').toMatch(/неизвестная команда/)
  })

  it('mdd читается как программа (сигил @)', async () => {
    const dir = tmp()
    fs.copyFileSync(fx('mdd/fight-club.md'), path.join(dir, 'card.mdd'))
    const res = await run(path.join(dir, 'card.mdd'), { cmd: 'debug' })
    expect(res.exitCode ?? 0).toBe(0)
    expect(res.output ?? '').toMatch(/## \$char Tyler Durden/)
  })

  it('$run на несуществующий id — ошибка, не пропуск', async () => {
    await expect(run(fx('pipeline.mdz'), { run: 'нет-такого' })).rejects.toThrow(
      /fn "нет-такого" не найден/,
    )
  })
})

describe('служебные атрибуты шага $nr-* (pipeline-graph-spec §2)', () => {
  // Схема пайплайна nrchat пишет `$nr-needs` / `$nr-node` / `$nr-title` в блок
  // `## $action` перед кодом — runz их не читает, шаг находится и исполняется как был.
  const DOC = [
    '$run: all',
    '',
    '## $action all',
    '$nr-node: false',
    '```ts',
    'export default async function (ctx, meta, helpers) {',
    "  const a = await helpers.run('a')",
    "  const b = await helpers.run('b')",
    "  return { output: [a.output, b.output].join(' ') }",
    '}',
    '```',
    '',
    '## $action a',
    '$nr-title: Шаг А',
    '```ts',
    "export default async function () { return { output: 'a-ok' } }",
    '```',
    '',
    '## $action b',
    '$nr-needs: $[a]',
    '$nr-title: Шаг Б',
    '```ts',
    "export default async function () { return { output: 'b-ok' } }",
    '```',
    '',
  ].join('\n')

  it('helpers.run находит шаг с атрибутами перед блоком кода', async () => {
    const dir = tmp()
    const file = path.join(dir, 'graph.mdz')
    fs.writeFileSync(file, DOC)
    const res = await run(file)
    expect(res.exitCode ?? 0).toBe(0)
    expect(res.output).toBe('a-ok b-ok')
  })

  it('--run=<шаг> с атрибутами — тот же шаг', async () => {
    const dir = tmp()
    const file = path.join(dir, 'graph.mdz')
    fs.writeFileSync(file, DOC)
    const res = await run(file, { run: 'b' })
    expect(res.output).toBe('b-ok')
  })
})
