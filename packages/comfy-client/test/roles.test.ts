import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PruneError, pruneEmptyLoaders, roles } from '../src/index.js'
import type { ObjectInfo, Prompt } from '../src/index.js'

const json = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as T
const info: ObjectInfo = { ...json<ObjectInfo>('object_info.json'), ...json<ObjectInfo>('object_info-extra.json') }
const wf = (name: string): Prompt => json<Prompt>(name)

// LoadImage → VAEEncode → KSampler.latent_image, denoise 0.6.
const IMG2IMG: Prompt = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['1', 1] } },
  '4': { class_type: 'LoadImage', inputs: { image: 'in.png' }, _meta: { title: 'Load Image' } },
  '5': { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } },
  '6': { class_type: 'KSampler', inputs: { model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['5', 0], seed: 7, steps: 30, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 0.6 } },
  '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['1', 2] } },
  '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'x' } },
}

// SDXL: CLIPTextEncode → ControlNetApplyAdvanced(image ← ref2) → KSampler; IPAdapter(image ← ref1) на model.
const SDXL_CN: Prompt = {
  '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sdxl.safetensors' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] }, _meta: { title: 'Positive' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'blurry', clip: ['1', 1] }, _meta: { title: 'Negative' } },
  '10': { class_type: 'LoadImage', inputs: { image: 'face.png' }, _meta: { title: 'ref1 лицо' } },
  '11': { class_type: 'LoadImage', inputs: { image: 'pose.png' }, _meta: { title: 'ref2 поза' } },
  '12': { class_type: 'ControlNetLoader', inputs: { control_net_name: 'cn.safetensors' } },
  '13': { class_type: 'ControlNetApplyAdvanced', inputs: { positive: ['2', 0], negative: ['3', 0], control_net: ['12', 0], image: ['11', 0], strength: 0.8, start_percent: 0, end_percent: 1 } },
  '14': { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: 'ip.safetensors' } },
  '15': { class_type: 'IPAdapter', inputs: { model: ['1', 0], ipadapter: ['14', 0], image: ['10', 0], weight: 1, start_at: 0, end_at: 1, weight_type: 'standard' } },
  '16': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 }, _meta: { title: 'Image' } },
  '17': { class_type: 'KSampler', inputs: { model: ['15', 0], positive: ['13', 0], negative: ['13', 1], latent_image: ['16', 0], seed: 1, steps: 25, cfg: 6, sampler_name: 'euler', scheduler: 'normal', denoise: 1 }, _meta: { title: 'Sampler' } },
  '18': { class_type: 'VAEDecode', inputs: { samples: ['17', 0], vae: ['1', 2] } },
  '19': { class_type: 'SaveImage', inputs: { images: ['18', 0], filename_prefix: 'x' } },
}

