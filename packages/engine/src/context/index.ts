// Context Engine — модуль nr-engine (решение №5).
// Spec: docs/specs/context-engine-spec.md

export { DefaultContextEngine } from './engine.js'
export type { ContextEngineOptions, ContextEvent } from './engine.js'

export { readEngineConfig, nameList, CTX_DEFAULTS, DEFAULT_MAX_TOKENS } from './config.js'
export { estimateTokens } from './tokens.js'
export { untrustedScope, resolveUntrusted } from './untrusted.js'
export { filterBlocks, depthOf, visibleToModel } from './filter.js'
export type { Depth, FilterOptions } from './filter.js'
export { packageContext } from './package.js'
export { renderTrace, traceJSON } from './trace.js'
export { cardField, CARD_FIELDS } from './card.js'

export { LorebookInjector, parseLorebook } from './injectors/lorebook.js'
export type { LorebookEntry, LorebookInjectorOptions } from './injectors/lorebook.js'
export { loadLorebooks } from './injectors/load.js'

export type {
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
  EngineSession,
} from './types.js'
