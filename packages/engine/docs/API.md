# @kerneldreams/engine

## main
run(config: EngineConfig, input?: RunInput | undefined): Promise<HandlerResult>
SessionConfig { model?, provider?, template?, bot?, persona?, title?, type?, created? }
ISession { config, getAllMessages, getMessages, last, appendMessage, removeLast, getCollapsed? }
IEditableSession { getById, ensureId, edit, delete, hide, unhide, setInjected, addSwipe, switchSwipe, getSwipes, version }
IAssembler { render }
IOrchestrator { execute, abort }
OrchestratorHook { beforeRequest?, afterResponse?, handleToolUse?, onEvent? }
EngineResponse { content, stopReason, usage? }
StreamEvent = | { type: 'delta'; text: string } | { type: 'thinking_delta'; text: string } | { type: 'tool_use'; name: string; id: string; input: unknown } | { type: 'tool_result'; id: string; content: unknown; error?: string } | { type: 'done'; message: MessageDTO; version: string; usage?: { input: number; output: number } } | { type: 'error'; message: string; code?: string } | { type: 'cancelled'; version: string } | { type: 'user_appended'; message: MessageDTO } | { type: 'budget:exceeded' totalRequired: number available: number dropped: DroppedItem[] } | { type: 'history:large' messageCount: number totalTokens: number suggestedRange?: { from: string; to: string } }
MessageDTO { id, role, name?, content, hidden, frozen, injected, hash?, swipes?, blocks? }
ToolDef = LLMTool
ToolCall { id, name, input }
ToolResult { content, error? }
IHandler { handle }
HandlerResult { output, artifacts? }
EngineConfig { session?, assembly?, orchestrator?, handler?, model?, provider?, providerType?, apiKey?, baseUrl?, maxTokens?, temperature?, extra?, thinking?, think?, template?, contextEngine?, maxIterations?, tools?, path?, file?, persona?, bot?, display?, cmd? }
RunInput { context?, injectors?, userMessage?, systemPrompt?, onEvent?, hooks?, provider? }
OperationResponse<T = unknown> { ok, result?, version, scope?, error? }
ISessionManager { list, create, open, rename, remove }
SessionInfo { id, title?, model?, updated?, messageCount? }
Message { role, attrs, blocks }
ContentBlock { type, attrs, body }
IContext { get, func, cast, cast }
Value = unknown
LLMMessage { role, content, tool_call_id?, name? }
LLMProvider { chat, stream }
LLMRequest { model, messages, max_tokens?, temperature?, top_p?, frequency_penalty?, presence_penalty?, tools?, tool_choice?, stream?, stop_sequences?, thinking?, effort?, extra? }
LLMTool { name, description, input_schema }
resolveSession(config: EngineConfig): ISession
resolveAssembler(config: EngineConfig): IAssembler
resolveOrchestrator(config: EngineConfig): IOrchestrator
resolveHandler(config: EngineConfig): IHandler
resolveProvider(config: EngineConfig): ResolvedProvider
FileSession { getAllMessages, getMessages, last, getById, appendMessage, removeLast, edit, delete, hide, unhide, setInjected, ensureId, addSwipe, switchSwipe, getSwipes, getCollapsed, version, initFile }
MemorySession { getAllMessages, getMessages, last, appendMessage, removeLast }
FileSessionManager { list, create, open, rename, remove }
> Scans a directory for `.mds`/`.md` chat sessions.
DefaultContextEngine { assemble, afterTurn }
readEngineConfig(ctx: IContext): EngineCtxConfig
> Прочитать `$ctx-*` из цепочки вызывающего. Единственная точка чтения (§2).
estimateTokens(text: string): number
untrustedScope(scope?: Record<string, unknown>): IContext
> Скоуп, об который резолвится чужой контент. Ничего сверх переданных данных.
resolveUntrusted(text: string, scope: IContext): string
> Резолвить чужой текст об untrusted-цепочку. Нерезолвимое остаётся литералом
(lenient) — чужой бот не отличит «нет доступа» от «нет значения».
filterBlocks(blocks: ContentBlock[], o: FilterOptions, summaryText?: string | undefined): { blocks: ContentBlock[]; replacedBySummary: boolean; }
> Отфильтровать блоки сообщения: сначала видимость, потом глубина.
`summaryText` (если есть и сообщение old) заменяет text-блоки целиком.
depthOf(distance: number, recentDepth: number, summaryDepth: number): Depth
visibleToModel(v: Visibility): boolean
> Виден модели? `ui` — нет (стат-панель, инвентарь: модель начнёт имитировать).
packageContext(pkg: ContextPackage): IContext
renderTrace(pkg: ContextPackage): string
> Человекочитаемый trace.
traceJSON(pkg: ContextPackage): string
> Машиночитаемый trace. Infinity не переживает JSON — пишем строкой.
cardField(context: IContext, fields: string[]): string
> Склеенный текст перечисленных полей карточки (пустые пропускаются).
CARD_FIELDS: readonly ["system_prompt", "personality", "scenario", "post_history_instructions"]
CTX_DEFAULTS: EngineCtxConfig
DEFAULT_MAX_TOKENS: 128000
LorebookInjector { scan }
parseLorebook(mdd: string): { scanDepth?: number | undefined; entries: LorebookEntry[]; }
> Разобрать mdd-лорбук в entries. Экспортируется — импортёр ST переиспользует.
loadLorebooks(names: string[], storage: IStorage, log: Logger, scanDepth?: number | undefined): Promise<IContextInjector[]>
ContextEngineOptions { injectors?, storage?, llm?, log?, onEvent?, largeHistoryRatio? }
ContextEvent { type }
ContextPackage { card, persona, messages, injections, examples, meta }
ContextMessage { role, blocks, attrs, isSummary, isFrozen, isCollapsedSummary, originalTokens?, name? }
ContextMeta { totalTokens, budget, historyFull, historySummarized, historyDropped, injectionsMatched, injectionsIncluded, injectionsDropped, dropped, decisions }
TaggedInjection { id, content, tags, source, score, tokens, depth? }
ScoredItem { content, tokens, score, source, metadata }
DroppedItem { item, source, tokens, score, reason }
DropReason = 'budget' | 'hidden' | 'filtered' | 'visibility'
Decision = | { kind: 'matched'; entry: string; injector: string; keys?: string[]; triggeredBy?: string } | { kind: 'scored'; item: string; source: string; base: number; boost?: number; final: number } | { kind: 'included'; item: string; tokens: number; budgetLeft: number } | { kind: 'dropped'; item: string; reason: DropReason; detail?: string } | { kind: 'replaced'; item: string; by: 'summary' | 'collapsed' }
EngineCtxConfig { maxTokens, reserveOutput, recentDepth, summaryDepth, toolsInMiddle, cardScore, historyScore, summaryScore, collapsedScore, examplesScore, scanDepth, lorebooks }
IContextEngine { assemble, afterTurn }
IContextInjector { id, scan, afterTurn? }
InjectorCapabilities { llm?, storage?, log, countTokens }
InjectedEntry { id, content, tags, priority, tokens?, source, triggeredBy?, triggeredAtDepth?, matchedKeys?, visibility?, depth? }
ScanContext { recentText, messages, card, turn }
ItemSource = 'system' | 'card' | 'history' | 'injector' | 'example'
Logger { debug, warn, error }
LLMCallFn = (messages: LLMMessage[]) => Promise<LLMResponse>
Visibility = 'model' | 'ui' | 'both'
LorebookEntry { id, keys, secondaryKeys, content, enabled, constant, tags, priority, cooldown, scanDepth?, visibility?, depth? }
LorebookInjectorOptions { id, source?, path?, scanDepth? }
DirectAssembler { render }
> Simple, hardcoded prompt assembly (Spec §3.2):
  1. system  — card fields + injections + %system without $post
  2. history — everything except %system, с at_depth-инъекциями
  3. post    — %system with $post + injections с тегом `post`

