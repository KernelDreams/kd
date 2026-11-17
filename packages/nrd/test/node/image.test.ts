// helpers.image (image-gen-spec §3): модель из цепочки, рефы с диска, out/N>1,
// дефолтный путь в dataDir, провенанс `.json` рядом с файлом.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { ok, err, type ImageProvider, type ImageRequest } from '../../src/contracts/index.js'
import { emptyContext, objectContext, type IContext } from '../../src/core/index.js'
import { buildHelpers, type ImageSetup } from '../../src/node/helpers.js'
import { nodeProgramCaps } from '../../src/node/capability-program.js'
import { fromBase64 } from '../../src/web/image/bytes.js'

const PNG = fromBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
)

let dir: string
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrd-image-'))
})
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function fakeProvider(count = 1): { provider: ImageProvider; calls: ImageRequest[] } {
  const calls: ImageRequest[] = []
  return {
    calls,
    provider: {
      async generate(req) {
        calls.push(req)
        if (req.prompt === 'boom') {
          const e = new Error('Content Moderated')
          e.name = 'ModerationError'
          return err(e)
        }
        return ok({ images: Array.from({ length: count }, () => PNG), mime: 'image/png', meta: { model: req.model, cost: 3 } })
      },
    },
  }
}

function helpers(attrs: Record<string, unknown>, setup?: ImageSetup, trusted = true) {
  const ctx: IContext = objectContext(attrs as never)
  return buildHelpers({
    ctx,
    meta: { dataDir: path.join(dir, 'data') } as never,
    decls: [],
    caps: nodeProgramCaps(dir, trusted),
    provider: {} as never,
    image: setup ? async () => setup : undefined,
    env: { render: (t) => t },
    runFn: async () => ({}) as never,
  })
}

