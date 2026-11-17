# @kerneldreams/ui-protocol

## main
SessionInfo { id, title?, createdAt?, updatedAt?, messageCount?, botId?, botName?, botAvatar?, accentColor?, participants?, parentSessionId?, forkMessageId? }
Participant { id, type, name, avatar? }
Message { id, role, name?, parts, flags?, swipes?, hash?, meta? }
MessageFlags { hidden?, frozen?, injected? }
MessageMeta { createdAt?, model?, usage?, personaId?, to?, seen?, speech? }   // to/seen — v1.12, speech — v1.15
MessageSpeech { speaker, voice, instruct? }   // v1.15
Usage { input, output }
Part = | TextPart | ThinkingPart | ToolUsePart | ToolResultPart | FilePart | ImagePart | ErrorPart | CustomPart
AnyPart = Part | UnknownPart
UnknownPart { type }
KnownPartType = Part['type']
TextPart { type, text }
ThinkingPart { type, text, meta? }
ToolUsePart { type, data, meta }
ToolResultPart { type, data?, text?, meta }
FilePart { type, meta }
ImagePart { type, meta }
ErrorPart { type, text, meta? }
CustomPart { type, data?, text?, meta }
Capabilities { protocol, name?, edits?, swipes?, fork?, cancel?, ask?, activity?, attachments?, catalog?, personas?, sessionMeta?, collapsed?, checkpoints? }
Envelope<T> { ok, result?, error?, version? }
RunStartInput { userMessage?, personaId?, regenerate?, segments?, wish? }   // segments/wish — v1.13
RunEvent = | RunStartEvent | MessageStartEvent | PartStartEvent | PartDeltaEvent | PartEndEvent | MessageEndEvent | AskEvent | ActivityEvent | SessionUpdateEvent | RunEndEvent
AnyRunEvent = RunEvent | UnknownRunEvent
UnknownRunEvent { type, runId? }
KnownRunEventType = RunEvent['type']
RunStartEvent { type, runId }
MessageStartEvent { type, runId, message }   // message.meta? — v1.15
PartStartEvent { type, runId, messageId, part, partType, meta? }
PartDeltaEvent { type, runId, messageId, part, delta, mode? }
PartEndEvent { type, runId, messageId, part, payload? }
MessageEndEvent { type, runId, message }
AskEvent { type, runId, askId, kind, payload }
ActivityEvent { type, runId, kind, payload? }
SessionUpdateEvent { type, runId, fields? }
RunEndEvent { type, runId, status, error?, usage?, version }
CoreAskKind = 'permission' | 'select' | 'text'
ProtocolBackend { capabilities, sessions, history, run, cancel, respond?, messages?, catalog?, personas?, meta?, attachments?, close? }
SessionsOps { list, create, get, delete, fork?, rename? }
MessagesOps { edit?, delete?, hide?, swipe? }
CatalogOps { bots, bot, asset? }
PersonasOps { list, save? }
Persona { id, kind, name, avatar?, model?, prompt?, color?, gender? }   // gender — v1.13
PersonaKind = 'user' | 'char'
PersonasDoc { personas, userId? }
PersonasCapability { edit?, multi? }
SessionPromptMode = 'append' | 'replace'
SessionMetaPrompt { pre?, post?, mode? }
SessionMetaDoc { prompt?, notes?, effectivePrompt?, [key: string]: unknown }
SessionMetaPatch { prompt?, notes?, [key: string]: unknown }
SessionMetaOps { get, patch }
AttachmentsOps { put }
SessionCreateOpts { botId?, greetingId?, personaId?, title? }
MessageEditPatch { parts?, text?, ifHash? }
SwipeTo { dir?, index? }
HistoryPage { messages, version }
AssetData { data, mime? }
NotSupportedError {  }
> Вызвана операция, которую бэкенд не заявил в capabilities (backends-spec §2).

Транспорт транслирует её в Envelope-ошибку с `code: 'not_supported'`
(serveBackend) и восстанавливает обратно на клиенте (createHttpBackend) —
так семантика «не умею» доезжает до UI через провод, не теряясь в 500.
NOT_SUPPORTED_CODE: "not_supported"
mergeSessionMeta(doc, patch): SessionMetaDoc — shallow merge; prompt мержится по своим ключам, null удаляет ключ; effectivePrompt выбрасывается как read-only (session-meta-spec §2, §7)
isSessionPromptMode(v: unknown): boolean — значение — известный режим промпта
sessionPromptMode(doc: SessionMetaDoc): SessionPromptMode — режим промпта документа; ключа нет или значение незнакомо → 'append' (session-meta-spec §7)
KNOWN_PART_TYPES: readonly ("text" | "thinking" | "tool_use" | "tool_result" | "file" | "image" | "error" | "custom")[]
KNOWN_RUN_EVENT_TYPES: readonly ("run_start" | "message_start" | "part_start" | "part_delta" | "part_end" | "message_end" | "ask" | "activity" | "session_update" | "run_end")[]
isTextPart(part: AnyPart): boolean
isThinkingPart(part: AnyPart): boolean
isToolUsePart(part: AnyPart): boolean
isToolResultPart(part: AnyPart): boolean
isFilePart(part: AnyPart): boolean
isImagePart(part: AnyPart): boolean
isErrorPart(part: AnyPart): boolean
isCustomPart(part: AnyPart): boolean
isKnownPart(part: AnyPart): boolean
> Part принадлежит закрытому ядру протокола (§1.2, §2.3).
`custom` считается известным (escape hatch), но всё равно рендерится
fallback-веткой по `meta.hint`. Тип вне реестра → opaque part.
isRunEvent<T extends KnownRunEventType>(event: AnyRunEvent, type: T): boolean
> Общий guard: `event.type === type` с сужением до конкретного варианта
дискриминированного объединения RunEvent.
isKnownRunEvent(event: AnyRunEvent): boolean
> Событие рана принадлежит закрытому ядру (§5.2). Иначе — opaque, игнорировать.
derivedText(message: Pick<Message, "parts">): string
> Плоский текст сообщения = конкатенация text-parts (§2.2).
`content` в протоколе отсутствует — считает клиент.
Учитываются только `text`-части; thinking/tool/файлы игнорируются.
matchToolPair(parts: readonly AnyPart[]): ToolPair[]
> Матчит tool_use ↔ tool_result по `meta.callId` (§2.3).
Возвращает пары в порядке первого появления callId.
Не-tool part'ы игнорируются; неизвестные типы не роняют.
ToolPair { callId, name?, use?, result? }
serializeRunEvent(event: AnyRunEvent): string
> Сериализует событие рана в один SSE-кадр (§9).
`event:` = `event.type`, `data:` = компактный JSON, завершается `\n\n`.
parseRunEvent(frame: string): AnyRunEvent | null
> Парсит один SSE-кадр в событие рана.

Устойчив к graceful degradation: несколько `data:`-строк склеиваются
через `\n` (спека SSE), поле `event:` информативно (истина — `type`
внутри JSON). Возвращает `null`, если `data` пуст или не парсится —
НЕ бросает (§5.2: неизвестное клиент игнорирует, а не падает).
parseSSEStream(text: string): AnyRunEvent[]
> Парсит SSE-стрим (текст из нескольких кадров) в массив событий.
Кадры разделяются пустой строкой; непарсящиеся кадры отбрасываются
(не роняют разбор — §1.2 graceful degradation).