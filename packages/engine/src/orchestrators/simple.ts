// SimpleOrchestrator — one call, no tool loop. For commit, translate, plain chat.
// Spec §3.3.

import type { LLMMessage, LLMProvider, OrchestratorHook, EngineResponse, IOrchestrator } from '../types.js'
import { streamCall, type OrchestratorOptions } from './common.js'

export class SimpleOrchestrator implements IOrchestrator {
  private aborted = false

  constructor(private opts: OrchestratorOptions) {}

  async execute(
    messages: LLMMessage[],
    provider: LLMProvider,
    hooks: OrchestratorHook[],
  ): Promise<EngineResponse> {
    this.aborted = false
    return streamCall(messages, provider, hooks, this.opts, () => this.aborted)
  }

  abort(): void {
    this.aborted = true
  }
}
