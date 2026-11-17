/**
 * Задачи (jobs-spec §7, юниты): реестр, планировщик (лимиты по ключам, общий
 * max, `lost` по мёртвому pid, resume), обёртка пишет лог после смерти
 * родителя, входы переживают удаление исходников. Обёртка — собранная
 * (`dist/cli.js`): `npm test` сначала собирает пакет.
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { attach, cancel, get, list, loadJobsConfig, parseJob, recipeAttrs, restart, serializeJob, start, tick } from '../src/jobs/index.js'
import type { JobInfo } from '../src/jobs/index.js'
import { writeJob } from '../src/jobs/registry.js'
import { inServiceCgroup, serviceScope } from '../src/jobs/scheduler.js'

/** Фейковый runz: значения читает из документа запуска (`$k: v` до первого `## `). */
function fakeRunz(dir: string): string {
  const bin = join(dir, 'fake-runz.mjs')
  writeFileSync(
    bin,
    `#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
const text = readFileSync(process.argv[2], 'utf8')
const v = {}
for (const l of text.split('\\n')) {
  if (l.startsWith('## ')) break
  const m = /^\\$(\\w+): (.*)$/.exec(l)
  if (m) v[m[1]] = m[2].replace(/^"|"$/g, '')
}
const done = (output) => { process.stdout.write(JSON.stringify({ output, outputs: [] }) + '\\n'); process.exit(0) }
if (v.mode === 'sleep') {
  process.on('SIGTERM', () => { process.stdout.write(JSON.stringify({ output: 'interrupted', exitCode: 1 }) + '\\n'); process.exit(1) })
  process.stdout.write('waiting\\n')
  setInterval(() => {}, 1000)
} else if (v.mode === 'lines') {
  let i = 0
  const t = setInterval(() => {
    i++
    process.stdout.write('line ' + i + '\\n')
    if (i === Number(v.n || 3)) { clearInterval(t); done('ok ' + i) }
  }, Number(v.delay || 50))
} else if (v.mode === 'inputs') {
  for (const [k, val] of Object.entries(v)) {
    if (val.startsWith('/')) process.stdout.write(k + ':' + existsSync(val) + ':' + (existsSync(val) ? readFileSync(val).length : 0) + '\\n')
  }
  done('inputs')
} else if (v.mode === 'jobdir') {
  process.stdout.write('jobdir:' + (process.env.RUNZ_JOB_DIR ?? '') + '\\n')
  done('jobdir')
} else if (v.mode === 'trace') {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { dirname } = await import('node:path')
  mkdirSync(dirname(v.trace), { recursive: true })
  writeFileSync(v.trace, '{"t":"2026-11-10T00:00:00Z","ev":"run.start"}\\n')
  writeFileSync(process.env.RUNZ_TRACE_POINTER, v.trace + '\\n')
  done('trace')
} else if (v.mode === 'fail') {
  process.stderr.write('boom\\n')
  process.stdout.write(JSON.stringify({ output: 'failed step', exitCode: 1 }) + '\\n')
  process.exit(1)
} else {
  done('plain')
}
`,
  )
  chmodSync(bin, 0o755)
  return bin
}

let root: string
let jobs: string
let bin: string
let recipe: string
const savedEnv = { ...process.env }

function writeConfig(body: string): void {
  writeFileSync(join(root, 'config.md'), body)
  process.env.NR_RUNZ_CONFIG = join(root, 'config.md')
}

const until = async (cond: () => boolean, ms = 10_000): Promise<void> => {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout')
    await new Promise((r) => setTimeout(r, 40))
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rr-jobs-'))
  jobs = join(root, 'jobs')
  process.env.RUNZ_JOBS_DIR = jobs
  bin = fakeRunz(root)
  recipe = join(root, 'fix-core.mdz')
  writeFileSync(recipe, '$job_keys: $[gemini]\n$mode: plain\n\n## $form\n$mode: string\n')
  writeConfig('$jobs: {max: 3, limits: {gemini: 1}}\n')
})

