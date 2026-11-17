// nr-engine — public types.
// Spec: docs/specs/nr-engine-spec.md §3–§8.
//
// After the sessions/ amputation the engine is pure generation:
// storage is nr-chat-store. The dialogue dictionary is the store's model
// (Message/Part/MessageFlags); the four pluggable interfaces are now
// IAssembler, IOrchestrator, IHandler (ISession is gone — a store is passed in).

import type { IContext, Value } from '@kerneldreams/nrd'
import type { ContentBlock } from './message-model.js'
import type {
  LLMMessage,
  LLMProvider,
  LLMRequest,
  LLMTool,
  ThinkingConfig,
} from '@kerneldreams/nrd/web'
import type {
  Message as StoreMessage,
  Part,
  MessageFlags,
  SessionStore,
} from '@kerneldreams/chat-store'
import type { DroppedItem, IContextInjector } from './context/types.js'

// nr-chat-store model is the engine's dialogue dictionary — re-exported for consumers.
export type {
  Message as StoreMessage,
  Part,
  MessageFlags,
  SessionStore,
  StoreNode,
  NodeInput,
} from '@kerneldreams/chat-store'
export type { IContext, Value } from '@kerneldreams/nrd'
export type { LLMMessage, LLMProvider, LLMRequest, LLMTool } from '@kerneldreams/nrd/web'

// ---------------------------------------------------------------------------
// Run target — where the dialogue is stored (spec §2)
// ---------------------------------------------------------------------------

/**
 * The store + session the run reads history from and writes the answer to.
 * Either a ready `store` instance, or a `storeName` resolved from the
 * nr-chat-store registry (+ opts). Swipes/regenerate live in the consumer
 * (`appendNode(parent=sibling)` + `setActiveLeaf`); the engine always works the
 * active path.
 */
export interface RunTarget {
  /** A ready store instance … */
  store?: SessionStore
  /** … or a registry name resolved by the engine (with `storeOpts`). */
  storeName?: string
  storeOpts?: unknown
  sessionId: string
}

/** Resolved target handed to handlers (store guaranteed, id-first assistant id). */
export interface HandlerTarget {
  store: SessionStore
  sessionId: string
  /** Pre-generated id of the assistant node (id-first, spec §2). */
  assistantId: string
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

/** Builds the LLM prompt from the model's messages + context. Spec §3.2. */
export interface IAssembler {
  /** Async — a template may load over the network; buildContext is async. */
  render(messages: StoreMessage[], context: IContext): Promise<LLMMessage[]>
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** A tool the LLM may call. Alias of nr-infra's LLMTool. */
export type ToolDef = LLMTool

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string
  name: string
  input: unknown
}

/** The result of running a tool, fed back to the model. */
export interface ToolResult {
  content: unknown
  error?: string
}

/** Hook into the request/response lifecycle. Spec §3.3. */
export interface OrchestratorHook {
  beforeRequest?(req: LLMRequest): LLMRequest | Promise<LLMRequest>
  afterResponse?(res: EngineResponse): EngineResponse | Promise<EngineResponse>
  handleToolUse?(call: ToolCall): Promise<ToolResult>
  /** Typed stream events (not raw text). */
  onEvent?(event: StreamEvent): void
}

/** Manages calls to the provider (single call, tool loop, retry). Spec §3.3. */
export interface IOrchestrator {
  execute(
    messages: LLMMessage[],
    provider: LLMProvider,
    hooks: OrchestratorHook[],
  ): Promise<EngineResponse>

