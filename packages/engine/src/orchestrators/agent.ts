// AgentOrchestrator — tool loop until end_turn or maxIterations. Spec §3.3.
//
// v1 limitation: nr-infra's LLMMessage has no tool_use content block, so an
// assistant tool turn is fed back as assistant text + a `tool` role message
// carrying the result (which the provider maps to tool_result). Full native
// tool_use round-tripping waits on an nr-infra LLMMessage extension.

import type {
  LLMMessage,
  LLMProvider,
  OrchestratorHook,
  EngineResponse,
  IOrchestrator,
  ToolCall,
  ToolResult,
} from '../types.js'
import { streamCall, safeParse, type OrchestratorOptions } from './common.js'

export class AgentOrchestrator implements IOrchestrator {
  private aborted = false

  constructor(private opts: OrchestratorOptions) {}

  async execute(
    messages: LLMMessage[],
    provider: LLMProvider,
    hooks: OrchestratorHook[],
  ): Promise<EngineResponse> {
    this.aborted = false
    const max = this.opts.maxIterations ?? 10
    const convo: LLMMessage[] = [...messages]

    let res = await streamCall(convo, provider, hooks, this.opts, () => this.aborted)
    let iter = 0

    while (res.stopReason === 'tool_use' && iter < max && !this.aborted) {
      iter++

      const assistantText = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.body)
        .join('\n')
      if (assistantText) convo.push({ role: 'assistant', content: assistantText })

      for (const tu of res.content.filter((b) => b.type === 'tool_use')) {
        const call: ToolCall = {
          id: String(tu.attrs['call_id'] ?? ''),
          name: String(tu.attrs['name'] ?? ''),
          input: safeParse(tu.body),
        }

        let result: ToolResult = { content: '', error: 'no handleToolUse hook' }
        for (const h of hooks) {
          if (h.handleToolUse) {
            result = await h.handleToolUse(call)
            break
          }
        }
        for (const h of hooks) {
          h.onEvent?.({ type: 'tool_result', id: call.id, content: result.content, error: result.error })
        }

        convo.push({
          role: 'tool',
          content: typeof result.content === 'string' ? result.content : JSON.stringify(result.content),
          tool_call_id: call.id,
          name: call.name,
        })
      }

      res = await streamCall(convo, provider, hooks, this.opts, () => this.aborted)
    }

    return res
  }

  abort(): void {
    this.aborted = true
  }
}
