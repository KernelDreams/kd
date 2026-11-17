// nrd-exec — исполнение блоков NRD. PORTABLE ядро.
// Spec: docs/specs/nrd-exec-spec.md §7.4.
//
// `execBlock` знает блок-семантику: распознать движок из имени блока, снять
// fence, резолвить `${}`, распарсить результат → IContext. Само исполнение
// инъектируется через `Executor` (как `driver` в `createStorage`) — ни одного
// `child_process`, ядро работает везде, где есть JS.

import {
  resolve,
  chainContext,
  objectContext,
  parseDocument,
  wrapValue,
  isContext,
  emptyContext,
  type NRDocument,
  type IContext,
} from '../core/index.js'
// Типы дерева — напрямую из кодека: nrd-core их лишь реэкспортирует ( §2.B).
import type { Block, BodyValue, AttributeValue } from '../md/index.js'
import { ok, err, type Result } from '../contracts/index.js'
import type { Executor, ExecInput, ExecOutput, Engine } from './executor.js'

export type { Executor, ExecInput, ExecOutput, Engine } from './executor.js'
// spawnExecutor — Node-only: import { spawnExecutor } from '../node/index.js'

const ENGINES: ReadonlySet<string> = new Set<Engine>(['shell', 'ts', 'zx'])

/** Служебные атрибуты — НЕ попадают в block-local контекст резолва. */
const SERVICE = new Set([
  'nr-parse',
  'cwd',
  'env',
  'timeout',
  'nr-raw',
  'nr-mode',
  'shell-bin',
])

export interface ExecBlockOptions {
  /** ОБЯЗАТЕЛЕН — инъекция исполнения (как driver в createStorage). */
  executor: Executor
  /** Внешний контекст для резолва тела. */
  external?: IContext
  /** cwd по умолчанию. */
  baseDir?: string
}

type ParseMode = 'text' | 'json' | 'mdd' | 'mdz'

interface BlockAttrs {
  locals: Record<string, unknown>
  env?: Record<string, string>
  cwd?: string
  timeout?: number
  raw: boolean
  parse: ParseMode
}

// ---------- Body / fence ----------

function bodyText(b: BodyValue | undefined): string {
  if (b === undefined) return ''
  return typeof b === 'string' ? b : b.raw
}

/**
 * Снять fence с тела. Fence обязателен (§3) — отделяет mdz-декларацию от
 * исполняемого тела. Берём содержимое между первой ` ``` ` и последней ` ``` `.
 * Без fence — тело целиком (lenient). Незакрытый fence — отбрасываем открывашку.
 */
function stripFence(raw: string): string {
  const lines = raw.replace(/\r\n/g, '\n').split('\n')
  let start = 0
  while (start < lines.length && lines[start].trim() === '') start++
  if (start >= lines.length) return ''
  if (!lines[start].trim().startsWith('```')) return lines.slice(start).join('\n')
  let end = lines.length - 1
  while (end > start && lines[end].trim() === '') end--
  if (end > start && lines[end].trim().startsWith('```')) {
    return lines.slice(start + 1, end).join('\n')
  }
  return lines.slice(start + 1).join('\n')
}

// ---------- Attributes ----------

/** AttributeValue → плоское JS-значение (interpolated резолвится против external). */
function attrToValue(v: AttributeValue, external?: IContext): unknown {
  if (v === null || typeof v !== 'object') return v // scalar
  if (Array.isArray(v)) return v.map((item) => attrToValue(item as AttributeValue, external))
  if ('raw' in v) return resolve((v as { raw: string }).raw, external ?? emptyContext)
  return v
}

function asString(v: unknown): string | undefined {
  return v === undefined || v === null ? undefined : String(v)
}

