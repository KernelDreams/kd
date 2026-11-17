/**
 * @kerneldreams/ui-protocol — универсальный протокол UI ⇄ бэкенд (v1).
 *
 * Типы протокола + маппинг-хелперы. Без движка: адаптеры pi/opencode
 * подключают этот пакет, не таща nr-engine (спека §10.7).
 *
 * Канон: nr-engine/docs/specs/nr-ui-protocol-spec.md
 *
 * v1.22 (session-document-spec, ре-экспорт nr-chat-store ≥0.22): `Persona.card`
 * — карта CCv3 в персоне, `MessageMeta.greeting` — индекс гритинга сиблинга,
 * `ProfileDoc.template`/`builder` — шаблон и билдер промпта агента.
 *
 * v1.23: `Capabilities.promptDebug`, ask `prompt` — отладка промпта
 * перед провайдером (`PromptDebugRequest` / `PromptDebugAnswer`, флаг меты `debugPrompt`).
 *
 * v1.24: `Capabilities.plugins` — внешние плагины фронта, транспорт
 * `PluginsSource` (`GET /plugins/<id>/…`, SSE `/plugins/events`), `backend.plugins.watch`.
 *
 * v1.25 (ре-экспорт nr-chat-store ≥0.26): `Usage` — опциональные
 * `cacheRead`/`cacheWrite` (кэш промпта) и `context {used, size}` (контекст
 * агента после хода): `MessageMeta.usage` ответа и `run_end.usage`.
 *
 * v1.26 (projects-spec): проекты — `WorkspaceInfo` с `kind: 'project'`,
 * `description`, `project` (`WorkspaceProject` — запись реестра); capability
 * `workspace.projects`/`edit`; `sessions.list({workspace})`,
 * `SessionCreateOpts.workspace`, `workspace.create/update`; мета
 * `workspace.project`; `ExternalPluginInfo.workspace` — плагин проекта.
 *
 * v1.27: `profiles.list/get({workspace})` — каталог профилей глазами
 * проекта клиента (`ProfilesListOpts`; HTTP `GET /profiles?workspace=`).
 *
 * v1.28: `workspace.files.search` — полнотекстовый поиск по
 * пространству (`FileSearchQuery` → `FileSearchHit[]`, capability
 * `workspace.files.search`; HTTP `POST /workspace/files/search`), общий матчер
 * `compileFileSearch`, `fileGlobRegExp`.
 *
 * v1.30 (users-spec §2–5): пользователи стенда — `Capabilities.users`
 * {me, admin}, `UsersOps` (`users.list/create/invite/loginLink/devices/revoke`),
 * `SessionInfo.owner`/`shared`, `sessions.share`, `SessionListOpts.all`,
 * `WorkspaceProject.members`/`reads`, `WorkspaceInfo.role`; код `forbidden` (403),
 * вход по ссылке — `/auth/join|login|logout` транспорта.
 *
 * v1.31 (run-resume-spec): подхват идущего рана — `SessionInfo.run`
 * {id, startedAt, waiting?}, `sessions.attach(id)` (снимок + живой поток;
 * capability `sessions.attach`, `canAttachRun`), событие `ask_end` (ask закрыт
 * ответом любого подписчика); `EngineInfo.switch` — движок без `.mds` не
 * цель смены исполнителя (`switchTargets`).
 *
 * v1.32 (front-context-spec §4, §6): управляемый контекст — мета
 * `context` {pinned, dropped, cleared} (`SessionContextMeta`, хелперы
 * `sessionContextOf`/`withSessionContext`, заглушка `clearedStub`), имена тулов
 * `skill_load`/`context_pin`; user.css — `SkinsOps.userCss/saveUserCss`,
 * capability `skins.user` (`GET|PUT /skins/user`).
 *
 * v1.33 (fix-backend-hub-spec): хаб — `EngineInfo.caps` (поля
 * capabilities, которыми движок отличается: лимит вложений, thinking, …;
 * `engineCaps(caps, engine)` — caps для сессии движка), `ProfilesListOpts.engine`
 * (профили движка — слепки ACP); сервисы и плагины хаба — объединение движков;
 * `WorkspaceFilesOps.at(workspace)` — файлы и поиск проекта вкладки (`?workspace=`).
 *
 * v1.34 (agents-spec §3): «профиль на проводе = агент» — каталог
 * агентов общий для движков хаба: `ProfileInfo.engine` — движок агента по
 * умолчанию, `source` (`agents` | `legacy`), `card`; `ProfileDoc.engine/card/
 * source`. `sessions.create({engine, profile})` — вместе: движку, у которого
 * агента нет в каталоге, хаб передаёт документ агента (профиль сессии — его
 * id, документ встроен); документ с `source` — профиль сессии его `id`, не `inline`.
 *
 * v1.35 (spaces-spec): пространство и проект. Запись реестра —
 * пространство (`WorkspaceProject.projektor/projects/aliases`, `WorkspaceInfo.hidden`
 * у записи-алиаса); проекты на диске — `workspace.repos({workspace}) → ProjectInfo[]`
 * (capability `workspace.repos`); `SessionCreateOpts.project/skills`,
 * `SessionInfo.project`, `SessionMetaDoc.skills`. Сессии алиаса видны в пространстве.
 *
 * v1.36 (task-session-spec): задача сессией. `SessionInfo.task`
 * {issue, role: executor|acceptor, parent} — из `sessionMeta.task` (пишет хост
 * задач патчем меты); `RunStartInput.headless` — ран хоста без человека (апрув
 * тула — таймаут и отказ); `WorkspaceProject.merge` — `before-accept | after-accept`.
 *
 * v1.37: писать агенту посреди хода. Capability `steer` + метод
 * `steer(id, runId, userMessage) → SteerResult`: сообщение вливается в идущий ран
 * (ACP `_session/steering`), в потоке приезжает user-сообщением `meta.steered`
 * между частями ответа. Без capability UI держит сообщения в очереди.
 *
 * v1.38: запущенные сессии. `sessions.live()` — сессии с идущим ходом
 * или живым процессом агента по всем пространствам и движкам (capability
 * `sessions.live`, `GET /sessions/live`); `sessions.release(id)` — погасить процесс
 * агента простаивающей сессии, лента цела, следующий ход поднимет из неё (capability
 * `sessions.release`, `POST /sessions/:id/release`). `SessionRun.last` — последнее
 * событие рана, `SessionInfo.process` — процесс агента жив (`idleSince`).
 *
 * v1.39 (LLM-12, agents-spec §1): распознавание агента. `ProfileInfo.voice` /
 * `ProfileDoc.voice` — `AgentVoice {mode?: smart|verbatim, refine?: auto|always|off}`
 * из `voice` в `%meta`; клиент берёт его у агента сессии поверх своей настройки 🎤.
 *
 * v1.41 (file-links-spec §3): файл вне пространств и действия хоста.
 * Capability `files.external` — `external.stat/read/list` по абсолютному пути (`~`
 * раскрывает бэкенд), `GET /files/external/{stat,read,list,raw}?path=`; capability
 * `host {open, apps}` — `host.reveal` (Finder), `host.open(path, {app})`,
 * `POST /host/{reveal,open}`. Закрытые пути — `forbidden`; доступ — владелец стенда.
 *
 * v1.42 (file-panel-spec §1–1a): адрес файла `{host?, path}` — `host=` у всех
 * `/files/external/*`, `FileEntry.host`; запись `POST /files/external/{write,mkdir,rename,
 * delete,copy}` (`files.write`), `GET /files/external/search` (`files.search`), SSE
 * `GET /files/external/events?path=` (`files.watch`); `files.host`/`files.hosts`; эскиз —
 * `raw?…&thumb=<px>`.
 *
 * v1.55 (session-archive-spec): архив и теги — `SessionInfo.archived` (дата / `false` —
 * вернули руками), `archivedBy: 'auto'`, `tags`; `SessionListOpts.archived` (`true` / `'only'`),
 * `sessions.move(id, {workspace, project?})`; capability `sessions {archive, move}`; хелперы
 * `canArchiveSessions`, `canMoveSession`, `isArchivedSession`, `pickArchived`, `archivePatch`.
 *
 * v1.56 (objects-spec §19): лицо записи — `ObjectRow.hue` / `color` / `cover` / `icon` /
 * `coverState`, `ObjectTypeInfo.color` (`$color`) и `cover` (`## $cover`); действия `cover` (`mode:
 * missing | all | one`), `cover-lock`, `cover-style`; хелперы `recordHue`, `recordColor`.
 *
 * v1.57: окна — `history(id, {limit, before})` → `HistoryPage.more/total` (capability
 * `history.page`), `SessionListOpts.query/limit/offset` (capability `sessions.page`); хелперы
 * `canPageHistory`, `canPageSessions`, `matchSessionQuery`, `pageSessions`, `historyWindow`.
 *
 * v1.59 (skills-spec §4): скиллы сессии с режимами — `SessionMetaDoc.skills:
 * Array<string | SessionSkill>` (`{name, mode: 'linked' | 'loaded', source?}`; строка —
 * `loaded`), capability `skills.session`; хелперы `canSessionSkills`, `sessionSkills`,
 * `sessionSkillNames`.
 *
 * v1.62: имя устройства штампа — `Capabilities.devices {list: DeviceInfo[], here?}`
 * (реестр `$hosts` стенда, машина запроса по tailnet), `RunStartInput.client.guess` (догадка
 * по браузеру — хаб вправе заменить именем машины по адресу).
 * v1.63: лицо чата и агента — `SessionInfo.icon` (`sessionMeta.icon`), `ProfileInfo.icon` /
 * `ProfileInfo.avatar` (`icon` / `avatar` в `%meta` агента).
 * v1.65: слой настроек `bot` записываемый — карта char-персоны сессии (экземпляр).
 * v1.66 (rp-build-spec §13.1): хранилища типа — `ObjectTypeInfo.stores` (`ObjectStoreInfo`: папка, машина,
 * сервис, `$layout`, `readonly`), `ObjectRow.store`, `ObjectQuery.store` (полка), `ObjectSourceRef.store`.
 * v1.67 (bot-assembly-spec §5, §2): переменные пресета на один ран — `RunStartInput.vars`
 * (`{<id>: значение}` → `meta.vars` реплики игрока, верхний слой каскада); предупреждения сборки в окне
 * отладки — `PromptDebugRequest.warnings` (нестабильный блок наверху).
 * v1.68: мультиплекс подписок — `ServicesOps.subscribe`, `POST /services/_mux/stream`
 * (`SERVICE_MUX_PATH`, кадры `service_mux` с ключом): все вечные подписки вкладки одним соединением.
 * v1.69: активность сессий — поток встроенного сервиса `nr.sessions`/`activity`
 * (`SessionActivity`: run_start / run_end / messages); открытая вкладка подцепляется к чужому рану сама.
 * v1.70 (bot-assembly-spec §6): обработчик гритинга — служебная команда `greeting`
 * (`GREETING_COMMAND`, параллельная): гритинг `options.messageId` под переменные пресета —
 * свайп рядом с оригиналом (`meta.generated`, `GreetingGeneratedMeta`) или рукописный под те же `vars`;
 * итог — кадр `activity` `node_meta` с `{id, patch: {active}}` нового активного узла.
 * v1.71 (plugin-registry-spec §5): `ExternalPluginInfo.api` — диапазон Plugin API манифеста (`nrchat.api`):
 * не подходит хосту — фронт плагин не грузит, причина в списке; `origin` — откуда папка (`stand` / `user` / `contour`).
 * v1.72 (file-links-spec §3a): подписанные адреса сырых файлов — `files.sign`; `GET /files/external/sign`
 * отдаёт ключ со сроком (`ExternalSignKey`), клиент подписывает адрес `raw` сам (`&exp=&sig=`, `signRawUrl`):
 * адрес работает без куки и заголовков — в `srcdoc` и кадрах песочниц; `external.ready()` — дождаться ключа.
 */

