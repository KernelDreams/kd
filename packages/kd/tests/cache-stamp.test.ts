/**
 * Кэш каталога зависит от настроек слоёв: замена `~/.kd/settings.mdz` (новый блок `## $complete`)
 * или файла `$layers` видна следующему Tab без удаления `~/.kd/cache`.
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { main, type Io } from '../src/node/cli.js'
import type { CompletionCache } from '../src/node/cache.js'
import { staleSettings } from '../src/complete-fast.js'

const BIN = resolve(__dirname, '..', 'bin', 'kd.mjs')
let root: string
let env: NodeJS.ProcessEnv
let home: string
let work: string

const tab = (words: string[]): string[] =>
  spawnSync(process.execPath, [BIN, '__complete', ...words], { cwd: work, env, encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean)
const cache = (): CompletionCache => JSON.parse(readFileSync(join(home, 'cache', 'catalog.json'), 'utf8')) as CompletionCache

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kd-stamp-'))
  home = join(root, 'home', '.kd')
  work = join(root, 'w')
  mkdirSync(join(work, '.kd', 'tools'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(work, '.kd', 'tools', 'pick.mdz'), ['$description: выбор', '', '## $form', '$host: string? $kind=host // Машина', '$skill: string? // Скилл'].join('\n'))
  writeFileSync(join(home, 'settings.mdz'), '$format: 1\n')
  env = { PATH: process.env.PATH, HOME: join(root, 'home'), KD_HOME: home }
  const io: Io = { stdout: () => {}, stderr: () => {}, readStdin: async () => '', interactive: false, cwd: work, env }
  await main([], io)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('кэш каталога и настройки слоёв', () => {
  it('в кэше — метки файлов настроек; без правки кэш свежий', () => {
    const c = cache()
    expect(Object.keys(c.files ?? {})).toContain(join(home, 'settings.mdz'))
    expect(staleSettings(c)).toBe(false)
    expect(tab(['pick', '--host='])).toEqual([])
  })

  it('замена settings.mdz с блоками $complete host / skill — Tab видит их сразу', () => {
    const hosts = join(root, 'hosts.mdz')
    writeFileSync(hosts, ['## $hosts alpha', '$ssh: a', '', '## $hosts beta', '$ssh: b'].join('\n'))
    writeFileSync(join(home, 'settings.mdz'), ['$format: 1', '', '## $complete host', `$blocks: ${hosts}`, '$section: hosts', '', '## $complete skill', '$list: $[one, two]'].join('\n'))
    expect(staleSettings(cache())).toBe(true)
    expect(tab(['pick', '--host=']).sort()).toEqual(['--host=alpha', '--host=beta'])
    expect(tab(['pick', '--skill=t'])).toEqual(['--skill=two'])
    expect(staleSettings(cache())).toBe(false)
  })

  it('та же дата правки, другой размер — тоже пересборка', () => {
    const f = join(home, 'settings.mdz')
    const before = cache().files![f]!
    writeFileSync(f, readFileSync(f, 'utf8').replace('$[one, two]', '$[one, two, three]'))
    const t = Number(before.split(':')[0]) / 1000
    utimesSync(f, t, t)
    expect(staleSettings(cache())).toBe(true)
    expect(tab(['pick', '--skill=th'])).toEqual(['--skill=three'])
  })

  it('файл $layers поменялся — пересборка', () => {
    const conf = join(root, 'config.md')
    writeFileSync(conf, '$x: 1\n')
    writeFileSync(join(home, 'settings.mdz'), [`$layers: $[${conf}]`, '', '## $complete skill', '$list: $[one]'].join('\n'))
    tab(['pick', '--skill='])
    expect(Object.keys(cache().files ?? {})).toContain(conf)
    writeFileSync(conf, ['$x: 1', '', '## $complete skill', '$list: $[zeta]'].join('\n'))
    expect(staleSettings(cache())).toBe(true)
    expect(tab(['pick', '--skill=z'])).toEqual(['--skill=zeta'])
  })
})