describe('roles', () => {
  it('qwen21-edit: 10 рефов по титулам, промпт и негатив в Encoder, размер, без denoise', () => {
    const r = roles(wf('qwen21-edit.json'), info)
    expect(r.refs.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(r.refs.map((s) => s.nodeId)).toEqual(['ref1', 'ref2', 'ref3', 'ref4', 'ref5', 'ref6', 'ref7', 'ref8', 'ref9', 'ref10'])
    expect(r.refs[0]).toEqual({ nodeId: 'ref1', input: 'image', index: 1 })
    expect(r.prompt).toEqual({ nodeId: 'encoder', input: 'prompt' })
    expect(r.negative).toEqual({ nodeId: 'encoder', input: 'negative_prompt' })
    expect(r.size).toEqual({ nodeId: 'image', input: 'width' })
    expect(r.seed).toEqual({ nodeId: 'sampler', input: 'seed' })
    expect(r.steps).toEqual({ nodeId: 'sampler', input: 'steps' })
    expect(r.denoise).toBeNull()
  })

  it('то же без objectInfo', () => {
    const r = roles(wf('qwen21-edit.json'))
    expect(r.prompt).toEqual({ nodeId: 'encoder', input: 'prompt' })
    expect(r.negative).toEqual({ nodeId: 'encoder', input: 'negative_prompt' })
  })

  it('anima-t2i: Positive/Negative по титулам, рефов нет', () => {
    const r = roles(wf('anima-t2i.json'), info)
    expect(r.refs).toEqual([])
    expect(r.prompt).toEqual({ nodeId: '6', input: 'text' })
    expect(r.negative).toEqual({ nodeId: '7', input: 'text' })
    expect(r.size).toEqual({ nodeId: '5', input: 'width' })
    expect(r.seed).toEqual({ nodeId: '3', input: 'seed' })
    expect(r.denoise).toBeNull()
  })

  it('zit-t2i: негатив = ConditioningZeroOut → null', () => {
    for (const oi of [info, undefined]) {
      const r = roles(wf('zit-t2i.json'), oi)
      expect(r.prompt).toEqual({ nodeId: '6', input: 'text' })
      expect(r.negative).toBeNull()
      expect(r.steps).toEqual({ nodeId: '3', input: 'steps' })
    }
  })

  it('qwen21-t2i: рефов 0, промпт и негатив есть', () => {
    const r = roles(wf('qwen21-t2i.json'), info)
    expect(r.refs).toEqual([])
    expect(r.prompt?.input).toBe('prompt')
    expect(r.negative?.input).toBe('negative_prompt')
  })

  it('img2img: один реф эвристикой (дефолтный титул без подписи), denoise есть, size null', () => {
    const r = roles(IMG2IMG, info)
    expect(r.refs).toEqual([{ nodeId: '4', input: 'image', index: 1 }])
    expect(r.prompt).toEqual({ nodeId: '2', input: 'text' })
    expect(r.negative).toEqual({ nodeId: '3', input: 'text' })
    expect(r.denoise).toEqual({ nodeId: '6', input: 'denoise' })
    expect(r.size).toBeNull()
  })

  it('инпейнт (ABC-313): LoadImage «mask» — роль mask, не реф; ref1 image — реф; denoise сквозь SetLatentNoiseMask; ckpt', () => {
    const r = roles(wf('sd-inpaint.json'), info)
    expect(r.refs).toEqual([{ nodeId: '1', input: 'image', index: 1, label: 'image' }])
    expect(r.mask).toEqual({ nodeId: '2', input: 'image' })
    expect(r.denoise).toEqual({ nodeId: '13', input: 'denoise' })
    expect(r.ckpt).toEqual({ nodeId: '8', input: 'ckpt_name' })
    expect(r.size).toBeNull()
    expect(roles(IMG2IMG, info).mask).toBeNull()
  })

  it('подпись слота из хвоста титула; промпт сквозь ControlNet', () => {
    const p = structuredClone(SDXL_CN)
    delete p['2']!._meta
    delete p['3']!._meta
    const r = roles(p, info)
    expect(r.refs).toEqual([
      { nodeId: '10', input: 'image', index: 1, label: 'лицо' },
      { nodeId: '11', input: 'image', index: 2, label: 'поза' },
    ])
    expect(r.prompt).toEqual({ nodeId: '2', input: 'text' })
    expect(r.negative).toEqual({ nodeId: '3', input: 'text' })
  })

  it('ссылка вместо литерала ролью не считается', () => {
    const p = structuredClone(IMG2IMG)
    p['6']!.inputs.seed = ['1', 0]
    expect(roles(p, info).seed).toBeNull()
  })
})

describe('pruneEmptyLoaders', () => {
  const WF: Prompt = {
    '1': { class_type: 'LoadImage', inputs: { image: '' } },
    '2': { class_type: 'ImageScale', inputs: { image: ['1', 0], width: 512 } },
    '3': { class_type: 'Encoder', inputs: { prompt: '', clip: ['4', 0], image1: ['2', 0] } },
    '4': { class_type: 'CLIPLoader', inputs: { clip_name: 'c' } },
  }

  it('пустой лоадер и его цепочка вырезаны, вход потребителя отрезан (без objectInfo)', () => {
    const wf = structuredClone(WF)
    expect(pruneEmptyLoaders(wf).sort()).toEqual(['1', '2'])
    expect(Object.keys(wf)).toEqual(['3', '4'])
    expect(wf['3']!.inputs.image1).toBeUndefined()
  })

  it('непустой лоадер не трогается', () => {
    const wf = structuredClone(WF)
    wf['1']!.inputs.image = 'x.png'
    expect(pruneEmptyLoaders(wf)).toEqual([])
    expect(Object.keys(wf)).toHaveLength(4)
  })

  it('qwen21-edit: пустые ref2..10 и их scale уходят, у Encoder остаётся image_1', () => {
    const p = wf('qwen21-edit.json')
    const removed = pruneEmptyLoaders(p, info)
    expect(removed).toHaveLength(18)
    expect(Object.keys(p['encoder']!.inputs).filter((k) => k.startsWith('images.'))).toEqual(['images.image_1'])
  })

  it('SDXL: без ref2 ControlNet обходится — positive/negative сэмплера ведут прямо в CLIPTextEncode', () => {
    const wf = structuredClone(SDXL_CN)
    wf['11']!.inputs.image = ''
    pruneEmptyLoaders(wf, info)
    expect(wf['13']).toBeUndefined()
    expect(wf['17']!.inputs.positive).toEqual(['2', 0])
    expect(wf['17']!.inputs.negative).toEqual(['3', 0])
    expect(wf['17']!.inputs.model).toEqual(['15', 0])
  })

  it('SDXL: без ref1 IPAdapter обходится — model ведёт в чекпоинт', () => {
    const wf = structuredClone(SDXL_CN)
    wf['10']!.inputs.image = ''
    pruneEmptyLoaders(wf, info)
    expect(wf['15']).toBeUndefined()
    expect(wf['17']!.inputs.model).toEqual(['1', 0])
    expect(wf['17']!.inputs.positive).toEqual(['13', 0])
  })

  it('SDXL: оба пустые — граф сходится к чекпоинту и энкодерам', () => {
    const wf = structuredClone(SDXL_CN)
    wf['10']!.inputs.image = ''
    wf['11']!.inputs.image = ''
    pruneEmptyLoaders(wf, info)
    expect(wf['17']!.inputs).toMatchObject({ model: ['1', 0], positive: ['2', 0], negative: ['3', 0] })
  })

  it('img2img без рефа: VAEEncode обойти нечем — PruneError', () => {
    const wf = structuredClone(IMG2IMG)
    wf['4']!.inputs.image = ''
    expect(() => pruneEmptyLoaders(wf, info)).toThrow(PruneError)
  })
})
