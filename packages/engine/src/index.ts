// @kerneldreams/engine — universal LLM execution pipeline.
// Spec: docs/specs/nr-engine-spec.md.
//
// After: pure generation. Storage is nr-chat-store (a SessionStore is
// passed via RunInput.target). Three pluggable interfaces (IAssembler,
// IOrchestrator, IHandler), convention-based resolution, one run() entry point.

// ---- entry point ----
export { run } from './run.js'

// ---- types ----
export type {
  // run target
  RunTarget,
  HandlerTarget,
  // assembler
  IAssembler,
  // orchestrator
  IOrchestrator,
  OrchestratorHook,
  EngineResponse,
  StreamEvent,
  ToolDef,
  ToolCall,
  ToolResult,
  // handler
  IHandler,
  HandlerResult,
  // config / run
  EngineConfig,
  RunInput,
  OperationResponse,
  // dialogue model (re-exported from nr-chat-store)
  StoreMessage,
  Part,
  MessageFlags,
  SessionStore,
  StoreNode,
  NodeInput,
  // context
  IContext,
  Value,
  // llm
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMTool,
} from './types.js'

// ---- resolution ----
export {
  resolveAssembler,
  resolveOrchestrator,
  resolveHandler,
  resolveProvider,
} from './resolve.js'

// ---- store resolution (legacy $session → $store mapping, spec §4.3) ----
export { resolveStoreName } from './store-config.js'

// ---- context engine (docs/specs/context-engine-spec.md) ----
export {
  DefaultContextEngine,
  readEngineConfig,
  estimateTokens,
  untrustedScope,
  resolveUntrusted,
  filterBlocks,
  depthOf,
  visibleToModel,
  packageContext,
  renderTrace,
  traceJSON,
  cardField,
  CARD_FIELDS,
  CTX_DEFAULTS,
  DEFAULT_MAX_TOKENS,
  LorebookInjector,
  parseLorebook,
  loadLorebooks,
} from './context/index.js'
export type {
  ContextEngineOptions,
  ContextEvent,
  ContextPackage,
  ContextMessage,
  ContextMeta,
  TaggedInjection,
  ScoredItem,
  DroppedItem,
  DropReason,
  Decision,
  EngineCtxConfig,
  IContextEngine,
  IContextInjector,
  InjectorCapabilities,
  InjectedEntry,
  ScanContext,
  ItemSource,
  Logger,
  LLMCallFn,
  Visibility,
  LorebookEntry,
  LorebookInjectorOptions,
} from './context/index.js'

// ---- assembly ----
export { DirectAssembler } from './assembly/direct.js'
export { mapRole } from './assembly/roles.js'
export { macroVars, resolveMacros } from './assembly/macros.js'
export type { MacroVars, MacroDefaults } from './assembly/macros.js'

// ---- orchestrators ----
export { SimpleOrchestrator } from './orchestrators/simple.js'
export { AgentOrchestrator } from './orchestrators/agent.js'
export type { OrchestratorOptions } from './orchestrators/common.js'

// ---- handlers ----
export { ChatHandler } from './handlers/chat.js'
export { RawHandler } from './handlers/raw.js'
export { TranslateHandler } from './handlers/translate.js'
export { ExtractHandler } from './handlers/extract.js'

// ---- providers ----
export { buildProvider, resolveProviderConfig } from './providers.js'
export type { ProviderInput, ResolvedProvider, ProviderConfig } from './providers.js'

// ---- Part ⇄ ContentBlock bridge + stream / utils ----
export { blocksToParts, partsToBlocks, textFromBlocks, textFromParts, messageFromNode } from './parts.js'
export { serializeEvent, parseEvent, parseNDJSON, ndjsonWriter } from './stream.js'
export { hash } from './hash.js'
export { generateId, dateStamp, generateTimestampedId } from './id.js'