  /** Abort the current generation. Partial output is discarded. */
  abort(): void
}

/**
 * Structured stream events — UI-safe, typed. Spec §3.3.
 *
 * `done`/`user_appended` carry the model's `Message` (+ `nodeId`). `swipes` are
 * computed on demand by the consumer (`swipeInfo`), not in every event.
 *
 * Context-engine события (`budget:exceeded`, `history:large`) едут этим же
 * каналом: собственного эмиттера у движка контекста нет (context-engine §6).
 */
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use'; name: string; id: string; input: unknown }
  | { type: 'tool_result'; id: string; content: unknown; error?: string }
  | { type: 'done'; message: StoreMessage; nodeId: string; version: string; usage?: { input: number; output: number } }
  | { type: 'error'; message: string; code?: string }
  | { type: 'cancelled'; version: string }
  | { type: 'user_appended'; message: StoreMessage; nodeId: string }
  | {
      type: 'budget:exceeded'
      totalRequired: number
      available: number
      dropped: DroppedItem[]
    }
  | {
      type: 'history:large'
      messageCount: number
      totalTokens: number
      suggestedRange?: { from: string; to: string }
    }

/** Result of orchestration. NOT nr-infra's LLMResponse. Spec §3.3. */
export interface EngineResponse {
  /** Provider-facing content blocks; mapped to store Parts on append (§3.4). */
  content: ContentBlock[]
  stopReason: string
  usage?: { input: number; output: number }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/** Processes the orchestrator's response (save via store, print, extract). Spec §3.4. */
export interface IHandler {
  handle(
    response: EngineResponse,
    target: HandlerTarget,
    config: EngineConfig,
  ): Promise<HandlerResult>
}

export interface HandlerResult {
  /** Text for stdout (the consumer prints it). */
  output: string
  /** Files, side effects, metadata. */
  artifacts?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Config + run
// ---------------------------------------------------------------------------

/** Engine configuration — from mdz attributes or programmatic. Spec §4. */
export interface EngineConfig {
  // what to use
  /** Store driver name for the runz/mdz resolve layer (registry). Default 'mds'. */
  store?: string
  assembly?: string // 'direct' | 'ntpl'           — default: 'direct'
  orchestrator?: string // 'simple' | 'agent'      — default: 'simple'
  handler?: string // 'chat' | 'raw' | 'translate' | 'extract' — default: 'chat'

  // llm
  model?: string
  provider?: string
  providerType?: string  // 'openai' | 'anthropic' | 'ollama'
  apiKey?: string
  baseUrl?: string
  maxTokens?: number
  temperature?: number
  /** Verbatim pass-through into the provider request body (min_p, dry_*, response_format, ...). */
  extra?: Record<string, unknown>
  thinking?: ThinkingConfig
  /** Ollama: toggle model thinking. false = disable, undefined = model default. */
  think?: boolean

  // assembly
  template?: string

  // context engine — 'default' | 'none' (default: 'default')
  contextEngine?: string

  // orchestrator
  maxIterations?: number
  tools?: ToolDef[]

  // store driver opts (mds file / dir)
  path?: string
  file?: string // alias for path
  persona?: string
  bot?: string

  // display
  display?: {
    botName?: string
    botAvatar?: string
    userName?: string
    userAvatar?: string
    description?: string
  }

  // commands
  cmd?: string // dry | dump | history | status | append | edit | ...

  // pass-through for plugins
  [key: string]: Value
}

export interface RunInput {
  /** Where history is read and the answer written (spec §2). */
  target: RunTarget
  /** IContext from nrd-context (card, lorebook, etc.). */
  context?: IContext
  /**
   * Дополнительные context-injector'ы (бот-бандл, тесты). Складываются с
   * лорбуками, поднятыми из `$lorebooks` каскада.
   */
  injectors?: IContextInjector[]
  /** Append a user message before generating. */
  userMessage?: string
  /** Append a system prompt before generating. */
  systemPrompt?: string
  /** Typed stream callback. */
  onEvent?: (event: StreamEvent) => void
  /** Additional orchestrator hooks (beforeRequest / afterResponse / handleToolUse). */
  hooks?: OrchestratorHook[]
  /** Override the resolved provider (in-process embedding / tests, no network). */
  provider?: LLMProvider
}

/** Unified response envelope for UI operations. Spec §8.2. */
export interface OperationResponse<T = unknown> {
  ok: boolean
  result?: T
  version: string
  scope?: StoreMessage[]
  error?: string
}

// nrd-core Message/ContentBlock stay available for the internal context layer
// (the context engine and orchestrator speak nrd-core; the boundary converts).
export type { Message, ContentBlock } from './message-model.js'
