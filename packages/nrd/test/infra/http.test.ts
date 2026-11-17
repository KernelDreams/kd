import { describe, it, expect, vi, afterEach } from 'vitest'
import { httpGet, httpPost, type HttpResponse } from '../../src/web/http.js'
import { isOk, isErr } from '../../src/infra/result.js'

function mockResponse(status: number, body: string, headers: Record<string, string> = {}) {
  return {
    status,
    headers: new Headers(headers),
    text: async () => body,
  } as unknown as Response
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('http', () => {
  it('успешный GET → ok с body и статусом', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, 'hello', { 'x-test': '1' })))
    const r = await httpGet('http://x/')
    expect(isOk(r)).toBe(true)
    if (isOk(r)) {
      expect(r.value.status).toBe(200)
      expect(r.value.body).toBe('hello')
      expect(r.value.headers['x-test']).toBe('1')
    }
  })

  it('json() возвращает Result, не throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, '{"a":1}')))
    const r = await httpGet('http://x/')
    if (!isOk(r)) throw new Error('expected ok')
    const parsed = r.value.json<{ a: number }>()
    expect(isOk(parsed)).toBe(true)
    if (isOk(parsed)) expect(parsed.value.a).toBe(1)
  })

  it('json() на невалидном JSON → err', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mockResponse(200, 'not json')))
    const r = await httpGet('http://x/')
    if (!isOk(r)) throw new Error('expected ok')
    expect(isErr(r.value.json())).toBe(true)
  })

  it('retry на 5xx, затем успех', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(503, 'down'))
      .mockResolvedValueOnce(mockResponse(200, 'up'))
    vi.stubGlobal('fetch', fetchMock)
    const r = await httpGet('http://x/', { retries: 1, retryDelay: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(isOk(r)).toBe(true)
    if (isOk(r)) expect(r.value.status).toBe(200)
  })

  it('НЕ retry на 4xx', async () => {
    const fetchMock = vi.fn(async () => mockResponse(404, 'nope'))
    vi.stubGlobal('fetch', fetchMock)
    const r = await httpGet('http://x/', { retries: 3, retryDelay: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    if (isOk(r)) expect(r.value.status).toBe(404)
  })

  it('retry на network error', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(mockResponse(200, 'ok'))
    vi.stubGlobal('fetch', fetchMock)
    const r = await httpGet('http://x/', { retries: 1, retryDelay: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(isOk(r)).toBe(true)
  })

  it('network error без retry → err', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    const r = await httpGet('http://x/')
    expect(isErr(r)).toBe(true)
  })

  it('timeout → err (AbortError)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            const e = new Error('aborted')
            e.name = 'AbortError'
            reject(e)
          })
        })
      }),
    )
    const r = await httpGet('http://x/', { timeout: 10 })
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error.message).toContain('timed out')
  })

  it('POST сериализует объект в JSON и ставит Content-Type', async () => {
    const fetchMock = vi.fn(async () => mockResponse(200, 'ok'))
    vi.stubGlobal('fetch', fetchMock)
    await httpPost('http://x/', { a: 1 })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"a":1}')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })
  it('timeout действует и на чтение body: заголовки пришли, тело зависло → err timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>((resolve) => setTimeout(() => resolve('late'), 60)),
    }) as unknown as Response))
    const r = await httpGet('http://x/', { timeout: 5 })
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error.message).toMatch(/timed out/)
  })

  it('обрыв body после заголовков → err, не reject', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      status: 200,
      headers: new Headers(),
      text: async () => { throw new Error('body connection reset') },
    }) as unknown as Response))
    const r = await httpPost('http://x/', { a: 1 })
    expect(isErr(r)).toBe(true)
    if (isErr(r)) expect(r.error.message).toBe('body connection reset')
  })

  it('несериализуемый POST-body → err до fetch', async () => {
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    const r = await httpPost('http://x/', cyc)
    expect(isErr(r)).toBe(true)
    expect(f).not.toHaveBeenCalled()
  })
})
