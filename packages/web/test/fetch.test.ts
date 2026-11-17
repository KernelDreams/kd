import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchTransport } from '../src/transport/fetch.js'
import { asText } from '../src/decode.js'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchTransport', () => {
  it('delivers a GET and returns status + Uint8Array body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new TextEncoder().encode('pong'), {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      ),
    )
    const r = await fetchTransport().deliver({ method: 'GET', url: 'https://x/ping' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.status).toBe(200)
      expect(r.value.body).toBeInstanceOf(Uint8Array)
      expect(asText(r.value)).toBe('pong')
      expect(r.value.headers['content-type']).toBe('text/plain')
    }
  })

  it('sends a string body and echoes request bytes out', async () => {
    const seen: { url?: string; init?: RequestInit } = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        seen.url = url
        seen.init = init
        return new Response(new Uint8Array([1, 2, 3]), { status: 201 })
      }),
    )
    const r = await fetchTransport().deliver({
      method: 'POST',
      url: 'https://x/echo',
      headers: { 'x-a': '1' },
      body: 'hello',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.status).toBe(201)
      expect(Array.from(r.value.body)).toEqual([1, 2, 3])
    }
    expect(seen.url).toBe('https://x/echo')
    expect(seen.init?.method).toBe('POST')
    expect(seen.init?.body).toBe('hello')
  })

  it('network failure → err(Error), not a throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const r = await fetchTransport().deliver({ method: 'GET', url: 'https://x/down' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toContain('ECONNREFUSED')
  })
})

describe('fetchTransport options', () => {
  it('without options passes neither redirect nor signal (bare fetch semantics)', async () => {
    let seen: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init
        return new Response('ok')
      }),
    )
    await fetchTransport().deliver({ method: 'GET', url: 'https://x/' })
    expect(seen?.redirect).toBeUndefined()
    expect(seen?.signal).toBeUndefined()
  })

  it('redirect: manual is passed through and the 3xx comes back with location', async () => {
    let seen: RequestInit | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init
        return new Response(null, { status: 302, headers: { location: 'https://y/' } })
      }),
    )
    const r = await fetchTransport({ redirect: 'manual' }).deliver({ method: 'GET', url: 'https://x/' })
    expect(seen?.redirect).toBe('manual')
    expect(r.ok && r.value.status).toBe(302)
    expect(r.ok && r.value.headers.location).toBe('https://y/')
  })

  it('maxBytes: body over the limit → err BodyTooLargeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(64))))
    const r = await fetchTransport({ maxBytes: 16 }).deliver({ method: 'GET', url: 'https://x/big' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('BodyTooLargeError')
  })

  it('maxBytes: declared content-length over the limit fails before reading', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('tiny', { headers: { 'content-length': '999999' } })),
    )
    const r = await fetchTransport({ maxBytes: 1000 }).deliver({ method: 'GET', url: 'https://x/liar' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('BodyTooLargeError')
  })

  it('maxBytes: body within the limit is read whole', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]))))
    const r = await fetchTransport({ maxBytes: 4 }).deliver({ method: 'GET', url: 'https://x/ok' })
    expect(r.ok && Array.from(r.value.body)).toEqual([1, 2, 3, 4])
  })

  it('timeoutMs: a hanging fetch → err TimeoutError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          }),
      ),
    )
    const r = await fetchTransport({ timeoutMs: 20 }).deliver({ method: 'GET', url: 'https://x/hang' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('TimeoutError')
  })

  it('signal: external abort → err AbortError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason))
          }),
      ),
    )
    const controller = new AbortController()
    const pending = fetchTransport({ signal: controller.signal, timeoutMs: 5_000 }).deliver({ method: 'GET', url: 'https://x/' })
    controller.abort()
    const r = await pending
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.name).toBe('AbortError')
  })
})
