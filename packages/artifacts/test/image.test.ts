// capability image (image-gen-2-spec §9): провайдеры контракта у хоста, гость
// видит только имена/модели/схему, события генерации — канал `image`, байты — `/i/<key>/…`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { byteRange, createArtifactHost } from '../src/host.js'
import type { ArtifactHost, ImageProviderLike, ImageWireEvent } from '../src/host.js'
import { checkAccess, checkArtifact, parseManifest } from '../src/index.js'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
const env = { artifactDir: '/ws/.nr/artifacts/a', dataDir: '/data/a', workspace: '/ws', selected: new Set<string>() }
const manifest = (text: string) => {
  const r = parseManifest(text)
  if (!r.ok) throw new Error(r.error)
  return r.value
}

describe('права image', () => {
  it('без $uses: image — отказ; image.save — $fs-write + {workspace}', () => {
    expect(checkAccess(manifest('$title: A\n$uses: $[file]\n'), 'image.generate', [], env)).toEqual({ ok: false, error: 'capability not declared: image' })
    expect(checkAccess(manifest('$title: A\n$uses: $[image]\n'), 'image.models', ['x'], env)).toEqual({ ok: true })
    expect(checkAccess(manifest('$title: A\n$uses: $[image]\n'), 'image.save', ['g1', 0, 'gen/a.png'], env)).toEqual({ ok: true, path: '/ws/gen/a.png' })
    expect(checkAccess(manifest('$title: A\n$uses: $[image]\n'), 'image.save', ['g1', 0, '/etc/a.png'], env)).toMatchObject({ ok: false })
  })

  it('статическая проверка: __host.image без $uses: image — ошибка', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifacts-image-check-'))
    try {
      writeFileSync(join(dir, 'meta.mdz'), '$title: A\n$uses: $[file]\n')
      writeFileSync(join(dir, 'index.html'), '<!doctype html><script>__host.image.generate("bfl", {model: "x"})</script>')
      const without = checkArtifact(dir, manifest('$title: A\n$uses: $[file]\n'))
      expect(without.errors.join('\n')).toMatch(/image/)
      const ok = checkArtifact(dir, manifest('$title: A\n$uses: $[image]\n'))
      expect(ok.errors).toEqual([])
      expect(ok.used).toContain('image')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('host: image', () => {
  let tmp = ''
  let host: ArtifactHost
  const calls: Array<{ name: string; req: Parameters<ImageProviderLike['generate']>[0] }> = []
  let gate: (() => void) | null = null

  const fake = (name: string): ImageProviderLike => ({
    async models() {
      return { ok: true, value: [{ id: `${name}-m`, edit: true, maxRefs: 2, price: '$0.05' }] }
    },
    async schema(model) {
      return { ok: true, value: { fields: { prompt: { type: 'string' }, seed: { type: 'integer' } }, maxRefs: 2, model } }
    },
    async generate(req) {
      calls.push({ name, req })
      req.onProgress?.({ stage: 'queued' })
      req.onProgress?.({ stage: 'running', status: 'Sampler', step: 1, total: 2 })
      req.onProgress?.({ stage: 'running', status: 'Sampler', preview: JPEG })
      if (req.prompt === 'wait') {
        await new Promise<void>((r) => {
          gate = r
          req.signal?.addEventListener('abort', () => r(), { once: true })
        })
        if (req.signal?.aborted) {
          const e = new Error('отменён')
          e.name = 'AbortError'
          return { ok: false, error: e }
        }
      }
      if (req.prompt === 'boom') {
        const e = new Error('Content Moderated')
        e.name = 'ModerationError'
        return { ok: false, error: e }
      }
      req.onProgress?.({ stage: 'done' })
      if (req.model === 'vid') return { ok: true, value: { images: [new Uint8Array(MP4)], mime: 'video/mp4', meta: { model: 'vid', cost: 4, cost_unit: 'seconds' } } }
      return { ok: true, value: { images: [new Uint8Array(PNG)], mime: 'image/png', meta: { model: req.model, cost: 0.05, cost_unit: 'usd' } } }
    },
  })

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'artifacts-image-'))
    mkdirSync(join(tmp, 'ws'), { recursive: true })
    calls.length = 0
    host = createArtifactHost({
      root: join(tmp, 'ws'),
      dataRoot: join(tmp, 'data'),
      configFile: join(tmp, 'none.md'),
      image: { providers: () => ['nano', 'comfyui'], provider: async (n) => fake(n) },
      warn: () => {},
    })
  })
  afterEach(async () => {
    await host.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  function artifact(name: string, uses: string): void {
    const dir = join(tmp, 'ws', '.nr', 'artifacts', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'meta.mdz'), `$title: ${name}\n$uses: ${uses}\n`)
    writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body></body></html>')
  }

  function collect(key: string): { events: ImageWireEvent[]; stop: () => void; until: (kind: string) => Promise<ImageWireEvent> } {
    const events: ImageWireEvent[] = []
    const waiters: Array<() => void> = []
    const ctrl = new AbortController()
    const r = host.imageEvents(key, ctrl.signal, (e) => {
      events.push(e)
      waiters.splice(0).forEach((w) => w())
    })
    expect(r.ok).toBe(true)
    const until = async (kind: string): Promise<ImageWireEvent> => {
      for (;;) {
        const e = events.find((x) => x.kind === kind)
        if (e) return e
        await new Promise<void>((w) => waiters.push(w))
      }
    }
    return { events, stop: () => ctrl.abort(), until }
  }

  it('providers / models / schema; generate — события, рефы байтами, результат по HTTP и в bytes/save', async () => {
    artifact('gen', '$[image, file]')
    const o = await host.open('ws/gen')
    expect(await host.bridge(o.key, 'image.providers', [])).toEqual({ ok: true, value: [{ name: 'nano' }, { name: 'comfyui' }] })
    expect(await host.bridge(o.key, 'image.models', ['nano'])).toEqual({ ok: true, value: [{ id: 'nano-m', edit: true, maxRefs: 2, price: '$0.05' }] })
    expect(await host.bridge(o.key, 'image.schema', ['nano', 'm1'])).toMatchObject({ ok: true, value: { maxRefs: 2 } })
    expect(await host.bridge(o.key, 'image.models', ['nope'])).toMatchObject({ ok: false, error: expect.stringMatching(/провайдера "nope" нет/) })

    const ev = collect(o.key)
    const g = (await host.bridge(o.key, 'image.generate', ['nano', { model: 'm1', prompt: 'fox', params: { seed: 1 } }, [{ __b64: PNG.toString('base64') }]])) as { ok: true; value: { id: string } }
    expect(g.ok).toBe(true)
    const done = (await ev.until('done')) as Extract<ImageWireEvent, { kind: 'done' }>
    expect(calls[0]!.req).toMatchObject({ model: 'm1', prompt: 'fox', params: { seed: 1 } })
    expect(Buffer.from(calls[0]!.req.refs![0]!).equals(PNG)).toBe(true)
    expect(ev.events.map((e) => e.kind)).toEqual(['progress', 'progress', 'preview', 'progress', 'done'])
    expect(ev.events[1]).toMatchObject({ kind: 'progress', stage: 'running', status: 'Sampler', step: 1, total: 2 })
    expect(done.meta).toMatchObject({ cost: 0.05, cost_unit: 'usd' })
    expect(done.images[0]!.path).toBe(`/i/${o.key}/${g.value.id}/0`)

    const origin = await host.origin
    const res = await fetch(`${origin}${done.images[0]!.path}`)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)
    const prev = ev.events.find((e) => e.kind === 'preview') as Extract<ImageWireEvent, { kind: 'preview' }>
    const pres = await fetch(`${origin}${prev.path}`)
    expect(Buffer.from(await pres.arrayBuffer()).equals(Buffer.from(JPEG))).toBe(true)

    const bytes = (await host.bridge(o.key, 'image.bytes', [g.value.id, 0])) as { ok: true; value: { __b64: string } }
    expect(Buffer.from(bytes.value.__b64, 'base64').equals(PNG)).toBe(true)
    const saved = (await host.bridge(o.key, 'image.save', [g.value.id, 0, 'gen/out.png'])) as { ok: true; value: { path: string } }
    expect(readFileSync(saved.value.path).equals(PNG)).toBe(true)
    ev.stop()
  })

  it('рефы персонажа (ABC-261) — четвёртым массивом, до провайдера как subjects', async () => {
    artifact('subj', '$[image]')
    const o = await host.open('ws/subj')
    const ev = collect(o.key)
    const b64 = { __b64: PNG.toString('base64') }
    const g = (await host.bridge(o.key, 'image.generate', ['nano', { model: 'veo', prompt: 'hero' }, [b64], [b64, b64]])) as { ok: boolean }
    expect(g.ok).toBe(true)
    await ev.until('done')
    const req = calls.at(-1)!.req as { refs?: Uint8Array[]; subjects?: Uint8Array[] }
    expect(req.refs!.length).toBe(1)
    expect(req.subjects!.length).toBe(2)
    expect(Buffer.from(req.subjects![1]!).equals(PNG)).toBe(true)
    ev.stop()
  })

  it('видео (media-gen-spec §6): mime провайдера в done, HTTP отвечает на Range 206, вне файла — 416', async () => {
    artifact('gen', '$[image, file]')
    const o = await host.open('ws/gen')
    const ev = collect(o.key)
    const g = (await host.bridge(o.key, 'image.generate', ['nano', { model: 'vid', prompt: 'wave' }, []])) as { ok: true; value: { id: string } }
    const done = (await ev.until('done')) as Extract<ImageWireEvent, { kind: 'done' }>
    expect(done.images[0]).toMatchObject({ mime: 'video/mp4' })
    const url = `${await host.origin}${done.images[0]!.path}`
    const full = await fetch(url)
    expect(full.status).toBe(200)
    expect(full.headers.get('accept-ranges')).toBe('bytes')
    expect(full.headers.get('content-type')).toBe('video/mp4')
    const part = await fetch(url, { headers: { range: 'bytes=4-7' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 4-7/${MP4.length}`)
    expect(Buffer.from(await part.arrayBuffer()).toString('latin1')).toBe('ftyp')
    expect((await fetch(url, { headers: { range: 'bytes=999-' } })).status).toBe(416)
    const saved = (await host.bridge(o.key, 'image.save', [g.value.id, 0, 'gen/clip.mp4'])) as { ok: true; value: { path: string } }
    expect(readFileSync(saved.value.path).equals(MP4)).toBe(true)
    ev.stop()
  })

  it('byteRange: a-b, a-, -n, мимо и мусор', () => {
    expect(byteRange('bytes=0-1', 10)).toEqual({ start: 0, end: 1 })
    expect(byteRange('bytes=5-', 10)).toEqual({ start: 5, end: 9 })
    expect(byteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 })
    expect(byteRange('bytes=2-99', 10)).toEqual({ start: 2, end: 9 })
    expect(byteRange('bytes=10-', 10)).toBe('bad')
    expect(byteRange('bytes=0-1,4-5', 10)).toBeUndefined()
    expect(byteRange(undefined, 10)).toBeUndefined()
  })

  it('ошибка провайдера — событие error с именем; cancel — cancelled', async () => {
    artifact('gen', '$[image]')
    const o = await host.open('ws/gen')
    const ev = collect(o.key)
    await host.bridge(o.key, 'image.generate', ['nano', { model: 'm', prompt: 'boom' }, []])
    expect(await ev.until('error')).toMatchObject({ kind: 'error', name: 'ModerationError', message: 'Content Moderated' })
    const g = (await host.bridge(o.key, 'image.generate', ['comfyui', { model: 'm', prompt: 'wait' }, []])) as { ok: true; value: { id: string } }
    expect(await host.bridge(o.key, 'image.cancel', [g.value.id])).toEqual({ ok: true, value: true })
    expect(await ev.until('cancelled')).toMatchObject({ kind: 'cancelled', id: g.value.id })
    ev.stop()
  })

  it('без права image — отказ в мосте, HTTP и стриме; без источника — понятная ошибка', async () => {
    artifact('plain', '$[file]')
    const o = await host.open('ws/plain')
    expect(await host.bridge(o.key, 'image.providers', [])).toEqual({ ok: false, error: 'capability not declared: image' })
    expect((await fetch(`${await host.origin}/i/${o.key}/g1/0`)).status).toBe(403)
    expect(host.imageEvents(o.key, new AbortController().signal, () => {})).toMatchObject({ ok: false })

    const bare = createArtifactHost({ root: join(tmp, 'ws'), dataRoot: join(tmp, 'data2'), configFile: join(tmp, 'none.md'), warn: () => {} })
    try {
      artifact('gen2', '$[image]')
      const o2 = await bare.open('ws/gen2')
      expect(await bare.bridge(o2.key, 'image.providers', [])).toMatchObject({ ok: false, error: expect.stringMatching(/не подключены/) })
      const ctx = (await bare.bridge(o2.key, 'getContext', [])) as { ok: true; value: { image: boolean } }
      expect(ctx.value.image).toBe(false)
    } finally {
      await bare.close()
    }
  })
})
