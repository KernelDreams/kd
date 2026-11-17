/**
 * Тулы ComfyUI для агента («Схемы ComfyUI»): собрать и поправить граф из узлов, которые реально стоят на
 * сервере (`/object_info`), проверить его до запуска (ошибка — модели на исправление), запустить, забрать картинки
 * (PNG ComfyUI несёт граф внутри), прочитать граф из PNG. Один набор на backend-nr, ACP и MCP; сеть, сохранение и
 * чтение файла приходят снаружи — библиотека без своего ввода-вывода.
 *
 * Граф — API-формат ComfyUI: `{ "<id>": { "class_type": "KSampler", "inputs": { "seed": 1, "model": ["4", 0] } } }`.
 */

import type { ToolDef } from './types.js'

export type ComfyFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer>; text(): Promise<string> }>

export interface ComfyToolsOptions {
  /** Адрес ComfyUI (`http://127.0.0.1:8188`); функция — читается на каждый вызов (подключили на ходу). */
  server: string | (() => string | undefined)
  fetch: ComfyFetch
  /** Сохранить результат (PNG с графом внутри) — путь файла. Нет — тул отдаёт только имена на сервере. */
  save?(name: string, bytes: Uint8Array): Promise<string>
  /** Байты картинки по пути (граф из PNG). */
  read?(path: string): Promise<Uint8Array>
  /** Сколько ждать прогона, мс; default 10 мин. */
  timeout?: number
}

type InputSpec = [unknown, Record<string, unknown>?] | unknown[]
export interface NodeInfo {
  input?: { required?: Record<string, InputSpec>; optional?: Record<string, InputSpec> }
  output?: string[]
  output_name?: string[]
  category?: string
  display_name?: string
}
export type ObjectInfo = Record<string, NodeInfo>
export type ApiGraph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const trim = (s: string): string => s.replace(/\/+$/, '')

/** Граф из аргумента: объект или JSON-строка; UI-формат (`nodes`/`links`) — словами, что нужен API-формат. */
export function graphOf(v: unknown): ApiGraph {
  const g = typeof v === 'string' ? (JSON.parse(v) as unknown) : v
  if (!g || typeof g !== 'object' || Array.isArray(g)) throw new Error('граф — объект {id: {class_type, inputs}}')
  if ('nodes' in g && 'links' in g) throw new Error('это UI-граф ComfyUI (nodes/links); нужен API-формат {id: {class_type, inputs}} — «Save (API)»')
  if ('prompt' in g && typeof (g as { prompt: unknown }).prompt === 'object') return graphOf((g as { prompt: unknown }).prompt)
  return g as ApiGraph
}

/** Варианты входа-перечисления (`[["a","b"], {...}]` или новый `["COMBO", {options}]`). */
function enumOf(spec: InputSpec): string[] | null {
  const head = spec[0]
  if (Array.isArray(head)) return head.map(String)
  const opts = (spec[1] as { options?: unknown } | undefined)?.options
  if (head === 'COMBO' && Array.isArray(opts)) return opts.map(String)
  return null
}

/**
 * Проверка графа по узлам сервера: класс есть, обязательные входы заданы, ссылки ведут в существующие узлы и выходы,
 * значения перечислений из списка, числа в пределах. Пусто — граф годен.
 */
export function checkGraph(g: ApiGraph, info: ObjectInfo): string[] {
  const out: string[] = []
  for (const [id, node] of Object.entries(g)) {
    const where = `узел ${id}${node?._meta?.title ? ` «${node._meta.title}»` : ''}`
    if (!node || typeof node.class_type !== 'string') {
      out.push(`${where}: нет class_type`)
      continue
    }
    const def = info[node.class_type]
    if (!def) {
      const near = Object.keys(info).filter((k) => k.toLowerCase().includes(node.class_type.toLowerCase().slice(0, 6))).slice(0, 5)
      out.push(`${where}: класса ${node.class_type} на сервере нет${near.length ? ` (похожие: ${near.join(', ')})` : ''}`)
      continue
    }
    const inputs = node.inputs ?? {}
    const req = def.input?.required ?? {}
    const opt = def.input?.optional ?? {}
    for (const [name, spec] of Object.entries(req)) {
      if (!(name in inputs)) out.push(`${where} (${node.class_type}): нет обязательного входа ${name}`)
      else checkValue(where, node.class_type, name, inputs[name], spec, g, info, out)
    }
    for (const [name, v] of Object.entries(inputs)) {
      if (name in req) continue
      const spec = opt[name]
      if (!spec) {
        out.push(`${where} (${node.class_type}): входа ${name} у класса нет; есть: ${[...Object.keys(req), ...Object.keys(opt)].join(', ')}`)
        continue
      }
      checkValue(where, node.class_type, name, v, spec, g, info, out)
    }
  }
  if (!Object.values(g).some((n) => n && info[n.class_type]?.output && /Save|Preview/i.test(n.class_type))) out.push('в графе нет выхода картинки (SaveImage / PreviewImage)')
  return out
}