afterEach(async () => {
  for (const j of list()) if (j.status === 'running' || j.status === 'queued') await cancel(j.id)
  await new Promise((r) => setTimeout(r, 200))
  process.env = { ...savedEnv }
  rmSync(root, { recursive: true, force: true })
})

describe('job.mdz', () => {
  it('шапка — короткие атрибуты, значения и тексты — блоками; круг без потерь', () => {
    const j: JobInfo = {
      id: '20261008-143012000-a1b2',
      title: 'elena',
      target: '/r/fix-core.mdz',
      cwd: '/r',
      keys: ['gemini', 'glm'],
      values: { source: 'https://example.com/x, y', n: 3, dry: false, list: ['a', 'b c'], tpl: 'a ${b} c' },
      status: 'failed',
      created: '2026-10-08T14:30:12.000Z',
      pid: 123,
      exit: 1,
      outputs: ['/r/out/bot.md'],
      output: 'итог\n## не заголовок',
      error: 'Traceback\n$dollar line',
    }
    const text = serializeJob(j)
    const head = text.split('\n## ')[0]!
    expect(head.split('\n').every((l) => l.length < 300)).toBe(true)
    expect(text).toContain('## $values\n$source: "https://example.com/x, y"')
    expect(text).toContain('## $error\nTraceback\n $dollar line')
    expect(parseJob(text)).toEqual(j)
  })

  it('конфиг $jobs и $job_keys рецепта через инклюд', () => {
    writeConfig('$jobs: {max: 6, limits: {gemini: 3, mac: 1}, resume_lost: true}\n')
    expect(loadJobsConfig()).toEqual({ max: 6, limits: { gemini: 3, mac: 1 }, resumeLost: true, pool: false })
    writeConfig('$jobs: {pool: true}\n')
    expect(loadJobsConfig().pool).toBe(true)
    writeFileSync(join(root, 'base.mdz'), '$job_keys: $[mac]\n$job_timeout: 90m\n')
    writeFileSync(join(root, 'thin.mdz'), '$[[base.mdz]]\n$out: "222"\n')
    expect(recipeAttrs(join(root, 'thin.mdz'))).toEqual({ keys: ['mac'], timeoutMs: 90 * 60_000, out: '222' })
    writeFileSync(join(root, 'thin2.mdz'), '$[[base.mdz]]\n$job_keys: $[gemini]\n')
    expect(recipeAttrs(join(root, 'thin2.mdz')).keys).toEqual(['gemini'])
  })

  it('профиль (preset, ABC-255): $job_keys профиля — очередь; значение задачи сильнее документа', () => {
    mkdirSync(join(root, 'models'), { recursive: true })
    writeFileSync(join(root, 'models/opus.mdz'), '$title: Opus\n$job_keys: $[opus]\n')
    writeFileSync(join(root, 'models/local.mdz'), '$title: Мак\n$job_keys: $[mac]\n')
    writeFileSync(join(root, 'pbase.mdz'), '$job_keys: $[gemini]\n\n## $form\n$models: preset? models/*.mdz // Модели\n\n## $@\n')
    writeFileSync(join(root, 'pthin.mdz'), '$[[pbase.mdz]]\n$models: models/local.mdz\n')
    expect(recipeAttrs(join(root, 'pbase.mdz')).keys).toEqual(['gemini'])
    expect(recipeAttrs(join(root, 'pthin.mdz')).keys).toEqual(['mac'])
    expect(recipeAttrs(join(root, 'pthin.mdz'), { models: 'opus' }).keys).toEqual(['opus'])
    expect(recipeAttrs(join(root, 'pbase.mdz'), { models: 'models/opus.mdz' }).keys).toEqual(['opus'])
    expect(() => recipeAttrs(join(root, 'pbase.mdz'), { models: 'opsu' })).toThrow(/opsu/)
  })
})

