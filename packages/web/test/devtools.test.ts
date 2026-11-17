import { describe, it, expect, vi } from 'vitest'

// Mock the CDP client so listen() runs against a fake connection.
vi.mock('../src/chrome/cdp-client.js', () => {
  function fakeClient() {
    return {
      async send(method: string) {
        if (method === 'Network.getResponseBody') {
          return { body: '{"ok":1}', base64Encoded: false }
        }
        return {}
      },
      on(method: string, fn: (params: any) => void) {
        if (method === 'Network.requestWillBeSent') {
          fn({
            requestId: 'r1',
            request: {
              method: 'POST',
              url: 'https://api.site/graphql',
              headers: { 'content-type': 'application/json' },
              postData: '{"q":1}',
            },
            type: 'XHR',
          })
        }
        if (method === 'Network.responseReceived') {
          fn({
            requestId: 'r1',
            response: { status: 200, headers: { 'content-type': 'application/json' } },
          })
        }
      },
      close() {},
    }
  }
  return {
    connectTab: async () => ({ ok: true, value: { client: fakeClient(), tab: {} } }),
    tabInfos: async () => ({ ok: true, value: [] }),
  }
})

import { devtools } from '../src/devtools/devtools.js'

describe('devtools.listen', () => {
  it('captures request AND response with bodies, returns objects (not TOON)', async () => {
    const r = await devtools().listen({ port: 9333, seconds: 0, filter: 'graphql' })
    expect(r.ok).toBe(true)
    if (!r.ok) return

    const caps = r.value
    expect(Array.isArray(caps)).toBe(true)
    expect(typeof caps).not.toBe('string') // not a TOON string
    expect(caps.length).toBe(1)

    const c = caps[0]
    expect(typeof c).toBe('object')
    expect(c.method).toBe('POST')
    expect(c.url).toContain('graphql')
    expect(c.requestHeaders['content-type']).toBe('application/json')
    expect(c.requestBody).toBe('{"q":1}')
    expect(c.status).toBe(200)
    expect(c.responseHeaders?.['content-type']).toBe('application/json')
    expect(c.responseBody).toContain('ok')
  })

  it('filter excludes non-matching requests', async () => {
    const r = await devtools().listen({ port: 9333, seconds: 0, filter: 'nomatch' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.length).toBe(0)
  })
})
