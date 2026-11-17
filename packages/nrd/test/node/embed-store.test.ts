// sqliteEmbedStore (embed-cas-spec §3) и helpers.embed (§4).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { emptyContext, objectContext } from '../../src/core/index.js'
import { sqliteEmbedStore, embedSpaceSlug, type SqliteEmbedStore } from '../../src/node/embed-store.js'
import { buildHelpers, type ProviderSetup } from '../../src/node/helpers.js'
import { nodeProgramCaps } from '../../src/node/capability-program.js'
import { memoryEmbedStore } from '../../src/web/embed.js'
import { ok } from '../../src/infra/result.js'

// vite 5 не знает node:sqlite как builtin — грузим мимо трансформа
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

let dir: string
const stores: SqliteEmbedStore[] = []
const open = (d = dir) => {
  const s = sqliteEmbedStore(d)
  stores.push(s)
  return s
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nrd-embed-'))
})

afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const v = (...xs: number[]) => Float32Array.from(xs)

describe('embedSpaceSlug', () => {
  it('/ → __, прочее вне [A-Za-z0-9._-] → _', () => {
    expect(embedSpaceSlug('embed/gemini')).toBe('embed__gemini')
    expect(embedSpaceSlug('a b:c/d.e-f_g')).toBe('a_b_c__d.e-f_g')
  })
})

describe('sqliteEmbedStore', () => {
  it('каталог создаётся при первом put; get/stat на пустом — без файла', async () => {
    const sub = path.join(dir, 'deep', 'embed')
    const s = open(sub)
    expect(await s.stat('embed/x')).toEqual({ count: 0, dim: null })
    expect((await s.get('embed/x', ['h'])).size).toBe(0)
    expect(await s.spaces()).toEqual([])
    expect(fs.existsSync(sub)).toBe(false)

    await s.put('embed/x', new Map([['h1', v(1, 2, 3)]]))
    expect(fs.existsSync(path.join(sub, 'embed__x.db'))).toBe(true)
  })

  it('get/put: f16 roundtrip, INSERT OR IGNORE, пачки IN > 500', async () => {
    const s = open()
    const entries = new Map<string, Float32Array>()
    for (let i = 0; i < 1200; i++) entries.set(`h${i}`, v(i / 1000, -i / 1000))
    await s.put('embed/x', entries)
    // повтор с другим значением не перезаписывает
    await s.put('embed/x', new Map([['h0', v(9, 9)]]))

    const want = [...entries.keys(), 'nope', 'h0']
    const got = await s.get('embed/x', want)
    expect(got.size).toBe(1200)
    expect([...got.get('h0')!]).toEqual([0, -0])
    expect(got.get('h1000')![0]).toBeCloseTo(1, 3)
    expect(got.get('h1000')).toBeInstanceOf(Float32Array)
    expect(await s.stat('embed/x')).toEqual({ count: 1200, dim: 2 })

    // WAL, ts, схема
    const db = new DatabaseSync(path.join(dir, 'embed__x.db'))
    expect((db.prepare('PRAGMA journal_mode').get() as any).journal_mode).toBe('wal')
    const meta = Object.fromEntries((db.prepare('SELECT k, v FROM meta').all() as any[]).map((r) => [r.k, r.v]))
    expect(meta).toEqual({ space: 'embed/x', norm: '1', dim: '2' })
    const row = db.prepare("SELECT v, ts FROM vec WHERE hash = 'h1'").get() as any
    expect(row.v.byteLength).toBe(4)
    expect(row.ts).toBeGreaterThan(0)
    db.close()
  })

  it('dim-guard: чужая размерность → ошибка, ничего не записано', async () => {
    const s = open()
    await s.put('embed/x', new Map([['a', v(1, 2, 3)]]))
    await expect(s.put('embed/x', new Map([['b', v(1, 2, 3)], ['c', v(1, 2)]]))).rejects.toThrow(
      /embed\/x.*размерность 2.*3/,
    )
    expect((await s.stat('embed/x')).count).toBe(1)
    // и в новом процессе (dim — из meta)
    s.close()
    await expect(open().put('embed/x', new Map([['d', v(1)]]))).rejects.toThrow(/размерность 1/)
  })

  it('norm-guard: файл с другим norm → ошибка с обоими значениями', async () => {
    const s = open()
    await s.put('embed/x', new Map([['a', v(1)]]))
    s.close()
    const db = new DatabaseSync(path.join(dir, 'embed__x.db'))
    db.prepare("UPDATE meta SET v = '0' WHERE k = 'norm'").run()
    db.close()
    await expect(open().get('embed/x', ['a'])).rejects.toThrow(/norm файла 0.*NORM_V 1/)
  })

  it('space-guard: коллизия slug → ошибка с обоими именами', async () => {
    const s = open()
    await s.put('embed/x', new Map([['a', v(1)]]))
    await expect(s.get('embed__x', ['a'])).rejects.toThrow(/"embed\/x".*"embed__x"/)
  })

  it('spaces — исходные имена из meta', async () => {
    const s = open()
    await s.put('embed/gemini', new Map([['a', v(1)]]))
    await s.put('local:nomic', new Map([['a', v(1, 2)]]))
    fs.writeFileSync(path.join(dir, 'junk.txt'), 'x')
    expect(await open().spaces()).toEqual(['embed/gemini', 'local:nomic'])
  })
})