export type {
  // §2.1 Session
  SessionInfo,
  SessionShare,
  DeviceInfo,
  SessionRun,
  SessionTask,
  Participant,
  // §2 models-spec — выбор модели сессии
  ModelSelection,
  SessionModel,
  // §2.2 Message
  Message,
  MessageFlags,
  MessageMeta,
  MessageSpeech,
  Usage,
  // §2.3 Part
  Part,
  AnyPart,
  UnknownPart,
  KnownPartType,
  TextPart,
  ThinkingPart,
  ToolUsePart,
  ToolResultPart,
  FilePart,
  ImagePart,
  ErrorPart,
  CustomPart,
  // §2 models-spec — каталог моделей
  ModelInfo,
  // §3 Capabilities
  Capabilities,
  // attachments-spec §2 — лимиты вложений
  AttachmentsCapability,
  AttachmentContent,
  // v1.10 — режимы рана
  RunCapability,
  // workspace-spec §2 — рабочее пространство
  WorkspaceInfo,
  WorkspaceProject,
  ProjectInfo,
  // v1.29 — движки хаба (users-spec §1)
  EngineInfo,
  EngineCapsOverride,
  SteerResult,
  EnginesCapability,
  // v1.30 — пользователи стенда (users-spec §2–5)
  ProjectRole,
  UserRole,
  UserAuthMethod,
  UserInfo,
  UsersCapability,
  UserDevice,
  UserLink,
  UserCreateInput,
  // workspace-files-spec §1 — файлы пространства (v1.7)
  WorkspaceFilesCapability,
  FileSearchQuery,
  FileSearchHit,
  FileEntry,
  FileEncoding,
  FileContent,
  WorkspaceUpdateEvent,
  // profiles-spec §4 — профили сессии
  ProfileInfo,
  // profile-editor-spec §2–3 — документ профиля и каталоги
  ProfileDoc,
  AgentVoice,
  CatalogTool,
  CatalogSkill,
  SessionSkill,
  SessionSkillMode,
  CatalogExtension,
  // session-meta-spec §2, §7 — мета сессии
  SessionMetaDoc,
  SessionToolDecl,
  SessionWorkspace,
  SessionContextMeta,
  SessionAgentCopy,
  SessionToolCall,
  ToolApprovalPreview,
  ToolApprovalRequest,
  ToolApprovalDecision,
  ToolApprovalAnswer,
  PromptDebugRequest,
  PromptDebugAnswer,
  SessionMetaPatch,
  SessionMetaPrompt,
  SessionPromptMode,
  // prompt-recipe-spec §1–2 — промпт сообщения (v1.8)
  PromptRecipe,
  PromptRecipeInjection,
  PromptInjectionRole,
  PromptInjection,
  PromptMessage,
  PromptView,
  PromptSystemBlock,
  // personas-spec §1, §3 — персоны сессии (v1.9)
  Persona,
  PersonaKind,
  PersonasDoc,
  PersonasCapability,
  PersonaContext,
  // §4 Envelope
  Envelope,
  // §5.1 Run start
  RunStartInput,
  RunCommand,
  RunDirection,
  ChoiceAxis,
  GreetingGeneratedMeta,
  DirectionLength,
  SideCommandOptions,
  NodeMetaActivity,
  ParticipantRef,
  CompactionPartData,
  // §5.2 RunEvent
  RunEvent,
  AnyRunEvent,
  UnknownRunEvent,
  KnownRunEventType,
  RunStartEvent,
  MessageStartEvent,
  PartStartEvent,
  PartDeltaEvent,
  PartEndEvent,
  MessageEndEvent,
  AskEvent,
  AskEndEvent,
  ActivityEvent,
  SessionUpdateEvent,
  RunEndEvent,
  // §5.3 Ask
  CoreAskKind,
} from './types.js'

