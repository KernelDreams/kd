import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  NORM_V,
  normText,
  textHash,
  toF16Bytes,
  fromF16Bytes,
  memoryEmbedStore,
  cachedEmbed,
  type Embedder,
} from '../../src/web/embed.js'
import { openaiProvider } from '../../src/web/llm/openai.js'
import { ollamaProvider } from '../../src/web/llm/ollama.js'
import { anthropicProvider } from '../../src/web/llm/anthropic.js'
import { LLMError } from '../../src/web/llm/errors.js'
import { ok, err } from '../../src/infra/result.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** Детерминированный «эмбед»: 768 значений ~N(0, 1/√768), нормированный. */
function vec768(seed = 1): Float32Array {
  let s = seed
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  const v = new Float32Array(768)
  for (let i = 0; i < v.length; i++) {
    // Box–Muller
    v[i] = Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd())
  }
  const n = Math.hypot(...v)
  for (let i = 0; i < v.length; i++) v[i] /= n
  return v
}

const cos = (a: Float32Array, b: Float32Array) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] ** 2; nb += b[i] ** 2 }
  return d / Math.sqrt(na * nb)
}

describe('normText', () => {
  it('NORM_V = 1', () => expect(NORM_V).toBe(1))

  it('CRLF/CR → LF, trim', () => {
    expect(normText('  a\r\nb\rc  \n')).toBe('a\nb\nc')
  })

  it('пробельные прогоны внутри строки → один пробел, хвост срезан', () => {
    expect(normText('a \t  b  c   \nd')).toBe('a b c\nd')
  })

  it('2+ пустые строки → одна; одна пустая остаётся', () => {
    expect(normText('a\n\nb')).toBe('a\n\nb')
    expect(normText('a\n\n\n\nb')).toBe('a\n\nb')
    expect(normText('a\n  \n \t \n\nb')).toBe('a\n\nb')
  })

  it('идемпотентна', () => {
    const t = ' x  y\r\n\r\n\r\n z '
    expect(normText(normText(t))).toBe(normText(t))
  })
})