describe('helpers.image', () => {
  it('out + провенанс; модель из $image_model сильнее $model; рефы читаются в байты', async () => {
    fs.writeFileSync(path.join(dir, 'ref1.png'), PNG)
    const fake = fakeProvider()
    const h = helpers({ image_model: 'flux-3-image', model: 'gpt-x' }, { provider: fake.provider, name: 'bfl' })
    const r = await h.image('a red fox', { refs: ['ref1.png'], params: { resolution: '1k' }, out: './out/fox.jpg' })

    const file = path.join(dir, 'out', 'fox.png')
    expect(r.files).toEqual([file])
    expect(fs.readFileSync(file)).toEqual(Buffer.from(PNG))
    expect(fake.calls[0]).toMatchObject({ model: 'flux-3-image', prompt: 'a red fox', params: { resolution: '1k' } })
    expect(fake.calls[0].refs?.[0]).toEqual(new Uint8Array(PNG))
    const prov = JSON.parse(fs.readFileSync(file + '.json', 'utf-8'))
    expect(prov).toMatchObject({
      prompt: 'a red fox',
      model: 'flux-3-image',
      provider: 'bfl',
      params: { resolution: '1k' },
      refs: ['ref1.png'],
      meta: { model: 'flux-3-image', cost: 3 },
    })
    expect(r.meta.cost).toBe(3)
  })

  it('N>1 с out — name.png, name-2.png, name-3.png', async () => {
    const h = helpers({ model: 'm' }, { provider: fakeProvider(3).provider, name: 'mock' })
    const r = await h.image('x', { out: 'many/shot.png' })
    expect(r.files.map((f) => path.basename(f))).toEqual(['shot.png', 'shot-2.png', 'shot-3.png'])
    for (const f of r.files) expect(fs.existsSync(f + '.json')).toBe(true)
  })

  it('без out — {dataDir}/image/{дата}/{время}-{n}.png, без коллизий между вызовами', async () => {
    const h = helpers({ model: 'm' }, { provider: fakeProvider().provider, name: 'mock' })
    const a = await h.image('x')
    const b = await h.image('y')
    expect(a.files[0]).not.toBe(b.files[0])
    expect(a.files[0]).toMatch(/[/\\]data[/\\]image[/\\]\d{4}-\d{2}-\d{2}[/\\]\d{6}-\d+\.png$/)
    expect(fs.existsSync(b.files[0])).toBe(true)
  })

  it('opts.model сильнее цепочки; нет модели — ошибка', async () => {
    const fake = fakeProvider()
    await helpers({ image_model: 'a' }, { provider: fake.provider, name: 'p' }).image('x', { model: 'b', out: 'm.png' })
    expect(fake.calls[0].model).toBe('b')
    await expect(helpers({}, { provider: fake.provider, name: 'p' }).image('x')).rejects.toThrow(/нет модели/)
  })

  it('ошибка провайдера всплывает с именем', async () => {
    const h = helpers({ model: 'm' }, { provider: fakeProvider().provider, name: 'p' })
    await expect(h.image('boom', { out: 'b.png' })).rejects.toMatchObject({ name: 'ModerationError' })
  })

  it('реф не найден; нет провайдера у хоста; недоверенное звено', async () => {
    const setup = { provider: fakeProvider().provider, name: 'p' }
    await expect(helpers({ model: 'm' }, setup).image('x', { refs: ['nope.png'] })).rejects.toThrow(/реф не найден: nope.png/)
    await expect(helpers({ model: 'm' }).image('x')).rejects.toThrow(/хост не дал провайдер/)
    await expect(helpers({ model: 'm' }, setup, false).image('x')).rejects.toThrow(/недоверенном звене/)
  })

  it('провайдер резолвится лениво — только по вызову image', async () => {
    let resolved = 0
    const ctx = emptyContext
    const h = buildHelpers({
      ctx,
      meta: {} as never,
      decls: [],
      caps: nodeProgramCaps(dir),
      provider: {} as never,
      image: async () => {
        resolved++
        return { provider: fakeProvider().provider, name: 'p' }
      },
      env: { render: (t) => t },
      runFn: async () => ({}) as never,
    })
    expect(resolved).toBe(0)
    await h.image('x', { model: 'm', out: 'lazy.png' })
    expect(resolved).toBe(1)
  })

  it('onProgress пробрасывается; без колбэка — строка в stderr на смену stage/status, не на шаг', async () => {
    const steps: ImageProvider = {
      async generate(req) {
        for (const e of [
          { stage: 'queued' as const },
          { stage: 'running' as const, status: 'KSampler', step: 1, total: 3 },
          { stage: 'running' as const, status: 'KSampler', step: 2, total: 3 },
          { stage: 'running' as const, status: 'VAEDecode' },
          { stage: 'done' as const },
        ])
          req.onProgress?.(e)
        return ok({ images: [PNG], mime: 'image/png', meta: { model: req.model } })
      },
    }
    const seen: unknown[] = []
    await helpers({ model: 'm' }, { provider: steps, name: 'p' }).image('x', { out: 'pr1.png', onProgress: (e) => seen.push(e) })
    expect(seen).toHaveLength(5)

    const lines: string[] = []
    const orig = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => (lines.push(String(chunk)), true)) as never
    try {
      await helpers({ model: 'm' }, { provider: steps, name: 'p' }).image('x', { out: 'pr2.png' })
    } finally {
      process.stderr.write = orig
    }
    expect(lines).toEqual([
      '[image p · m] queued\n',
      '[image p · m] running KSampler\n',
      '[image p · m] running VAEDecode\n',
      '[image p · m] done\n',
    ])
  })
})

// ==================== helpers.video / helpers.audio (media-gen-spec §5) ====================

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0])
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 0])

function mediaProvider(kinds: Record<string, 'image' | 'video' | 'audio'>): { provider: ImageProvider; calls: ImageRequest[] } {
  const calls: ImageRequest[] = []
  return {
    calls,
    provider: {
      async schema(model) {
        return ok(kinds[model] ? { fields: {}, kind: kinds[model] } : undefined)
      },
      async generate(req) {
        calls.push(req)
        const kind = kinds[req.model]
        const bytes = kind === 'video' ? MP4 : kind === 'audio' ? MP3 : PNG
        const mime = kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png'
        return ok({ images: [bytes], mime, meta: { model: req.model, cost: 4, cost_unit: 'seconds' } })
      },
    },
  }
}

