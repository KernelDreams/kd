// Тулы ComfyUI — проверка графа по /object_info, запуск и забор картинок, граф из PNG.
import { describe, expect, it } from 'vitest'
import { checkGraph, comfyTools, pngGraph, type ApiGraph, type ObjectInfo } from '../src/comfy.js'

const INFO: ObjectInfo = {
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sdxl.safetensors', 'sd15.safetensors']] } }, output: ['MODEL', 'CLIP', 'VAE'] },
  CLIPTextEncode: { input: { required: { text: ['STRING', { multiline: true }], clip: ['CLIP'] } }, output: ['CONDITIONING'] },
  EmptyLatentImage: { input: { required: { width: ['INT', { default: 512, min: 16, max: 8192 }], height: ['INT', { default: 512, min: 16, max: 8192 }], batch_size: ['INT', { default: 1 }] } }, output: ['LATENT'] },
  KSampler: {
    input: { required: { model: ['MODEL'], seed: ['INT', { min: 0 }], steps: ['INT', { min: 1, max: 10000 }], cfg: ['FLOAT'], sampler_name: [['euler', 'dpmpp_2m']], scheduler: [['normal', 'karras']], positive: ['CONDITIONING'], negative: ['CONDITIONING'], latent_image: ['LATENT'], denoise: ['FLOAT'] } },
    output: ['LATENT'],
  },
  VAEDecode: { input: { required: { samples: ['LATENT'], vae: ['VAE'] } }, output: ['IMAGE'] },
  SaveImage: { input: { required: { images: ['IMAGE'], filename_prefix: ['STRING'] } }, output: [] },
}

const GOOD: ApiGraph = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'cat', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: '', clip: ['4', 1] } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '3': { class_type: 'KSampler', inputs: { model: ['4', 0], seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0], denoise: 1 } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['8', 0], filename_prefix: 'kd' } },
}

describe('тулы ComfyUI', () => {
  it('годный граф — без ошибок; поломки — словами с узлом и вариантами', () => {
    expect(checkGraph(GOOD, INFO)).toEqual([])
    const bad = structuredClone(GOOD)
    bad['4']!.inputs.ckpt_name = 'nope.safetensors'
    bad['3']!.inputs.sampler_name = 'euler_ancestral'
    bad['3']!.inputs.positive = ['99', 0]
    bad['8']!.inputs.vae = ['4', 0]
    delete bad['5']!.inputs.height
    bad['10'] = { class_type: 'UltraUpscale', inputs: {} }
    const errs = checkGraph(bad, INFO).join('\n')
    expect(errs).toMatch(/ckpt_name = «nope.safetensors» нет в списке сервера; есть: sdxl.safetensors/)
    expect(errs).toMatch(/sampler_name = «euler_ancestral»/)
    expect(errs).toMatch(/узел 99, которого нет/)
    expect(errs).toMatch(/вход vae ждёт VAE, а узел 4 отдаёт MODEL/)
    expect(errs).toMatch(/нет обязательного входа height/)
    expect(errs).toMatch(/класса UltraUpscale на сервере нет/)
  })

  it('comfy_run: негодный — не запускает; годный — /prompt, /history, /view, сохраняет PNG', async () => {
    const calls: string[] = []
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const fetch = async (url: string, init?: { method?: string; body?: string }) => {
      calls.push(`${init?.method ?? 'GET'} ${url.replace('http://c:8188', '')}`)
      const json = (v: unknown) => ({ ok: true, status: 200, json: async () => v, text: async () => JSON.stringify(v), arrayBuffer: async () => new ArrayBuffer(0) })
      if (url.endsWith('/object_info')) return json(INFO)
      if (url.endsWith('/prompt')) return json({ prompt_id: 'p1' })
      if (url.includes('/history/p1')) return json({ p1: { outputs: { '9': { images: [{ filename: 'kd_0001.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success' } } })
      return { ok: true, status: 200, json: async () => ({}), text: async () => '', arrayBuffer: async () => png.buffer.slice(0) }
    }
    const saved: string[] = []
    const tools = comfyTools({ server: 'http://c:8188/', fetch, save: async (name) => (saved.push(name), `/pics/${name}`) })
    const run = tools.find((t) => t.name === 'comfy_run')!
    const ctx = { signal: new AbortController().signal } as never
    const broken = await run.execute({ workflow: { '1': { class_type: 'Nope', inputs: {} } } }, ctx)
    expect(typeof broken === 'object' && broken.isError).toBe(true)
    expect(calls.some((c) => c.includes('/prompt'))).toBe(false)
    const ok = await run.execute({ workflow: JSON.stringify(GOOD), name: 'cat' }, ctx)
    expect(typeof ok === 'object' && ok.text).toBe('готово: /pics/cat-1.png')
    expect(calls).toContain('POST /prompt')
    expect(saved).toEqual(['cat-1.png'])
    const none = comfyTools({ server: () => undefined, fetch })[0]!
    const r = await none.execute({ search: 'x' }, ctx)
    expect(typeof r === 'object' && r.text).toMatch(/ComfyUI не подключён/)
  })

  it('граф из PNG: tEXt prompt и workflow', () => {
    const enc = new TextEncoder()
    const chunk = (type: string, data: Uint8Array): Uint8Array => {
      const out = new Uint8Array(12 + data.length)
      new DataView(out.buffer).setUint32(0, data.length)
      out.set(enc.encode(type), 4)
      out.set(data, 8)
      return out
    }
    const text = (k: string, v: string) => chunk('tEXt', new Uint8Array([...enc.encode(k), 0, ...enc.encode(v)]))
    const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), text('prompt', JSON.stringify(GOOD)), text('workflow', '{"nodes":[],"links":[]}'), chunk('IEND', new Uint8Array())]
    const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let at = 0
    for (const p of parts) {
      bytes.set(p, at)
      at += p.length
    }
    const g = pngGraph(bytes)
    expect(g.prompt?.['9']?.class_type).toBe('SaveImage')
    expect(g.workflow).toEqual({ nodes: [], links: [] })
  })
})