describe('helpers.embed', () => {
  function helpers(attrs: Record<string, string>, provider: Partial<ProviderSetup['provider']> | null, store = memoryEmbedStore()) {
    return buildHelpers({
      ctx: objectContext(attrs),
      meta: {} as never,
      decls: [],
      caps: nodeProgramCaps(dir),
      provider: { name: 'lgate', model: 'm', provider: { stream: async function* () {}, ...provider } } as ProviderSetup,
      env: { render: (t) => t },
      runFn: async () => ({}) as never,
      embedStore: store,
    })
  }

  const embed = vi.fn(async (req: { model: string; input: string[] }) =>
    ok({ vectors: req.input.map((t) => v(t.length, 0, 0)) }),
  )

  beforeEach(() => { embed.mockClear() })

  it('space = $embed_model; дубли — один раз; повтор — ноль вызовов и onProgress', async () => {
    const h = helpers({ embed_model: 'embed/gemini' }, { embed })
    const progress = vi.fn()
    const texts = ['Генки хаотичная девочка', 'тихий библиотекарь', 'Генки хаотичная девочка']
    const r = await h.embed(texts, { onProgress: progress })
    expect(r).toHaveLength(3)
    expect(r[0]).toEqual(r[2])
    expect(embed).toHaveBeenCalledTimes(1)
    expect(embed.mock.calls[0][0]).toEqual({ model: 'embed/gemini', input: [texts[0], texts[1]] })
    expect(progress).toHaveBeenCalledWith(2, 2)

    const again = vi.fn()
    await h.embed(texts, { onProgress: again })
    expect(embed).toHaveBeenCalledTimes(1)
    expect(again).not.toHaveBeenCalled()
  })

  it('opts.model перекрывает $embed_model', async () => {
    await helpers({ embed_model: 'embed/gemini' }, { embed }).embed(['a'], { model: 'embed/other' })
    expect(embed.mock.calls[0][0].model).toBe('embed/other')
  })

  it('нет $embed_model → ошибка (не тихий дефолт)', async () => {
    await expect(helpers({}, { embed }).embed(['a'])).rejects.toThrow(/нет \$embed_model/)
  })

  it('у провайдера нет embed → ошибка с его именем', async () => {
    await expect(helpers({ embed_model: 'e' }, {}).embed(['a'])).rejects.toThrow(/"lgate" нет embed/)
  })

  it('стор по умолчанию — sqlite в $embed_dir', async () => {
    const h = buildHelpers({
      ctx: objectContext({ embed_model: 'embed/gemini', embed_dir: dir }),
      meta: {} as never,
      decls: [],
      caps: nodeProgramCaps(dir),
      provider: { name: 'lgate', model: 'm', provider: { stream: async function* () {}, embed } } as ProviderSetup,
      env: { render: (t) => t },
      runFn: async () => ({}) as never,
    })
    await h.embed(['a', 'bb'])
    expect(fs.existsSync(path.join(dir, 'embed__gemini.db'))).toBe(true)
    const s = open()
    expect(await s.stat('embed/gemini')).toEqual({ count: 2, dim: 3 })
  })
})

describe('helpers.embedImages', () => {
  // JPEG: сигнатура FF D8 FF; PNG: сигнатура + IHDR, байт 25 — тип цвета (2 — RGB, 6 — RGBA)
  const jpeg = (n: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, n])
  const png = (colorType: number) => {
    const b = new Uint8Array(33)
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    b[25] = colorType
    return b
  }
  const embed = vi.fn(async (req: { model: string; input: string[]; modality?: string }) =>
    ok({ vectors: req.input.map((t) => v(t.length, 1, 0)) }),
  )
  const helpers = (attrs: Record<string, string>) => buildHelpers({
    ctx: objectContext(attrs),
    meta: {} as never,
    decls: [],
    caps: nodeProgramCaps(dir),
    provider: { name: 'lgate', model: 'm', provider: { stream: async function* () {}, embed } } as ProviderSetup,
    env: { render: (t) => t },
    runFn: async () => ({}) as never,
    embedStore: memoryEmbedStore(),
  })

  beforeEach(() => { embed.mockClear() })

  it('пути, байты и data URL → data URL с modality: image; одинаковое содержимое — один вызов; повтор — из стора', async () => {
    fs.writeFileSync(path.join(dir, 'a.jpg'), jpeg(1))
    const h = helpers({ embed_image_model: 'embed/siglip' })
    const r = await h.embedImages([path.join(dir, 'a.jpg'), jpeg(1), jpeg(2), 'data:image/jpeg;base64,AAAA'])
    expect(r).toHaveLength(4)
    expect(r[0]).toEqual(r[1])
    expect(embed).toHaveBeenCalledTimes(1)
    const req = embed.mock.calls[0][0]
    expect(req.model).toBe('embed/siglip')
    expect(req.modality).toBe('image')
    expect(req.input).toHaveLength(3)
    expect(req.input[0]).toMatch(/^data:image\/jpeg;base64,/)
    await h.embedImages([jpeg(2)])
    expect(embed).toHaveBeenCalledTimes(1)
  })

  it('нет $embed_image_model → ошибка; PNG с альфой → ошибка до сети; RGB PNG — годен', async () => {
    await expect(helpers({}).embedImages([jpeg(1)])).rejects.toThrow(/нет \$embed_image_model/)
    const h = helpers({ embed_image_model: 'embed/siglip' })
    await expect(h.embedImages([png(6)])).rejects.toThrow(/PNG с альфой/)
    expect(embed).not.toHaveBeenCalled()
    await h.embedImages([png(2)])
    expect(embed.mock.calls[0][0].input[0]).toMatch(/^data:image\/png;base64,/)
  })
})
