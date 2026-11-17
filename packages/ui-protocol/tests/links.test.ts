import { describe, expect, it } from 'vitest'
import { canExternalLocate, canHostOpenOn, canLinks, hostByHome, type ExternalHostInfo } from '../src/index.js'

const hosts: ExternalHostInfo[] = [
  { name: 'mini', hub: true, state: 'ok', home: ['/Users/build'] },
  { name: 'air', state: 'ok', home: ['/Users/user'] },
  { name: 'pc', state: 'ok', home: ['C:\\', 'D:/'] },
  { name: 'laptop', state: 'ok', home: ['D:\\'] },
]

describe('hostByHome (v1.54, link-resolver-spec §6 п.3)', () => {
  it('путь под маской — её машина', () => {
    expect(hostByHome(hosts, '/Users/user/Lifelog/a.md')).toBe('air')
    expect(hostByHome(hosts, '/Users/build/x')).toBe('mini')
    expect(hostByHome(hosts, 'c:/Users/x.txt')).toBe('pc')
  })
  it('нет маски — null; маска не префикс сегмента', () => {
    expect(hostByHome(hosts, '/tmp/a.md')).toBeNull()
    expect(hostByHome(hosts, '/Users/user2/a.md')).toBeNull()
  })
  it('равные маски у двух машин — null (решает locate)', () => {
    expect(hostByHome(hosts, 'D:\\work\\a.txt')).toBeNull()
  })
})

describe('гейты v1.54', () => {
  it('locate, действия на машине, сервис links', () => {
    expect(canExternalLocate({ files: { external: true, locate: true } })).toBe(true)
    expect(canExternalLocate({ files: { external: true } })).toBe(false)
    const caps = { files: { external: true as const, host: 'mini' }, host: { open: true, apps: ['zed'], on: ['air'] } }
    expect(canHostOpenOn(caps, undefined)).toBe(true)
    expect(canHostOpenOn(caps, 'mini')).toBe(true)
    expect(canHostOpenOn(caps, 'air', 'zed')).toBe(true)
    expect(canHostOpenOn(caps, 'erin')).toBe(false)
    expect(canLinks({ services: { links: { methods: ['rules', 'resolve'] } } })).toBe(true)
    expect(canLinks({ services: {} })).toBe(false)
  })
})