function checkValue(where: string, cls: string, name: string, v: unknown, spec: InputSpec, g: ApiGraph, info: ObjectInfo, out: string[]): void {
  if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number') {
    const src = g[v[0]]
    if (!src) return void out.push(`${where} (${cls}): вход ${name} ссылается на узел ${v[0]}, которого нет`)
    const outs = info[src.class_type]?.output
    if (outs && (v[1] < 0 || v[1] >= outs.length)) out.push(`${where} (${cls}): вход ${name} — выхода ${v[1]} у узла ${v[0]} (${src.class_type}) нет, выходов ${outs.length}`)
    const want = typeof spec[0] === 'string' ? spec[0] : null
    const got = outs?.[v[1]]
    if (want && got && want !== '*' && got !== '*' && !want.split(',').includes(got)) out.push(`${where} (${cls}): вход ${name} ждёт ${want}, а узел ${v[0]} отдаёт ${got}`)
    return
  }
  const list = enumOf(spec)
  if (list && !list.includes(String(v))) out.push(`${where} (${cls}): ${name} = «${String(v)}» нет в списке сервера; есть: ${list.slice(0, 12).join(', ')}${list.length > 12 ? '…' : ''}`)
  const o = (spec[1] ?? {}) as { min?: number; max?: number }
  if (typeof v === 'number' && ((typeof o.min === 'number' && v < o.min) || (typeof o.max === 'number' && v > o.max))) out.push(`${where} (${cls}): ${name} = ${v} вне пределов ${o.min ?? '−∞'}…${o.max ?? '∞'}`)
}

/** Короткая сводка узла для модели: входы (тип / варианты), выходы. */
export function nodeSummary(cls: string, n: NodeInfo, full = false): string {
  const fmt = (name: string, spec: InputSpec): string => {
    const list = enumOf(spec)
    if (list) return `${name}: ${full ? list.join(' | ') : `${list.slice(0, 6).join(' | ')}${list.length > 6 ? ` …(${list.length})` : ''}`}`
    const o = (spec[1] ?? {}) as { default?: unknown; min?: number; max?: number }
    return `${name}: ${String(spec[0])}${o.default !== undefined ? ` = ${JSON.stringify(o.default)}` : ''}${o.min !== undefined || o.max !== undefined ? ` [${o.min ?? ''}…${o.max ?? ''}]` : ''}`
  }
  const req = Object.entries(n.input?.required ?? {}).map(([k, s]) => fmt(k, s))
  const opt = Object.entries(n.input?.optional ?? {}).map(([k, s]) => fmt(k, s))
  return [`${cls}${n.display_name && n.display_name !== cls ? ` (${n.display_name})` : ''}`, req.length ? `  вход: ${req.join('; ')}` : '', opt.length ? `  необяз.: ${opt.join('; ')}` : '', `  выход: ${(n.output ?? []).join(', ') || '—'}`].filter(Boolean).join('\n')
}