describe('планировщик', () => {
  it('лимит по ключу и общий max: gemini 1 идёт, 2 ждут; чужой ключ — свой слот; отмена освобождает слот', async () => {
    const a = await start({ target: recipe, values: { mode: 'sleep' }, runz: [bin] })
    const b = await start({ target: recipe, values: { mode: 'sleep' }, runz: [bin] })
    const c = await start({ target: recipe, values: { mode: 'sleep' }, runz: [bin] })
    const d = await start({ target: recipe, values: { mode: 'sleep' }, keys: ['glm'], runz: [bin] })
    expect(a.status).toBe('running')
    expect(a.keys).toEqual(['gemini'])
    expect([b.status, c.status]).toEqual(['queued', 'queued'])
    expect(d.status).toBe('running')
    // общий max 3: ещё два glm — один встаёт, второй ждёт
    const e = await start({ target: recipe, values: { mode: 'sleep' }, keys: ['glm'], runz: [bin] })
    const f = await start({ target: recipe, values: { mode: 'sleep' }, keys: ['glm'], runz: [bin] })
    expect([e.status, f.status]).toEqual(['running', 'queued'])

    await cancel(a.id)
    await until(() => get(a.id)?.status === 'cancelled')
    // конец обёртки — проход планировщика: b стартует без резидентного цикла
    await until(() => get(b.id)?.status === 'running')
    expect(get(c.id)?.status).toBe('queued')
    expect(readFileSync(join(jobs, a.id, 'log.ndjson'), 'utf8')).toContain('"status":"cancelled"')
    // отмена в очереди — сразу
    await cancel(c.id)
    expect(get(c.id)?.status).toBe('cancelled')
  }, 30_000)

  it('running с мёртвым pid → lost; resume_lost ставит заново и запускает', async () => {
    const j = await start({ target: recipe, values: { mode: 'lines', n: 2 }, runz: [bin], keys: ['x'] })
    await until(() => get(j.id)?.status === 'done')
    // имитация: задача «шла», процесса нет
    writeJob(jobs, { ...parseJob(readFileSync(join(jobs, j.id, 'job.mdz'), 'utf8')), id: j.id, status: 'running', pid: 999_999 })
    expect(get(j.id)?.status).toBe('lost') // показ — сразу
    const r = await tick({ runz: [bin] })
    expect(r.lost).toEqual([j.id])
    expect(readFileSync(join(jobs, j.id, 'job.mdz'), 'utf8')).toContain('$status: "lost"')

    writeConfig('$jobs: {max: 3, resume_lost: true}\n')
    const r2 = await tick({ runz: [bin] })
    expect(r2.resumed).toEqual([j.id])
    expect(r2.launched).toEqual([j.id])
    await until(() => get(j.id)?.status === 'done')
    expect(get(j.id)?.resumed).toBe(1)
  }, 30_000)
})