function readAttrs(block: Block, external?: IContext): BlockAttrs {
  const locals: Record<string, unknown> = {}
  const env: Record<string, string> = {}
  let hasEnv = false
  const out: BlockAttrs = { locals, raw: false, parse: 'text' }

  // Last-wins (§2.4) — поздний атрибут перебивает ранний.
  for (const a of block.attrs) {
    const key = a.key.join('.')
    if (key.startsWith('env.')) {
      const name = key.slice('env.'.length)
      const s = asString(attrToValue(a.value, external))
      if (s !== undefined) {
        env[name] = s
        hasEnv = true
      }
      continue
    }
    if (SERVICE.has(key)) {
      const val = attrToValue(a.value, external)
      switch (key) {
        case 'nr-parse':
          out.parse = String(val) as ParseMode
          break
        case 'cwd':
          out.cwd = asString(val)
          break
        case 'timeout':
          out.timeout = typeof val === 'number' ? val : Number(val)
          break
        case 'nr-raw':
          out.raw = val === true || val === 'true'
          break
        // nr-mode / shell-bin — распознаны (не попадают в locals), но ExecInput
        // их не несёт (portable-контракт): подсказки для конкретного executor'а.
      }
      continue
    }
    locals[key] = attrToValue(a.value, external)
  }

  if (hasEnv) out.env = env
  return out
}

// ---------- Result → IContext ----------

function toContext(out: ExecOutput, mode: ParseMode): IContext {
  // §6.1 — in-process executor отдал нативный return: оборачиваем напрямую.
  if (out.value !== undefined) {
    const w = wrapValue(out.value)
    if (isContext(w)) return w
    return objectContext({ value: out.value })
  }
  // §6.2 — spawn: парсим stdout по $nr-parse.
  const stdout = out.stdout
  switch (mode) {
    case 'json': {
      const parsed = JSON.parse(stdout)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return objectContext(parsed as Record<string, unknown>)
      }
      return objectContext({ value: parsed })
    }
    case 'mdd':
      return parseDocument(stdout, { sigil: '@' })
    case 'mdz':
      return parseDocument(stdout, { sigil: '$' })
    case 'text':
    default:
      return objectContext({ content: stdout })
  }
}

// ---------- execBlock ----------

/**
 * Исполнить один блок → IContext. Алгоритм (§7.4):
 * 1. engine из `block.name`; не в `executor.supports` → `Result.err`.
 * 2. chain([blockLocals, external]) — block-local перебивает external (§4).
 * 3. снять fence, резолв `${}` (если не `$nr-raw`).
 * 4. `executor.run(...)`.
 * 5. ExecOutput → IContext: `value` напрямую, иначе `stdout` по `$nr-parse`.
 * 6. code ≠ 0 → `Result.err` со stderr.
 */
export async function execBlock(
  block: Block,
  opts: ExecBlockOptions,
): Promise<Result<IContext>> {
  const { executor, external, baseDir } = opts
  const engine = block.name as Engine

  if (!ENGINES.has(block.name)) {
    return err(new Error(`нераспознанный движок "${block.name}" (ожидался shell|ts|zx)`))
  }
  if (!executor.supports.has(engine)) {
    return err(
      new Error(`движок "${engine}" не поддерживается executor'ом "${executor.id}"`),
    )
  }

  const attrs = readAttrs(block, external)
  const blockLocals = objectContext(attrs.locals)
  const chain = external ? chainContext(blockLocals, external) : blockLocals

  const code = stripFence(bodyText(block.body))
  const resolved = attrs.raw ? code : resolve(code, chain)

  const input: ExecInput = {
    engine,
    code: resolved,
    env: attrs.env,
    cwd: attrs.cwd ?? baseDir,
    timeout: attrs.timeout,
  }

  const r = await executor.run(input)
  if (!r.ok) return err(r.error)

  const out = r.value
  if (out.code !== 0) {
    return err(new Error(out.stderr || `процесс завершился с кодом ${out.code}`))
  }

  try {
    return ok(toContext(out, attrs.parse))
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}

/**
 * Исполнить все exec-блоки (`shell`/`ts`/`zx`) документа → Record<id, IContext>.
 * Ключ — `block.id`, иначе `<engine>-<index>`. Первая ошибка прерывает.
 */
export async function execBlocks(
  doc: NRDocument,
  opts: ExecBlockOptions,
): Promise<Result<Record<string, IContext>>> {
  const result: Record<string, IContext> = {}
  let idx = 0
  for (const block of doc.doc.root.children) {
    if (!ENGINES.has(block.name)) continue
    const r = await execBlock(block, opts)
    if (!r.ok) return err(r.error)
    result[block.id ?? `${block.name}-${idx}`] = r.value
    idx++
  }
  return ok(result)
}
