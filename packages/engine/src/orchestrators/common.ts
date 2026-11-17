// Shared single-call streaming routine used by both orchestrators.
// Consumes nr-infra's LLMChunk stream, emits typed StreamEvents through hooks,
// and assembles a typed EngineResponse (thinking / text / tool_use blocks).

import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  OrchestratorHook,
  EngineResponse,
  StreamEvent,
  ContentBlock,
  ToolDef,
} from '../types.js'
import type { ThinkingConfig } from '@kerneldreams/nrd/web'

export interface OrchestratorOptions {
  model: string
  maxTokens?: number
  temperature?: number
  tools?: ToolDef[]
  thinking?: ThinkingConfig
  maxIterations?: number
  /** Verbatim pass-through to LLMRequest.extra (backend-specific sampling, response_format, ...). */
  extra?: Record<string, unknown>
}

export function safeParse(json: string): unknown {
  try {
    return json ? JSON.parse(json) : {}
  } catch {
    return json
  }
}

/** Run one provider call, streaming events. Returns the assembled response. */
export async function streamCall(
  messages: LLMMessage[],
  provider: LLMProvider,
  hooks: OrchestratorHook[],
  opts: OrchestratorOptions,
  isAborted: () => boolean,
): Promise<EngineResponse> {
  let req: LLMRequest = { model: opts.model, messages, stream: true }
  if (opts.maxTokens !== undefined) req.max_tokens = opts.maxTokens
  if (opts.temperature !== undefined) req.temperature = opts.temperature
  if (opts.tools?.length) req.tools = opts.tools
  if (opts.thinking) req.thinking = opts.thinking
  if (opts.extra) req.extra = opts.extra

  for (const h of hooks) if (h.beforeRequest) req = await h.beforeRequest(req)

  const emit = (e: StreamEvent) => {
    for (const h of hooks) h.onEvent?.(e)
  }

  let textBuf = ''
  let thinkBuf = ''
  let stopReason = 'end_turn'
  let usage: { input: number; output: number } | undefined
  const toolOrder: string[] = []
  const toolAcc = new Map<string, { id: string; name: string; json: string }>()

  for await (const chunk of provider.stream(req)) {
    if (isAborted()) break
    switch (chunk.type) {
      case 'text':
        if (chunk.text) {
          textBuf += chunk.text
          emit({ type: 'delta', text: chunk.text })
        }
        break
      case 'thinking':
        if (chunk.text) {
          thinkBuf += chunk.text
          emit({ type: 'thinking_delta', text: chunk.text })
        }
        break
      case 'tool_call_start': {
        const tc = chunk.tool_call
        if (tc?.id) {
          toolOrder.push(tc.id)
          toolAcc.set(tc.id, { id: tc.id, name: tc.name ?? '', json: '' })
        }
        break
      }
      case 'tool_call_delta': {
        const id = chunk.tool_call?.id ?? toolOrder[toolOrder.length - 1]
        if (id && toolAcc.has(id)) toolAcc.get(id)!.json += chunk.text ?? ''
        break
      }
      case 'done':
        if (chunk.stop_reason) stopReason = chunk.stop_reason
        if (chunk.usage) {
          usage = { input: chunk.usage.input_tokens, output: chunk.usage.output_tokens }
        }
        break
    }
  }

  // Aborted mid-stream: discard the partial answer (§3.3).
  if (isAborted()) return { content: [], stopReason: 'cancelled', usage }

  const content: ContentBlock[] = []
  if (thinkBuf) content.push({ type: 'thinking', attrs: {}, body: thinkBuf })
  if (textBuf) content.push({ type: 'text', attrs: {}, body: textBuf })
  for (const id of toolOrder) {
    const tc = toolAcc.get(id)!
    content.push({ type: 'tool_use', attrs: { name: tc.name, call_id: tc.id }, body: tc.json || '{}' })
    emit({ type: 'tool_use', name: tc.name, id: tc.id, input: safeParse(tc.json) })
  }

  let res: EngineResponse = { content, stopReason, usage }
  for (const h of hooks) if (h.afterResponse) res = await h.afterResponse(res)
  return res
}
