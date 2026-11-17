/**
 * Smoke — перенос rz/test/smoke.test.ts (rz-merge §3.5): настоящим CLI, в
 * настоящем окружении runz (там резолвятся пакеты вроде `@toon-format/toon`,
 * которых нет у документа в node_modules).
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures')
const BIN = path.join(HERE, '..', '..', 'bin', 'runz.ts')
const fx = (name: string) => path.join(FIX, name)

const temps: string[] = []
function tmp(inRepo = false): string {
  const base = inRepo ? path.join(FIX, '.tmp') : os.tmpdir()
  fs.mkdirSync(base, { recursive: true })
  const dir = fs.mkdtempSync(path.join(base, 'smoke-'))
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

function runz(args: string[]): { status: number; out: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf-8', cwd: FIX })
  return { status: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

describe('smoke: runz <документ> — все четыре формата настоящим CLI', () => {
  it('pipeline.mdz — оба шага ($run: all)', () => {
    const db = tmp()
    const profiles = tmp()
    const r = runz([fx('pipeline.mdz'), '--provider=mock', `--db_dir=${db}`, `--profiles_dir=${profiles}`])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/Pipeline complete/)
  })

  it('pipeline.mds — та же программа лентой', () => {
    const db = tmp()
    const r = runz([fx('pipeline.mds'), '--provider=mock', `--db_dir=${db}`])
    expect(r.status, r.out).toBe(0)
    expect(fs.readFileSync(path.join(db, 'fight-club.md'), 'utf-8')).toMatch(/Mock Character/)
  })

  it('conv.mdz — тело импортит пакет из окружения runz', () => {
    const out = path.join(tmp(), 'data.toon')
    const r = runz([fx('conv.mdz'), `--in=${fx('data.json')}`, `--out=${out}`])
    expect(r.status, r.out).toBe(0)
    expect(fs.readFileSync(out, 'utf-8')).toMatch(/items\[3\]/)
  })

  it('sim.mdz — стор и персистентность', () => {
    const dir = tmp(true)
    fs.copyFileSync(fx('sim.mdz'), path.join(dir, 'sim.mdz'))
    const r = runz([
      path.join(dir, 'sim.mdz'),
      '--provider=mock',
      '--run_file=./run.mds',
      '--turns=2',
    ])
    expect(r.status, r.out).toBe(0)
    expect(fs.readFileSync(path.join(dir, 'run.mds'), 'utf-8')).toMatch(/%assistant/)
  })

  it('notebook.mdz — блокнот без $type и без $handler', () => {
    const r = runz([fx('notebook.mdz')])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/шаг 2 видит: шаг 1: привет/)
  })

  it('site-user-download.mdz --cmd=debug — дамп без сети', () => {
    const r = runz([fx('site-user-download.mdz'), '--cmd=debug'])
    expect(r.status, r.out).toBe(0)
    expect(r.out).toMatch(/## \$action download/)
  })
})

describe('smoke: ошибка рантайма', () => {
  it('--runz-json: префикс `runz: ` не дублируется', () => {
    const r = spawnSync(process.execPath, [BIN, './nope.ts', '--runz-json'], { encoding: 'utf-8', cwd: FIX })
    expect(r.status).toBe(1)
    const json = JSON.parse(r.stdout.trim().split('\n').pop()!)
    expect(json.exitCode).toBe(1)
    expect(json.output).toMatch(/^runz: script not found/)
    expect(json.output).not.toMatch(/runz: runz:/)
    expect(r.stderr).not.toMatch(/runz: runz:/)
  })
})