Раскладка инъекций по тегам — дефолт «прямого» ассемблера. Точная раскладка
(обёртки, порядок, произвольные теги) — дело ntpl-шаблона.
mapRole(role: string): ApiRole
> Map a session role to an LLM API role. Unknown roles → system.
macroVars(ctx: IContext, defaults?: MacroDefaults): MacroVars
> Build macro vars from a context (card / persona) with config fallbacks.
resolveMacros(text: string, vars: MacroVars): string
> Replace `{{macro}}` tokens. Cheap string replace, not a template engine.
MacroVars { user, char, time?, date?, model? }
MacroDefaults { user?, char?, model? }
SimpleOrchestrator { execute, abort }
AgentOrchestrator { execute, abort }
OrchestratorOptions { model, maxTokens?, temperature?, tools?, thinking?, maxIterations?, extra? }
ChatHandler { handle }
RawHandler { handle }
TranslateHandler { handle }
ExtractHandler { handle }
buildProvider(input: ProviderInput, env?: ProcessEnv): ResolvedProvider
resolveProviderConfig(ctx: IContext, name: string): ProviderConfig
ProviderInput { provider?, model?, apiKey?, baseUrl?, type?, think?, timeout? }
ResolvedProvider { provider, model, type, name }
ProviderConfig { apiKey?, baseUrl?, type?, think?, timeout? }
toDTO(m: Message, index: number, session?: ISession | undefined): MessageDTO
> Map a stored Message to its UI DTO.