describe('обёртка', () => {
  it('лог пишется после смерти родителя; attach отдаёт хвост и живые кадры до конца', async () => {
    // Родитель — отдельный процесс: ставит задачу (--now) и сразу выходит.
    const dist = fileURLToPath(new URL('../dist/jobs/index.js', import.meta.url))
    const parent = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const { start } = await import(${JSON.stringify(dist)}); const j = await start({ target: ${JSON.stringify(recipe)}, values: { mode: 'lines', n: 6, delay: 150 }, runz: [${JSON.stringify(bin)}], now: true }); process.stdout.write(j.id); process.exit(0)`,
      ],
      { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] },
    )
    let id = ''
    parent.stdout.on('data', (c: Buffer) => (id += c.toString()))
    const code = await new Promise((r) => parent.on('close', r))
    expect(code).toBe(0)
    expect(get(id)?.status).toBe('running')

    const frames = []
    for await (const f of attach(id, { pollMs: 50 })) frames.push(f)
    const lines = frames.filter((f) => f.kind === 'line').map((f) => f.text)
    expect(lines).toEqual(['line 1', 'line 2', 'line 3', 'line 4', 'line 5', 'line 6'])
    expect(frames.at(-1)).toMatchObject({ kind: 'end', status: 'done', output: 'ok 6' })
    const job = get(id)!
    expect(job).toMatchObject({ status: 'done', exit: 0, output: 'ok 6' })
    expect(job.child).toBeUndefined()
    // файл запуска рядом с рецептом убран
    expect(existsSync(join(root, `.fix-core.job-${id}.mdz`))).toBe(false)
    // attach с середины
    const tail = []
    for await (const f of attach(id, { from: frames.length - 2 })) tail.push(f)
    expect(tail.map((f) => f.n)).toEqual([frames.length - 2, frames.length - 1])
  }, 30_000)

  it('провал: failed, stderr — блоком $error', async () => {
    const j = await start({ target: recipe, values: { mode: 'fail' }, runz: [bin], keys: ['x'] })
    await until(() => get(j.id)?.status === 'failed')
    const text = readFileSync(join(jobs, j.id, 'job.mdz'), 'utf8')
    expect(text).toContain('## $error\nboom')
    expect(text).toContain('## $output\nfailed step')
  }, 20_000)
})

describe('задача-команда (ABC-690)', () => {
  it('cmd круг без потерь: кавычки, ${VAR}, перевод строки', () => {
    const j: JobInfo = {
      id: '20261106-143012000-a1b2',
      title: 'sleep',
      target: 'sh',
      cmd: 'echo "a b" && echo ${HOME} \'x\'\nsleep 1',
      cwd: '/r',
      keys: ['sh'],
      values: {},
      status: 'queued',
      created: '2026-11-06T14:30:12.000Z',
    }
    expect(parseJob(serializeJob(j))).toEqual(j)
  })

  it('sh -c: строки в лог, done по коду 0, хвост вывода — output; код 3 — failed', async () => {
    const ok = await start({ cmd: 'echo one; echo two', cwd: root, now: true })
    expect(ok.target).toBe('sh')
    expect(ok.title).toBe('echo one; echo two')
    await until(() => get(ok.id)?.status === 'done')
    const v = get(ok.id)!
    expect(v.exit).toBe(0)
    expect(v.output).toBe('one\ntwo')
    const bad = await start({ cmd: 'echo oops >&2; exit 3', cwd: root, title: 'bad', now: true })
    await until(() => get(bad.id)?.status === 'failed')
    expect(get(bad.id)!.exit).toBe(3)
    expect(get(bad.id)!.error).toContain('oops')
    const re = await restart(ok.id, { now: true })
    expect(re.cmd).toBe('echo one; echo two')
    await until(() => get(re.id)?.status === 'done')
  }, 20_000)
})

describe('рестарт стенда (ABC-690, 10.11)', () => {
  const starts = (id: string): number =>
    readFileSync(join(jobs, id, 'log.ndjson'), 'utf8').split('\n').filter((l) => l.includes('"kind":"start"')).length

  it('now: проход планировщика, пока постановка ждёт замок, задачу не запускает — одна обёртка', async () => {
    writeConfig('$jobs: {max: 20}\n')
    mkdirSync(jobs, { recursive: true })
    const lock = join(jobs, '.lock')
    // Замок держит «другой процесс» (резидентный планировщик стенда).
    writeFileSync(lock, `${process.pid}\n`)
    const p = start({ cmd: 'sleep 0.3', cwd: root, now: true })
    await new Promise((r) => setTimeout(r, 150))
    rmSync(lock)
    await tick() // проход по fs-watch раньше, чем постановка дождалась замка
    const j = await p
    await until(() => get(j.id)?.status === 'done')
    expect(starts(j.id)).toBe(1)
  }, 20_000)

  it('сигнал обёртке без cancel() — lost с причиной, не cancelled', async () => {
    const j = await start({ cmd: 'sleep 30', cwd: root, now: true })
    await until(() => get(j.id)?.child !== undefined)
    process.kill(-j.pid!, 'SIGTERM')
    await until(() => get(j.id)?.status !== 'running')
    const v = get(j.id)!
    expect(v.status).toBe('lost')
    expect(v.error).toContain('не отмена')
  }, 20_000)

  it('cgroup: сервис узнаётся по строке *.service; под ним обёртка уходит в свой scope', async () => {
    expect(inServiceCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/studio.lab.acp.service\n')).toBe(true)
    expect(inServiceCgroup('0::/user.slice/user-1000.slice/session-3.scope\n')).toBe(false)
    expect(inServiceCgroup('0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-p1-i2.scope\n')).toBe(false)
    process.env.RUNZ_JOBS_SCOPE = '1'
    if (serviceScope().length === 0) return // не linux или нет systemd-run --user
    const j = await start({ cmd: 'sleep 5', cwd: root, now: true })
    await until(() => get(j.id)?.child !== undefined)
    const cg = readFileSync(`/proc/${j.pid}/cgroup`, 'utf8')
    expect(cg).toMatch(/\.scope\s*$/m)
    expect(cg).not.toMatch(/\.service\s*$/m)
  }, 20_000)
})

describe('входы', () => {
  it('3 картинки (байты + 2 пути) и длинный текст: исходники удалены — задача видит все 4; restart — те же', async () => {
    const src = join(root, 'src')
    mkdirSync(src)
    writeFileSync(join(src, 'a.png'), Buffer.alloc(10, 1))
    writeFileSync(join(src, 'b.png'), Buffer.alloc(20, 2))
    const long = 'текст '.repeat(2000)
    const j = await start({
      target: recipe,
      keys: ['x'],
      runz: [bin],
      values: { mode: 'inputs', clip: 'inputs/clip.png', a: 'inputs/a.png', b: 'inputs/b.png', notes: 'inputs/notes.md', short: 'коротко' },
      files: [
        { name: 'clip.png', bytes: Buffer.alloc(30, 3).toString('base64') },
        { name: 'a.png', path: join(src, 'a.png') },
        { name: 'b.png', path: join(src, 'b.png') },
        { name: 'notes.md', text: long },
      ],
    })
    rmSync(src, { recursive: true })
    await until(() => get(j.id)?.status === 'done')
    const seen = (id: string): string[] =>
      readFileSync(join(jobs, id, 'log.ndjson'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; text?: string })
        .filter((f) => f.kind === 'line')
        .map((f) => f.text!)
        .sort()
    const bytes = Buffer.byteLength(long)
    expect(seen(j.id)).toEqual(['a:true:10', 'b:true:20', 'clip:true:30', `notes:true:${bytes}`])
    // в job.mdz — стабильные ссылки inputs/…, не абсолютные пути
    expect(readFileSync(join(jobs, j.id, 'job.mdz'), 'utf8')).toContain('$a: "inputs/a.png"')

    const r = await restart(j.id, { runz: [bin] })
    expect(r.restartOf).toBe(j.id)
    await until(() => get(r.id)?.status === 'done')
    expect(seen(r.id)).toEqual(seen(j.id))
  }, 30_000)

  it('runz задачи видит RUNZ_JOB_DIR — каталог задачи с inputs/ (bot-fix-tool §3)', async () => {
    const j = await start({ target: recipe, keys: ['x'], runz: [bin], values: { mode: 'jobdir' }, files: [{ name: 'a.txt', text: 'a' }] })
    await until(() => get(j.id)?.status === 'done')
    const lines = readFileSync(join(jobs, j.id, 'log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; text?: string })
    const seen = lines.find((f) => f.kind === 'line' && f.text?.startsWith('jobdir:'))?.text
    expect(seen).toBe(`jobdir:${join(jobs, j.id)}`)
    expect(existsSync(join(jobs, j.id, 'inputs', 'a.txt'))).toBe(true)
  })

  it('след прогона (ABC-731): runz пишет путь в RUNZ_TRACE_POINTER — у задачи поле trace', async () => {
    const trace = join(root, 'out', 'run.trace.jsonl')
    const j = await start({ target: recipe, keys: ['x'], runz: [bin], values: { mode: 'trace', trace } })
    await until(() => get(j.id)?.status === 'done')
    expect(get(j.id)?.trace).toBe(trace)
  })
})
