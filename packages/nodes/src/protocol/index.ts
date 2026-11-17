// Протокол исполнения схем (node-canvas-spec §5): контракт «редактор ⇄ исполнитель», не способ
// исполнения. JSON-RPC 2.0 поверх stdio / WebSocket / HTTP+SSE; исполнитель — на любом языке.
// Рукопожатие — как ACP, отладка — как DAP, события узлов — как ComfyUI (завершение и выход — разные
// события), подключение к чужому прогону — Rivet, вопрос человеку — LangGraph, журнал — Temporal.
//
// Прогон хранится как сейчас — след `run.trace.jsonl` (runz, pipeline-run-spec): `fromTrace` переводит
// записи следа в события этого протокола, второго пути рядом нет.

import type { RunAddress, SchemaModel } from '../schema/types.js'

export const PROTOCOL_VERSION = 1

// ---------- рукопожатие ----------

export type RunMode = 'graph' | 'subgraph' | 'node'
export type Continuation = 'continuation' | 'restart-node' | 'replay' | 'none'

export interface ExecutorCapabilities {
  modes: RunMode[]
  debug?: { pause?: boolean; step?: boolean; breakpoints?: boolean; variables?: boolean }
  /** Какие события шлёт (`node.value`, `bt.status`…). */
  events: EventType[]
  /** Как продолжает после вопроса человеку. */
  continuation: Continuation
  /** Каталог типов узлов: виды схем и хэш ревизии каталога. */
  catalog?: { kinds: string[]; revision: string }
}

export interface InitializeParams {
  protocolVersion: number
  client: { name: string; version?: string }
}

export interface InitializeResult {
  protocolVersion: number
  executor: { name: string; version?: string }
  capabilities: ExecutorCapabilities
}

// ---------- методы редактор → исполнитель ----------

/** Граф inline, по ссылке на ревизию или заранее зарегистрированный. */
export type GraphRef = { inline: SchemaModel } | { ref: string; revision?: string } | { registered: string }

export interface RunStartParams {
  graph: GraphRef
  mode?: RunMode
  /** Режим `subgraph` / `node`: с чего начать. */
  target?: RunAddress
  inputs?: Record<string, unknown>
  /** Сид, счётчики — что вид схемы понимает. */
  options?: Record<string, unknown>
}

export interface Methods {
  initialize: { params: InitializeParams; result: InitializeResult }
  'run.start': { params: RunStartParams; result: { runId: string } }
  'run.attach': { params: { runId: string; fromSequence?: number }; result: { runId: string; sequence: number } }
  'run.cancel': { params: { runId: string }; result: { ok: boolean } }
  'run.pause': { params: { runId: string }; result: { ok: boolean } }
  'run.resume': { params: { runId: string }; result: { ok: boolean } }
  'debug.step': { params: { runId: string; kind?: 'into' | 'over' | 'out' }; result: { ok: boolean } }
  'debug.breakpoints.set': { params: { runId?: string; breakpoints: RunAddress[] }; result: { ok: boolean } }
  'debug.variables.get': { params: { runId: string; at?: RunAddress }; result: { variables: Record<string, unknown> } }
  'interaction.respond': { params: { runId: string; interactionId: string; value: unknown }; result: { ok: boolean } }
  'artifact.get': { params: { runId: string; artifact: string }; result: { mime: string; url?: string; text?: string } }
}

export type MethodName = keyof Methods
export const METHODS = [
  'initialize',
  'run.start',
  'run.attach',
  'run.cancel',
  'run.pause',
  'run.resume',
  'debug.step',
  'debug.breakpoints.set',
  'debug.variables.get',
  'interaction.respond',
  'artifact.get',
] as const satisfies readonly MethodName[]

// ---------- события исполнитель → редактор ----------

/** Большие данные — ссылкой, не байтами. */
export interface ArtifactRef {
  artifact: string
  mime?: string
  size?: number
}

interface Base {
  runId: string
  sequence: number
  /** ISO-время. */
  t?: string
  at?: RunAddress
}