export type {
  // backends-spec §2 — шов бэкенда
  ProtocolBackend,
  SessionsOps,
  UsersOps,
  MessagesOps,
  CatalogOps,
  PersonasOps,
  SessionMetaOps,
  AttachmentsOps,
  AttachmentPutResult,
  WorkspaceOps,
  WorkspaceFilesOps,
  WorkspaceUpdateListener,
  FileReadOpts,
  FileWriteOpts,
  ProfilesOps,
  CatalogsOps,
  ModelsOps,
  SessionCreateOpts,
  SessionListOpts,
  SessionMoveInput,
  ProfilesListOpts,
  WorkspaceProjectPatch,
  MessageEditPatch,
  MessageAppendOpts,
  SwipeTo,
  HistoryPage,
  HistoryOpts,
  AssetData,
  ServicesOps,
  ServicesHost,
} from './backend.js'

export { NotSupportedError, NOT_SUPPORTED_CODE, MESSAGE_META_EDITABLE } from './backend.js'
export { TOOL_APPROVAL_ASK_KIND, PROMPT_DEBUG_ASK_KIND, PROMPT_DEBUG_META_KEY, COMPACT_COMMAND, COMPACTION_PART_HINT, PROMPT_ACTIVITY_KIND, CHOICES_COMMAND, EDITOR_COMMAND, GREETING_COMMAND, GREETING_GENERATED_META, NODE_META_ACTIVITY_KIND, CHOICE_AXES, PARALLEL_COMMANDS, isParallelRun } from './types.js'

