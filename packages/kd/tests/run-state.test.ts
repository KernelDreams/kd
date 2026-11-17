/**
 * Прогон без подтверждений, с состоянием (§8): убитый посреди прогон продолжается той же
 * командой с места обрыва; шаг с `$effects` без `$repeatable` после обрыва — код 4 и `--retry`;
 * закрытый stdin — ни одного вопроса.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const BIN = resolve(__dirname, '..', 'bin', 'kd.mjs')
let dir: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kd-state-'))
  env = { PATH: process.env.PATH, HOME: join(dir, 'home'), KD_HOME: join(dir, 'home', '.kd'), LOG: join(dir, 'log.txt'), KILL: join(dir, 'kill') }
  mkdirSync(join(dir, 'home'), { recursive: true })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const step = (id: string, extra = '', body = ''): string =>
  [
    `## $step ${id}`,
    extra,
    '```ts',
    "import { appendFileSync, existsSync, rmSync } from 'node:fs'",
    'export default async () => {',
    `  appendFileSync(process.env.LOG, '${id}\\n')`,
    body,
    `  return { output: '${id} готов' }`,
    '}',
    '```',
    '',
  ].join('\n')

// Второй шаг убивает процесс, пока лежит файл-флаг (и снимает его — второй прогон идёт дальше).
const KILLER = "  if (existsSync(process.env.KILL)) { rmSync(process.env.KILL); process.kill(process.pid, 'SIGKILL') }"

const kd = (args: string[], stdin = ''): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: dir, env, encoding: 'utf8', input: stdin })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const log = (): string[] => (existsSync(env.LOG!) ? readFileSync(env.LOG!, 'utf8').trim().split('\n') : [])

describe('§8 состояние прогона', () => {
  it('убитый посреди прогон продолжается той же командой с места обрыва', () => {
    writeFileSync(join(dir, 'job.mdz'), ['$title: прогон', '', step('one'), step('two', '', KILLER), step('three')].join('\n'))
    writeFileSync(env.KILL!, '')
    const first = kd(['job.mdz'])
    expect(first.code).toBe(null) // SIGKILL
    expect(log()).toEqual(['one', 'two'])
    expect(existsSync(join(dir, '.runz', 'state', 'job.mds'))).toBe(true)
    const second = kd(['job.mdz'])
    expect(second.code).toBe(0)
    // one — из состояния, two (без $effects) повторён, three — новый
    expect(log()).toEqual(['one', 'two', 'two', 'three'])
    expect(second.out).toContain('three готов')
    expect(existsSync(join(dir, '.runz', 'state', 'job.mds'))).toBe(false)
  })
  it('шаг с побочным действием без $repeatable — код 4, повтор флагом', () => {
    writeFileSync(join(dir, 'job.mdz'), [step('one'), step('push', '$effects: $[remote]', KILLER), step('three')].join('\n'))
    writeFileSync(env.KILL!, '')
    kd(['job.mdz'])
    const again = kd(['job.mdz'])
    expect(again.code).toBe(4)
    expect(again.err).toMatch(/--retry=push/)
    expect(log()).toEqual(['one', 'push'])
    const retry = kd(['--retry=push', 'job.mdz'])
    expect(retry.code).toBe(0)
    expect(log()).toEqual(['one', 'push', 'push', 'three'])
  })
  it('$repeatable — повтор сам', () => {
    writeFileSync(join(dir, 'job.mdz'), [step('one'), step('push', '$effects: $[remote]\n$repeatable: true', KILLER), step('three')].join('\n'))
    writeFileSync(env.KILL!, '')
    kd(['job.mdz'])
    expect(kd(['job.mdz']).code).toBe(0)
    expect(log()).toEqual(['one', 'push', 'push', 'three'])
  })
  it('ночной прогон: stdin закрыт — ни одного вопроса; недостающее поле — код 2, а не ожидание', () => {
    mkdirSync(join(dir, '.kd', 'tools'), { recursive: true })
    writeFileSync(join(dir, '.kd', 'tools', 'need.mjs'), 'export const tool = { fields: { url: "string $pos=1 // Адрес" } }\nexport default (c) => ({ output: "ок" })\n')
    writeFileSync(join(dir, 'job.mdz'), [step('one'), step('two')].join('\n'))
    const r = spawnSync(process.execPath, [BIN, 'job.mdz'], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
    expect(r.status).toBe(0)
    const n = spawnSync(process.execPath, [BIN, 'need'], { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 })
    expect(n.status).toBe(2)
  })
})
