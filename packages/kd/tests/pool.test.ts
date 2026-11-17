/**
 * §11 удалённый исполнитель: задача, поставленная постановщиком, выполняется `kd worker` (другая «машина» —
 * свой процесс и своя папка данных) и возвращает лог и выход; убитый воркер — задача без `$repeatable`
 * второй раз сама не исполняется (код 4 у постановщика), `$repeatable` уходит следующему воркеру.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Center, servePool } from '@kerneldreams/runz-run/pool'

const BIN = resolve(__dirname, '..', 'bin', 'kd.mjs')
let root: string
let jobsDir: string
let center: Center
let srv: { url: string; close(): Promise<void> }
const workers: ChildProcess[] = []

const env = (name: string): NodeJS.ProcessEnv => {
  const { RUNZ_HOME: _h, ...rest } = process.env
  return { ...rest, HOME: join(root, name), KD_HOME: join(root, name, '.kd'), RUNZ_JOBS_DIR: jobsDir, RUNZ_JOBS: '' }
}

function run(args: string[], name: string, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((done) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd, env: env(name), stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (b) => (out += b))
    p.stderr.on('data', (b) => (err += b))
    p.on('close', (code) => done({ code, out, err }))
  })
}

function worker(name: string): ChildProcess {
  mkdirSync(join(root, name), { recursive: true })
  const p = spawn(process.execPath, [BIN, 'worker', `--center=${srv.url}`, `--key=key-${name}`, `--name=${name}`], { cwd: join(root, name), env: env(name), stdio: ['ignore', 'pipe', 'pipe'] })
  p.stderr.on('data', () => {})
  p.stdout.on('data', () => {})
  workers.push(p)
  return p
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kd-pool-'))
  jobsDir = join(root, 'jobs')
  mkdirSync(jobsDir, { recursive: true })
  center = new Center({ dir: jobsDir, leaseMs: 3000, staleMs: 3000, config: { max: 4, limits: {}, resumeLost: false, pool: true } as never }).start(200)
  srv = await servePool(center, { keys: { w1: 'key-w1', w2: 'key-w2' }, port: 0 })
})
afterEach(async () => {
  for (const w of workers.splice(0)) w.kill('SIGKILL')
  center.stop()
  await srv.close()
  rmSync(root, { recursive: true, force: true })
})

/** Ждём события, а не срок: на загруженной машине воркер стартует и берёт задачу десятки секунд. */
async function until(ok: () => boolean, ms: number, what: string): Promise<void> {
  const t0 = Date.now()
  while (!ok()) {
    if (Date.now() - t0 > ms) throw new Error('не дождались: ' + what)
    await new Promise((r) => setTimeout(r, 200))
  }
}

const doc = (name: string, body: string, extra = ''): string => {
  const dir = join(root, 'poster')
  mkdirSync(dir, { recursive: true })
  const f = join(dir, name)
  writeFileSync(f, `${extra}\n## $step main\n\`\`\`ts\n${body}\n\`\`\`\n`)
  return f
}

describe('kd worker + kd job --on', () => {
  it('задача постановщика выполняется воркером другой машины и возвращает лог и выход', async () => {
    worker('w1')
    const f = doc('hello.mdz', "export default async () => { console.log('ход на воркере'); return { output: 'привет с ' + process.env.KD_DATA } }")
    const r = await run(['job', 'start', f, '--on=w1', '--wait'], 'poster', join(root, 'poster'))
    if (r.code !== 0) console.log(r.out, r.err)
    expect(r.code).toBe(0)
    expect(r.out).toMatch(/done @w1/)
    expect(r.out).toContain(join(root, 'w1'))
  }, 240_000)

  it('убитый воркер: без $repeatable — код 4 и второй раз сама не исполняется; $repeatable — следующему', async () => {
    const started = join(root, 'plain-started')
    const slow = "import { writeFileSync } from 'node:fs'\nexport default async () => { writeFileSync(" + JSON.stringify(started) + ", '1'); await new Promise((r) => setTimeout(r, 600000)); return { output: 'долго' } }"
    const w1 = worker('w1')
    const plainP = run(['job', 'start', doc('plain.mdz', slow), '--on=w1', '--wait'], 'poster', join(root, 'poster'))
    await until(() => existsSync(started), 150_000, 'w1 начал задачу без $repeatable')
    w1.kill('SIGKILL')
    const plain = await plainP
    expect(plain.code).toBe(4)
    expect(plain.out).toMatch(/без \$repeatable/)

    // Повторяемая задача в пул без привязки: w1 берёт её и умирает посреди — задачу сам забирает w2.
    const mark = join(root, 'first-attempt')
    const rep = "import { existsSync, writeFileSync } from 'node:fs'\nexport default async () => { if (!existsSync(" + JSON.stringify(mark) + ")) { writeFileSync(" + JSON.stringify(mark) + ", '1'); await new Promise((r) => setTimeout(r, 60000)) } return { output: 'повтор на ' + process.env.KD_DATA } }"
    const w1b = worker('w1')
    const repP = run(['job', 'start', doc('rep.mdz', rep, '$repeatable: true'), '--pool', '--wait'], 'poster', join(root, 'poster'))
    await until(() => existsSync(mark), 150_000, 'w1 начал повторяемую задачу')
    w1b.kill('SIGKILL')
    worker('w2')
    const done = await repP
    expect(done.code).toBe(0)
    expect(done.out).toMatch(/done @w2/)
  }, 480_000)
})