`id` is the opaque handle the UI round-trips: a stored `$id` if present
(swipe slots), otherwise the ephemeral positional `pos:N` (§3.1.1).
toHistory(session: ISession): MessageDTO[]
> Full message list as DTOs (UI source — excludes $injected).
serializeEvent(event: StreamEvent): string
> Serialize one StreamEvent to an NDJSON line (no trailing newline).
parseEvent(line: string): StreamEvent
> Parse one NDJSON line back into a StreamEvent.
parseNDJSON(text: string): StreamEvent[]
> Parse a full NDJSON document (ignores blank lines).
ndjsonWriter(write?: (chunk: string) => void): (event: StreamEvent) => void
> A sink that writes NDJSON lines (defaults to stdout).
hash(input: string): string
> FNV-1a 64-bit hash of a string → 16-char lowercase hex.
generateId(): string
> Generate a CVCVCV id, e.g. `weruka`.
dateStamp(d?: Date): string
> `YYYYMMDD` for the given (or current) date.
generateTimestampedId(base?: string | undefined): string
> Generate a timestamped session id, e.g. `weruka-20260614`.
msgText(m: Message): string
> Concatenated text of all `text` blocks (trimmed).
msgId(m: Message): string | undefined
> Stable id ($id attribute) if present.
isHidden(m: Message): boolean
isFrozen(m: Message): boolean
isInjected(m: Message): boolean
msgSwipe(m: Message): number | undefined
msgCollapsed(m: Message): string | undefined
> `$collapsed: id` — сообщение-ссылка на свёрнутый диапазон (session-format §5).
Тело ссылки = summary; полный контент лежит в блоке `## $collapsed <id>`.
msgSummary(m: Message): string | undefined
> `````%summary`-блок сообщения (message-format-spec §3.2), если есть.
msgVisibility(m: Message): Visibility
> `$visibility` сообщения (context-engine-spec §4). Дефолт — `both`.
blockVisibility(b: ContentBlock, inherited?: Visibility): Visibility
> `$visibility` контент-блока. Наследует видимость сообщения, если не задан.
textFromBlocks(blocks: ContentBlock[]): string
> Plain text view of an EngineResponse's blocks (for stdout / DTO content).
serializeMessage(m: Message): string
> A full `%role …` message stanza.
serializeBlocks(blocks: ContentBlock[]): string
> Blocks → body text. `text` blocks verbatim; typed blocks as ````%type fences.
serializeAttrs(attrs: Record<string, unknown>): string
> ` $key: value` pairs; bare `true` flags become ` $flag`.
blocksFromContent(content: string): ContentBlock[]
> Turn an append payload into content blocks. If the text carries `````%type`
fences it is parsed into typed blocks (so a serialized assistant turn with
thinking / tool_use round-trips); otherwise it is a single verbatim text block.

## context
nameList(v: unknown): string[]
> name-list: `$[a, b]` (массив) или `a, b` (строка).
Depth = 'recent' | 'middle' | 'old'
FilterOptions { depth, frozen, toolsInMiddle, inherited }
EngineSession { getAllMessages }