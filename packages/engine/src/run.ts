// run() — the engine entry point. Spec §5.
//
// resolve store + components → seed input (appendNode) → load history →
// context engine (assemble) → commands (dry/dump/trace) → assemble prompt →
// orchestrate (with hooks) → handle (append id-first via store).

import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { chainContext, emptyContext } from '@kerneldreams/nrd'
import { fsStorage } from '@kerneldreams/nrd/node'
import { getStore, toHistory } from '@kerneldreams/chat-store'
import type { SessionStore, StoreMessage } from './types.js'
import type { LLMMessage } from '@kerneldreams/nrd/web'
import type {
  EngineConfig,
  RunInput,
  RunTarget,
  HandlerTarget,
  HandlerResult,
  OrchestratorHook,
  StreamEvent,
} from './types.js'
import {
  resolveAssembler,
  resolveOrchestrator,
  resolveHandler,
  resolveProvider,
} from './resolve.js'
import { generateId } from './id.js'
import { blocksToParts, messageFromNode } from './parts.js'
import { storeToNrd } from './context/model.js'
import { DefaultContextEngine } from './context/engine.js'
import type { ContextEvent, ContextEngineOptions } from './context/engine.js'
import { readEngineConfig } from './context/config.js'
import { loadLorebooks } from './context/injectors/load.js'
import { packageContext } from './context/package.js'
import { renderTrace, traceJSON } from './context/trace.js'
import type { ContextMessage, ContextPackage, IContextInjector, Logger } from './context/types.js'
import type { IContext } from './types.js'

interface ResolvedTarget {
  store: SessionStore
  sessionId: string
}

/** Resolve the run target: a ready store, or a registry name + opts. */
function resolveTarget(target: RunTarget): ResolvedTarget {
  const store = target.store ?? (target.storeName ? getStore(target.storeName, target.storeOpts) : undefined)
  if (!store) throw new Error('nr-engine: RunInput.target needs a store or storeName')
  return { store, sessionId: target.sessionId }
}

async function versionOf(store: SessionStore, sid: string): Promise<string> {
  return store.version ? await store.version(sid) : ''
}

/** Wrap RunInput.onEvent into an orchestrator hook (Spec §5 note). */
function resolveHooks(input?: RunInput): OrchestratorHook[] {
  const hooks: OrchestratorHook[] = []
  if (input?.onEvent) hooks.push({ onEvent: input.onEvent })
  if (input?.hooks) hooks.push(...input.hooks)
  return hooks
}

function formatPrompt(messages: LLMMessage[]): string {
  return messages
    .map((m) => {
      const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      return `%${m.role}\n${content}`
    })
    .join('\n\n')
}

/** ContextMessage → store Message: the assembler works the store model. */
function contextToStore(cm: ContextMessage): StoreMessage {
  const id = cm.attrs['id']
  const msg: StoreMessage = { id: typeof id === 'string' ? id : '', role: cm.role, parts: blocksToParts(cm.blocks) }
  if (cm.name) msg.name = cm.name
  if (cm.isFrozen) msg.flags = { frozen: true }
  return msg
}

const stderrLog: Logger = {
  debug: () => {},
  warn: (m) => process.stderr.write(`[context] ${m}\n`),
  error: (m) => process.stderr.write(`[context] ${m}\n`),
}

