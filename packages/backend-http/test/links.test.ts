/**
 * Сервис `links` (v1.54, link-resolver-spec §3–4): каскад слоёв, вытеснение по id,
 * `$off`, включения `$links`, доверие гостя, резолв `${}`, `exec`.
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as nrdModule from '@kerneldreams/nrd'
import { createLinksEngine, defaultLinkLayers, type LinksNrd } from '../src/links.js'

const nrd = nrdModule as unknown as LinksNrd
let root: string
let cwd: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'nr-links-')))
  cwd = join(root, 'work', 'repo', 'sub')
  await mkdir(cwd, { recursive: true })
  await mkdir(join(root, 'agents'), { recursive: true })
  await mkdir(join(root, 'users', 'alice'), { recursive: true })
  await mkdir(join(root, 'projects'), { recursive: true })
  await mkdir(join(root, 'work', 'repo', '.nr'), { recursive: true })
  // стенд: правило задачи, действие файла, торрент
  await writeFile(
    join(root, 'links.mdz'),
    [
      '## $link dev',
      "$pattern: 'DEV-\\d+'",
      '$kind: task',
      '',
      '## $action reveal-stand',
      '$for: file',
      '$title: Показать на стенде',
      '$run: host.reveal',
      '',
      '## $action torrent',
      '$for: magnet',
      '$title: В торрент',
      '$run: exec',
      '$cmd: \'echo add "${target}" on ${device.host}\'',
      '',
      '## $action zed',
      '$for: file',
      '$run: host.open',
    ].join('\n'),
  )
  // агент: перекрывает dev, снимает встроенное `zed` и действие стенда `zed`
  await writeFile(
    join(root, 'agents', 'chat.links.mdz'),
    ['## $link dev', "$pattern: 'DEV-\\d+'", '$kind: url', "$target: 'https://p/${text}'", "$label: 'задача ${text}'", '$icons: $[menu, expand]', '', '## $action zed', '$off: true'].join('\n'),
  )
  // пользователь: exec — у гостя пропадёт
  await writeFile(join(root, 'users', 'alice', 'links.mdz'), ['## $action notify', '$for: file', '$run: exec', '$cmd: echo ${basename(path)}'].join('\n'))
  // пространство: `.nr/links.mdz` вверх от cwd + `$links` реестра
  await writeFile(join(root, 'work', 'repo', '.nr', 'links.mdz'), ['$links: $[extra.mdz]', '## $link nas', "$pattern: 'nas:/\\S+'", '$kind: file'].join('\n'))
  await writeFile(join(root, 'work', 'repo', '.nr', 'extra.mdz'), ['## $action extra', '$for: nas', '$run: copy'].join('\n'))
  await writeFile(join(root, 'projects', 'dev.mdz'), ['$links: $[../space-links.mdz]'].join('\n'))
  input = { agent: 'chat', space: 'dev', cwd, user: 'alice' }
  await writeFile(join(root, 'space-links.mdz'), ['## $action space-copy', '$for: url', '$run: copy.link', '$title: Ссылка'].join('\n'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const engine = () => createLinksEngine({ nrd, hub: 'mini', layers: (input) => defaultLinkLayers(root, input, { nrd }) })
let input: { agent?: string; space: string; cwd: string; user: string }

describe('links: каскад', () => {
  it('сильный слой вытесняет одноимённое правило; $off снимает нижнее и встроенное', () => {
    const r = engine().rules(input)
    const dev = r.links.find((l) => l.id === 'dev')!
    expect(dev).toMatchObject({ layer: 'agent', kind: 'url', pattern: 'DEV-\\d+', label: 'задача ${text}', icons: ['menu', 'expand'] })
    expect(r.links.filter((l) => l.id === 'dev')).toHaveLength(1)
    expect(r.off).toContain('zed')
    expect(r.actions.map((a) => a.id).sort()).toEqual(['extra', 'notify', 'reveal-stand', 'space-copy', 'torrent'])
    expect(r.links.find((l) => l.id === 'nas')).toMatchObject({ layer: 'space', kind: 'file' })
    expect(r.layers.map((l) => l.layer)).toEqual(['agent', 'space', 'space', 'space', 'user', 'stand'])
    expect(r.trusted).toBe(true)
  })

  it('без агента — правило стенда', () => {
    const r = engine().rules({ ...input, agent: undefined })
    expect(r.links.find((l) => l.id === 'dev')).toMatchObject({ layer: 'stand', kind: 'task' })
    expect(r.off).toEqual([])
  })

  it('гость: exec пользовательского слоя выброшен, exec стенда остаётся', async () => {
    const e = engine()
    const r = e.rules(input, { trusted: false })
    expect(r.trusted).toBe(false)
    expect(r.actions.find((a) => a.id === 'notify')).toBeUndefined()
    expect(r.actions.find((a) => a.id === 'torrent')).toBeDefined()
    await expect(e.run({ action: 'notify', vars: { path: '/a/b.md' }, input, trusted: false })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('resolve: params сильнее, функции путей', () => {
    expect(engine().resolve(['${basename(path)}', '${dirname(path)}', '${ext(path)}', 'задача ${text}', '${device.host}'], { path: '/a/b/c.md', text: 'ABC-1', device: { host: 'air' } })).toEqual(['c.md', '/a/b', 'md', 'задача ABC-1', 'air'])
  })

  it('run exec: команда с ${} на хабе; dryRun — без исполнения; чужая машина — execOn', async () => {
    const vars = { target: 'magnet:?xt=1', device: { host: 'mini' }, path: '/x/y.txt' }
    const e = engine()
    expect(await e.run({ action: 'torrent', vars, input, dryRun: true })).toMatchObject({ command: 'echo add "magnet:?xt=1" on mini', where: 'mini' })
    expect(await e.run({ action: 'notify', vars, input })).toMatchObject({ code: 0, stdout: 'y.txt\n', where: 'mini' })
    const calls: string[] = []
    const remote = createLinksEngine({
      nrd,
      hub: 'mini',
      layers: (i) => defaultLinkLayers(root, i, { nrd }),
      execOn: async (w, cmd) => {
        calls.push(`${w}: ${cmd}`)
        return { code: 0, stdout: 'ok', stderr: '' }
      },
    })
    await writeFile(join(root, 'links.mdz'), ['## $action torrent', '$for: magnet', '$run: exec', '$where: ${device.host}', '$cmd: echo ${target}'].join('\n'))
    expect(await remote.run({ action: 'torrent', vars: { ...vars, device: { host: 'air' } }, input })).toMatchObject({ where: 'air', stdout: 'ok' })
    expect(calls).toEqual(['air: echo magnet:?xt=1'])
  })

  it('агент: $links из %meta агента и соседний файл агента пространства', async () => {
    await mkdir(join(root, 'projects', 'dev', 'agents'), { recursive: true })
    await writeFile(join(root, 'projects', 'dev', 'agents', 'pm.mds'), "%meta {name: 'pm', links: ['pm-extra.mdz']}\n%system\nты pm\n")
    await writeFile(join(root, 'projects', 'dev', 'agents', 'pm-extra.mdz'), '## $action pm-act\n$for: file\n$run: copy\n')
    await writeFile(join(root, 'projects', 'dev', 'agents', 'pm.links.mdz'), "## $link pmdev\n$pattern: 'PM-\\d+'\n")
    const r = engine().rules({ agent: 'pm', space: 'dev' })
    expect(r.actions.find((a) => a.id === 'pm-act')).toMatchObject({ layer: 'agent' })
    expect(r.links.find((l) => l.id === 'pmdev')).toMatchObject({ layer: 'agent' })
  })

  it('files: все файлы слоёв (и несуществующие)', () => {
    const fs = engine().files(input)
    expect(fs).toContain(join(root, 'agents', 'chat.links.mdz'))
    expect(fs).toContain(join(root, 'work', 'repo', 'sub', '.nr', 'links.mdz'))
    expect(fs).toContain(join(root, 'space-links.mdz'))
  })
})
