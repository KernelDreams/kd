// Component resolution from EngineConfig. Spec §2, §9 (convention-based).
// External modules (.nr-engine/...) and the ntpl assembler are out of scope here.

import type {
  EngineConfig,
  IAssembler,
  IOrchestrator,
  IHandler,
} from './types.js'
import { DirectAssembler } from './assembly/direct.js'
import { SimpleOrchestrator } from './orchestrators/simple.js'
import { AgentOrchestrator } from './orchestrators/agent.js'
import type { OrchestratorOptions } from './orchestrators/common.js'
import { ChatHandler } from './handlers/chat.js'
import { RawHandler } from './handlers/raw.js'
import { TranslateHandler } from './handlers/translate.js'
import { ExtractHandler } from './handlers/extract.js'
import { buildProvider, type ResolvedProvider } from './providers.js'

export function resolveAssembler(config: EngineConfig): IAssembler {
  const kind = config.assembly ?? 'direct'
  switch (kind) {
    case 'direct':
      return new DirectAssembler({
        user: config.display?.userName,
        char: config.display?.botName ?? config.bot,
        model: config.model,
      })
    case 'ntpl':
      throw new Error('nr-engine: NtplAssembler not implemented (after ntpl review)')
    default:
      throw new Error(`nr-engine: unknown assembly "${kind}"`)
  }
}

function orchestratorOptions(config: EngineConfig): OrchestratorOptions {
  if (!config.model) throw new Error('nr-engine: config.model required for orchestration')
  const opts: OrchestratorOptions = { model: config.model }
  if (config.maxTokens !== undefined) opts.maxTokens = config.maxTokens
  if (config.temperature !== undefined) opts.temperature = config.temperature
  if (config.tools) opts.tools = config.tools
  if (config.thinking) opts.thinking = config.thinking
  if (config.maxIterations !== undefined) opts.maxIterations = config.maxIterations
  if (config.extra !== undefined) opts.extra = config.extra
  return opts
}

export function resolveOrchestrator(config: EngineConfig): IOrchestrator {
  const kind = config.orchestrator ?? 'simple'
  const opts = orchestratorOptions(config)
  switch (kind) {
    case 'simple':
      return new SimpleOrchestrator(opts)
    case 'agent':
      return new AgentOrchestrator(opts)
    default:
      throw new Error(`nr-engine: unknown orchestrator "${kind}"`)
  }
}

export function resolveHandler(config: EngineConfig): IHandler {
  const kind = config.handler ?? 'chat'
  switch (kind) {
    case 'chat':
      return new ChatHandler()
    case 'raw':
      return new RawHandler()
    case 'translate':
      return new TranslateHandler()
    case 'extract':
      return new ExtractHandler()
    default:
      throw new Error(`nr-engine: unknown handler "${kind}"`)
  }
}

export function resolveProvider(config: EngineConfig): ResolvedProvider {
  return buildProvider({
    provider: config.provider,
    model: config.model,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    type: config.providerType,
    think: config.think,
    timeout: typeof config.timeout === 'number' ? config.timeout : undefined,
  }, process.env)
}