export async function run(config: EngineConfig, input: RunInput): Promise<HandlerResult> {
  // 1. Resolve store + components.
  const { store, sessionId } = resolveTarget(input.target)
  const assembler = resolveAssembler(config)
  const handler = resolveHandler(config)

  // 2. Input (optional — for non-chat scenarios): seed via the store.
  if (input.systemPrompt) await store.appendNode(sessionId, { role: 'system', text: input.systemPrompt })
  if (input.userMessage) {
    const node = await store.appendNode(sessionId, { role: 'user', text: input.userMessage })
    input.onEvent?.({ type: 'user_appended', message: messageFromNode(node), nodeId: node.id })
  }

  // Context: caller override, else empty (NRD-driven context is a later task).
  const context = input.context ?? emptyContext
  const hooks = resolveHooks(input)

  // 3. Load history (active path, incl. $hidden — the engine filters).
  const model = await store.load(sessionId)
  const history = toHistory(model)

  // 4. Context engine: что попадает в контекст (scoring + бюджет + инъекции).
  const assembled = await assembleContext(config, context, history, hooks, input.injectors)
  const renderMessages: StoreMessage[] = assembled
    ? assembled.pkg.messages.map(contextToStore)
    : history
  const renderContext = assembled
    ? chainContext(packageContext(assembled.pkg), assembled.ctx)
    : context

  // 5. Commands (dry / dump / trace) — assemble and return, no generation.
  if (config.cmd === 'trace') {
    if (!assembled) return { output: 'nr-engine: trace недоступен — контекстный движок выключен' }
    const { pkg } = assembled
    const json = config['json'] === true || config['json'] === 'true'
    const output = json ? traceJSON(pkg) : renderTrace(pkg)
    return { output, artifacts: { decisions: pkg.meta.decisions, meta: pkg.meta } }
  }

  if (config.cmd === 'dry' || config.cmd === 'dump') {
    const llm = await assembler.render(renderMessages, renderContext)
    const output = formatPrompt(llm)
    if (config.cmd === 'dump') {
      const out = (config.path ?? config.file ?? 'prompt') + '.prompt.md'
      writeFileSync(out, output)
      return { output, artifacts: { messages: llm, file: out } }
    }
    return { output, artifacts: { messages: llm } }
  }

  // 6. Assemble the prompt.
  const orchestrator = resolveOrchestrator(config)
  const provider = input.provider ?? resolveProvider(config).provider
  const llm = await assembler.render(renderMessages, renderContext)

  // 7. Orchestrate.
  const response = await orchestrator.execute(llm, provider, hooks)

  // 7a. Cancelled mid-stream — emit cancelled, skip the handler (nothing written).
  if (response.stopReason === 'cancelled') {
    input.onEvent?.({ type: 'cancelled', version: await versionOf(store, sessionId) } satisfies StreamEvent)
    return { output: '', artifacts: { stopReason: 'cancelled' } }
  }

  // 8. Handle — id-first: the assistant id is generated before the write and
  // rides the `done` event; the handler appends under the same id.
  const assistantId = generateId()
  const handlerTarget: HandlerTarget = { store, sessionId, assistantId }
  const result = await handler.handle(response, handlerTarget, config)

  // 8a. Emit the terminal `done` event: model message (id == record id) + version.
  if (input.onEvent) {
    const role = typeof config['assistantRole'] === 'string' ? (config['assistantRole'] as string) : 'assistant'
    const message: StoreMessage = { id: assistantId, role, parts: blocksToParts(response.content) }
    if (response.usage) message.meta = { usage: response.usage }
    input.onEvent({
      type: 'done',
      message,
      nodeId: assistantId,
      version: await versionOf(store, sessionId),
      usage: response.usage,
    })
  }

  return result
}

/**
 * Собрать ContextPackage. `$contextEngine: none` — старый путь (сырая лента),
 * чтобы утилиты, которым движок не нужен, платили ноль.
 */
async function assembleContext(
  config: EngineConfig,
  context: IContext,
  history: StoreMessage[],
  hooks: OrchestratorHook[],
  extra?: IContextInjector[],
): Promise<{ pkg: ContextPackage; ctx: IContext } | undefined> {
  if (config.contextEngine === 'none') return undefined

  const ctx = context

  const path = config.path ?? config.file
  const baseDirRaw = ctx.get(['__basedir'])
  const baseDir =
    typeof baseDirRaw === 'string' ? baseDirRaw : path ? dirname(path) : process.cwd()
  const storage = fsStorage(baseDir)

  const cfg = readEngineConfig(ctx)
  const injectors: IContextInjector[] = [...(extra ?? [])]
  if (cfg.lorebooks.length > 0) {
    injectors.push(...(await loadLorebooks(cfg.lorebooks, storage, stderrLog, cfg.scanDepth)))
  }

  // События движка едут существующим каналом hooks (§6) — своего эмиттера нет.
  const onEvent = (e: ContextEvent) => {
    for (const h of hooks) h.onEvent?.(e as unknown as StreamEvent)
  }

  // Context engine works nrd-core internally — convert the store history at the boundary.
  const engineSession = { getAllMessages: () => history.map(storeToNrd) }

  const opts: ContextEngineOptions = { injectors, storage, log: stderrLog, onEvent }
  const engine = new DefaultContextEngine(opts)
  return { pkg: await engine.assemble(engineSession, ctx), ctx }
}
