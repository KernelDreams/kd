/**
 * helpers.image (image-gen-spec §3) на моке: `$provider: mock` →
 * mockImageProvider (PNG 1×1, без сети). Файл и `.json` провенанса на месте,
 * `out` с N>1, дефолтный путь в `{dataDir}/image/{дата}/`.
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildChain, execute, listImageProviders, resolveImageProvider } from '@kerneldreams/runz-runtime'
import { parseDocument } from '@kerneldreams/nrd'
import type { ScriptResult, Value } from '@kerneldreams/runz-runtime'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(HERE, 'fixtures', 'image')

const temps: string[] = []
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'runz-image-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true })
})

async function run(args: Record<string, Value>): Promise<ScriptResult> {
  const r = await execute({ script: path.join(FIX, 'image.mdz'), args, cwd: FIX, env: {} })
  return r.result as ScriptResult
}

describe('helpers.image', () => {
  it('мок: файл + провенанс, out с N>1, дефолтный путь в dataDir', async () => {
    const out = tmp()
    const dataDir = tmp()
    const res = await run({ out, dataDir })
    expect(res.exitCode ?? 0).toBe(0)
    const r = JSON.parse(res.output ?? '{}')

    expect(r.one.files).toEqual([path.join(out, 'fox.png')])
    const png = fs.readFileSync(r.one.files[0])
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])
    const prov = JSON.parse(fs.readFileSync(r.one.files[0] + '.json', 'utf-8'))
    expect(prov).toMatchObject({
      prompt: 'a red fox in snow',
      model: 'flux-3-image',
      provider: 'mock',
      params: { resolution: '1k' },
      refs: [],
      meta: { model: 'flux-3-image', id: 'mock' },
    })

    expect(r.many.files.map((f: string) => path.basename(f))).toEqual(['fox.png', 'fox-2.png', 'fox-3.png'])
    for (const f of r.many.files) expect(fs.existsSync(f + '.json')).toBe(true)
    expect(r.many.meta.model).toBe('flux-2-pro')

    expect(r.auto.files[0].startsWith(path.join(dataDir, 'image') + path.sep)).toBe(true)
    expect(r.auto.files[0]).toMatch(/\d{4}-\d{2}-\d{2}[/\\]\d{6}-1\.png$/)
  })

  it('провайдер без поддержки картинок — ошибка с именем и типом', async () => {
    await expect(run({ out: tmp(), run: 'noprov', image_provider: 'plain' })).rejects.toThrow(
      /провайдер "plain" \(\$type: не задан\) не умеет медиа; поддержаны: bfl, nanogpt, comfy, google, vertex, gate, mock/,
    )
  })
})

describe('resolveImageProvider / listImageProviders (image-gen-2-spec §5)', () => {
  const chain = (cfg: string, doc = '$x: 1\n') =>
    buildChain({ cliArgs: {}, doc: parseDocument(doc), globalConfig: parseDocument(cfg) } as never)
  const CFG = [
    '$comfy: http://127.0.0.1:9',
    '',
    '## $provider nano',
    '$type: nanogpt',
    '$base_url: https://nano.example/api/v1',
    '$api_key: test-key-1',
    '',
    '## $provider flux',
    '$type: bfl',
    '$base_url: https://bfl.example',
    '$api_key: test-key-1',
    '',
    // Не `comfy`: блок с id `comfy` затенил бы корневой `$comfy` (id-lookup §8 раньше атрибута).
    '## $provider comfyui',
    '$type: comfy',
    '',
    '## $provider chat',
    '$type: openai',
    '$base_url: https://llm.example/v1',
    '',
    '## $provider gemini',
    '$type: google',
    '$api_key: test-key-1',
    '',
    '## $provider vtx',
    '$type: vertex',
    '$project: proj-1',
    '$gcloud: /nonexistent/gcloud',
    '',
    '## $provider gw',
    '$type: gate',
    '$base_url: http://127.0.0.1:9/v1',
    '$api_key: gate-key',
    '',
  ].join('\n')

  it('listImageProviders — блоки с $type bfl/nanogpt/comfy/google/vertex, по порядку конфига', () => {
    expect(listImageProviders(chain(CFG))).toEqual(['nano', 'flux', 'comfyui', 'gemini', 'vtx', 'gw'])
  })

  it('google (media-gen-spec §2) — провайдер со схемой по семейству без сети; без ключа — ошибка', async () => {
    const s = await resolveImageProvider(chain(CFG), 'gemini')
    const sc = await s.provider.schema!('veo-3.1-lite-generate-preview')
    expect(sc.ok && sc.value).toMatchObject({ kind: 'video', refRole: 'frames', maxRefs: 2 })
    const noKey = CFG.replace('$type: google\n$api_key: test-key-1', '$type: google')
    await expect(resolveImageProvider(chain(noKey), 'gemini')).rejects.toThrow(/"gemini" \(\$type: google\) — нет ключа/)
  })

  it('vertex — без $project ошибка; токен — gcloud из $gcloud (ошибка называет команду)', async () => {
    // $gcloud, которого нет на диске, после уходит в поиск (и находит настоящий gcloud машины) —
    // берём существующий подставной, который падает.
    const gcloud = path.join(tmp(), 'gcloud')
    fs.writeFileSync(gcloud, '#!/bin/sh\necho "no adc" >&2\nexit 1\n', { mode: 0o755 })
    const s = await resolveImageProvider(chain(CFG.replace('/nonexistent/gcloud', gcloud)), 'vtx')
    const r = await s.provider.generate({ model: 'gemini-3.1-flash-image', prompt: 'x' })
    expect(!r.ok && r.error.message).toContain(`токен Vertex не получен (${gcloud} auth application-default print-access-token): no adc`)
    await expect(resolveImageProvider(chain(CFG.replace('$project: proj-1\n', '')), 'vtx')).rejects.toThrow(/"vtx" \(\$type: vertex\) — нет \$project/)
  })

  it('gate (gate-media-spec §7) — gateMediaProvider по $base_url; без адреса — ошибка', async () => {
    const s = await resolveImageProvider(chain(CFG, '$video_provider: gw\n'), undefined, 'video')
    expect(s.name).toBe('gw')
    expect(typeof s.provider.models).toBe('function')
    const r = await s.provider.generate({ model: 'veo', prompt: 'x' })
    expect(!r.ok && r.error.message).toMatch(/^gate: /)
    await expect(resolveImageProvider(chain(CFG.replace('$base_url: http://127.0.0.1:9/v1\n', '')), 'gw')).rejects.toThrow(/"gw" \(\$type: gate\) — нет \$base_url/)
  })

  it('вид: $video_provider / $audio_provider сильнее $image_provider', async () => {
    const c = chain(CFG, '$image_provider: flux\n$video_provider: gemini\n')
    expect((await resolveImageProvider(c, undefined, 'video')).name).toBe('gemini')
    expect((await resolveImageProvider(c, undefined, 'audio')).name).toBe('flux')
    expect((await resolveImageProvider(c)).name).toBe('flux')
  })

  it('nanogpt — без ключа ошибка с типом; с ключом — провайдер с models()', async () => {
    const s = await resolveImageProvider(chain(CFG), 'nano')
    expect(s.name).toBe('nano')
    expect(typeof s.provider.models).toBe('function')
    const noKey = CFG.replace('$api_key: test-key-1\n\n## $provider flux', '\n## $provider flux')
    await expect(resolveImageProvider(chain(noKey), 'nano')).rejects.toThrow(/"nano" \(\$type: nanogpt\) — нет ключа/)
  })

  it('comfy — сервер из $comfy, шаблоны из $comfy_templates: models() без сети по ролям', async () => {
    const tpl = tmp()
    fs.copyFileSync(path.join(HERE, '..', '..', '..', 'comfy-client', 'test', 'fixtures', 'qwen21-edit.json'), path.join(tpl, 'qwen21-edit.json'))
    const s = await resolveImageProvider(chain(CFG, `$image_provider: comfyui\n$comfy_templates: ${tpl}\n`))
    expect(s.name).toBe('comfyui')
    const m = await s.provider.models!()
    expect(m.ok && m.value).toEqual([{ id: 'qwen21-edit', edit: true, maxRefs: 10 }])
  })

  it('comfy без сервера — ошибка', async () => {
    await expect(resolveImageProvider(chain(CFG.replace('$comfy: http://127.0.0.1:9', '')), 'comfyui')).rejects.toThrow(/нет сервера: \$server или \$comfy/)
  })
})
