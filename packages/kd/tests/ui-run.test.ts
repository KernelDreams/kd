/**
 * `--ui` у любого тула (§9): прогон не-агента в окне — сессия `.mds`: реплика — команда,
 * ход тула (stderr) — рассуждением, шаги документа — узлами вызова с результатом, вывод — ответом.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cwdKey } from '../src/complete-values.js'

const BIN = resolve(__dirname, '..', 'bin', 'kd.mjs')
let root: string
let work: string
let env: NodeJS.ProcessEnv

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kd-uirun-'))
  work = join(root, 'w')
  mkdirSync(join(work, '.kd', 'tools'), { recursive: true })
  env = { PATH: process.env.PATH, HOME: join(root, 'home'), KD_HOME: join(root, 'home', '.kd'), KD_NO_OPEN: '1', KD_UI_HOLD: '0' }
  writeFileSync(
    join(work, '.kd', 'tools', 'greet.mjs'),
    [
      "export const tool = { description: 'привет', fields: { name: 'string $pos=1 // Имя' } }",
      'export default async (ctx) => {',
      "  process.stderr.write('готовлю привет\\n')",
      "  return { output: 'привет, ' + ctx.get(['name']) }",
      '}',
    ].join('\n'),
  )
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const kd = (args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: work, env, encoding: 'utf8' })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const sessions = (): string[] => {
  const d = join(root, 'home', '.kd', 'sessions', cwdKey(work))
  return readdirSync(d).filter((f) => f.endsWith('.mds')).map((f) => readFileSync(join(d, f), 'utf8'))
}

describe('--ui у любого тула', () => {
  it('объявленный тул: --ui после имени и до имени — окно, сессия с командой, ходом и выводом', () => {
    for (const args of [['greet', 'Мир', '--ui'], ['--ui', 'greet', 'Мир']]) {
      const r = kd(args)
      expect(r.code).toBe(0)
      expect(r.out).toBe('привет, Мир\n') // stdout — по-прежнему только результат
      expect(r.err).toMatch(/kd: окно http:\/\/127\.0\.0\.1:\d+\//)
    }
    const [s] = sessions()
    expect(s).toMatch(/^%user .*\nkd greet Мир$/m)
    expect(s).toMatch(/%%thinking\nготовлю привет/)
    expect(s).toMatch(/^%assistant .*\nпривет, Мир$/m)
    expect(sessions()).toHaveLength(2)
  })
  it('документ с шагами: шаги — узлами вызова с результатом', () => {
    const step = (id: string): string => [`## $step ${id}`, '```ts', `export default async () => { await new Promise((r) => setTimeout(r, 500)); return { output: '${id} готов' } }`, '```', ''].join('\n')
    writeFileSync(join(work, 'job.mdz'), ['$title: прогон', '', step('one'), step('two')].join('\n'))
    const r = kd(['--ui', 'job.mdz'])
    expect(r.code).toBe(0)
    const [s] = sessions()
    expect(s).toMatch(/%%tool_use \{callId: 'step-one', name: 'one'\}/)
    expect(s).toMatch(/%%tool_result \{callId: 'step-one', name: 'one'\}/)
    expect(s).toMatch(/%%tool_use \{callId: 'step-two', name: 'two'\}/)
    expect(s).toMatch(/one готов\ntwo готов/)
  })
  it('тул упал — код в ленте заметкой, код выхода тот же', () => {
    writeFileSync(join(work, '.kd', 'tools', 'boom.mjs'), "export const tool = { description: 'падает' }\nexport default () => ({ output: 'плохо', exitCode: 1 })\n")
    const r = kd(['boom', '--ui'])
    expect(r.code).toBe(1)
    expect(sessions()[0]).toMatch(/kd: код выхода 1/)
  })
})