export {
  // реестры известных типов
  KNOWN_PART_TYPES,
  KNOWN_RUN_EVENT_TYPES,
  // Part guards
  isTextPart,
  isThinkingPart,
  isToolUsePart,
  isToolResultPart,
  isFilePart,
  isImagePart,
  isErrorPart,
  isCustomPart,
  isKnownPart,
  // RunEvent guards
  isRunEvent,
  isKnownRunEvent,
  // хелперы
  derivedText,
  matchToolPair,
  subagentParent,
  // session-meta-spec §2, §7 — merge патча меты и режим промпта
  mergeSessionMeta,
  isSessionPromptMode,
  sessionPromptMode,
  // profile-editor-spec §2 — id и витрина профиля
  isProfileId,
  profileInfoOf,
  // bot-as-session-spec §1 — встроенный профиль
  INLINE_PROFILE_ID,
  isProfileDoc,
  // v1.10 — ран без user-сообщения
  canContinue,
  canSteer,
  // v1.18 — команды рана, узел компакции
  canCommand,
  canChoices,
  canEditor,
  canImpersonate,
  isParticipantRef,
  targetsUser,
  compactionOf,
  // v1.20 — рабочий каталог сессии
  canSessionCwd,
  canProjects,
  DEFAULT_PROJECT_ID,
  isProjectId,
  pluginsForWorkspace,
  projectIdOf,
  sessionProjectOf,
  isAbsolutePath,
  sessionCwdOf,
  // v1.29 — движки хаба
  canEngines,
  canSetEngine,
  switchTargets,
  engineCaps,
  canAttachRun,
  canListLive,
  canArchiveSessions,
  canMoveSession,
  // v1.57 — окна ленты и списка
  canPageHistory,
  canPageSessions,
  matchSessionQuery,
  pageSessions,
  historyWindow,
  // v1.59 — скиллы сессии
  canSessionSkills,
  sessionSkills,
  sessionSkillNames,
  isArchivedSession,
  pickArchived,
  archivePatch,
  canReleaseSession,
  localEngineOf,
  sessionEngineOf,
  engineItems,
  // v1.30 — пользователи стенда
  canUsers,
  isStandOwner,
  canShareSession,
  canWriteSession,
  canWriteFiles,
} from './helpers.js'

