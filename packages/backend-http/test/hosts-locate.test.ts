/**
 * v1.54 (link-resolver-spec §6): `locate` по всем хостам, маски `$home` в `hostsInfo`,
 * действия хоста на машине устройства `{host, on}` — на месте, по монтированию, скачать.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bootstrapCode } from '@kerneldreams/host-agent'
import { createExternalHost } from '../src/external.js'
import { createHostsRouter, createRemoteHost, mountedPaths, parseMounts, type RemoteHost } from '../src/remote-host.js'

let hub: string
let air: string
let shared: string
const hosts: RemoteHost[] = []

beforeEach(async () => {
  hub = await realpath(await mkdtemp(join(tmpdir(), 'nr-loc-hub-')))
  air = await realpath(await mkdtemp(join(tmpdir(), 'nr-loc-air-')))
  shared = await realpath(await mkdtemp(join(tmpdir(), 'nr-loc-shared-')))
  await writeFile(join(hub, 'h.md'), 'hub\n')
  await mkdir(join(air, 'Lifelog'))
  await writeFile(join(air, 'Lifelog', 'a.md'), 'air\n')
  await writeFile(join(shared, 'both.md'), 'both\n')
})
afterEach(async () => {
  for (const h of hosts.splice(0)) h.close()
  for (const d of [hub, air, shared]) await rm(d, { recursive: true, force: true })
})

// `os` — платформа, которую агент назовёт в hello: «air» — macOS на любом хосте прогона (на Linux тест был красным).
const agentAt = (home: string, os?: NodeJS.Platform) => (): ChildProcess =>
  spawn(process.execPath, ['-e', (os ? `Object.defineProperty(process, 'platform', { value: ${JSON.stringify(os)} });` : '') + bootstrapCode()], { env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ['pipe', 'pipe', 'pipe'] })

function router() {
  const airHost = createRemoteHost({ name: 'air', os: 'darwin', home: [air], aliases: ['air.local'] }, { spawn: agentAt(air, 'darwin') })
  const hubAgent = createRemoteHost({ name: 'mini' }, { spawn: agentAt(hub) })
  hosts.push(airHost, hubAgent)
  return createHostsRouter(createExternalHost({ home: hub, hostOpen: true, hostName: 'mini', exec: async () => {} }), [airHost], { hubHome: [hub], hubAgent: () => hubAgent })
}

describe('mount', () => {
  it('parseMounts: smb и nfs, шара без ведущего /', () => {
    const out = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '//alice@mini._smb._tcp.local/smith on /Volumes/smith (smbfs, nodev, nosuid, mounted by alice)',
      'erin:/home/pv on /Volumes/erin (nfs, asynchronous)',
    ].join('\n')
    expect(parseMounts(out)).toEqual([
      { server: 'mini._smb._tcp.local', share: 'smith', at: '/Volumes/smith' },
      { server: 'erin', share: 'home/pv', at: '/Volumes/erin' },
    ])
  })
  it('mountedPaths: хвост шары в пути источника → путь у устройства', () => {
    const mounts = parseMounts('//d@mini._smb._tcp.local/smith on /Volumes/smith (smbfs)\nerin:/home/pv on /Volumes/erin (nfs)')
    expect(mountedPaths('/Users/smith/Studio/a.md', mounts, ['mini'])).toEqual(['/Volumes/smith/Studio/a.md'])
    expect(mountedPaths('/home/pv/x', mounts, ['erin'])).toEqual(['/Volumes/erin/x'])
    expect(mountedPaths('/Users/other/a.md', mounts, ['mini'])).toEqual([])
    expect(mountedPaths('/Users/smith/a.md', mounts, ['air'])).toEqual([])
  })
})

describe('роутер v1.54', () => {
  it('hostsInfo несёт home, locate — все машины с файлом, host.on — macOS', async () => {
    const r = router()
    await r.probe()
    const caps = r.capability()
    expect(caps.files.locate).toBe(true)
    expect(caps.files.hostsInfo?.map((h) => [h.name, h.home])).toEqual([
      ['mini', [hub]],
      ['air', [air]],
    ])
    expect(caps.host?.on).toEqual(['air'])
    expect((await r.locate(join(air, 'Lifelog', 'a.md'))).map((s) => s.host)).toEqual(['mini', 'air'])
    expect((await r.locate(join(shared, 'both.md'))).map((s) => s.host)).toEqual(['mini', 'air'])
    expect(await r.locate(join(shared, 'nope.md'))).toEqual([])
  })

  it('открыть на машине устройства: свой файл — на месте; файл хаба без монтирования — копия в ~/Downloads/nr/mini', async () => {
    const r = router()
    const own = await r.host!.reveal(join(air, 'Lifelog', 'a.md'), { host: 'air', on: 'air', dryRun: true })
    expect(own).toMatchObject({ on: 'air', via: 'direct', cmd: 'open', args: ['-R', join(air, 'Lifelog', 'a.md')] })
    const far = await r.host!.open(join(hub, 'h.md'), { on: 'air', app: 'zed', dryRun: true })
    expect(far).toMatchObject({ on: 'air', via: 'download', path: join(air, 'Downloads', 'nr', 'mini', 'h.md'), args: ['-a', 'Zed', join(air, 'Downloads', 'nr', 'mini', 'h.md')] })
  })

  it('скачать на устройство по-настоящему (open — заглушкой через exec агента)', async () => {
    const r = router()
    const airHost = r.remotes.get('air')!
    const calls: string[][] = []
    const realExec = airHost.exec.bind(airHost)
    ;(airHost as { exec: RemoteHost['exec'] }).exec = async (cmd, args, o) => {
      if (cmd === 'open') {
        calls.push(args)
        return { code: 0, stdout: '', stderr: '' }
      }
      return realExec(cmd, args, o)
    }
    const res = await r.host!.open(join(hub, 'h.md'), { on: 'air' })
    expect(res.via).toBe('download')
    expect(calls).toEqual([[join(air, 'Downloads', 'nr', 'mini', 'h.md')]])
    const st = await airHost.files.stat(join(air, 'Downloads', 'nr', 'mini', 'h.md'))
    expect(st.exists).toBe(true)
  })

  it('машина не macOS или чужая — отказ', async () => {
    const r = router()
    await expect(r.host!.reveal(join(hub, 'h.md'), { on: 'erin', dryRun: true })).rejects.toMatchObject({ code: 'not_found' })
  })
})
