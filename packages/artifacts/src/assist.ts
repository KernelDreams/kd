/**
 * Голос и модель для артефакта (DECISIONS 24.10 «артефакт без церемоний»): то, что
 * мини-приложению нужно всегда, — одной строкой, без своего `service.ts` и ключей в коде.
 * Источники даёт встраивающий (сервис nrchat — speak стенда и провайдер `$default_provider`);
 * нет источника — методы отвечают ошибкой.
 *
 *   speak.say(text, {voice?, speed?}) → {bytes, mime}        право `speak`
 *   speak.voices() → {default, voices[]}
 *   speak.transcribe(bytes, {mime?, language?, prompt?}) → {text}
 *   llm.complete(prompt | {prompt?, system?, messages?, model?, maxTokens?, temperature?, json?}) → {text, model}   право `llm`
 *   llm.models() → string[]
 */

export interface SpeakSource {
  say(text: string, opts: { voice?: string; speed?: number }): Promise<{ bytes: Uint8Array; mime: string }>
  voices(): Promise<unknown>
  transcribe(bytes: Uint8Array, opts: { mime?: string; language?: string; prompt?: string }): Promise<{ text: string }>
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface LlmRequest {
  messages: LlmMessage[]
  model?: string
  maxTokens?: number
  temperature?: number
  /** Ответ — JSON-объект (`response_format: json_object`, где провайдер умеет). */
  json?: boolean
}

export interface LlmSource {
  complete(req: LlmRequest): Promise<{ text: string; model: string }>
  models(): Promise<string[]>
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined)
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** Аргумент `llm.complete`: строка — один запрос пользователя; объект — prompt/system/messages. */
export function llmRequestOf(arg: unknown): LlmRequest {
  if (typeof arg === 'string') {
    if (!arg.trim()) throw new Error('llm.complete: пустой запрос')
    return { messages: [{ role: 'user', content: arg }] }
  }
  const a = obj(arg)
  const messages: LlmMessage[] = []
  const system = str(a.system)
  if (system) messages.push({ role: 'system', content: system })
  if (Array.isArray(a.messages)) {
    for (const m of a.messages) {
      const o = obj(m)
      const role = o.role === 'system' || o.role === 'assistant' ? o.role : 'user'
      const content = typeof o.content === 'string' ? o.content : ''
      if (content) messages.push({ role, content })
    }
  }
  const prompt = str(a.prompt)
  if (prompt) messages.push({ role: 'user', content: prompt })
  if (!messages.some((m) => m.role === 'user')) throw new Error('llm.complete: нужен prompt или messages')
  return {
    messages,
    ...(str(a.model) ? { model: str(a.model)! } : {}),
    ...(num(a.maxTokens) ? { maxTokens: num(a.maxTokens)! } : {}),
    ...(num(a.temperature) != null ? { temperature: num(a.temperature)! } : {}),
    ...(a.json === true ? { json: true } : {}),
  }
}

export function sayOptsOf(arg: unknown): { voice?: string; speed?: number } {
  const a = obj(arg)
  const speed = num(a.speed)
  return { ...(str(a.voice) ? { voice: str(a.voice)! } : {}), ...(speed && speed > 0 ? { speed: Math.min(4, Math.max(0.25, speed)) } : {}) }
}

export function transcribeOptsOf(arg: unknown): { mime?: string; language?: string; prompt?: string } {
  const a = obj(arg)
  return {
    ...(str(a.mime) ? { mime: str(a.mime)! } : {}),
    ...(str(a.language) ? { language: str(a.language)! } : {}),
    ...(str(a.prompt) ? { prompt: str(a.prompt)! } : {}),
  }
}
