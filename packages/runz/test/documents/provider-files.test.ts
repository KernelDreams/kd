/**
 * Провайдеры файлами: `<type>.ts` в папке провайдеров — новый `$type` без правки runz;
 * файл с именем встроенного типа его перекрывает; битый файл — громкая ошибка с путём; список
 * медиа-провайдеров (`listImageProviders` — его же видят Pix и Media Gen) включает файловые.
 * `a1111` — против HTTP-фикстуры sdapi (живого Automatic1111/Forge в контурах нет).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AddressInfo } from 'node:net'
import {
  buildChain,
  findProviderFile,
  listImageProviders,
  listProviderFiles,
  providerDirs,
  providerFileKinds,
  resolveImageProvider,
  resolveProvider,
} from '@kerneldreams/runz-runtime'
import { parseDocument } from '@kerneldreams/nrd'

const temps: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runz-provfiles-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true })
})

const chain = (cfg: string, doc = '$x: 1\n') => buildChain({ cliArgs: {}, doc: parseDocument(doc), globalConfig: parseDocument(cfg) } as never)

const IMAGE_FILE = (tag: string) => `
export const kind = 'image'
export default function (cfg) {
  return {
    async generate(req) {
      return { ok: true, value: { images: [new Uint8Array([1])], mime: 'image/png', meta: { model: req.model, id: '${tag}', base: cfg.baseUrl, name: cfg.name } } }
    },
  }
}
`

const LLM_FILE = `
export const kind: string = 'llm'
export default function (cfg: { name: string; apiKey?: string }) {
  return {
    async *stream(req: { messages?: unknown[] }) {
      yield { type: 'text', text: 'file-llm ' + cfg.name + ' ' + cfg.apiKey + ' ' + String(req.messages?.length ?? 0) }
    },
  }
}
`

describe('провайдеры файлами (ABC-864)', () => {
  const dir = tmp()
  fs.writeFileSync(path.join(dir, 'bfl.mjs'), IMAGE_FILE('override'))
  fs.writeFileSync(path.join(dir, 'fancy.ts'), IMAGE_FILE('fancy'))
  fs.writeFileSync(path.join(dir, 'myllm.ts'), LLM_FILE)
  fs.writeFileSync(path.join(dir, 'broken.ts'), 'export const kind = "image"\nexport default function ( {\n')
  fs.writeFileSync(path.join(dir, 'nokind.mjs'), 'export default () => ({ generate() {} })\n')
  fs.writeFileSync(path.join(dir, 'empty.mjs'), 'export const kind = "image"\nexport default () => ({})\n')

  const CFG = [
    `$providers_dir: ${dir}`,
    '',
    '## $provider flux',
    '$type: bfl',
    '$base_url: https://bfl.example',
    '',
    '## $provider fan',
    '$type: fancy',
    '$base_url: http://fancy.example',
    '',
    '## $provider talk',
    '$type: myllm',
    '$api_key: k1',
    '',
    '## $provider bad',
    '$type: broken',
    '',
    '## $provider nk',
    '$type: nokind',
    '',
    '## $provider em',
    '$type: empty',
    '',
    '## $provider chat',
    '$type: openai',
    '$base_url: https://llm.example/v1',
    '',
    '## $provider plain',
    '',
  ].join('\n')

  it('папки: $providers_dir цепочки; поиск по $type с приоритетом расширений', () => {
    const dirs = providerDirs(chain(CFG))
    expect(dirs).toEqual([dir])
    expect(findProviderFile(dirs, 'fancy')?.path).toBe(path.join(dir, 'fancy.ts'))
    expect(findProviderFile(dirs, 'openai')).toBeUndefined()
    expect(findProviderFile(dirs, '../etc')).toBeUndefined()
    expect(providerFileKinds(path.join(dir, 'myllm.ts'))).toEqual(['llm'])
    expect(listProviderFiles(dirs).map((f) => f.type).sort()).toEqual(['bfl', 'broken', 'empty', 'fancy', 'myllm', 'nokind'])
  })

  it('файл находится по $type и получает cfg блока + имя', async () => {
    const s = await resolveImageProvider(chain(CFG), 'fan')
    const r = await s.provider.generate({ model: 'm1' })
    expect(r.ok && r.value.meta).toMatchObject({ id: 'fancy', base: 'http://fancy.example', name: 'fan', model: 'm1' })
  })

  it('файл с именем встроенного типа перекрывает встроенный (bfl без ключа не падает)', async () => {
    const s = await resolveImageProvider(chain(CFG), 'flux')
    const r = await s.provider.generate({ model: 'flux-2-pro' })
    expect(r.ok && r.value.meta.id).toBe('override')
  })

  it('listImageProviders включает файловые медиа-провайдеры, но не llm и не без kind', () => {
    expect(listImageProviders(chain(CFG))).toEqual(['flux', 'fan', 'bad', 'em'])
  })

  it('битый файл — громкая ошибка с путём', async () => {
    await expect(resolveImageProvider(chain(CFG), 'bad')).rejects.toThrow(
      new RegExp(`провайдер-файл ${path.join(dir, 'broken.ts').replace(/[.\\/]/g, '\\$&')} \\(\\$type: broken\\) — не загрузился`),
    )
    await expect(resolveImageProvider(chain(CFG), 'nk')).rejects.toThrow(/nokind\.mjs .*нет export const kind/)
    await expect(resolveImageProvider(chain(CFG), 'em')).rejects.toThrow(/empty\.mjs .*не ImageProvider \(нет generate\(\)\)/)
    await expect(resolveImageProvider(chain(CFG), 'talk')).rejects.toThrow(/myllm\.ts .*kind llm — нужен 'image'/)
  })

  it('«не умеет медиа» перечисляет встроенные и файловые типы', async () => {
    await expect(resolveImageProvider(chain(CFG), 'plain')).rejects.toThrow(/поддержаны: bfl, nanogpt, comfy, google, vertex, gate, mock; файлами: .*fancy \(.*fancy\.ts\)/)
  })

  it('resolveProvider: LLM-провайдер файлом', async () => {
    const s = await resolveProvider(chain(CFG, '$provider: talk\n'))
    const chunks = []
    for await (const c of s.provider.stream({ messages: [{ role: 'user', content: 'hi' }] } as never)) chunks.push(c)
    expect(chunks).toEqual([{ type: 'text', text: 'file-llm talk k1 1' }])
    expect(s.name).toBe('talk')
  })

  it('без $providers_dir — образцы пакета: a1111 в списке и резолвится', async () => {
    const c = chain('## $provider sd\n$type: a1111\n$base_url: http://127.0.0.1:9\n')
    expect(listImageProviders(c)).toEqual(['sd'])
    const s = await resolveImageProvider(c, 'sd')
    expect(typeof s.provider.models).toBe('function')
  })
})

// ---------------------------------------------------------------------------- a1111 на фикстуре sdapi

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

describe('a1111 (фикстура sdapi)', () => {
  const seen: Array<{ url: string; auth?: string; body?: Record<string, unknown> }> = []
  let server: http.Server
  let base = ''

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined
        seen.push({ url: req.url ?? '', auth: req.headers.authorization, body })
        const json = (v: unknown, status = 200) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(v))
        }
        if (req.headers.authorization !== 'Basic ' + Buffer.from('u:p').toString('base64')) return json({ detail: 'Not authenticated' }, 401)
        if (req.url === '/sdapi/v1/sd-models') return json([{ title: 'sdxl.safetensors [abc]', model_name: 'sdxl' }, { title: 'pony.safetensors [def]', model_name: 'pony' }])
        if (req.url === '/sdapi/v1/samplers') return json([{ name: 'Euler a' }, { name: 'DPM++ 2M' }])
        if (req.url?.startsWith('/sdapi/v1/progress')) return json({ progress: 0.5, state: { sampling_step: 5, sampling_steps: 10 } })
        if (req.url === '/sdapi/v1/txt2img' || req.url === '/sdapi/v1/img2img') {
          const n = Number(body?.batch_size) || 1
          setTimeout(() => json({ images: [...Array(n + 1)].map(() => PNG.toString('base64')), info: JSON.stringify({ seed: 42 }) }), 1200)
          return
        }
        json({ detail: 'Not Found' }, 404)
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  const sd = async (key = 'u:p') => (await resolveImageProvider(chain(`## $provider sd\n$type: a1111\n$base_url: ${base}\n$api_key: ${key}\n`), 'sd')).provider

  it('models() — чекпойнты sd-models; schema() — поля и сэмплеры', async () => {
    const p = await sd()
    const m = await p.models!()
    expect(m.ok && m.value).toEqual([
      { id: 'sdxl.safetensors [abc]', name: 'sdxl', edit: true, mask: true, maxRefs: 1 },
      { id: 'pony.safetensors [def]', name: 'pony', edit: true, mask: true, maxRefs: 1 },
    ])
    const s = await p.schema!('sdxl.safetensors [abc]')
    expect(s.ok && s.value?.fields.sampler_name).toEqual({ type: 'string', enum: ['Euler a', 'DPM++ 2M'] })
    expect(s.ok && Object.keys(s.value!.fields)).toEqual(expect.arrayContaining(['width', 'height', 'steps', 'cfg_scale', 'seed', 'n']))
    expect(s.ok && s.value?.maxRefs).toBe(1)
  })

  it('txt2img: чекпойнт через override_settings, n → batch_size, сид из info, прогресс', async () => {
    const p = await sd()
    const progress: unknown[] = []
    seen.length = 0
    const r = await p.generate({ model: 'sdxl.safetensors [abc]', prompt: 'fox', params: { n: 2, steps: 10, width: 512 }, onProgress: (e) => progress.push(e) })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.images).toHaveLength(2)
    expect(r.value.mime).toBe('image/png')
    expect(r.value.meta).toMatchObject({ model: 'sdxl.safetensors [abc]', seed: 42 })
    const call = seen.find((s) => s.url === '/sdapi/v1/txt2img')!
    expect(call.body).toEqual({ prompt: 'fox', steps: 10, width: 512, batch_size: 2, override_settings: { sd_model_checkpoint: 'sdxl.safetensors [abc]' } })
    expect(progress).toContainEqual({ stage: 'running', step: 5, total: 10 })
    expect(progress.at(-1)).toEqual({ stage: 'done' })
  })

  it('img2img: реф → init_images, маска → mask; модель default не переключает чекпойнт', async () => {
    const p = await sd()
    seen.length = 0
    const r = await p.generate({ model: 'default', prompt: 'fix', refs: [new Uint8Array(PNG)], mask: new Uint8Array([7]), params: { denoising_strength: 0.4 } })
    expect(r.ok).toBe(true)
    const call = seen.find((s) => s.url === '/sdapi/v1/img2img')!
    expect(call.body).toMatchObject({ init_images: [PNG.toString('base64')], mask: Buffer.from([7]).toString('base64'), denoising_strength: 0.4, batch_size: 1 })
    expect(call.body).not.toHaveProperty('override_settings')
  })

  it('401 — AuthError с подсказкой про $api_key', async () => {
    const r = await (await sd('x:y')).models!()
    expect(!r.ok && r.error.name).toBe('AuthError')
    expect(!r.ok && r.error.message).toMatch(/\$api_key user:pass/)
  })
})