export type { ToolPair } from './helpers.js'

export {
  // attachments-spec §2–3 — правила attachments.put, общие для бэкендов
  ATTACHMENT_MIMES,
  AttachmentRejectedError,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  TEXT_ATTACHMENT_EXTENSIONS,
  attachmentKind,
  attachmentLimits,
  attachmentPart,
  attachmentContent,
  attachmentDataUrl,
  canGetAttachment,
  estimateTokens,
} from './attachments.js'

export type { AttachmentContentInput, AttachmentKind, AttachmentPartInput } from './attachments.js'

export {
  // workspace-files-spec §1 — правила workspace.files, общие для бэкендов
  ALWAYS_IGNORED_NAMES,
  DEFAULT_FILE_READ_MAX_BYTES,
  FileBadRequestError,
  FileConflictError,
  FileNotFoundError,
  WORKSPACE_TRASH_DIR,
  DEFAULT_FILE_SEARCH_LIMIT,
  FILE_SEARCH_LINE_MAX,
  MAX_FILE_SEARCH_LIMIT,
  checkFileReadSize,
  compileFileSearch,
  decodeFileContent,
  fileGlobRegExp,
  fileContent,
  fileMime,
  isIgnoredPath,
  isTrashPath,
  isWorkspaceUpdateEvent,
  matchGitignore,
  normalizeFilePath,
  parentFilePath,
  parseGitignore,
  parseWorkspaceEvent,
  serializeWorkspaceEvent,
} from './files.js'