function mediaHelpers(attrs: Record<string, unknown>, fake: { provider: ImageProvider }, seen: string[] = []) {
  return buildHelpers({
    ctx: objectContext(attrs as never),
    meta: { dataDir: path.join(dir, 'data') } as never,
    decls: [],
    caps: nodeProgramCaps(dir, true),
    provider: {} as never,
    image: async () => ({ provider: fake.provider, name: 'img-only' }),
    media: async (kind) => {
      seen.push(kind)
      return { provider: fake.provider, name: `p-${kind}` }
    },
    env: { render: (t) => t },
    runFn: async () => ({}) as never,
  })
}

describe('helpers.video / helpers.audio', () => {
  const kinds = { 'veo-lite': 'video', lyria: 'audio', 'flux-3-image': 'image' } as const

  it('video: frame/lastFrame → кадры по порядку, $video_model, провайдер по виду, .mp4 + провенанс с kind', async () => {
    fs.writeFileSync(path.join(dir, 'f1.png'), PNG)
    fs.writeFileSync(path.join(dir, 'f2.png'), PNG)
    const fake = mediaProvider(kinds)
    const seen: string[] = []
    const h = mediaHelpers({ video_model: 'veo-lite', model: 'gpt-x' }, fake, seen)
    const r = await h.video('wave', { frame: 'f1.png', lastFrame: 'f2.png', params: { duration: 4 }, out: 'clips/wave', onProgress: () => {} })
    expect(seen).toEqual(['video'])
    expect(fake.calls[0].model).toBe('veo-lite')
    expect(fake.calls[0].refs).toHaveLength(2)
    expect(r.files).toEqual([path.join(dir, 'clips', 'wave.mp4')])
    const prov = JSON.parse(fs.readFileSync(r.files[0] + '.json', 'utf-8'))
    expect(prov).toMatchObject({ kind: 'video', model: 'veo-lite', provider: 'p-video', refs: ['f1.png', 'f2.png'], mime: 'video/mp4' })
  })

  it('audio: $audio_model, дефолтный путь {dataDir}/audio/…mp3', async () => {
    const fake = mediaProvider(kinds)
    const h = mediaHelpers({ audio_model: 'lyria' }, fake)
    const r = await h.audio('jingle', { onProgress: () => {} })
    expect(r.files[0].startsWith(path.join(dir, 'data', 'audio'))).toBe(true)
    expect(r.files[0].endsWith('.mp3')).toBe(true)
  })

  it('нет $video_model — ошибка; $model не подхватывается', async () => {
    const h = mediaHelpers({ model: 'gpt-x' }, mediaProvider(kinds))
    await expect(h.video('x')).rejects.toThrow(/нет модели.*\$video_model/)
  })

  it('модель другого вида — ошибка до генерации', async () => {
    const fake = mediaProvider(kinds)
    const h = mediaHelpers({}, fake)
    await expect(h.video('x', { model: 'flux-3-image' })).rejects.toThrow(/вида image; бери helpers.image/)
    await expect(h.image('x', { model: 'veo-lite' })).rejects.toThrow(/вида video/)
    expect(fake.calls).toHaveLength(0)
  })

  it('frame вместе с refs — ошибка; без media у хоста — провайдер image', async () => {
    const fake = mediaProvider(kinds)
    await expect(mediaHelpers({}, fake).video('x', { model: 'veo-lite', refs: ['a'], frame: 'b' })).rejects.toThrow(/либо refs/)
    const h = helpers({ video_model: 'veo-lite' }, { provider: fake.provider, name: 'img' })
    const r = await h.video('x', { onProgress: () => {} })
    expect(r.files[0].endsWith('.mp4')).toBe(true)
  })
})
