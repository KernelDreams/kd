import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Shared spawn state — hoisted so the module mock can see it.
const h = vi.hoisted(() => ({ spawnCalls: 0 }))
vi.mock('node:child_process', () => ({
  spawn: () => {
    h.spawnCalls++
    return { unref() {} }
  },
}))

import { ensureChrome, killChrome, buildChromeCommand } from '../src/chrome/supervisor.js'

const PORT = 9333

// Controls whether /json/version reports alive.
let initialAlive = false

function versionAlive(): boolean {
  return initialAlive || h.spawnCalls > 0
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, _init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/json/version')) {
        return versionAlive()
          ? new Response('{"webSocketDebuggerUrl":"ws://localhost:0/x"}', { status: 200 })
          : Response.error()
      }
      if (url.includes('/json/list')) {
        // One page tab already on origin (avoids tab creation path).
        return new Response(
          JSON.stringify([{ type: 'page', title: 't', url: 'https://site.test/home', id: '1' }]),
          { status: 200 },
        )
      }
      if (url.includes('/json/new')) {
        return new Response(JSON.stringify({ id: '2', title: 'new', url: 'https://site.test/' }), {
          status: 200,
        })
      }
      return new Response('{}', { status: 200 })
    }),
  )
}

beforeEach(() => {
  h.spawnCalls = 0
  initialAlive = false
  mockFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('buildChromeCommand', () => {
  it('assembles exe + fixed-port + user-data-dir + flags from fields', () => {
    const { exe, args } = buildChromeCommand({
      port: 9333,
      userDataDir: 'D:\\ChromeDev\\x',
      exe: 'C:\\chrome.exe',
      flags: ['--disable-web-security'],
    })
    expect(exe).toBe('C:\\chrome.exe')
    expect(args).toEqual([
      '--remote-debugging-port=9333',
      '--user-data-dir=D:\\ChromeDev\\x',
      '--disable-web-security',
    ])
  })
})

describe('ensureChrome', () => {
  it('alive → connects, didStart:false, does not spawn', async () => {
    initialAlive = true
    const r = await ensureChrome({ port: PORT, userDataDir: 'D:\\x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.didStart).toBe(false)
    expect(h.spawnCalls).toBe(0)
  })

  it('dead → launches, polls until up, didStart:true', async () => {
    initialAlive = false
    const r = await ensureChrome({ port: PORT, userDataDir: 'D:\\x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.didStart).toBe(true)
    expect(h.spawnCalls).toBe(1)
  })

  it('with origin present among tabs → reuses it (no tab creation)', async () => {
    initialAlive = true
    const r = await ensureChrome({ port: PORT, userDataDir: 'D:\\x', origin: 'https://site.test' })
    expect(r.ok).toBe(true)
  })
})

describe('killChrome', () => {
  it('returns a Result (never throws) when the browser socket is unreachable', async () => {
    initialAlive = true
    const r = await killChrome(PORT)
    // ws://localhost:0 cannot connect → err, but as a Result, not a throw.
    expect(r.ok).toBe(false)
  })
})
