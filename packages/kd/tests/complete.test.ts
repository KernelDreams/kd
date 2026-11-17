/**
 * Подсказки Tab (§6): лёгкая точка `kd __complete` читает кэш без рантайма — до 50 мс;
 * действия объекта с описаниями, поля с умолчаниями, значения вариантов.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { complete } from '../src/complete-fast.js'
import { main, type Io } from '../src/node/cli.js'
import type { CompletionCache } from '../src/node/cache.js'

const BIN = resolve(__dirname, '..', 'bin', 'kd.mjs')
let root: string
let env: NodeJS.ProcessEnv

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kd-complete-'))
  const work = join(root, 'w')
  const d = join(work, '.kd')
  mkdirSync(join(d, 'tools'), { recursive: true })
  writeFileSync(
    join(d, 'tools', 'bot.mdz'),
    ['$description: бот', '$lang: ru', '', '## $form', '$url: string $pos=1 $kind=bot // Адрес бота', '$lang: select ru, en // Язык', '', '## $action show', '$title: показать', '$default: true', '', '## $action play', '$title: сыграть'].join('\n'),
  )
  writeFileSync(join(d, 'links.mdz'), ["## $link bot", "$pattern: 'https://bots\\.example/[\\w-]+'", '$kind: bot', '', '## $action bot.play', '$for: bot', '$title: сыграть с ботом', '$run: kd', '$cmd: bot play ${text}'].join('\n'))
  env = { PATH: process.env.PATH, HOME: join(root, 'home'), KD_HOME: join(root, 'home', '.kd') }
  const io: Io = { stdout: () => {}, stderr: () => {}, readStdin: async () => '', interactive: false, cwd: work, env }
  await main([], io) // пишет кэш
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const run = (words: string[]): { out: string; ms: number } => {
  const t = performance.now()
  const r = spawnSync(process.execPath, [BIN, '__complete', ...words], { cwd: join(root, 'w'), env, encoding: 'utf8' })
  return { out: r.stdout, ms: performance.now() - t }
}

describe('kd __complete', () => {
  it('действия объекта с описаниями', () => {
    expect(run(['https://bots.example/cat', '']).out).toContain('play\tсыграть с ботом')
  })
  it('тулы, действия тула, поля с умолчаниями, варианты', () => {
    expect(run(['bo']).out).toContain('bot\tбот')
    expect(run(['bot', '']).out).toMatch(/^play\tсыграть$/m)
    expect(run(['bot', '--l']).out).toContain('--lang=\tЯзык (по умолчанию ru)')
    expect(run(['bot', '--lang=']).out.trim().split('\n')).toEqual(['--lang=ru', '--lang=en'])
  })
  it('формат zsh: двоеточия в значении экранированы', () => {
    const r = spawnSync(process.execPath, [BIN, '__complete', '--shell=zsh', 'https://bots.example/cat', ''], { cwd: join(root, 'w'), env, encoding: 'utf8' })
    expect(r.stdout).toContain('play:сыграть с ботом')
  })
  it('ответ из кэша — до 50 мс (без запуска node — сама работа)', () => {
    const cache = JSON.parse(require('node:fs').readFileSync(join(root, 'home', '.kd', 'cache', 'catalog.json'), 'utf8')) as CompletionCache
    const t = performance.now()
    for (let i = 0; i < 20; i++) complete(['bot', '--lang='], cache, join(root, 'w'))
    expect((performance.now() - t) / 20).toBeLessThan(50)
  })
  it('процесс целиком — лёгкая точка без рантайма', () => {
    const times = [0, 1, 2].map(() => run(['bot', '']).ms)
    // Старт node сам по себе ~30–60 мс; рантайм runz добавил бы сотни.
    expect(Math.min(...times)).toBeLessThan(250)
  })
})