describe('textHash', () => {
  it('hex sha256 нормализованного текста', async () => {
    // sha256('abc')
    expect(await textHash('  abc \r\n')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('варианты одного текста — один хеш', async () => {
    expect(await textHash('Генки  хаотичная\r\nдевочка')).toBe(await textHash('Генки хаотичная\nдевочка '))
  })
})

describe('f16', () => {
  const check = (to: typeof toF16Bytes, from: typeof fromF16Bytes) => {
    const v = vec768()
    const bytes = to(v)
    expect(bytes.byteLength).toBe(768 * 2)
    const back = from(bytes)
    expect(back.length).toBe(768)
    for (let i = 0; i < v.length; i++) {
      // относительная точность half ≈ 2^-11 (+ субнормали около нуля)
      expect(Math.abs(back[i] - v[i])).toBeLessThanOrEqual(Math.abs(v[i]) * 2 ** -11 + 2 ** -24)
    }
    expect(cos(v, back)).toBeGreaterThanOrEqual(0.9999)
    // спецзначения
    const sp = from(to(Float32Array.from([0, -0, 1, -2, 65504, 1e6, 1e-8, 5.960464477539063e-8])))
    expect([...sp]).toEqual([0, -0, 1, -2, 65504, Infinity, 0, 5.960464477539063e-8])
    // невыровненный вход
    const shifted = new Uint8Array(bytes.byteLength + 1)
    shifted.set(bytes, 1)
    expect(from(shifted.subarray(1))).toEqual(back)
  }

  it('roundtrip (нативный путь, если есть Float16Array)', () => check(toF16Bytes, fromF16Bytes))

  it('roundtrip (ручная конверсия) — байты совпадают с нативными', async () => {
    const native = toF16Bytes(vec768(7))
    vi.stubGlobal('Float16Array', undefined)
    vi.resetModules()
    // модуль фиксирует путь при загрузке: этот экземпляр — ручная конверсия
    const m = await import('../../src/web/embed.js')
    check(m.toF16Bytes, m.fromF16Bytes)
    expect(m.toF16Bytes(vec768(7))).toEqual(native)
  })

  it('нечётная длина — ошибка', () => {
    expect(() => fromF16Bytes(new Uint8Array(3))).toThrow(/нечётная/)
  })
})

describe('cachedEmbed', () => {
  const fake = (dim = 4) => {
    const calls: string[][] = []
    const embedder: Embedder = async (input) => {
      calls.push(input)
      return ok({ vectors: input.map((t) => Float32Array.from({ length: dim }, (_, i) => t.length + i)) })
    }
    return { calls, embedder }
  }

  it('вектора в порядке входа, дубли считаются один раз, повтор — из стора', async () => {
    const store = memoryEmbedStore()
    const { calls, embedder } = fake()
    const progress: [number, number][] = []
    const texts = ['aa', 'b', ' aa ', 'ccc']
    const r = await cachedEmbed(texts, { space: 'embed/x', store, embedder, onProgress: (d, t) => progress.push([d, t]) })
    expect(r.map((v) => v[0])).toEqual([2, 1, 2, 3])
    expect(r[0]).toBe(r[2])
    expect(calls).toEqual([['aa', 'b', 'ccc']])
    expect(progress).toEqual([[3, 3]])

    const again = vi.fn()
    const r2 = await cachedEmbed(texts, { space: 'embed/x', store, embedder, onProgress: again })
    expect(calls).toHaveLength(1)
    expect(again).not.toHaveBeenCalled()
    expect(r2.map((v) => v[0])).toEqual([2, 1, 2, 3])
  })

  it('пачки по batch; падение на середине — оплаченное сохранено', async () => {
    const store = memoryEmbedStore()
    let n = 0
    const embedder: Embedder = async (input) => {
      if (++n === 2) return err(new Error('boom'))
      return ok({ vectors: input.map(() => new Float32Array(4)) })
    }
    await expect(
      cachedEmbed(['a', 'b', 'c', 'd', 'e'], { space: 's', store, embedder, batch: 2 }),
    ).rejects.toThrow('boom')
    expect((await store.stat('s')).count).toBe(2)

    const { calls, embedder: e2 } = fake()
    const progress: [number, number][] = []
    await cachedEmbed(['a', 'b', 'c', 'd', 'e'], { space: 's', store, embedder: e2, batch: 2, onProgress: (d, t) => progress.push([d, t]) })
    expect(calls).toEqual([['c', 'd'], ['e']])
    expect(progress).toEqual([[2, 3], [3, 3]])
  })

  it('пустой после нормализации текст → ошибка с индексом', async () => {
    const { embedder } = fake()
    await expect(
      cachedEmbed(['a', ' \r\n\t '], { space: 's', store: memoryEmbedStore(), embedder }),
    ).rejects.toThrow(/texts\[1\]/)
  })

  it('разная размерность в ответе / со стором → ошибка с именем space', async () => {
    const mixed: Embedder = async (input) =>
      ok({ vectors: input.map((_, i) => new Float32Array(i ? 3 : 4)) })
    await expect(
      cachedEmbed(['a', 'b'], { space: 'embed/mix', store: memoryEmbedStore(), embedder: mixed }),
    ).rejects.toThrow(/embed\/mix.*размерность 3/)

    const store = memoryEmbedStore()
    await cachedEmbed(['a'], { space: 'embed/g', store, embedder: fake(4).embedder })
    await expect(
      cachedEmbed(['z'], { space: 'embed/g', store, embedder: fake(8).embedder }),
    ).rejects.toThrow(/embed\/g.*размерность 8.*4/)
  })

  it('число векторов ≠ числу входов → ошибка', async () => {
    const short: Embedder = async () => ok({ vectors: [new Float32Array(2)] })
    await expect(
      cachedEmbed(['a', 'b'], { space: 's', store: memoryEmbedStore(), embedder: short }),
    ).rejects.toThrow(/1 векторов на 2/)
  })
})

describe('provider.embed', () => {
  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    ({ status, headers: new Headers(headers), text: async () => JSON.stringify(body) }) as unknown as Response

  it('openai: POST {base}/embeddings, порядок по index', async () => {
    const fetchMock = vi.fn(async () =>
      reply(200, {
        model: 'google/gemini-embedding-001',
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const p = openaiProvider({ baseUrl: 'http://gw/v1/', apiKey: 'test-key-1' })
    const r = await p.embed!({ model: 'embed/gemini', input: ['a', 'b'] })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://gw/v1/embeddings')
    expect(JSON.parse(String(init.body))).toEqual({ model: 'embed/gemini', input: ['a', 'b'] })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key-1')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.vectors.map((v) => [...v])).toEqual([[1, 0], [0, 1]])
      expect(r.value.vectors[0]).toBeInstanceOf(Float32Array)
      expect(r.value.model).toBe('google/gemini-embedding-001')
    }
  })

  it('openai: картинки — то же тело с modality: image', async () => {
    const fetchMock = vi.fn(async () => reply(200, { data: [{ index: 0, embedding: [1, 0] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await openaiProvider({ baseUrl: 'http://gw/v1', apiKey: 'k' }).embed!({ model: 'embed/siglip', input: ['data:image/jpeg;base64,AA'], modality: 'image' })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ model: 'embed/siglip', input: ['data:image/jpeg;base64,AA'], modality: 'image' })
    expect(r.ok).toBe(true)
  })

  it('openai: число векторов ≠ входов → err', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(200, { data: [{ index: 0, embedding: [1] }] })))
    const r = await openaiProvider({ baseUrl: 'http://gw/v1', apiKey: 'k' }).embed!({ model: 'm', input: ['a', 'b'] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.message).toMatch(/1 векторов на 2/)
  })

  it('openai: HTTP-ошибка → LLMError с кодом и retryAfter', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(429, { error: { message: 'slow down' } }, { 'retry-after': '7' })))
    const r = await openaiProvider({ baseUrl: 'http://gw/v1', apiKey: 'k' }).embed!({ model: 'm', input: ['a'] })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toBeInstanceOf(LLMError)
      const e = r.error as LLMError
      expect(e.code).toBe('rate_limit')
      expect(e.retryAfter).toBe(7)
      expect(e.message).toBe('slow down')
    }
  })

  it('ollama: /v1/embeddings от корня хоста', async () => {
    const fetchMock = vi.fn(async () => reply(200, { data: [{ index: 0, embedding: [0.5] }] }))
    vi.stubGlobal('fetch', fetchMock)
    for (const baseUrl of ['http://mac:11434', 'http://mac:11434/v1', 'http://mac:11434/api/']) {
      const r = await ollamaProvider({ baseUrl, apiKey: '' }).embed!({ model: 'nomic', input: ['a'] })
      expect(r.ok).toBe(true)
    }
    expect(fetchMock.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      'http://mac:11434/v1/embeddings',
      'http://mac:11434/v1/embeddings',
      'http://mac:11434/v1/embeddings',
    ])
  })

  it('anthropic — без embed', () => {
    expect(anthropicProvider({ baseUrl: 'http://x', apiKey: 'k' }).embed).toBeUndefined()
  })
})