/** Граф из PNG ComfyUI: текстовые чанки `prompt` (API) и `workflow` (UI). */
export function pngGraph(bytes: Uint8Array): { prompt?: ApiGraph; workflow?: unknown } {
  const out: { prompt?: ApiGraph; workflow?: unknown } = {}
  if (bytes.length < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return out
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const dec = new TextDecoder()
  for (let p = 8; p + 8 <= bytes.length; ) {
    const len = dv.getUint32(p)
    const type = dec.decode(bytes.subarray(p + 4, p + 8))
    const data = bytes.subarray(p + 8, p + 8 + len)
    if (type === 'tEXt' || type === 'iTXt') {
      const z = data.indexOf(0)
      const key = dec.decode(data.subarray(0, z))
      let text = data.subarray(z + 1)
      if (type === 'iTXt') {
        // флаг сжатия, метод, язык\0, перевод\0
        let q = 2
        q = text.indexOf(0, q) + 1
        q = text.indexOf(0, q) + 1
        text = text.subarray(q)
      }
      try {
        if (key === 'prompt') out.prompt = JSON.parse(dec.decode(text)) as ApiGraph
        if (key === 'workflow') out.workflow = JSON.parse(dec.decode(text))
      } catch {
        // битый чанк — мимо
      }
    }
    if (type === 'IEND') break
    p += 12 + len
  }
  return out
}

export function comfyTools(o: ComfyToolsOptions): ToolDef[] {
  const server = (): string => {
    const s = typeof o.server === 'function' ? o.server() : o.server
    if (!s) throw new Error('ComfyUI не подключён: «Локальные модели» → «Подключить» у ComfyUI')
    return trim(s)
  }
  let cache: { at: number; server: string; info: ObjectInfo } | null = null
  const objectInfo = async (): Promise<ObjectInfo> => {
    const s = server()
    if (cache && cache.server === s && Date.now() - cache.at < 60_000) return cache.info
    const r = await o.fetch(`${s}/object_info`)
    if (!r.ok) throw new Error(`ComfyUI ${s}: /object_info — HTTP ${r.status}`)
    const info = (await r.json()) as ObjectInfo
    cache = { at: Date.now(), server: s, info }
    return info
  }
  const tool = (name: string, description: string, schema: Record<string, unknown>, run: (a: Record<string, unknown>, signal?: AbortSignal) => Promise<string>): ToolDef => ({
    name,
    description,
    schema,
    executor: 'backend',
    source: 'registry',
    async execute(args: Record<string, unknown>, ctx: { signal?: AbortSignal }) {
      try {
        return { text: await run(args, ctx?.signal) }
      } catch (e) {
        return { text: `${name}: ${errText(e)}`, isError: true }
      }
    },
  })
  return [
    tool(
      'comfy_nodes',
      'Узлы, которые реально стоят на сервере ComfyUI: поиск по имени/категории (search) или полное описание одного класса (class) — входы с типами и вариантами (чекпойнты, сэмплеры), выходы. Собирай граф только из них.',
      { type: 'object', properties: { search: { type: 'string', description: 'часть имени или категории: "sampler", "upscale", "lora"' }, class: { type: 'string', description: 'точное имя класса — полное описание' } } },
      async (a) => {
        const info = await objectInfo()
        const cls = typeof a.class === 'string' ? a.class.trim() : ''
        if (cls) {
          const n = info[cls]
          if (!n) throw new Error(`класса ${cls} нет; поищи search`)
          return nodeSummary(cls, n, true)
        }
        const q = typeof a.search === 'string' ? a.search.trim().toLowerCase() : ''
        const hits = Object.entries(info).filter(([k, n]) => !q || k.toLowerCase().includes(q) || (n.category ?? '').toLowerCase().includes(q) || (n.display_name ?? '').toLowerCase().includes(q))
        if (!hits.length) return `по «${q}» узлов нет (всего на сервере ${Object.keys(info).length})`
        return [`узлов: ${hits.length}${hits.length > 25 ? ', первые 25 — уточни search' : ''}`, ...hits.slice(0, 25).map(([k, n]) => nodeSummary(k, n))].join('\n')
      },
    ),
    tool(
      'comfy_check',
      'Проверить граф ComfyUI (API-формат {id: {class_type, inputs}}) по узлам сервера до запуска: классы, обязательные входы, ссылки, варианты, пределы. Ответ — «граф годен» или список ошибок: исправь и проверь снова.',
      { type: 'object', properties: { workflow: { description: 'граф: объект или JSON-строка' } }, required: ['workflow'] },
      async (a) => {
        const errs = checkGraph(graphOf(a.workflow), await objectInfo())
        return errs.length ? `ошибок: ${errs.length}\n${errs.map((e) => `- ${e}`).join('\n')}` : 'граф годен'
      },
    ),
    tool(
      'comfy_run',
      'Запустить граф на ComfyUI (сначала comfy_check) и забрать картинки: файлы ложатся в открытую папку KD Pix, граф — внутри PNG. Ответ — пути файлов; ошибка ComfyUI — словами, исправь граф.',
      { type: 'object', properties: { workflow: { description: 'граф: объект или JSON-строка' }, name: { type: 'string', description: 'основа имени файлов' } }, required: ['workflow'] },
      async (a, signal) => {
        const g = graphOf(a.workflow)
        const info = await objectInfo()
        const errs = checkGraph(g, info)
        if (errs.length) throw new Error(`граф негоден, не запускаю:\n${errs.map((e) => `- ${e}`).join('\n')}`)
        const s = server()
        const r = await o.fetch(`${s}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: g, client_id: 'kd-pix' }), ...(signal ? { signal } : {}) })
        const body = (await r.json().catch(() => ({}))) as { prompt_id?: string; error?: { message?: string }; node_errors?: Record<string, { errors?: { message?: string; details?: string }[] }> }
        if (!r.ok || !body.prompt_id) {
          const ne = Object.entries(body.node_errors ?? {}).flatMap(([id, e]) => (e.errors ?? []).map((x) => `узел ${id}: ${x.message ?? ''} ${x.details ?? ''}`.trim()))
          throw new Error(`ComfyUI отказал: ${body.error?.message ?? `HTTP ${r.status}`}${ne.length ? `\n${ne.join('\n')}` : ''}`)
        }
        const deadline = Date.now() + (o.timeout ?? 600_000)
        let outputs: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }> | null = null
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error('остановлено')
          const h = await o.fetch(`${s}/history/${body.prompt_id}`)
          const hist = (await h.json().catch(() => ({}))) as Record<string, { outputs?: typeof outputs; status?: { status_str?: string; messages?: [string, { exception_message?: string }][] } }>
          const it = hist[body.prompt_id]
          if (it?.status?.status_str === 'error') {
            const m = it.status.messages?.find((x) => x[0] === 'execution_error')?.[1]?.exception_message
            throw new Error(`ComfyUI упал при прогоне: ${m ?? 'execution_error'}`)
          }
          if (it?.outputs && Object.keys(it.outputs).length) {
            outputs = it.outputs
            break
          }
          await new Promise((res) => setTimeout(res, 800))
        }
        if (!outputs) throw new Error(`ComfyUI не закончил за ${Math.round((o.timeout ?? 600_000) / 1000)} с`)
        const files: string[] = []
        const base = typeof a.name === 'string' && a.name.trim() ? a.name.trim() : 'comfy'
        for (const out of Object.values(outputs) as { images?: { filename: string; subfolder?: string; type?: string }[] }[]) {
          for (const im of out.images ?? []) {
            const q = new URLSearchParams({ filename: im.filename, subfolder: im.subfolder ?? '', type: im.type ?? 'output' })
            const res = await o.fetch(`${s}/view?${q}`)
            if (!res.ok) throw new Error(`ComfyUI /view ${im.filename}: HTTP ${res.status}`)
            const bytes = new Uint8Array(await res.arrayBuffer())
            files.push(o.save ? await o.save(`${base}-${files.length + 1}${/\.\w+$/.exec(im.filename)?.[0] ?? '.png'}`, bytes) : im.filename)
          }
        }
        if (!files.length) throw new Error('прогон прошёл, картинок на выходе нет (в графе нет SaveImage / PreviewImage?)')
        return `готово: ${files.join(', ')}`
      },
    ),
    tool(
      'comfy_workflow',
      'Граф ComfyUI из PNG (картинка, сгенерированная ComfyUI): API-граф для правки и запуска. Объясняй и правь схему открытой картинки по нему.',
      { type: 'object', properties: { path: { type: 'string', description: 'путь PNG' } }, required: ['path'] },
      async (a) => {
        if (!o.read) throw new Error('чтение файлов не подключено')
        const g = pngGraph(await o.read(String(a.path ?? '')))
        if (!g.prompt && !g.workflow) return 'в PNG нет графа ComfyUI'
        return g.prompt ? JSON.stringify(g.prompt) : `в PNG только UI-граф (без API): ${JSON.stringify(g.workflow).slice(0, 4000)}`
      },
    ),
  ]
}
