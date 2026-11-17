import { describe, expect, it } from 'vitest'
import {
  canExternalFiles,
  canExternalSearch,
  canExternalWatch,
  canExternalWrite,
  canExternalDisk,
  externalHosts,
  externalHostsInfo,
  isHubHost,
  parseExternalEvent,
  serializeExternalEvent,
} from '../src/index.js'

describe('files.external v1.42 (ABC-415)', () => {
  it('под-флаги: без external ничего', () => {
    expect(canExternalWrite({ files: { write: true } })).toBe(false)
    expect(canExternalFiles({ files: { external: true } })).toBe(true)
    const caps = { files: { external: true, write: true, search: true } }
    expect(canExternalWrite(caps)).toBe(true)
    expect(canExternalSearch(caps)).toBe(true)
    expect(canExternalWatch(caps)).toBe(false)
  })

  it('хосты: заявленные, иначе свой', () => {
    expect(externalHosts(null)).toEqual([])
    expect(externalHosts({ files: { external: true } })).toEqual([''])
    expect(externalHosts({ files: { external: true, host: 'mini' } })).toEqual(['mini'])
    expect(externalHosts({ files: { external: true, host: 'mini', hosts: ['mini', 'linux'] } })).toEqual(['mini', 'linux'])
    const caps = { files: { external: true, host: 'mini' } }
    expect(isHubHost(caps, undefined)).toBe(true)
    expect(isHubHost(caps, 'mini')).toBe(true)
    expect(isHubHost(caps, 'linux')).toBe(false)
  })

  it('v1.45: хосты со связью — заявленные, иначе из hosts (хаб ok, прочие unknown); disk под флагом', () => {
    expect(externalHostsInfo({ files: { external: true, host: 'mini', hosts: ['mini', 'erin'] } })).toEqual([
      { name: 'mini', hub: true, state: 'ok' },
      { name: 'erin', state: 'unknown' },
    ])
    const info = [{ name: 'mini', hub: true, state: 'ok' as const }, { name: 'erin', os: 'linux', state: 'off' as const, reason: 'ssh: timeout' }]
    expect(externalHostsInfo({ files: { external: true, host: 'mini', hosts: ['mini', 'erin'], hostsInfo: info } })).toEqual(info)
    expect(canExternalDisk({ files: { external: true, disk: true } })).toBe(true)
    expect(canExternalDisk({ files: { disk: true } })).toBe(false)
  })

  it('кадр слежения туда-обратно, чужой — null', () => {
    const ev = { type: 'external_update' as const, host: 'mini', paths: ['/a/b', ''] }
    expect(parseExternalEvent(serializeExternalEvent(ev))).toEqual(ev)
    expect(parseExternalEvent('event: workspace_update\ndata: {"type":"workspace_update","paths":[]}\n\n')).toBeNull()
    expect(parseExternalEvent('data: {bad')).toBeNull()
  })
})