export type { FileContentInput, FileSearchMatcher, GitignoreRule } from './files.js'

export {
  // prompt-recipe-spec §1, §3 — рецепт промпта: запись в сессии и форма
  PROMPT_RECIPE_CUSTOM_TYPE,
  PROMPT_HASH_LENGTH,
  PROMPT_MESSAGE_HASH_LENGTH,
  isPromptRecipe,
} from './prompts.js'

export {
  // personas-spec §1–2, §4 — запись в сессии, форма, имя в тексте
  PERSONAS_CUSTOM_TYPE,
  PERSONA_INJECTION_SOURCE,
  charPersonas,
  expandPersonaNames,
  isPersona,
  isPersonasDoc,
  personaPrefixed,
  personasCapability,
  personaContext,
  personasDocOf,
  personasSystemBlock,
  personasVoiced,
  stripPersonaPrefix,
  turnPersona,
  userPersona,
  validatePersonas,
} from './personas.js'

export {
  // plugin-services-spec §2 — сервисы плагинов (v1.11)
  SERVICE_ERROR_EVENT,
  SERVICE_HTTP_METHOD,
  SERVICE_EVENT_SSE,
  SERVICE_END_SSE,
  canService,
  isServiceEvent,
  serviceErrorEvent,
  serializeServiceEvent,
  serializeServiceEnd,
  parseServiceFrame,
  SERVICE_MUX_PATH,
  SERVICE_MUX_SSE,
  serializeServiceMux,
  parseServiceMuxFrame,
} from './services.js'

export type { ServiceEvent, ServiceDescriptor, ServiceHttpRequest, ServiceHttpResponse, ServiceKind, ServiceFrame, ServiceMuxStream, ServicesCapability } from './services.js'

// активность сессий (v1.69): поток встроенного сервиса хаба
export { SESSION_ACTIVITY_SERVICE, SESSION_ACTIVITY_STREAM, SESSION_ACTIVITY_EVENT, isSessionActivity, canSessionActivity } from './activity.js'
export type { SessionActivity, SessionActivityKind } from './activity.js'