export type ExecEvent =
  | (Base & { type: 'node.started'; title?: string; icon?: string })
  | (Base & { type: 'node.progress'; value: number; max?: number; text?: string })
  | (Base & { type: 'node.value'; value?: unknown; artifact?: ArtifactRef })
  | (Base & { type: 'node.completed'; ms?: number })
  | (Base & { type: 'node.cached' })
  | (Base & { type: 'node.failed'; error: string; ms?: number })
  | (Base & { type: 'state.entered' })
  | (Base & { type: 'state.exited' })
  | (Base & { type: 'transition.fired'; relation?: string })
  | (Base & { type: 'bt.status'; status: 'running' | 'success' | 'failure' | 'idle' })
  | (Base & { type: 'variable.changed'; name: string; value: unknown })
  | (Base & { type: 'log'; level?: 'debug' | 'info' | 'warn' | 'error'; text: string; data?: Record<string, unknown> })
  | (Base & { type: 'interaction.requested'; interactionId: string; prompt: string; schema?: unknown })
  | (Base & { type: 'run.paused' })
  | (Base & { type: 'run.completed'; ms?: number; outputs?: Record<string, unknown> })
  | (Base & { type: 'run.failed'; error: string; ms?: number })
  | (Base & { type: 'run.cancelled' })

export type EventType = ExecEvent['type']

/** Событие без `runId` / `sequence` — их ставит тот, кто шлёт (распределённо по вариантам union). */
export type ExecEventInit = ExecEvent extends infer E ? (E extends ExecEvent ? Omit<E, 'runId' | 'sequence'> : never) : never

export const EVENT_TYPES: readonly EventType[] = [
  'node.started',
  'node.progress',
  'node.value',
  'node.completed',
  'node.cached',
  'node.failed',
  'state.entered',
  'state.exited',
  'transition.fired',
  'bt.status',
  'variable.changed',
  'log',
  'interaction.requested',
  'run.paused',
  'run.completed',
  'run.failed',
  'run.cancelled',
]

/** Событие, которого редактор не знает: рисуется как непонятное, редактор не падает (как `custom` в чате). */
export interface UnknownEvent {
  type: 'unknown'
  runId?: string
  sequence?: number
  raw: unknown
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Разобрать событие с провода: известное — как есть, прочее — `unknown`, никогда не throw. */
export function parseEvent(raw: unknown): ExecEvent | UnknownEvent {
  if (!isObj(raw) || typeof raw.type !== 'string' || !(EVENT_TYPES as readonly string[]).includes(raw.type)) {
    return { type: 'unknown', runId: isObj(raw) && typeof raw.runId === 'string' ? raw.runId : undefined, sequence: isObj(raw) && typeof raw.sequence === 'number' ? raw.sequence : undefined, raw }
  }
  if (typeof raw.runId !== 'string' || typeof raw.sequence !== 'number') return { type: 'unknown', raw }
  return raw as unknown as ExecEvent
}

// ---------- JSON-RPC 2.0 ----------

export interface RpcRequest<M extends MethodName = MethodName> {
  jsonrpc: '2.0'
  id: number | string
  method: M
  params: Methods[M]['params']
}
export interface RpcNotification {
  jsonrpc: '2.0'
  method: 'event'
  params: ExecEvent
}
export interface RpcResponse<M extends MethodName = MethodName> {
  jsonrpc: '2.0'
  id: number | string
  result?: Methods[M]['result']
  error?: { code: number; message: string; data?: unknown }
}

export function request<M extends MethodName>(id: number | string, method: M, params: Methods[M]['params']): RpcRequest<M> {
  return { jsonrpc: '2.0', id, method, params }
}

export function notifyEvent(ev: ExecEvent): RpcNotification {
  return { jsonrpc: '2.0', method: 'event', params: ev }
}

// ---------- след runz → события ----------

/** Запись следа `run.trace.jsonl` (runz-runtime `TraceEvent`). */
export interface TraceRecord {
  t?: string
  ev: string
  step?: string
  part?: string
  ms?: number
  model?: string
  tokens_in?: number
  tokens_out?: number
  cost?: number
  out?: string
  ok?: boolean
  error?: string
  doc?: string
  run?: string
  icon?: string
  title?: string
}

/**
 * Записи следа → события протокола. Шаг — сущность (`step`), ветка шага (`part`) — путь экземпляра;
 * выход шага (`out`) — отдельное событие `node.value` ссылкой, завершение — `node.completed` / `node.failed`.
 * `llm` — `log` с моделью и токенами. Незнакомая запись — `log` уровня debug (не теряется).
 */
export function fromTrace(records: Iterable<TraceRecord>, runId?: string): ExecEvent[] {
  const out: ExecEvent[] = []
  let id = runId ?? 'run'
  let seq = 0
  const at = (r: TraceRecord): RunAddress | undefined => (r.step ? { entity: r.step, ...(r.part ? { instance: [r.part] } : {}) } : undefined)
  for (const r of records) {
    const base = { runId: id, t: r.t }
    switch (r.ev) {
      case 'run.start':
        if (!runId && r.run) id = r.run
        out.push({ ...base, runId: id, sequence: seq++, type: 'log', level: 'info', text: `прогон ${r.doc ?? ''}`.trim(), data: { doc: r.doc } })
        break
      case 'step.start':
        out.push({ ...base, sequence: seq++, type: 'node.started', at: at(r), title: r.title, icon: r.icon })
        break
      case 'step.end':
        if (r.ok === false) out.push({ ...base, sequence: seq++, type: 'node.failed', at: at(r), error: r.error ?? 'ошибка', ms: r.ms })
        else {
          if (r.out) out.push({ ...base, sequence: seq++, type: 'node.value', at: at(r), artifact: { artifact: r.out } })
          out.push({ ...base, sequence: seq++, type: 'node.completed', at: at(r), ms: r.ms })
        }
        break
      case 'llm':
        out.push({ ...base, sequence: seq++, type: 'log', level: 'info', at: at(r), text: `модель ${r.model ?? '?'}`, data: { model: r.model, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost: r.cost, ms: r.ms } })
        break
      case 'run.end':
        out.push(r.ok === false ? { ...base, sequence: seq++, type: 'run.failed', error: r.error ?? 'ошибка', ms: r.ms } : { ...base, sequence: seq++, type: 'run.completed', ms: r.ms })
        break
      default:
        out.push({ ...base, sequence: seq++, type: 'log', level: 'debug', text: `запись следа ${r.ev}`, data: r as unknown as Record<string, unknown> })
    }
  }
  return out
}

/** Текст `run.trace.jsonl` → события (битые строки — `log` warn, не throw). */
export function fromTraceText(text: string, runId?: string): ExecEvent[] {
  const recs: TraceRecord[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      recs.push(JSON.parse(s) as TraceRecord)
    } catch {
      recs.push({ ev: 'bad-line', error: s.slice(0, 200) })
    }
  }
  return fromTrace(recs, runId)
}