// file-links-spec §3 — файл вне пространств, действия хоста (v1.41)
export {
  HOST_UNAVAILABLE_CODE,
  canExternalDisk,
  canExternalFiles,
  canExternalSearch,
  canExternalWatch,
  canExternalWrite,
  canExternalLocate,
  canHostOpen,
  canHostOpenOn,
  externalHosts,
  externalHostsInfo,
  hostByHome,
  isHubHost,
  parseExternalEvent,
  serializeExternalEvent,
} from './external.js'
export type {
  ExternalFileStat,
  ExternalSignKey,
  ExternalFilesCapability,
  ExternalFilesOps,
  ExternalHostInfo,
  ExternalHostState,
  ExternalOpts,
  ExternalSearchQuery,
  ExternalUpdateEvent,
  ExternalUpdateListener,
  FileAddress,
  HostActionOpts,
  HostActionResult,
  HostCapability,
  HostOps,
} from './external.js'

// link-resolver-spec — резолвер ссылок, сервис ядра `links` (v1.54)
export { LINKS_CHANGED_EVENT, LINKS_SERVICE, LINK_BUILTIN_RUNS, LINK_LAYERS, canLinks } from './links.js'
export type { LinkActionDef, LinkBuiltinRun, LinkLayer, LinkLayersInput, LinkRuleDef, LinkRules, LinkRunResult, LinkTone } from './links.js'

// objects-spec — объекты и виды, сервис ядра `objects` (v1.49)
export { OBJECTS_SERVICE, canObjects, objectBlockSource, objectHash, recordColor, recordHue, stateActions } from './objects.js'
export type {
  ObjectColorRule,
  ObjectCoverInfo,
  ObjectSlice,
  ObjectStoreInfo,
  ObjectCoverState,
  ObjectDiscuss,
  ObjectDoc,
  ObjectEditorInfo,
  ObjectEvent,
  ObjectLink,
  ObjectLinkGroup,
  ObjectListResult,
  ObjectMetric,
  ObjectQuery,
  ObjectRevision,
  ObjectRow,
  ObjectSaveResult,
  ObjectSource,
  ObjectSourceRef,
  ObjectStates,
  ObjectTemplateView,
  ObjectTypeError,
  ObjectTypeInfo,
  ObjectTypesResult,
  ObjectViewHostKind,
  SessionObjectRef,
} from './objects.js'

// settings-spec — настройки по слоям (v1.40)
export {
  DEFAULT_SETTINGS_SCOPES,
  SERVER_SETTINGS_LAYERS,
  SETTINGS_CHANGED_EVENT,
  SETTINGS_CHANGES_STREAM,
  SETTINGS_KEY,
  SETTINGS_LAYERS,
  SETTINGS_NAME,
  SETTINGS_SERVICE,
  canSettings,
  isSettingsLayer,
  putSetting,
  scopesOf,
} from './settings.js'
export type {
  SettingsCapability,
  SettingsChangedEvent,
  SettingsContext,
  SettingsGetOpts,
  SettingsLayer,
  SettingsLayerInfo,
  SettingsOps,
  SettingsResetOpts,
  SettingsScopes,
  SettingsSection,
  SettingsSetOpts,
  SettingsSnapshot,
  SettingsValues,
  SettingsWriteResult,
} from './settings.js'

// skin-spec §5 — скины как данные (v1.21)
export { canSkins } from './skins.js'
export type { ExternalPluginInfo, PluginChangedEvent, PluginChangedListener, PluginFile, PluginsOps, PluginsSource } from './plugins.js'
export { externalPlugins, parsePluginChanged, serializePluginChanged } from './plugins.js'
export type { SkinInfo, SkinMode, SkinSaveOpts, SkinSaveResult, SkinSelection, SkinsCapability, SkinsListOpts, SkinsOps, UserCssOpts } from './skins.js'
export { CLEARED_KEY_FIELDS, CONTEXT_PIN_TOOL, SKILL_LOAD_TOOL, clearedKeyOf, clearedStub, formatBytes, sessionContextOf, withSessionContext } from './context.js'

export {
  // §9 SSE
  serializeRunEvent,
  parseRunEvent,
  parseSSEStream,
} from './sse.js'