// ---------- состояние прогона по событиям ----------

export type NodeRunStatus = 'running' | 'done' | 'cached' | 'failed'

export interface RunState {
  runId?: string
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
  /** Ключ — `entity` или `entity@inst1/inst2`. */
  nodes: Record<string, { status: NodeRunStatus; value?: unknown; artifact?: ArtifactRef; error?: string; ms?: number }>
  logs: string[]
  unknown: number
  lastSequence: number
}

export const addressKey = (a: RunAddress | undefined): string => (a ? `${a.entity}${a.instance?.length ? `@${a.instance.join('/')}` : ''}` : '')

export function initialRunState(): RunState {
  return { status: 'idle', nodes: {}, logs: [], unknown: 0, lastSequence: -1 }
}

/** Свернуть событие в состояние (для подсветки узлов на полотне). Чистая функция. */
export function reduceRun(s: RunState, ev: ExecEvent | UnknownEvent): RunState {
  if (ev.type === 'unknown') return { ...s, unknown: s.unknown + 1 }
  const n = { ...s, runId: s.runId ?? ev.runId, lastSequence: Math.max(s.lastSequence, ev.sequence) }
  const k = addressKey(ev.at)
  const set = (patch: RunState['nodes'][string]) => {
    n.nodes = { ...n.nodes, [k]: { ...n.nodes[k], ...patch } }
  }
  switch (ev.type) {
    case 'node.started':
      n.status = 'running'
      set({ status: 'running' })
      break
    case 'node.value':
      set({ status: n.nodes[k]?.status ?? 'running', value: ev.value, artifact: ev.artifact })
      break
    case 'node.completed':
      set({ status: 'done', ms: ev.ms })
      break
    case 'node.cached':
      set({ status: 'cached' })
      break
    case 'node.failed':
      set({ status: 'failed', error: ev.error, ms: ev.ms })
      break
    case 'log':
      n.logs = [...n.logs, ev.text]
      break
    case 'run.paused':
      n.status = 'paused'
      break
    case 'run.completed':
      n.status = 'completed'
      break
    case 'run.failed':
      n.status = 'failed'
      n.logs = [...n.logs, ev.error]
      break
    case 'run.cancelled':
      n.status = 'cancelled'
      break
  }
  return n
}
