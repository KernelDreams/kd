/**
 * createStoreBackend — протокольная механика ProtocolBackend поверх **любого**
 * SessionStore (@kerneldreams/chat-store). Написана один раз: run-lifecycle,
 * маппинг операций, busy, version — вместо копии в каждом бэкенде.
 *
 * Run-lifecycle перенесён из backend-mds-spec §4/§6 дословно (норматив):
 * user append сразу + события; regenerate = appendNode-sibling + setActiveLeaf;
 * стрим → RunEvent (id-first); запись ассистента одним appendNode на done;
 * cancel пишет частичное; ошибка generate — store не тронут; busy per-session
 * (реестр ранов у бэкенда, store про раны не знает).
 *
 * Канон: nr-ui-protocol.dev/specs/backend-store-refactor-spec.md
 *        (run-lifecycle — backend-mds-spec §4/§6).
 */

import type { KvStore } from '@kerneldreams/nrd/contracts'
import { randomUUID, sha256Hex } from '@kerneldreams/chat-store/fs'
import { agentEngineModel } from '@kerneldreams/chat-store/builder'
import { CHOICES_META, DIRECTION_META, choicesOf, clientContextOf, directionOf, type DirectionMeta } from '@kerneldreams/chat-store/assembly'
import { ProjectBadRequestError, ProjectNotFoundError, checkProject, expandProject, newProjectId, patchProject, projectInfo, type ProjectEntry, type ProjectsRegistry } from './projects.js'
import { answerRemote, createAliveRegistry, createAskState, createMemoryKv, createRunRegistry, type AskState } from './run-state.js'
import {
  ATTACHMENT_MIMES,
  DEFAULT_ATTACHMENT_MAX_BYTES,
  INLINE_PROFILE_ID,
  NotSupportedError,
  sessionSkillNames,
  PERSONA_INJECTION_SOURCE,
  PROMPT_ACTIVITY_KIND,
  NODE_META_ACTIVITY_KIND,
  MESSAGE_META_EDITABLE,
  isParallelRun,
  PROMPT_HASH_LENGTH,
  PROMPT_MESSAGE_HASH_LENGTH,
  attachmentContent,
  attachmentPart,
  derivedText,
  fileMime,
  expandPersonaNames,
  isAbsolutePath,
  isParticipantRef,
  isPromptRecipe,
  isProfileDoc,
  isProfileId,
  mergeSessionMeta,
  pickArchived,
  historyWindow,
  pageSessions,
  personaPrefixed,
  personasSystemBlock,
  personasVoiced,
  profileInfoOf,
  sessionCwdOf,
  sessionPromptMode,
  stripPersonaPrefix,
  turnPersona,
  userPersona,
  validatePersonas,
  PROMPT_DEBUG_ASK_KIND,
  DEFAULT_PROJECT_ID,
} from '@kerneldreams/ui-protocol'
import type {
  ProjectInfo,
  AnyRunEvent,
  AttachmentContent,
  AttachmentPutResult,
  Capabilities,
  CatalogExtension,
  CatalogSkill,
  CatalogTool,
  HistoryPage,
  HistoryOpts,
  Message,
  MessageEditPatch,
  MessagesOps,
  ModelInfo,
  Part,
  Persona,
  PersonasDoc,
  ProfileDoc,
  ProfileInfo,
  ProfilesListOpts,
  PromptInjection,
  PromptInjectionRole,
  PromptRecipe,
  ParticipantRef,
  PromptView,
  ProtocolBackend,
  RunStartInput,
  RunCommand,
  SessionCreateOpts,
  SessionListOpts,
  SessionMoveInput,
  WorkspaceProject,
  WorkspaceProjectPatch,
  SessionInfo,
  SessionMetaDoc,
  SessionMetaPatch,
  SessionModel,
  SessionToolDecl,
  ServicesHost,
  SwipeTo,
  Usage,
  WorkspaceInfo,
} from '@kerneldreams/ui-protocol'
import {
  StoreAssetNotFound,
  StoreNodeNotFound,
  descendToLeaf,
  nodeToMessage,
  resolveTree,
  swipeInfo,
  toHistory,
} from '@kerneldreams/chat-store'
// SessionModel хранилища (info + nodes) — тёзка протокольного SessionModel
// (выбор модели), поэтому здесь он StoredSession: в одном файле нужны оба.
import type { SessionModel as StoredSession, SessionStore, StoreNode } from '@kerneldreams/chat-store'
import { createMemoryFiles } from './memory-files.js'
import { createProjectFilesRouter, type ProjectFilesFactory } from './project-files.js'
import { aliasIds, repoPrefix, spaceOfSession, type ReposSource } from './repos-core.js'
import { sessionObjectBlocks, sessionObjectsOf } from './session-objects.js'

// ────────────────────────────────────────────────────────────────────────────
// Инъекция генерации (backend-mds-spec §4 — переносится дословно)
// ────────────────────────────────────────────────────────────────────────────

export type GenChunk =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  /**
   * Usage хода модели: относится к текущему ответу ассистента; итог рана — сумма.
   * Кэш (`cacheRead`/`cacheWrite`) и контекст (`context`, итог — последний) —
   * опционально: пишутся в `meta.usage` ответа как есть.
   */
  | { type: 'usage'; input: number; output: number; cacheRead?: number; cacheWrite?: number; context?: { used: number; size: number } }
  | { type: 'model'; model: string }
  // ── агентный ран (backend-nr-spec §7, добавлением) ──────────────────────────
  /**
   * Вызов тула — part `tool_use` текущего ответа ассистента. `stream` — ключ
   * превью (`tool_call_start`), если аргументы стримились: вызов встаёт в ту же
   * часть, а не новой.
   */
  | { type: 'tool_call'; callId: string; name: string; args: unknown; stream?: string; parent?: string }
  /**
   * Тул собирается: имя известно, аргументы ещё текут. Фронту —
   * `part_start` tool_use сразу, дельты аргументов — `part_delta` в ту же часть
   * (`meta.partial`); итог — `tool_call` с тем же `stream`. Без него запись
   * большого файла была бы тишиной до готовых аргументов. `callId` — если уже
   * известен (иначе превью адресуется ключом `stream`).
   */
  | { type: 'tool_call_start'; stream: string; name: string; callId?: string; parent?: string }
  /** Кусок аргументов превью `stream`; `replace` — целиком вместо прежнего (снимок разобранного). */
  | { type: 'tool_call_delta'; stream: string; delta: string; replace?: boolean }
  /**
   * Результат тула — отдельное сообщение `role: 'tool'` с part `tool_result`.
   * Закрывает текущий ответ ассистента (пишется сразу); следующий text/thinking/
   * tool_call открывает новый ответ — ход модели после тулов.
   */
  | { type: 'tool_result'; callId: string; name: string; text: string; data?: unknown; parent?: string; subagentContext?: number }
  /** Ошибка тула — то же сообщение, `meta.error: true`. */
  | { type: 'tool_error'; callId: string; name: string; message: string; data?: unknown; parent?: string; subagentContext?: number }
  /*
   * `parent` у вызова и результата (v1.60) — callId тула `Agent`, чей субагент сделал
   * вызов: пишется в `meta.parent` части; `subagentContext` — окно субагента после вызова.
   */
  /**
   * Заметка в ленте: видна человеку, модели — нет. Закрывает текущий
   * ответ (его текст/рассуждение пишутся как есть) и пишет отдельное сообщение
   * ассистента с `flags.disabled` (вне контекста, в ленте — приглушённо). Ран при
   * этом не ошибка — например, «модель вернула пустой ответ (только размышления)».
   */
  | { type: 'note'; text: string }
  /**
   * Сообщение человека влилось в идущий ход (`ProtocolBackend.steer`):
   * закрывает текущий ответ (если в нём уже что-то есть) и пишется user-узлом
   * `meta.steered` на этом месте ленты; событие `message_start`/`message_end`
   * приезжает фронту в потоке рана. Следующий text/tool_call открывает новый ответ.
   */
  | { type: 'user'; message: string | Part[] }
  /**
   * Картинка человеку в ленте (П-3): результат тула (генерация, правка) —
   * отдельным сообщением ассистента с `ImagePart`; байты — во вложения сессии
   * (`ref` драйвера, превью — `attachments.get`), `path` — файл на диске
   * (`meta.path`, им модель отдаёт картинку рефом). Закрывает текущий ответ, как
   * `note`. В транскрипт модели сообщение без текста не идёт — картинку модель
   * видит результатом тула.
   */
  | { type: 'image'; name: string; mime: string; data: Uint8Array; path?: string }
  /**
   * Вопрос пользователю (`ask`, §5.3). Генерация ждёт ответ через
   * `GenerateRequest.awaitAnswer(askId)`; есть только при опции `ask`.
   */
  | { type: 'ask'; askId: string; kind: string; payload: unknown }
  /**
   * Вопрос снят без ответа человека (task-session-spec §4): безголовый ран не
   * дождался апрува за таймаут — генерация ответила сама. Фронт и снимок рана
   * гасят карточку (`ask_end`).
   */
  | { type: 'ask_end'; askId: string }
  /**
   * Компакция контекста (протокол v1.18, `COMPACTION_PART_HINT`): узел
   * `compaction` пишется в стор (опция `compaction`) — до ответа рана или
   * вместо него (`/compact`), — и уходит фронту сообщением `role: 'system'`.
   * Нет опции — чанк пропускается.
   */
  | {
      type: 'compaction'
      summary: string
      firstKeptEntryId: string
      tokensBefore: number
      details?: unknown
      usage?: { input: number; output: number }
    }

  /**
   * Патч меты сессии из рана (v1.32, front-context-spec §4): бэкенд
   * пишет `context.cleared` (что не в контексте модели), тул агента
   * `context_pin` — `context.pinned`. Правило патча — `mergeSessionMeta`
   * (верхний ключ целиком); пишется без проверки `busy` (это сам ран), фронту —
   * событие `session_update` с ключами патча. Драйвер без меты — пропуск.
   */
  | { type: 'meta'; patch: SessionMetaPatch }
  /**
   * Патч меты существующего узла ветки: лорбук v2 пишет закрепления
   * `meta.lore`/`meta.loreOnce` в реплику игрока хода. Мелкий merge
   * (`NodePatch.meta`, `null` снимает ключ), содержимое не трогается; драйвер без
   * `editNode` — пропуск. Событие фронту не шлётся: мета реплики модели, не ленте.
   */
  | { type: 'node_meta'; id: string; patch: Record<string, unknown> }
  /**
   * Сиблинг узла (v1.70, §6, обработчик гритинга; только служебный ран):
   * среди сиблингов `of` ищется узел, чья мета совпала с `match` (ключи — пути через
   * точку, сравнение по JSON); нашёлся — он становится активным (свайп), нет и есть
   * `text` — новый сиблинг с `meta`, активный. Кадр `activity` `node_meta` `{id, patch: {active: true}}`.
   */
  | { type: 'sibling'; of: string; match?: Record<string, unknown>; text?: string; meta?: Record<string, unknown> }
  /**
   * Рецепт хода (backend-nr-spec §7, добавлением): system, который на самом
   * деле ушёл модели (сборка генерации — профиль, каталог скиллов…). При опции
   * `prompts` замещает system рецепта; без опции — пропускается.
   */
  | {
      type: 'recipe'
      system: string
      /**
       * Полный рецепт сборки (добавлением; всё необязательно): system
       * по блокам с источниками, инъекции с текстом и причиной, id сообщений
       * контекста (иначе — вход генерации), тулы рана, адресат хода, запрос
       * как ушёл (`sent` — для кадра impersonate).
       */
      systemBlocks?: Array<{ source: string; text: string }>
      injections?: Array<{ role: PromptInjectionRole; text: string; source?: string; reason?: string }>
      messageIds?: string[]
      tools?: string[]
      target?: ParticipantRef
      sent?: Array<{ role: string; content: string }>
      /**
       * Промпт рана `.mds` (session-document-spec §4.1): `%meta` и узлы,
       * как ушли провайдеру. Отдаётся `meta.get` как `effectivePrompt` — последний
       * ран сессии, в памяти процесса (рестарт — до следующего рана).
       */
      mds?: string
    }

export interface GenerateRequest {
  /** Активный путь в DTO протокола, БЕЗ `flags.disabled`-сообщений (§4; legacy hidden драйвер маппит в disabled). */
  messages: Message[]
  session: SessionInfo
  sessionMeta?: Record<string, unknown>
  /**
   * Персоны (personas-spec §5), только при опции `personas` и непустом
   * документе: весь документ и персона хода. Имена уже подставлены — в
   * `sessionMeta.prompt` раскрыты `{{char}}`/`{{user}}`, а когда имена в ходу
   * (собеседников >1 или у персоны хода `prompt`), у текста user/assistant
   * сообщений префикс `Имя: `, а `system` несёт блок участников.
   */
  personas?: PersonasDoc
  persona?: Persona
  /** Блок участников (§4) — когда имена в ходу; фикстура кладёт его куда хочет. */
  system?: string
  /**
   * Адресат хода (`RunStartInput.target`, v1.19). `{kind: 'user'}` — impersonate:
   * ответ генерации стримится несохраняемым сообщением игрока; есть только
   * при опции `impersonate`.
   */
  target?: ParticipantRef
  /** Impersonate: текст `userMessage` — `{{input}}` шаблона (в ленту не пишется). */
  input?: string
  signal: AbortSignal
  /**
   * Профиль сессии документом (profiles-spec §2): из каталога опции `profiles`
   * или встроенный. Нет каталога — нет поля.
   */
  profile?: ProfileDoc
  /** Тулы сессии (`sessionMeta.tools`, протокол v1.16) — исполнитель решает generate. */
  tools?: SessionToolDecl[]
  /**
   * Рабочий каталог сессии (`sessionMeta.workspace.cwd`, v1.20) — только при
   * опции `sessionCwd`; нет — каталог окружения (решает генерация).
   */
  cwd?: string
  /**
   * Проект сессии (v1.26, projects-spec §2) — запись реестра опции `projects`:
   * `dirs`, `skills`, `context` — генерации (ACP: `additionalDirectories`,
   * скиллы; nr — скиллы). Нет опции или проект пропал из реестра — нет поля.
   */
  project?: ProjectEntry
  /**
   * Префикс сессии после агента (v1.35, spaces-spec §4): контекст проекта
   * (`SessionInfo.project`) и доп. скиллы старта (`sessionMeta.skills`) — блоки
   * на место `<{ project }>` шаблона агента. Нет проекта и скиллов — нет поля.
   */
  prefix?: Array<{ source: string; text: string }>
  /**
   * Подключённые скиллы сессии (v1.59): `sessionMeta.skills` в режиме `linked` —
   * имена (или пути папок); генерация добавляет их к каталогу скиллов рана (агент грузит
   * сам). `loaded` — уже в `prefix`. Нет — поля нет.
   */
  skills?: string[]
  /** Проект сессии на диске (v1.35): корень, контекст-пакет, файлы префикса. */
  repo?: ProjectInfo
  /**
   * Ответ на `ask`-чанк (§5.3): резолвится `respond(sid, askId, answer)`,
   * отменой рана — reject. Есть ровно при опции `ask`.
   */
  awaitAnswer?(askId: string): Promise<unknown>
  /**
   * Безголовый ран (`RunStartInput.headless`, v1.36): человека у сессии нет —
   * апрув генерация ждёт не дольше своего таймаута и отвечает отказом сама.
   */
  headless?: boolean
  /**
   * Команда рана (`RunStartInput.command`, v1.18) — только из опции `commands`.
   * Ран команды: user-сообщения нет, ответ ассистента не открыт заранее.
   */
  command?: RunCommand
  /**
   * Направление хода игрока (`RunStartInput.direction`, v1.47, cyoa-spec §3):
   * у impersonate — вход шаблона (намерение, тон, длина). У хода — уже в
   * `meta.direction` реплики; здесь не дублируется.
   */
  direction?: DirectionMeta
}

export type GenerateFn = (req: GenerateRequest) => AsyncIterable<GenChunk>

/** Итог рана: вход/выход/кэш — сумма ходов, контекст — последний. */
function sumUsage(a: Usage | undefined, b: Usage): Usage {
  const out: Usage = { input: (a?.input ?? 0) + b.input, output: (a?.output ?? 0) + b.output }
  if (a?.cacheRead !== undefined || b.cacheRead !== undefined) out.cacheRead = (a?.cacheRead ?? 0) + (b.cacheRead ?? 0)
  if (a?.cacheWrite !== undefined || b.cacheWrite !== undefined) out.cacheWrite = (a?.cacheWrite ?? 0) + (b.cacheWrite ?? 0)
  const context = b.context ?? a?.context
  if (context) out.context = context
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// Опции
// ────────────────────────────────────────────────────────────────────────────

export interface StoreBackendOpts {
  /** Хранилище — вся format-специфика (mds/pi/claude/remote) внутри драйвера. */
  store: SessionStore
  /** Инъекция генерации (§4). */
  generate: GenerateFn
  /** `Capabilities.name`. */
  name?: string
  /**
   * Каталог моделей (models-spec §5). Задан — бэкенд заявляет capability
   * `models` и умеет `list`/`set`; не задан — capability нет, метода нет,
   * биндинг отвечает not_supported.
   */
  models?: ModelInfo[]
  /** Модель сессий, для которых выбор ещё не делали. Должна быть из `models`. */
  defaultModel?: SessionModel
  /**
   * Модель, которой пойдёт ран без выбора (П-15): `$model` окружения, когда
   * `defaultModel` не задан (чтобы работал `$model` профиля). Только показ —
   * `SessionInfo.model` сессии без выбора: `$model` её профиля, иначе эта.
   * В выбор не пишется.
   */
  fallbackModel?: string
  /** Id движка этого бэкенда в хабе — ключ `models` агента; по умолчанию `nr`. */
  engineId?: string
  /**
   * Каталог профилей (profiles-spec §5) — для фикстур, без семантики: выбор
   * только запоминается и виден в `SessionInfo.profile` (и в `session` запроса
   * генерации), на саму генерацию не влияет. Задан — capability
   * `profiles {switch, edit}`: `list`/`set`/`get` и правка каталога в памяти
   * (`save`/`delete`/`duplicate`, profile-editor-spec §4); не задан — ничего.
   * Элемент — `ProfileDoc` или витрина `ProfileInfo` (её `promptMode` читается
   * как `prompt.mode`). Первый профиль каталога — профиль сессий без выбора; он
   * не удаляется.
   */
  profiles?: Array<ProfileDoc | ProfileInfo>
  /**
   * Статические каталоги конструктора профилей (profile-editor-spec §4) — для
   * фикстур. Заданный вид ⇔ флаг `catalogs.<вид>` и метод.
   */
  catalogs?: { tools?: CatalogTool[]; skills?: CatalogSkill[]; extensions?: CatalogExtension[] }
  /**
   * Кастомный трансформ нод перед генерацией (assembly-слой).
   * `StoreNode[] → StoreNode[]` — чистая функция.
   * Если задан — заменяет дефолтную сборку (toHistory + filter hidden).
   * Если не задан — дефолтное поведение (активный путь минус hidden).
   */
  transform?: (nodes: StoreNode[]) => StoreNode[]
  /**
   * Лимит одного вложения, байт (attachments-spec §3). Default 2 МБ — как у
   * backend-pi: фикстура обязана отказывать там же, где живой бэкенд.
   */
  attachmentMaxBytes?: number
  /**
   * Путь файла вложения на диске (image-chat-spec §3.4, П-2): картинка-вложение
   * в `generate` несёт его в `meta.path` — генерация пишет модели `[image: путь]`,
   * чтобы та передала картинку рефом в тул. Нет функции или вернула `undefined` —
   * без пути. Байты картинок (`meta.url` = `data:`) генерация получает всегда.
   */
  attachmentPath?: (sid: string, ref: string) => string | undefined
  /**
   * Файлы пространства (workspace-files-spec §2) — memory-FS для фикстур:
   * карта `path → content` (ключ с `/` в конце — пустой каталог). Задана —
   * capability `workspace.files {write, watch}`, watch — эмуляция на записи;
   * не задана — файлов нет. Живут до конца процесса, store не трогают.
   */
  files?: Record<string, string | Uint8Array>
  /**
   * Промпт сообщения (prompt-recipe-spec §5) — для фикстур: рецепт каждого
   * рана в памяти, capability `prompts`. System — `system` опции с `pre` меты
   * по режиму промпта (append — в начало, replace — вместо); `post` меты —
   * инъекция `user`; сообщения — ровно те, что ушли в `generate`. Рецепты
   * живут до конца процесса, store не трогают.
   */
  prompts?: boolean | { system?: string; store?: RecipeStore }
  /**
   * Персоны (personas-spec §5) — для фикстур: документ персон сессии в памяти,
   * capability `personas {edit, multi}`. Ран подписывает user-сообщение
   * `userId`, ответ — персоной хода (`RunStartInput.personaId`, иначе первая
   * char; regenerate без него — персоной перегенерируемого ответа); `generate`
   * получает сообщения с именами (см. `GenerateRequest.personas`), а префикс
   * `Имя:` известной персоны срезается с ответа — в store текст чистый, имя в
   * `meta.personaId`. Живут до конца процесса, store не трогают.
   */
  personas?: boolean | { store: PersonaStore; raw?: boolean }
  /**
   * Impersonate бэкендом (протокол v1.19, capability `impersonate`): ран с
   * `target: {kind: 'user'}` — без записи в ленту: `userMessage` уходит
   * генерации как `input`, ответ — события сообщения `role: 'user'` (персона
   * игрока), рецепт — кадр `activity` `prompt`. Без опции такой ран —
   * `not_supported`.
   */
  impersonate?: boolean
  /**
   * Сервисы плагинов (plugin-services-spec §4) — `createServicesHost` /
   * `createMemoryServices` из `@kerneldreams/backend-local/services`. Заданы —
   * `backend.services` и capability `services` (что сервисы зарегистрировали);
   * `close()` бэкенда закрывает и их.
   */
  services?: ServicesHost
  /**
   * Вопросы пользователю посреди рана (§5.3): заявленные kinds — capability
   * `ask`, метод `respond`, `GenerateRequest.awaitAnswer`. Не задано — ask-чанк
   * генерации ран не останавливает (событие уходит, ответа ждать не у кого).
   */
  ask?: string[]
  /**
   * Capability `promptDebug` (v1.23): генерация при флаге меты
   * `debugPrompt` шлёт ask `prompt` до провайдера (backend-nr). Нужен `ask` с `prompt`.
   */
  promptDebug?: boolean
  /** Capability `tools.session` (протокол v1.16): generate исполняет тулы `sessionMeta.tools`. */
  sessionTools?: boolean
  /**
   * Рабочий каталог на сессию (протокол v1.20, capability `workspace.perSession`;
   * нужна мета у драйвера): `SessionCreateOpts.cwd` пишется в мету
   * (`workspace.cwd`), каталог из меты едет генерации `GenerateRequest.cwd`.
   * Путь обязан быть абсолютным; функция — ещё и проверка хоста (каталог есть,
   * разрешён): throw → `bad_request`, при create — до создания сессии.
   */
  sessionCwd?: boolean | ((cwd: string) => void | Promise<void>)
  /**
   * Проекты стенда (v1.26, projects-spec): `workspace.list` — реестр (`kind:
   * 'project'`), `switch` — текущий проект процесса, `sessions.list({workspace})`
   * — сессии проекта (`SessionInfo.workspace`, без пометки — `default`),
   * `sessions.create` — `$root` → `cwd` (при `sessionCwd`), `$profile`/`$model` —
   * если не заданы явно; пометка — в шапке сессии. `create`/`update` реестра —
   * capability `workspace.edit`. Генерация получает запись `GenerateRequest.project`.
   */
  projects?: ProjectsRegistry
  /**
   * Файлы проекта на диске (нужна `projects`): хост по записи проекта
   * собирает пространство (backend-fs: `$root` + `$dirs` папками в корне).
   * `workspace.files` — пространство текущего проекта процесса, смена
   * проекта (`switch`) — `workspace_update ['']`. Опция `files` (memory-FS
   * фикстуры) важнее.
   */
  projectFiles?: ProjectFilesFactory
  /**
   * Проекты пространств на диске (v1.35, spaces-spec §2; нужна `projects`):
   * маски `$projects` → `workspace.repos`, `SessionCreateOpts.project/skills`. Хост
   * (node) — `createRepos()`; нет — capability `workspace.repos` нет.
   */
  repos?: ReposSource
  /**
   * Папки доп. скиллов старта по имени (v1.35, spaces-spec §4): кэш skillbox /
   * `$skills_dir` хоста. Нет — только абсолютные пути.
   */
  skillDir?: (names: string[]) => Promise<Array<{ name: string; dir: string }>>
  /**
   * Чтение `SKILL.md` скиллов сессии без `repos` (v1.59): хост с `skillDir`, но без проектов
   * на диске. Есть `repos` — читает он.
   */
  readText?: (path: string) => Promise<string | undefined>
  /**
   * Персистентный выбор модели и профиля сессии (живой бэкенд; без опции — в
   * памяти процесса). `get` — один раз на сессию, лениво (get/history/run);
   * `set` — на каждый выбор (create с моделью/профилем, `models.set`,
   * `profiles.set`). Встроенный профиль (`inline`) — с документом (`profileDoc`).
   */
  choices?: {
    get(sid: string): Promise<SessionChoices>
    set(sid: string, choices: SessionChoices): Promise<void>
  }
  /**
   * Файловый каталог профилей (живой бэкенд): `list()` читается на каждый
   * запрос каталога и ран (внешняя правка файла видна), правки конструктора
   * (`save`/`delete`/`duplicate`) уходят в него. Опция `profiles` при этом —
   * встроенные профили (не файлы): идут первыми, первый — профиль сессий без
   * выбора.
   */
  /**
   * Команды рана (протокол v1.18, `run.commands`): имена, с которыми ран
   * пускается в `generate` (`GenerateRequest.command`). Прочие — `not_supported`.
   */
  commands?: string[]
  /**
   * Запись узла компакции (чанк `compaction`): расширение `compaction` драйвера.
   * `parent` — родитель записи (ветка regenerate), нет — текущий лист.
   */
  compaction?: {
    append(
      sid: string,
      input: { summary: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown; usage?: { input: number; output: number }; parent?: string },
    ): Promise<StoreNode>
  }
  /**
   * Состояние ранов: busy сессий и ранние ответы на `ask` — в kv
   * хоста, а не в памяти процесса (Worker без общей памяти). Нет — kv в памяти
   * процесса. С внешним kv ран опрашивает его за ответами из других процессов.
   */
  kv?: KvStore
  profileStore?: {
    /**
     * Каталог глазами проекта `workspace` (agents-spec §2): агенты
     * проекта поверх общих. Нет — каталог стенда.
     */
    list(workspace?: string): ProfileDoc[]
    save(doc: ProfileDoc): ProfileDoc | Promise<ProfileDoc>
    delete(id: string): void | Promise<void>
    duplicate?(id: string, newId: string): ProfileDoc | Promise<ProfileDoc>
  }
}

/**
 * Персистентные персоны (personas-spec §5): документ сессии в
 * хранилище — расширение `personas` драйвера (nr-chat — шапка `%meta`, pi —
 * запись `nr-session-personas`). С ним capability
 * `personas` — не фикстурная память, а сессия. `raw: true` (опция `personas`)
 * — `generate` получает сообщения и мету как есть: имена в тексте и
 * `{{char}}/{{user}}` раскрывает сама сборка (backend-nr).
 */
export interface PersonaStore {
  get(sid: string): Promise<PersonasDoc>
  set(sid: string, doc: PersonasDoc): Promise<void>
}

/**
 * Персистентные рецепты (prompt-recipe-spec §3) — расширение `recipes`
 * драйвера (`StoreRecipesApi` nr-chat-store): nr-chat — `meta.recipe` ответа +
 * тексты в sidecar, pi — `nr-prompt-recipe` + `<файл>.prompts/<hash>.md`.
 * `effective` — `.mds` промпта последнего рана в хранилище:
 * `effectivePrompt` переживает рестарт; нет — только память процесса.
 */
export interface RecipeStore {
  put(sid: string, data: PromptRecipe & { forMessageId: string }, texts: ReadonlyMap<string, string>): Promise<void>
  get(sid: string, messageId: string): Promise<{ data: unknown; texts: Map<string, string> } | undefined>
  effective?: {
    get(sid: string): Promise<string | undefined>
    set(sid: string, mds: string): Promise<void>
  }
}

/** Выбор сессии для {@link StoreBackendOpts.choices}. */
export interface SessionChoices {
  model?: SessionModel
  profile?: string
  /** Документ встроенного профиля (`profile: 'inline'`): хранилище держит его в сессии, рестарт его не теряет. */
  profileDoc?: ProfileDoc
}

/** У сообщения нет рецепта промпта (prompt-recipe-spec §2): не ответ, либо ран был до опции. */
export class StorePromptNotFoundError extends Error {
  readonly code = 'not_found'
  constructor(mid: string) {
    super(`backend-store: у сообщения ${mid} нет рецепта промпта`)
    this.name = 'StorePromptNotFoundError'
  }
}

/** Вход операции не годится (append без parts, чужая роль). */
export class StoreBadRequestError extends Error {
  readonly code = 'bad_request'
  constructor(message: string) {
    super(`backend-store: ${message}`)
    this.name = 'StoreBadRequestError'
  }
}

/** Запрошена модель, которой нет в каталоге бэкенда (models-spec §3). */
export class StoreUnknownModelError extends Error {
  readonly code = 'bad_request'
  constructor(id: string) {
    super(`backend-store: модели ${id} нет в каталоге`)
    this.name = 'StoreUnknownModelError'
  }
}

/** Запрошен профиль, которого нет в каталоге бэкенда (profiles-spec §4). */
export class StoreUnknownProfileError extends Error {
  readonly code = 'bad_request'
  constructor(id: string) {
    super(`backend-store: профиля ${id} нет в каталоге`)
    this.name = 'StoreUnknownProfileError'
  }
}

/** Профиля с таким id в каталоге нет (profile-editor-spec §3: get/delete/duplicate). */
export class StoreProfileNotFoundError extends Error {
  readonly code = 'not_found'
  constructor(id: string) {
    super(`backend-store: профиля ${id} нет в каталоге`)
    this.name = 'StoreProfileNotFoundError'
  }
}

/** `duplicate` в занятый id (profile-editor-spec §3). */
export class StoreProfileConflictError extends Error {
  readonly code = 'conflict'
  constructor(id: string) {
    super(`backend-store: профиль ${id} уже есть`)
    this.name = 'StoreProfileConflictError'
  }
}

/** Сессия занята живым раном — мутации применяются между ранами (§3, §4.3). */
export class StoreBusyError extends Error {
  readonly code = 'busy'
  constructor(sid: string) {
    super(`backend-store: сессия ${sid} занята живым раном`)
    this.name = 'StoreBusyError'
  }
}

// ────────────────────────────────────────────────────────────────────────────
// createStoreBackend
// ────────────────────────────────────────────────────────────────────────────

/** Сколько лент держит кэш `history`: повторное открытие недавних — без разбора файла. */
const HISTORY_CACHE_MAX = 12

export function createStoreBackend(opts: StoreBackendOpts): ProtocolBackend {
  const { store, generate, name, transform } = opts
  const catalog = opts.models
  const attachmentMaxBytes = opts.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES

  /**
   * Байты вложений, когда драйвер хранить их не умеет (attachments-spec §3:
   * «memory-хранилище байтов — для фикстур»): sid → ref → байты.
   *
   * Назад их отдаёт `attachments.get` (v1.10: превью и аватар после
   * перезагрузки вкладки); живут до конца процесса.
   */
  const blobs = new Map<string, Map<string, { data: Uint8Array; mime?: string }>>()

  /**
   * Единственное пространство бэкенда (workspace-spec §4).
   *
   * `id: 'memory'` — не про драйвер, а про природу: пространство здесь не место
   * на диске, а сам store, отданный опцией. Клиенту важно лишь, что оно одно и
   * не меняется, — id для него opaque.
   */
  const workspaceInfo: WorkspaceInfo = { id: 'memory', name: name ?? 'memory' }

  /** Файлы пространства (workspace-files-spec §2): есть ровно при опции. */
  const memoryFiles = opts.files ? createMemoryFiles(opts.files, { rootName: workspaceInfo.name }) : undefined
  /** Файлы проекта на диске: за текущим проектом процесса. */
  const filesRouter =
    !memoryFiles && opts.projects && opts.projectFiles
      ? createProjectFilesRouter(
          opts.projectFiles,
          async () => {
            const list = await projectList()
            const cur = list.find((p) => p.id === currentProject) ?? list.find((p) => p.id === DEFAULT_PROJECT_ID) ?? list[0]
            if (!cur) throw new ProjectNotFoundError(currentProject)
            return cur
          },
          async (id) => {
            const got = (await projectList()).find((p) => p.id === id)
            if (!got) throw new ProjectNotFoundError(id)
            return got
          },
        )
      : undefined
  const files = memoryFiles ?? filesRouter?.ops

  /** Сессии с живым раном (§3: один активный run, мутация при живом → busy) — в kv. */
  const runKv = opts.kv ?? createMemoryKv()
  /** Живость исполнителей тулов сессии (`toolsAlive` патча меты) — в том же kv. */
  const alive = createAliveRegistry(runKv)
  const runs = createRunRegistry(runKv)
  /** Управление живыми ранами для cancel: sid → {runId, abort}. */
  const runControls = new Map<string, { runId: string; ac: AbortController }>()
  /** Ожидающие ответа ask живого рана (§5.3): sid → состояние. Есть ровно при опции `ask`. */
  const runAsks = new Map<string, AskState>()
  let runSeq = 0

  /**
   * Рецепты промптов (prompt-recipe-spec §5): sid → id ответа → рецепт и тексты
   * по хэшу. В памяти, как выбор модели: в контракте SessionStore места нет.
   */
  const promptsOpt = opts.prompts ? (opts.prompts === true ? {} : opts.prompts) : undefined
  const recipes = new Map<string, Map<string, { recipe: PromptRecipe; texts: Map<string, string> }>>()
  /** `effectivePrompt` сессий: `.mds` промпта последнего рана (чанк `recipe.mds`). */
  const effective = new Map<string, string>()

  /** Документы персон (personas-spec §5): sid → документ. В памяти, как рецепты (фикстура). */
  const personaStore = typeof opts.personas === 'object' ? opts.personas.store : undefined
  const personasRaw = typeof opts.personas === 'object' && opts.personas.raw === true
  const personaDocs = opts.personas === true ? new Map<string, PersonasDoc>() : undefined
  const personasOn = personaDocs !== undefined || personaStore !== undefined
  // Рабочий каталог сессии (v1.20) живёт в мете — без меты драйвера его негде держать.
  const cwdOn = !!opts.sessionCwd && !!store.meta
  async function checkCwd(cwd: string): Promise<void> {
    if (typeof cwd !== 'string' || !isAbsolutePath(cwd)) throw new StoreBadRequestError(`cwd: ожидается абсолютный путь, получено ${JSON.stringify(cwd)}`)
    if (typeof opts.sessionCwd === 'function') {
      try {
        await opts.sessionCwd(cwd)
      } catch (err) {
        throw new StoreBadRequestError(`cwd ${cwd}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  /** `$root` проекта: абсолютный, хост его принимает (как cwd сессии). */
  async function checkRoot(root: string): Promise<void> {
    if (!isAbsolutePath(root)) throw new ProjectBadRequestError(`root: ожидается абсолютный путь, получено ${JSON.stringify(root)}`)
    if (typeof opts.sessionCwd === 'function') {
      try {
        await opts.sessionCwd(root)
      } catch (err) {
        throw new ProjectBadRequestError(`root ${root}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  async function personasOf(sid: string): Promise<PersonasDoc> {
    if (personaStore) return structuredClone(await personaStore.get(sid))
    return structuredClone(personaDocs?.get(sid) ?? { personas: [] })
  }
  const recipeStore = typeof opts.prompts === 'object' ? opts.prompts.store : undefined

  // ── проекты (v1.26) ──────────────────────────────────────────────────────
  const projects = opts.projects
  const repos: ReposSource | undefined = projects ? opts.repos : undefined
  /** Проект сессии на диске: `project` сессии; сессия алиаса без него — по `$root` старой записи. */
  async function repoOfInfo(info: SessionInfo, list?: ProjectEntry[]): Promise<ProjectInfo | undefined> {
    if (!repos) return undefined
    const all = list ?? (await projectList())
    const ws = info.workspace || DEFAULT_PROJECT_ID
    const space = spaceOfSession(all, ws)
    if (!space) return undefined
    if (info.project) return repos.find(space, info.project)
    if (space.id === ws) return undefined
    return repos.ofRoot(space, all.find((p) => p.id === ws)?.root)
  }
  /** Блоки префикса сессии (проект + скиллы старта) — на каждом ране: файлы свежие. */
  async function prefixOf(info: SessionInfo, meta: unknown): Promise<{ prefix?: Array<{ source: string; text: string }>; repo?: ProjectInfo; skills?: string[] }> {
    // Объекты сессии (v1.53): карточка «Обсудить» — блоком после проекта и скиллов, источник `object:<тип>/<id>`.
    const objects = sessionObjectBlocks(meta)
    // Скиллы сессии (v1.59): `loaded` (и строки — скиллы старта) — `SKILL.md` в префиксе, `linked` — каталогу рана.
    const linked = sessionSkillNames(meta as SessionMetaDoc | undefined, 'linked')
    const tail: { skills?: string[] } = linked.length ? { skills: linked } : {}
    const readText = repos ? repos.readText.bind(repos) : opts.readText
    if (!readText) return objects.length ? { prefix: objects, ...tail } : tail
    const repo = repos && info.project ? await repoOfInfo(info) : undefined
    const skills = sessionSkillNames(meta as SessionMetaDoc | undefined, 'loaded')
    if (!repo && !skills.length) return objects.length ? { prefix: objects, ...tail } : tail
    const got = await repoPrefix(repo, skills, readText, opts.skillDir)
    const blocks = [...got.blocks, ...objects]
    return { ...(blocks.length ? { prefix: blocks } : {}), ...(repo ? { repo } : {}), ...tail }
  }
  /** Список сессий стенда (фильтр архива и пространства) — до поиска и окна v1.57. */
  async function listRows(listOpts?: SessionListOpts): Promise<SessionInfo[]> {
    // Архивные (v1.55) — по `archived`; по умолчанию без них.
    const all = pickArchived((await store.list()).sessions, listOpts?.archived)
    // Проект (v1.26): без пометки — `default`; без опции — фильтра нет.
    const want = projects ? listOpts?.workspace : undefined
    // Алиасы (v1.35): сессии старых id пространства — здесь же, проект — по `$root` старой записи;
    // без `workspace` — все, у сессий алиасов проект дописан тоже.
    const spaces = projects ? await projectList() : []
    if (want === undefined && !spaces.some((p) => p.aliases?.length)) return all.map(withModel)
    const ids = want === undefined ? null : new Set([want, ...(spaces.find((p) => p.id === want)?.aliases ?? [])])
    const picked = ids ? all.filter((s) => ids.has(s.workspace || DEFAULT_PROJECT_ID)) : all
    const out: SessionInfo[] = []
    for (const s of picked) {
      const sw = s.workspace || DEFAULT_PROJECT_ID
      if (!s.project && sw !== want && (want !== undefined || spaces.some((p) => p.id !== sw && p.aliases?.includes(sw)))) {
        const repo = await repoOfInfo(s, spaces)
        out.push(withModel(repo ? { ...s, project: repo.id } : s))
      } else out.push(withModel(s))
    }
    return out
  }

  /** Текущий проект процесса (`workspace.switch`); клиент шлёт свой явно. */
  let currentProject = DEFAULT_PROJECT_ID
  async function projectList(): Promise<ProjectEntry[]> {
    return projects ? await projects.list() : []
  }
  async function projectById(id: string): Promise<ProjectEntry> {
    const found = (await projectList()).find((p) => p.id === id)
    if (!found) throw new ProjectNotFoundError(id)
    return found
  }
  /** Проект сессии по пометке; пропал из реестра — нет. */
  async function projectOfInfo(info: SessionInfo): Promise<{ project?: ProjectEntry }> {
    if (!projects) return {}
    const id = info.workspace || DEFAULT_PROJECT_ID
    const found = (await projectList()).find((p) => p.id === id)
    return found ? { project: structuredClone(found) } : {}
  }
  async function currentInfo(): Promise<WorkspaceInfo> {
    const list = await projectList()
    const cur = list.find((p) => p.id === currentProject) ?? list.find((p) => p.id === DEFAULT_PROJECT_ID) ?? list[0]
    if (!cur) return { ...workspaceInfo }
    return projectInfo(cur)
  }

  /**
   * Выбор модели по сессиям (models-spec §5).
   *
   * В памяти, а не в хранилище: в контракте SessionStore поля под модель нет,
   * а `meta` есть не у каждого драйвера. Для сессий, которых тут нет,
   * действует `defaultModel`. Персистентность выбора — задача бэкенда, который
   * умеет её обеспечить (backend-pi спрашивает pi), не этой механики.
   */
  const chosen = new Map<string, SessionModel>()

  /** Модель сессии: явный выбор, иначе дефолт бэкенда, иначе ничего. */
  function modelOf(sid: string): SessionModel | undefined {
    return chosen.get(sid) ?? opts.defaultModel
  }

  /**
   * Выбор профиля по сессиям (profiles-spec §5) — в памяти, по той же причине,
   * что и модель: в контракте SessionStore поля под него нет.
   */
  /**
   * Каталог документов в порядке опции (profile-editor-spec §4): правится
   * `save`/`delete`/`duplicate`, живёт до конца процесса.
   */
  const builtinProfiles = (opts.profiles ?? []).map((p) => profileDocOf(p))
  const profileCatalog = opts.profiles || opts.profileStore ? new Map(builtinProfiles.map((p) => [p.id, p])) : undefined
  /** Каталог из файлов (`profileStore`) поверх встроенных — перед каждым чтением каталога. */
  function refreshProfiles(workspace?: string): void {
    if (!opts.profileStore || !profileCatalog) return
    profileCatalog.clear()
    for (const p of builtinProfiles) profileCatalog.set(p.id, p)
    for (const p of opts.profileStore.list(workspace)) profileCatalog.set(p.id, p)
  }
  refreshProfiles()

  /** Сессии, чей сохранённый выбор уже поднят в память (`choices`). */
  const hydrated = new Set<string>()
  async function hydrate(sid: string): Promise<void> {
    if (!opts.choices || hydrated.has(sid)) return
    hydrated.add(sid)
    let c: SessionChoices
    try {
      c = await opts.choices.get(sid)
    } catch {
      return
    }
    if (c.model && !chosen.has(sid) && catalog?.some((m) => m.id === c.model!.model)) chosen.set(sid, c.model)
    if (c.profile === INLINE_PROFILE_ID && c.profileDoc && !chosenProfile.has(sid)) {
      rememberProfile(sid, { id: INLINE_PROFILE_ID, doc: { ...c.profileDoc, id: INLINE_PROFILE_ID } })
    } else if (c.profile && c.profile !== INLINE_PROFILE_ID && !chosenProfile.has(sid)) {
      refreshProfiles()
      // Агент каталога стенда — живьём из каталога; нет (агент проекта, чужого
      // движка) — встроенный при создании документ.
      if (profileCatalog?.has(c.profile)) chosenProfile.set(sid, c.profile)
      else if (c.profileDoc) rememberProfile(sid, { id: c.profile, doc: { ...c.profileDoc, id: c.profile } })
    }
  }
  async function persistChoice(sid: string, c: SessionChoices): Promise<void> {
    if (!opts.choices) return
    if (c.profile !== undefined) {
      const doc = inlineProfiles.get(sid)
      if (doc) c.profileDoc = doc
      else if (c.profile === INLINE_PROFILE_ID) delete c.profile
    }
    if (c.model === undefined && c.profile === undefined) return
    hydrated.add(sid)
    await opts.choices.set(sid, c)
  }
  /** Профиль сессий без выбора — первый в опции; удалить его нельзя, поэтому id стабилен. */
  const defaultProfileId = opts.profiles?.[0]?.id ?? profileCatalog?.keys().next().value
  const chosenProfile = new Map<string, string>()
  /**
   * Встроенные профили сессий (bot-as-session-spec §1): документ живёт при
   * сессии, каталог его не видит. Выбор — тот же `chosenProfile` с id `inline`.
   */
  const inlineProfiles = new Map<string, ProfileDoc>()

  /** Профиль по id для выбора (create/set); неизвестный — отказ `bad_request`. */
  function profileById(id: string): ProfileInfo {
    refreshProfiles()
    const found = profileCatalog?.get(id)
    if (!found) throw new StoreUnknownProfileError(id)
    return profileInfoOf(found)
  }

  /**
   * Агент по id глазами проекта: есть в каталоге стенда — id; есть
   * только у проекта — документ (встраивается под своим id, шаблон — файлом).
   * Неизвестный — `undefined`.
   */
  function agentFor(id: string, workspace: string | undefined): string | ProfileDoc | undefined {
    refreshProfiles(workspace)
    const found = profileCatalog?.get(id)
    if (!found) return undefined
    if (workspace === undefined) return id
    refreshProfiles()
    return profileCatalog?.has(id) ? id : structuredClone(found)
  }

  /**
   * Выбор профиля сессии (create/set): id каталога — проверка по каталогу;
   * документ — встраивается под id `inline`, каталог не трогается. Возвращает
   * витрину и то, что запомнить; до записи — чтобы отказ не оставил сирот.
   */
  function pickProfile(profile: string | ProfileDoc): { info: ProfileInfo; id: string; doc?: ProfileDoc } {
    if (typeof profile === 'string') {
      const info = profileById(profile)
      return { info, id: info.id }
    }
    if (!isProfileDoc(profile)) throw new StoreBadRequestError('profile: ожидается id или документ профиля {name}')
    // Документ агента из общего каталога (v1.34; помечен `source`): id агента, не `inline`.
    if (profile.source !== undefined && isProfileId(profile.id) && profile.id !== INLINE_PROFILE_ID) {
      const doc: ProfileDoc = structuredClone(profile)
      return { info: profileInfoOf(doc), id: doc.id, doc }
    }
    const doc: ProfileDoc = { ...structuredClone(profile), id: INLINE_PROFILE_ID }
    return { info: profileInfoOf(doc), id: INLINE_PROFILE_ID, doc }
  }

  function rememberProfile(sid: string, picked: { id: string; doc?: ProfileDoc }): void {
    chosenProfile.set(sid, picked.id)
    if (picked.doc) inlineProfiles.set(sid, picked.doc)
    else inlineProfiles.delete(sid)
  }

  /**
   * Профиль сессии документом для generate: встроенный, выбранный из каталога
   * (удалённый — как дефолт), иначе первый каталога. Каталога нет — ничего.
   */
  function profileForGenerate(sid: string): { profile?: ProfileDoc } {
    refreshProfiles()
    const picked = chosenProfile.get(sid)
    const inline = picked !== undefined ? inlineProfiles.get(sid) : undefined
    if (inline) return { profile: structuredClone(inline) }
    const id = picked !== undefined && profileCatalog?.has(picked) ? picked : defaultProfileId
    const doc = id !== undefined ? profileCatalog?.get(id) : undefined
    return doc ? { profile: structuredClone(doc) } : {}
  }

  /** Документ по id для конструктора; неизвестный — `not_found`. */
  function profileDoc(id: string): ProfileDoc {
    refreshProfiles()
    const found = profileCatalog?.get(id)
    if (!found) throw new StoreProfileNotFoundError(id)
    return found
  }

  /**
   * SessionInfo драйвера + текущие выборы сессии поверх (§2: SessionInfo.model,
   * profiles-spec §4: SessionInfo.profile — у сессии без выбора первый профиль
   * каталога; выбранный, но удалённый — тоже он: так бы сессия и поднялась).
   */
  function withModel(info: SessionInfo): SessionInfo {
    const picked = chosenProfile.get(info.id)
    const embedded = picked !== undefined ? inlineProfiles.get(info.id) : undefined
    const inline = picked === INLINE_PROFILE_ID ? embedded : undefined
    const profile = embedded ? picked : picked !== undefined && profileCatalog?.has(picked) ? picked : defaultProfileId
    // Без выбора — модель, которой пойдёт ран (П-15): `$model` профиля, иначе стенда.
    const doc = embedded ?? (profile !== undefined ? profileCatalog?.get(profile) : undefined)
    // `models: {nr: …}` агента — модель именно этого движка, потом общая `model`.
    const fallback = agentEngineModel(doc, opts.engineId ?? 'nr') ?? doc?.model ?? opts.fallbackModel
    const model = modelOf(info.id) ?? (fallback ? { model: fallback } : undefined)
    const out = model ? { ...info, model } : info
    if (inline) return { ...out, profile: INLINE_PROFILE_ID, profileDoc: structuredClone(inline) }
    return profile !== undefined ? { ...out, profile } : out
  }

  /**
   * Выбор → применённое: неизвестная модель — отказ, невозможный уровень
   * рассуждения — молча снимается (§3: `set` возвращает ПРИМЕНЁННОЕ).
   */
  function applyChoice(want: SessionModel): SessionModel {
    const found = catalog?.find((m) => m.id === want.model)
    if (!found) throw new StoreUnknownModelError(want.model)
    const levels = found.thinking ?? []
    const applied: SessionModel = { model: found.id }
    if (want.thinking !== undefined && levels.includes(want.thinking)) applied.thinking = want.thinking
    return applied
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Общее
  // ──────────────────────────────────────────────────────────────────────────

  /** Мутация при живом ране той же сессии → busy (§4.3 backends-spec). */
  async function guardBusy(sid: string): Promise<void> {
    if (await runs.busy(sid)) throw new StoreBusyError(sid)
  }

  /** version сессии: sync-токен от драйвера, иначе пустой (resync через history). */
  async function versionOf(sid: string): Promise<string> {
    return store.version ? await store.version(sid) : ''
  }

  /** Message узла по его id после мутации/записи (пересборка со свайпами и хешем). */
  async function messageAfter(sid: string, nid: string): Promise<Message> {
    const model = await store.load(sid)
    const tree = resolveTree(model.nodes)
    const node = tree.byId.get(nid)
    if (!node) throw new StoreNodeNotFound(nid)
    return nodeToMessage(node, tree)
  }

  /** Лента по версии файла: повторное открытие и ресинк без разбора `.mds`. */
  const historyCache = new Map<string, { version: string; messages: Message[] }>()

  /** Свежий id узла, инъектируемый в meta для id-first (§6.3) при записи на done. */
  function freshNodeId(model: StoredSession): string {
    const taken = new Set(model.nodes.map((n) => n.id))
    let id = randomUUID()
    while (taken.has(id)) id = randomUUID()
    return id
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Ран (§6): user append → generate → запись ассистента одним appendNode
  // ──────────────────────────────────────────────────────────────────────────

  async function* run(sid: string, input: RunStartInput): AsyncIterable<AnyRunEvent> {
    // Команда рана (v1.18) — только заявленная; с репликой или regenerate не смешивается.
    const command = input.command
    if (command !== undefined) {
      if (typeof command?.name !== 'string' || !opts.commands?.includes(command.name)) throw new NotSupportedError(`run.command ${String(command?.name)}`)
      if (input.userMessage !== undefined || input.regenerate) throw new StoreBadRequestError('run.command не совмещается с userMessage/regenerate')
      // Служебная команда (v1.47, `PARALLEL_COMMANDS`): параллельно ходу, без busy;
      // не пишет сообщений — только `node_meta`, он же уходит кадром `activity`.
      if (isParallelRun(input)) {
        yield* sideRun(sid, command)
        return
      }
    }
    if (input.direction !== undefined && !directionOf(input.direction)) throw new StoreBadRequestError('run.direction: ожидается {intent, axis?, tone?, length?, choice?}')
    if (input.vars !== undefined && runVarsOf(input.vars) === undefined && (typeof input.vars !== 'object' || input.vars === null || Array.isArray(input.vars))) throw new StoreBadRequestError('run.vars: ожидается {<переменная>: значение}')
    // Адресат хода (v1.19): impersonate — только заявленный и без команд/regenerate.
    if (input.target !== undefined && !isParticipantRef(input.target)) throw new StoreBadRequestError('run.target: ожидается {kind: user} | {kind: char, personaId?}')
    const impersonating = input.target?.kind === 'user'
    if (impersonating) {
      if (!opts.impersonate) throw new NotSupportedError('run.target user (impersonate)')
      if (command !== undefined || input.regenerate) throw new StoreBadRequestError('impersonate не совмещается с command/regenerate')
    }
    await guardBusy(sid)
    await hydrate(sid)
    const runId = `store-${sid}-${++runSeq}`
    const lease = await runs.begin(sid, runId)
    if (!lease) throw new StoreBusyError(sid)
    const ac = new AbortController()
    runControls.set(sid, { runId, ac })
    const askState = opts.ask ? createAskState({ sid, kv: runKv, signal: ac.signal, ...(opts.kv ? { pollMs: 1000 } : {}) }) : undefined
    if (askState) runAsks.set(sid, askState)

    try {
      // 0. Персоны (personas-spec §5): чей ход — до записи, чтобы чужой id не оставил сироту.
      const cast = personasOn ? await personasOf(sid) : undefined
      const voices = cast && cast.personas.length ? cast : undefined
      let turn: Persona | undefined
      if (voices) {
        let wanted = input.personaId ?? (input.target?.kind === 'char' ? input.target.personaId : undefined)
        if (wanted === undefined && input.regenerate) {
          const was = (await store.load(sid)).nodes.find((n) => n.id === input.regenerate!.messageId)?.meta?.personaId
          if (typeof was === 'string' && turnPersona(voices, was)) wanted = was
        }
        turn = turnPersona(voices, wanted)
        if (wanted !== undefined && !turn) throw new StoreBadRequestError(`personaId ${wanted}: такой char-персоны нет`)
      }
      const userId = voices && userPersona(voices)?.id

      // Impersonate (v1.19): своя ветка — ленту не трогает вовсе.
      if (impersonating) {
        yield* impersonateRun(sid, runId, ac, input, voices, turn, userId, askState)
        return
      }

      // 1. userMessage → appendNode на активный лист, пишется сразу (§6.1).
      let userNode: StoreNode | undefined
      if (input.userMessage !== undefined) {
        const parts = normalizeUserParts(input.userMessage)
        // Заголовок пуст — первые 40 символов первой реплики (общее правило
        // бэкендов). До записи реплики: служебная запись драйвера (pi —
        // `session_info`) ложится в цепочку перед ней, а не между user и ответом.
        if (store.rename) {
          const before = await store.load(sid)
          const title = before.info.title ? undefined : autoTitle([...before.nodes, { role: 'user', parts }])
          if (title) {
            await store.rename(sid, title)
            // Происхождение имени: автоимя — карточка чата может его заменить.
            if (store.meta) await store.meta.patch(sid, { titleSource: 'auto' }).catch(() => undefined)
          }
        }
        // Время и устройство реплики — из них штамп контекста модели.
        const client = clientContextOf(input.client)
        const direction = directionOf(input.direction)
        // Чип переменных пресета (v1.67, §5): перебивка на этот ран — в мету реплики игрока.
        const vars = runVarsOf(input.vars)
        const meta: Record<string, unknown> = { createdAt: new Date().toISOString(), ...(userId ? { personaId: userId } : {}), ...(client ? { client } : {}), ...(direction ? { [DIRECTION_META]: direction } : {}), ...(vars ? { vars } : {}) }
        userNode = await store.appendNode(sid, { role: 'user', parts, meta })
        if (direction) await markPicked(sid, direction)
      }

      // Состояние после user-append: активный путь + дерево для регенерации.
      const model = await store.load(sid)
      const tree = resolveTree(model.nodes)

      // 2. regenerate → assistant будет sibling'ом messageId (ветка от parent, §6.2).
      let regenParent: string | undefined
      // Предки родителя (включая его) по ДЕРЕВУ — до фильтрации disabled и до transform:
      // обрезка контекста ниже ищет последнего предка в собранной истории, а не сам parent,
      // который может быть disabled/вырезан transform'ом (тогда findIndex = -1 и старый ответ
      // с будущей историей уезжали в промпт).
      let regenAncestors: Set<string> | undefined
      if (input.regenerate) {
        const target = tree.byId.get(input.regenerate.messageId)
        if (!target) throw new StoreNodeNotFound(input.regenerate.messageId)
        const parent = tree.parentOf.get(target) ?? null
        if (!parent) throw new Error('backend-store: regenerate первого сообщения сессии не поддержан')
        regenParent = parent.id
        regenAncestors = new Set<string>()
        for (let n: StoreNode | null = parent; n; n = tree.parentOf.get(n) ?? null) regenAncestors.add(n.id)
      }

      // 3. Сборка контекста: кастомный transform или дефолтный путь (§4).
      const assembled = transform ? transform(model.nodes) : model.nodes
      const genTree = resolveTree(assembled)
      let genMessages = toHistory({ ...model, nodes: assembled }, genTree).filter((m) => !m.flags?.disabled)
      // regenerate: контекст обрывается НА родителе — старый ответ (и всё ниже по пути)
      // в промпт НЕ едет, иначе модель эхоит его (улика: usage.input ≈ старый input+output).
      if (regenAncestors) {
        let cut = -1
        for (let i = genMessages.length - 1; i >= 0; i--) {
          if (regenAncestors.has(genMessages[i]!.id)) { cut = i; break }
        }
        genMessages = genMessages.slice(0, cut + 1)
      }
      // Чип переменных на ходе без новой реплики (свайп, «продолжить», §5): перебивка ложится
      // в мету последней реплики игрока — и в сторе, и в собранной истории этого рана.
      const swipeVars = userNode ? undefined : runVarsOf(input.vars)
      if (swipeVars) {
        const at = genMessages.map((m) => m.role).lastIndexOf('user')
        const target = at >= 0 ? genMessages[at]! : undefined
        if (target) {
          const prev = (target.meta as { vars?: Record<string, string> } | undefined)?.vars
          const vars = { ...(prev ?? {}), ...swipeVars }
          if (store.editNode) await store.editNode(sid, target.id, { meta: { vars } }).catch(() => {})
          genMessages = genMessages.map((m, i) => (i === at ? ({ ...m, meta: { ...(m.meta ?? {}), vars } } as typeof m) : m))
        }
      }
      let sessionMeta = store.meta ? await store.meta.get(sid) : undefined
      // Имена в тексте (personas-spec §2): плейсхолдеры меты, префиксы, блок участников.
      // `raw` — это делает сама сборка генерации.
      const named = voices && !personasRaw ? nameForGenerate(voices, turn, genMessages, sessionMeta) : undefined
      if (named) sessionMeta = named.sessionMeta
      // Рецепт собирается ДО генерации: он о том, что ушло, а не о том, что пришло.
      const pending = promptsOpt ? draftRecipe(genMessages, sessionMeta, named?.system) : undefined

      // id-first (§6.3): id ассистента известен до записи — уедет в NodeInput.id.
      const assistantId = freshNodeId(model)

      yield { type: 'run_start', runId }
      if (userNode) {
        const un = tree.byId.get(userNode.id) ?? userNode
        yield { type: 'message_start', runId, message: { id: userNode.id, role: 'user' } }
        yield { type: 'message_end', runId, message: nodeToMessage(un, tree) }
      }
      // Ран команды ответа заранее не открывает: он появится, только если команда заговорит.
      if (command === undefined) yield { type: 'message_start', runId, message: { id: assistantId, role: 'assistant' } }

      // 4. Чанки → события и записи. Ответ ассистента: text = part 0, thinking =
      // part 1 (порядок сборки), tool_use — следом в порядке вызовов. Агентный ран —
      // несколько сообщений подряд: ответ → результаты тулов (role tool) → ответ…
      // Закрытый ответ и каждый результат пишутся сразу одним appendNode.
      const TEXT_PART = 0
      const THINK_PART = 1
      interface OpenTurn {
        id: string
        text: string
        thinking: string
        textStarted: boolean
        thinkStarted: boolean
        calls: Part[]
        /** Занято частей вызовов (превью и вызовы): индекс следующей — `THINK_PART + 1 + slots`. */
        slots: number
        /** Превью тулов (`tool_call_start`): ключ → индекс части. */
        streams: Map<string, number>
        model?: string
        usage?: Usage
      }
      const openTurn = (id: string): OpenTurn => ({ id, text: '', thinking: '', textStarted: false, thinkStarted: false, calls: [], slots: 0, streams: new Map() })
      const taken = new Set(model.nodes.map((n) => n.id))
      taken.add(assistantId)
      const freshId = (): string => {
        let id = randomUUID()
        while (taken.has(id)) id = randomUUID()
        taken.add(id)
        return id
      }
      let cur: OpenTurn | undefined = command === undefined ? openTurn(assistantId) : undefined
      /** Последняя записанная нода рана — родитель следующей (regenerate: первая — от regenParent). */
      let lastWritten: string | undefined
      let lastAssistant: string | undefined
      let speaker = turn?.id
      let model_: string | undefined
      let usage: Usage | undefined
      const addUsage = (u: Usage): void => {
        usage = sumUsage(usage, u)
      }
      // Родитель следующей записи. Обычный ран — продолжение активного пути
      // (`parent` не задан: драйвер двигает лист сам). regenerate — первая нода
      // ветвится от regenParent и сразу становится листом, дальше — как обычно;
      // драйвер без setActiveLeaf — явная цепочка от предыдущей.
      const parentOfNext = (): string | undefined =>
        lastWritten === undefined ? regenParent : regenParent !== undefined && !store.setActiveLeaf ? lastWritten : undefined
      const afterWrite = async (id: string): Promise<void> => {
        if (lastWritten === undefined && regenParent !== undefined && store.setActiveLeaf) await store.setActiveLeaf(sid, id)
        lastWritten = id
      }

      /** Закрыть ответ: хвостовые part_end, запись одним appendNode, message_end. */
      async function* closeTurn(t: OpenTurn, cancelled: boolean): AsyncGenerator<AnyRunEvent> {
        // Срез префикса `Имя:` известной персоны (§2): в store текст чистый, имя — в meta.
        if (voices) {
          const stripped = stripPersonaPrefix(t.text, voices.personas)
          if (stripped.personaId !== undefined) {
            t.text = stripped.text
            speaker = stripped.personaId
          }
        }
        if (t.thinkStarted) {
          yield { type: 'part_end', runId, messageId: t.id, part: THINK_PART, payload: { type: 'thinking', text: t.thinking } }
        }
        if (t.textStarted) {
          yield { type: 'part_end', runId, messageId: t.id, part: TEXT_PART, payload: { type: 'text', text: t.text } }
        }
        // Запись (§6.4). cancel пишет частичное (§6.5).
        const parts: Part[] = []
        if (t.text !== '' || (t.thinking === '' && t.calls.length === 0)) parts.push({ type: 'text', text: t.text })
        if (t.thinking !== '') parts.push({ type: 'thinking', text: t.thinking })
        parts.push(...t.calls)

        const meta: Record<string, unknown> = { createdAt: new Date().toISOString() }
        // §2: `MessageMeta.model` на ассистенте обязателен. Что сказала генерация —
        // истина; молчит — пишем модель сессии, она и генерировала.
        const metaModel = t.model ?? model_ ?? modelOf(sid)?.model
        if (metaModel !== undefined) meta.model = metaModel
        if (t.usage !== undefined) {
          meta.usage = t.usage
          addUsage(t.usage)
        }
        if (cancelled) meta.cancelled = true
        if (speaker !== undefined) meta.personaId = speaker

        // id-first (§6.3): id ассистента известен до записи — через явное поле
        // контракта `NodeInput.id`, драйвер чтит его как id записи.
        const written = await store.appendNode(sid, { role: 'assistant', id: t.id, parts, parent: parentOfNext(), meta })
        await afterWrite(written.id)
        lastAssistant = written.id
        yield { type: 'message_end', runId, message: await messageAfter(sid, written.id) }
      }

      let genError: unknown
      /** Ран спрашивал окно отладки промпта (ask `prompt`). */
      let promptAsked = false
      // Тулы сессии без живого исполнителя (отметка `toolsAlive` старше TTL) в ран не идут.
      const declared = (sessionMeta as SessionMetaDoc | undefined)?.tools
      const isLive = Array.isArray(declared) ? await alive.live(sid) : undefined
      const liveTools = Array.isArray(declared) ? structuredClone(declared.filter((d) => isLive!(d))) : undefined
      const it = generate({
        messages: await withImageBytes(sid, named?.messages ?? genMessages),
        ...(input.target ? { target: { ...input.target } } : {}),
        session: withModel(model.info),
        sessionMeta,
        ...(voices ? { personas: structuredClone(voices) } : {}),
        ...(turn ? { persona: { ...turn } } : {}),
        ...(named?.system !== undefined ? { system: named.system } : {}),
        signal: ac.signal,
        ...profileForGenerate(sid),
        ...(liveTools ? { tools: liveTools } : {}),
        ...(askState ? { awaitAnswer: (askId: string) => askState.wait(askId) } : {}),
        ...(input.headless === true ? { headless: true } : {}),
        ...(command !== undefined ? { command: { ...command } } : {}),
        ...(cwdOn && sessionCwdOf(sessionMeta) ? { cwd: sessionCwdOf(sessionMeta)! } : {}),
        ...(await projectOfInfo(model.info)),
        ...(await prefixOf(model.info, sessionMeta)),
      })[Symbol.asyncIterator]()

      // Отмена не ждёт генерацию: generate, не закрывшийся по сигналу (провайдер
      // дотягивает ответ), не держит ран — гонка шага против abort.
      const abortedP = new Promise<'aborted'>((resolve) => {
        if (ac.signal.aborted) resolve('aborted')
        else ac.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
      })
      try {
        while (true) {
          const step = await Promise.race([it.next(), abortedP])
          if (step === 'aborted') break
          if (step.done) break
          const chunk = step.value
          if (ac.signal.aborted) break
          if (chunk.type === 'text' || chunk.type === 'thinking' || chunk.type === 'tool_call' || chunk.type === 'tool_call_start') {
            if (!cur) {
              cur = openTurn(freshId())
              yield { type: 'message_start', runId, message: { id: cur.id, role: 'assistant' } }
            }
          }
          if (chunk.type === 'text') {
            const t = cur!
            if (!t.textStarted) {
              t.textStarted = true
              yield { type: 'part_start', runId, messageId: t.id, part: TEXT_PART, partType: 'text' }
            }
            t.text += chunk.delta
            yield { type: 'part_delta', runId, messageId: t.id, part: TEXT_PART, delta: chunk.delta }
          } else if (chunk.type === 'thinking') {
            const t = cur!
            if (!t.thinkStarted) {
              t.thinkStarted = true
              yield { type: 'part_start', runId, messageId: t.id, part: THINK_PART, partType: 'thinking' }
            }
            t.thinking += chunk.delta
            yield { type: 'part_delta', runId, messageId: t.id, part: THINK_PART, delta: chunk.delta }
          } else if (chunk.type === 'tool_call_start') {
            const t = cur!
            if (t.streams.has(chunk.stream)) continue
            const index = THINK_PART + 1 + t.slots++
            t.streams.set(chunk.stream, index)
            yield { type: 'part_start', runId, messageId: t.id, part: index, partType: 'tool_use', meta: { callId: chunk.callId || `stream:${chunk.stream}`, name: chunk.name, ...(chunk.parent ? { parent: chunk.parent } : {}) } }
          } else if (chunk.type === 'tool_call_delta') {
            const index = cur?.streams.get(chunk.stream)
            if (index === undefined || !chunk.delta) continue
            yield { type: 'part_delta', runId, messageId: cur!.id, part: index, delta: chunk.delta, ...(chunk.replace ? { mode: 'replace' as const } : {}) }
          } else if (chunk.type === 'tool_call') {
            const t = cur!
            const part: Part = { type: 'tool_use', data: chunk.args ?? {}, meta: { callId: chunk.callId, name: chunk.name, ...(chunk.parent ? { parent: chunk.parent } : {}) } }
            const streamed = chunk.stream === undefined ? undefined : t.streams.get(chunk.stream)
            const index = streamed ?? THINK_PART + 1 + t.slots++
            t.calls.push(part)
            if (streamed === undefined) yield { type: 'part_start', runId, messageId: t.id, part: index, partType: 'tool_use', meta: { ...part.meta } }
            else t.streams.delete(chunk.stream!)
            yield { type: 'part_end', runId, messageId: t.id, part: index, payload: structuredClone(part) }
          } else if (chunk.type === 'tool_result' || chunk.type === 'tool_error') {
            // Результат закрывает ответ с вызовами: он пишется до результатов (родитель цепочки).
            if (cur) {
              yield* closeTurn(cur, false)
              cur = undefined
            }
            const error = chunk.type === 'tool_error'
            const part: Part = {
              type: 'tool_result',
              text: error ? chunk.message : chunk.text,
              meta: {
                callId: chunk.callId,
                name: chunk.name,
                ...(error ? { error: true } : {}),
                ...(chunk.parent ? { parent: chunk.parent } : {}),
                ...(chunk.subagentContext !== undefined ? { subagentContext: chunk.subagentContext } : {}),
              },
            }
            if (chunk.data !== undefined) part.data = chunk.data
            const toolId = freshId()
            yield { type: 'message_start', runId, message: { id: toolId, role: 'tool' } }
            yield { type: 'part_start', runId, messageId: toolId, part: 0, partType: 'tool_result', meta: { callId: chunk.callId, name: chunk.name, ...(chunk.parent ? { parent: chunk.parent } : {}) } }
            yield { type: 'part_end', runId, messageId: toolId, part: 0, payload: structuredClone(part) }
            const written = await store.appendNode(sid, {
              role: 'tool',
              id: toolId,
              parts: [part],
              parent: parentOfNext(),
              meta: { createdAt: new Date().toISOString() },
            })
            await afterWrite(written.id)
            yield { type: 'message_end', runId, message: await messageAfter(sid, written.id) }
          } else if (chunk.type === 'note') {
            if (cur && (cur.textStarted || cur.thinkStarted || cur.calls.length)) {
              yield* closeTurn(cur, false)
              cur = undefined
            }
            const part: Part = { type: 'text', text: chunk.text }
            const noteId = freshId()
            yield { type: 'message_start', runId, message: { id: noteId, role: 'assistant' } }
            yield { type: 'part_start', runId, messageId: noteId, part: TEXT_PART, partType: 'text' }
            yield { type: 'part_end', runId, messageId: noteId, part: TEXT_PART, payload: structuredClone(part) }
            const written = await store.appendNode(sid, {
              role: 'assistant',
              id: noteId,
              parts: [part],
              parent: parentOfNext(),
              flags: { disabled: true },
              meta: { createdAt: new Date().toISOString() },
            })
            await afterWrite(written.id)
            yield { type: 'message_end', runId, message: await messageAfter(sid, written.id) }
          } else if (chunk.type === 'user') {
            // Пустой заведённый ответ остаётся (фронт вставит сообщение перед ним); с содержимым — закрывается.
            if (cur && (cur.textStarted || cur.thinkStarted || cur.calls.length)) {
              yield* closeTurn(cur, false)
              cur = undefined
            }
            const parts = normalizeUserParts(chunk.message)
            const meta: Record<string, unknown> = { createdAt: new Date().toISOString(), steered: true }
            if (userId) meta.personaId = userId
            const written = await store.appendNode(sid, { role: 'user', parts, parent: parentOfNext(), meta })
            taken.add(written.id)
            await afterWrite(written.id)
            yield { type: 'message_start', runId, message: { id: written.id, role: 'user', meta: { steered: true } } }
            yield { type: 'message_end', runId, message: await messageAfter(sid, written.id) }
          } else if (chunk.type === 'image') {
            if (cur && (cur.textStarted || cur.thinkStarted || cur.calls.length)) {
              yield* closeTurn(cur, false)
              cur = undefined
            }
            let part: Part
            try {
              part = (await putAttachment(sid, chunk.name, chunk.data, chunk.mime)).part
            } catch (err) {
              part = { type: 'text', text: `[картинка ${chunk.name} не сохранена: ${err instanceof Error ? err.message : String(err)}]` }
            }
            if (chunk.path && part.type === 'image') part.meta = { ...part.meta, path: chunk.path } as typeof part.meta
            const imageId = freshId()
            yield { type: 'message_start', runId, message: { id: imageId, role: 'assistant' } }
            yield { type: 'part_start', runId, messageId: imageId, part: 0, partType: part.type }
            yield { type: 'part_end', runId, messageId: imageId, part: 0, payload: structuredClone(part) }
            const written = await store.appendNode(sid, {
              role: 'assistant',
              id: imageId,
              parts: [part],
              parent: parentOfNext(),
              meta: { createdAt: new Date().toISOString() },
            })
            await afterWrite(written.id)
            yield { type: 'message_end', runId, message: await messageAfter(sid, written.id) }
          } else if (chunk.type === 'recipe') {
            if (chunk.mds !== undefined) {
              effective.set(sid, chunk.mds)
              // В хранилище: после рестарта панель видит промпт без нового рана.
              if (recipeStore?.effective) await recipeStore.effective.set(sid, chunk.mds).catch(() => {})
            }
            if (pending) applyRecipeChunk(pending, chunk, genMessages)
          } else if (chunk.type === 'compaction') {
            if (!opts.compaction) continue
            // Ответ с содержимым закрывается до узла (его родитель — ответ); пустой
            // открытый ответ (компакция перед ходом) пишется уже ПОСЛЕ узла.
            if (cur && (cur.textStarted || cur.thinkStarted || cur.calls.length)) {
              yield* closeTurn(cur, false)
              cur = undefined
            }
            const parent = parentOfNext()
            const written = await opts.compaction.append(sid, {
              summary: chunk.summary,
              firstKeptEntryId: chunk.firstKeptEntryId,
              tokensBefore: chunk.tokensBefore,
              ...(chunk.details !== undefined ? { details: chunk.details } : {}),
              ...(chunk.usage ? { usage: chunk.usage } : {}),
              ...(parent !== undefined ? { parent } : {}),
            })
            taken.add(written.id)
            await afterWrite(written.id)
            yield { type: 'message_start', runId, message: { id: written.id, role: written.role } }
            yield { type: 'message_end', runId, message: await messageAfter(sid, written.id) }
          } else if (chunk.type === 'node_meta') {
            if (!store.editNode) continue
            await store.editNode(sid, chunk.id, { meta: chunk.patch }).catch(() => {}) // узел сменился (свайп, удаление) — закрепление не критично
          } else if (chunk.type === 'meta') {
            if (!store.meta) continue
            const next = mergeSessionMeta((await store.meta.get(sid)) as SessionMetaDoc, chunk.patch)
            if (store.meta.set) await store.meta.set(sid, next as Record<string, unknown>)
            else await store.meta.patch(sid, next as Record<string, unknown>)
            yield { type: 'session_update', runId, fields: Object.keys(chunk.patch) }
          } else if (chunk.type === 'ask') {
            if (chunk.kind === PROMPT_DEBUG_ASK_KIND) promptAsked = true
            yield { type: 'ask', runId, askId: chunk.askId, kind: chunk.kind, payload: chunk.payload }
          } else if (chunk.type === 'ask_end') {
            yield { type: 'ask_end', runId, askId: chunk.askId }
          } else if (chunk.type === 'usage') {
            const { type: _t, ...u } = chunk
            if (cur) cur.usage = u
            else addUsage(u)
          } else if (chunk.type === 'model') {
            model_ = chunk.model
            if (cur) cur.model = chunk.model
          }
        }
      } catch (err) {
        genError = err
      }
      // Отмена посреди ожидания ask/тула: генератор не дочитан — закрыть, чтобы его finally отработал.
      if (ac.signal.aborted) void it.return?.(undefined)?.catch(() => {})

      // Окно отладки промпта ответило «отмена» — это отмена рана, не ошибка.
      const askCancelled = promptAsked && (genError as { code?: unknown } | undefined)?.code === 'cancelled'

      // Ошибка генерации (не отмена) → run_end error; открытый ответ не пишется (§4).
      if (genError !== undefined && !ac.signal.aborted && !askCancelled) {
        yield {
          type: 'run_end',
          runId,
          status: 'error',
          error: errOf(genError),
          version: await versionOf(sid),
        }
        return
      }

      const cancelled = ac.signal.aborted || askCancelled
      // Отменили в окне отладки промпта, модель не сказала ни слова — рана не было:
      // пустой «отменённый» ответ не пишется (ui-batch-5-spec §4).
      const nothingSaid = cur !== undefined && !cur.textStarted && !cur.thinkStarted && cur.calls.length === 0
      if (cancelled && promptAsked && nothingSaid) cur = undefined

      // 5. Последний ответ (§6.4); после результатов тулов без нового хода — его нет.
      if (cur) yield* closeTurn(cur, cancelled)
      // regenerate: новая ветка становится активной (§6.2) — до её конца.
      if (regenParent !== undefined && lastWritten !== undefined && store.setActiveLeaf) await store.setActiveLeaf(sid, lastWritten)

      if (pending && lastAssistant !== undefined) {
        const metaModel = model_ ?? modelOf(sid)?.model
        if (metaModel !== undefined) pending.recipe.model = metaModel
        if (usage !== undefined) pending.recipe.tokens = { input: usage.input, output: usage.output }
        if (speaker !== undefined) pending.recipe.personaId = speaker
        let perSession = recipes.get(sid)
        if (!perSession) recipes.set(sid, (perSession = new Map()))
        perSession.set(lastAssistant, pending)
        // В сессию — той же записью, что пишет pi-ext (ребёнком ответа): рецепт
        // переживает рестарт и читается backend-pi. Сбой — ран всё равно прошёл.
        if (recipeStore) await recipeStore.put(sid, { forMessageId: lastAssistant, ...structuredClone(pending.recipe) }, pending.texts).catch(() => {})
      }

      const version = await versionOf(sid)
      const runEnd: AnyRunEvent = { type: 'run_end', runId, status: cancelled ? 'cancelled' : 'done', version }
      if (usage !== undefined) (runEnd as { usage?: unknown }).usage = usage
      yield runEnd
    } finally {
      runControls.delete(sid)
      runAsks.delete(sid)
      askState?.close()
      await lease.end().catch(() => {})
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Промпт сообщения (prompt-recipe-spec §5): простая реализация для фикстур
  // ──────────────────────────────────────────────────────────────────────────

  /** Чанк `recipe` генерации → рецепт рана: system, блоки, инъекции, контекст, тулы. */
  function applyRecipeChunk(pending: { recipe: PromptRecipe; texts: Map<string, string> }, chunk: Extract<GenChunk, { type: 'recipe' }>, genMessages: Message[]): void {
    const put = (text: string): string => {
      const hash = promptHash(text)
      pending.texts.set(hash, text)
      return hash
    }
    pending.recipe.systemHash = put(chunk.system)
    if (chunk.systemBlocks) pending.recipe.systemBlocks = chunk.systemBlocks.map((b) => ({ source: b.source, hash: put(b.text) }))
    if (chunk.injections) {
      pending.recipe.injections = chunk.injections.map((inj) => {
        const out: PromptRecipe['injections'][number] = { role: inj.role, hash: put(inj.text) }
        if (inj.source !== undefined) out.source = inj.source
        if (inj.reason !== undefined) out.reason = inj.reason
        return out
      })
    }
    if (chunk.messageIds) {
      const byId = new Map(genMessages.map((m) => [m.id, m]))
      pending.recipe.messageIds = [...chunk.messageIds]
      pending.recipe.messageHashes = chunk.messageIds.map((id) => (byId.get(id)?.hash ?? '').slice(0, PROMPT_MESSAGE_HASH_LENGTH))
    }
    if (chunk.tools) pending.recipe.tools = [...chunk.tools]
    if (chunk.target) pending.recipe.target = { ...chunk.target }
  }

  /**
   * Вариант выбран (cyoa-spec §2): реплика ушла по направлению из варианта —
   * `picked` у `meta.choices` ответа бота. Ответ сменился (свайп, удаление) — молча.
   */
  async function markPicked(sid: string, direction: DirectionMeta): Promise<void> {
    const c = direction.choice
    if (!c || !store.editNode) return
    const node = (await store.load(sid)).nodes.find((n) => n.id === c.messageId)
    const cur = node ? choicesOf(node as unknown as Message) : undefined
    if (!cur || c.index < 0 || c.index >= cur.choices.length) return
    await store.editNode(sid, c.messageId, { meta: { [CHOICES_META]: { ...cur, picked: c.index } } }).catch(() => {})
  }

  /**
   * Служебный ран (v1.47, CYOA `choices`/`editor`): параллельно ходу, без busy и
   * без записи сообщений. Контекст — путь до `options.messageId` (ответ бота на
   * активной ветке). Генерация отдаёт `node_meta` — патч меты узла: пишется и
   * уходит кадром `activity` `node_meta`. Отмена — `return` итератора (закрыли поток).
   */
  async function* sideRun(sid: string, command: RunCommand): AsyncGenerator<AnyRunEvent> {
    const target = typeof command.options?.messageId === 'string' ? command.options.messageId : undefined
    if (!target) throw new StoreBadRequestError(`run.command ${command.name}: нужен options.messageId`)
    await hydrate(sid)
    const model = await store.load(sid)
    const tree = resolveTree(model.nodes)
    const assembled = transform ? transform(model.nodes) : model.nodes
    const all = toHistory({ ...model, nodes: assembled }, resolveTree(assembled)).filter((m) => !m.flags?.disabled)
    const at = all.findIndex((m) => m.id === target)
    if (at < 0) throw new StoreNodeNotFound(target)
    const genMessages = all.slice(0, at + 1)
    const sessionMeta = store.meta ? await store.meta.get(sid) : undefined
    const cast = personasOn ? await personasOf(sid) : undefined
    const voices = cast && cast.personas.length ? cast : undefined
    const turn = voices ? turnPersona(voices, undefined) : undefined
    const runId = `store-${sid}-side-${++runSeq}`
    const ac = new AbortController()
    let model_: string | undefined
    yield { type: 'run_start', runId }
    let genError: unknown
    const it = generate({
      messages: await withImageBytes(sid, genMessages),
      session: withModel(model.info),
      ...(sessionMeta ? { sessionMeta } : {}),
      ...(voices ? { personas: structuredClone(voices) } : {}),
      ...(turn ? { persona: { ...turn } } : {}),
      signal: ac.signal,
      ...profileForGenerate(sid),
      command: structuredClone(command),
    })[Symbol.asyncIterator]()
    try {
      for (;;) {
        const step = await it.next()
        if (step.done) break
        const chunk = step.value
        if (chunk.type === 'node_meta') {
          if (store.editNode) await store.editNode(sid, chunk.id, { meta: chunk.patch }).catch(() => {})
          yield { type: 'activity', runId, kind: NODE_META_ACTIVITY_KIND, payload: { id: chunk.id, patch: chunk.patch } }
        } else if (chunk.type === 'sibling') {
          const id = await placeSibling(sid, chunk)
          yield { type: 'activity', runId, kind: NODE_META_ACTIVITY_KIND, payload: { id, patch: { active: true } } }
        } else if (chunk.type === 'recipe') {
          // Запрос вызова как ушёл (`sent`) — кадр `prompt`, как у impersonate.
          const pending = draftRecipe(genMessages, sessionMeta)
          applyRecipeChunk(pending, chunk, genMessages)
          if (model_) pending.recipe.model = model_
          const view = viewOf(pending.recipe, pending.texts, tree)
          if (chunk.sent) view.sent = chunk.sent.map((m) => ({ ...m }))
          yield { type: 'activity', runId, kind: PROMPT_ACTIVITY_KIND, payload: view }
        } else if (chunk.type === 'model') {
          model_ = chunk.model
        }
      }
    } catch (err) {
      genError = err
    } finally {
      ac.abort()
    }
    const version = await versionOf(sid)
    if (genError !== undefined) yield { type: 'run_end', runId, status: 'error', error: { message: errMsg(genError) }, version }
    else yield { type: 'run_end', runId, status: 'done', version }
  }

  /** Чанк `sibling` (v1.70): свайп на совпавший по мете сиблинг или новый сиблинг с текстом. */
  async function placeSibling(sid: string, chunk: Extract<GenChunk, { type: 'sibling' }>): Promise<string> {
    if (!store.setActiveLeaf) throw new NotSupportedError('sibling: драйвер без setActiveLeaf')
    const model = await store.load(sid)
    const tree = resolveTree(model.nodes)
    const node = tree.byId.get(chunk.of)
    if (!node) throw new StoreNodeNotFound(chunk.of)
    const at = (meta: unknown, path: string): unknown => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), meta)
    const match = chunk.match && Object.keys(chunk.match).length ? chunk.match : undefined
    const found = match ? swipeInfo(node, tree).siblings.find((n) => Object.entries(match).every(([k, v]) => JSON.stringify(at(n.meta, k)) === JSON.stringify(v))) : undefined
    if (found) {
      await store.setActiveLeaf(sid, descendToLeaf(found, tree).id)
      return found.id
    }
    if (chunk.text === undefined) throw new StoreBadRequestError('sibling: нет ни совпавшего узла, ни текста')
    const raw = model.nodes.find((n) => n.id === chunk.of)!
    const written = await store.appendNode(sid, { role: raw.role, parts: [{ type: 'text', text: chunk.text }], parent: raw.parent ?? null, meta: { createdAt: new Date().toISOString(), ...(chunk.meta ?? {}) } })
    await store.setActiveLeaf(sid, written.id)
    return written.id
  }

  /**
   * Ран impersonate (v1.19): сборка «от лица» игрока, ответ — события
   * сообщения `role: 'user'`, которое НЕ пишется (history его не вернёт,
   * version прежний); рецепт — кадр `activity` `prompt`. Никаких записей.
   */
  async function* impersonateRun(
    sid: string,
    runId: string,
    ac: AbortController,
    input: RunStartInput,
    voices: PersonasDoc | undefined,
    turn: Persona | undefined,
    userId: string | undefined,
    askState?: AskState,
  ): AsyncGenerator<AnyRunEvent> {
    const model = await store.load(sid)
    const tree = resolveTree(model.nodes)
    const genMessages = toHistory(model, tree).filter((m) => !m.flags?.disabled)
    const sessionMeta = store.meta ? await store.meta.get(sid) : undefined
    const text = input.userMessage === undefined ? '' : derivedText({ id: '', role: 'user', parts: normalizeUserParts(input.userMessage) } as Message)
    const draftId = freshNodeId(model)
    yield { type: 'run_start', runId }
    yield { type: 'message_start', runId, message: { id: draftId, role: 'user', ...(userId ? { meta: { personaId: userId } } : {}) } }
    let reply = ''
    let started = false
    let genError: unknown
    const it = generate({
      messages: await withImageBytes(sid, genMessages),
      session: withModel(model.info),
      sessionMeta,
      ...(voices ? { personas: structuredClone(voices) } : {}),
      ...(turn ? { persona: { ...turn } } : {}),
      target: { kind: 'user' },
      input: text,
      ...(directionOf(input.direction) ? { direction: directionOf(input.direction)! } : {}),
      signal: ac.signal,
      ...profileForGenerate(sid),
      // Отладка промпта: окно и у impersonate.
      ...(askState ? { awaitAnswer: (askId: string) => askState.wait(askId) } : {}),
    })[Symbol.asyncIterator]()
    const abortedP = new Promise<'aborted'>((resolve) => {
      if (ac.signal.aborted) resolve('aborted')
      else ac.signal.addEventListener('abort', () => resolve('aborted'), { once: true })
    })
    try {
      while (true) {
        const step = await Promise.race([it.next(), abortedP])
        if (step === 'aborted' || step.done || ac.signal.aborted) break
        const chunk = step.value
        if (chunk.type === 'text') {
          if (!started) {
            started = true
            yield { type: 'part_start', runId, messageId: draftId, part: 0, partType: 'text' }
          }
          reply += chunk.delta
          yield { type: 'part_delta', runId, messageId: draftId, part: 0, delta: chunk.delta }
        } else if (chunk.type === 'recipe') {
          const pending = draftRecipe(genMessages, sessionMeta)
          applyRecipeChunk(pending, chunk, genMessages)
          pending.recipe.target = { kind: 'user' }
          const view = viewOf(pending.recipe, pending.texts, tree)
          if (chunk.sent) view.sent = chunk.sent.map((m) => ({ ...m }))
          yield { type: 'activity', runId, kind: PROMPT_ACTIVITY_KIND, payload: view }
        } else if (chunk.type === 'ask') {
          yield { type: 'ask', runId, askId: chunk.askId, kind: chunk.kind, payload: chunk.payload }
        }
      }
    } catch (err) {
      genError = err
    }
    if (ac.signal.aborted) void it.return?.(undefined)?.catch(() => {})
    const version = await versionOf(sid)
    const askCancelled = (genError as { code?: unknown } | undefined)?.code === 'cancelled'
    if (askCancelled) {
      yield { type: 'run_end', runId, status: 'cancelled', version }
      return
    }
    if (genError !== undefined && !ac.signal.aborted) {
      yield { type: 'run_end', runId, status: 'error', error: { message: errMsg(genError) }, version }
      return
    }
    if (started) yield { type: 'part_end', runId, messageId: draftId, part: 0, payload: { type: 'text', text: reply } }
    const message: Message = { id: draftId, role: 'user', parts: [{ type: 'text', text: reply }], ...(userId ? { meta: { personaId: userId } } : {}) }
    yield { type: 'message_end', runId, message }
    yield { type: 'run_end', runId, status: ac.signal.aborted ? 'cancelled' : 'done', version }
  }

  /** Рецепт + тексты → развёрнутый вид (панель prompt) по текущему дереву. */
  function viewOf(recipe: PromptRecipe, texts: Map<string, string>, tree: ReturnType<typeof resolveTree>): PromptView {
    const injections: PromptInjection[] = recipe.injections.map((inj) => {
      const out: PromptInjection = { role: inj.role, text: texts.get(inj.hash) ?? '' }
      if (inj.source !== undefined) out.source = inj.source
      if (inj.reason !== undefined) out.reason = inj.reason
      return out
    })
    const messages = recipe.messageIds.map((id, i) => {
      const node = tree.byId.get(id)
      if (!node) return { id, role: '', text: '', missing: true }
      const message = nodeToMessage(node, tree)
      const out: PromptView['messages'][number] = { id, role: message.role, text: derivedText(message) }
      const was = recipe.messageHashes?.[i]
      if (was && (message.hash ?? '').slice(0, PROMPT_MESSAGE_HASH_LENGTH) !== was) out.edited = true
      return out
    })
    const view: PromptView = { recipe: structuredClone(recipe), system: texts.get(recipe.systemHash) ?? '', injections, messages }
    if (recipe.systemBlocks) view.systemBlocks = recipe.systemBlocks.map((b) => ({ source: b.source, text: texts.get(b.hash) ?? '' }))
    return view
  }

  function promptHash(text: string): string {
    return sha256Hex(text).slice(0, PROMPT_HASH_LENGTH)
  }

  /** Рецепт рана: system и инъекции из опции и меты, сообщения — вход генерации. */
  function draftRecipe(
    genMessages: Message[],
    sessionMeta: Record<string, unknown> | undefined,
    personasBlock?: string,
  ): { recipe: PromptRecipe; texts: Map<string, string> } {
    const texts = new Map<string, string>()
    const put = (text: string): string => {
      const hash = promptHash(text)
      texts.set(hash, text)
      return hash
    }
    const doc = (sessionMeta ?? {}) as SessionMetaDoc
    const base = promptsOpt?.system ?? ''
    const pre = doc.prompt?.pre
    const prompted = !pre ? base : sessionPromptMode(doc) === 'replace' || base === '' ? pre : `${pre}\n\n${base}`
    // Блок участников (personas-spec §4) — в конец system; в рецепте он ещё и
    // инъекцией `persona`, чтобы было видно, что и почему добавилось.
    const system = personasBlock === undefined ? prompted : prompted === '' ? personasBlock : `${prompted}\n\n${personasBlock}`
    const injections: PromptRecipe['injections'] = []
    if (personasBlock !== undefined) injections.push({ role: 'system', hash: put(personasBlock), source: PERSONA_INJECTION_SOURCE })
    if (doc.prompt?.post) injections.push({ role: 'user', hash: put(doc.prompt.post), source: 'meta.post' })

    const recipe: PromptRecipe = {
      at: new Date().toISOString(),
      systemHash: put(system),
      injections,
      messageIds: genMessages.map((m) => m.id),
      messageHashes: genMessages.map((m) => (m.hash ?? '').slice(0, PROMPT_MESSAGE_HASH_LENGTH)),
    }
    return { recipe, texts }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Персоны (personas-spec §2, §5): имена в тексте для фикстурного generate
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Что уходит в `generate`, когда у сессии есть персоны: `{{char}}`/`{{user}}`
   * меты раскрыты всегда; префиксы `Имя: ` у user/assistant (по их
   * `meta.personaId`; user без него — `userId`) и блок участников — только
   * когда имена в ходу (§2: один собеседник — никакого шума). Store не трогается:
   * это копии для генерации.
   */
  function nameForGenerate(
    doc: PersonasDoc,
    turn: Persona | undefined,
    messages: Message[],
    sessionMeta: Record<string, unknown> | undefined,
  ): { messages: Message[]; sessionMeta?: Record<string, unknown>; system?: string } {
    const user = userPersona(doc)
    const names = { char: turn?.name, user: user?.name }
    let meta = sessionMeta
    const prompt = (sessionMeta as SessionMetaDoc | undefined)?.prompt
    if (prompt) {
      const expanded = { ...prompt }
      if (typeof expanded.pre === 'string') expanded.pre = expandPersonaNames(expanded.pre, names)
      if (typeof expanded.post === 'string') expanded.post = expandPersonaNames(expanded.post, names)
      meta = { ...sessionMeta, prompt: expanded }
    }
    if (!personasVoiced(doc, turn)) return { messages, sessionMeta: meta }

    const byId = new Map(doc.personas.map((p) => [p.id, p]))
    const out = messages.map((m) => {
      if (m.role !== 'user' && m.role !== 'assistant') return m
      const id = m.meta?.personaId ?? (m.role === 'user' ? user?.id : undefined)
      const speaker = id === undefined ? undefined : byId.get(id)
      if (!speaker) return m
      const first = m.parts.findIndex((p) => p.type === 'text')
      if (first < 0) return m
      const parts = m.parts.map((p, i) => (i === first && p.type === 'text' ? { ...p, text: personaPrefixed(speaker.name, p.text) } : p))
      return { ...m, parts }
    })
    return { messages: out, sessionMeta: meta, system: personasSystemBlock(doc, turn) }
  }

  async function promptOf(sid: string, mid: string): Promise<PromptView> {
    const model = await store.load(sid) // сессии нет → not_found драйвера
    let found = recipes.get(sid)?.get(mid)
    if (!found && recipeStore) {
      const stored = await recipeStore.get(sid, mid).catch(() => undefined)
      if (stored && isPromptRecipe(stored.data)) {
        const { forMessageId: _for, ...recipe } = stored.data as PromptRecipe & { forMessageId?: unknown }
        found = { recipe, texts: stored.texts }
      }
    }
    if (!found) throw new StorePromptNotFoundError(mid)
    return viewOf(found.recipe, found.texts, resolveTree(model.nodes))
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Мутации сообщений (§5): 1:1 на методы драйвера, conflict пробрасывается
  // ──────────────────────────────────────────────────────────────────────────

  async function swipe(sid: string, mid: string, to: SwipeTo): Promise<Message> {
    await guardBusy(sid)
    const model = await store.load(sid)
    const tree = resolveTree(model.nodes)
    const node = tree.byId.get(mid)
    if (!node) throw new StoreNodeNotFound(mid)

    const info = swipeInfo(node, tree)
    const targetIdx = to.index !== undefined ? to.index : info.active + (to.dir === 'next' ? 1 : -1)
    const clamped = Math.min(info.count - 1, Math.max(0, targetIdx))
    const target = info.siblings[clamped]

    // Лист — глубина ветки sibling'а (таверна-семантика), не сам sibling:
    // иначе возврат на ветку с детьми обрывает путь и «теряет» поддерево в рендере.
    await store.setActiveLeaf!(sid, descendToLeaf(target, tree).id)
    return nodeToMessage(target, tree)
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Сборка ProtocolBackend: опциональный метод драйвера отсутствует →
  // метод бэкенда не выставляется → биндинг отвечает not_supported (§2).
  // ──────────────────────────────────────────────────────────────────────────

  const messages: MessagesOps = {}
  if (store.editNode) {
    const editNode = store.editNode.bind(store)
    messages.edit = async (sid, mid, patch: MessageEditPatch) => {
      // Только мета (v1.47): ключи плагинов, ленту не трогает — и посреди хода.
      if (patch.meta !== undefined) {
        if (patch.meta === null || typeof patch.meta !== 'object' || Array.isArray(patch.meta)) throw new StoreBadRequestError('edit.meta: ожидается объект')
        const bad = Object.keys(patch.meta).filter((k) => !MESSAGE_META_EDITABLE.includes(k))
        if (bad.length) throw new StoreBadRequestError(`edit.meta: ключи ${bad.join(', ')} клиент не правит (можно: ${MESSAGE_META_EDITABLE.join(', ')})`)
      }
      const metaOnly = patch.meta !== undefined && patch.parts === undefined && patch.text === undefined
      if (!metaOnly) await guardBusy(sid)
      const node = await editNode(sid, mid, patch)
      return messageAfter(sid, node.id)
    }
  }
  if (store.deleteNode) {
    const deleteNode = store.deleteNode.bind(store)
    messages.delete = async (sid, mid) => {
      await guardBusy(sid)
      await deleteNode(sid, mid)
    }
  }
  if (store.hideNode) {
    const hideNode = store.hideNode.bind(store)
    messages.hide = async (sid, mid, hidden) => {
      await guardBusy(sid)
      await hideNode(sid, mid, hidden)
    }
  }
  if (store.setActiveLeaf) messages.swipe = swipe
  if (promptsOpt) messages.prompt = promptOf

  // append (attachments-spec §2): appendNode есть у любого драйвера — метод
  // выставляется всегда. Сообщение ложится на активный лист, рана нет.
  // assistant — гритинг; swipeOf — сиблинг существующего сообщения, и он же
  // становится активным (bot-as-session-spec §1): тот же ход, что у regenerate.
  messages.append = async (sid, parts, appendOpts) => {
    await guardBusy(sid)
    if (!Array.isArray(parts) || parts.length === 0) throw new StoreBadRequestError('append требует непустой parts')
    const role = appendOpts?.role
    if (role !== undefined && role !== 'user' && role !== 'assistant' && role !== 'system') {
      throw new StoreBadRequestError(`append: роль ${String(role)} не поддержана — user, assistant или system`)
    }
    const swipeOf = appendOpts?.swipeOf
    // Заметка хоста (v1.36): system без рана; `context` — модели следующим ходом.
    if (role === 'system') {
      if (swipeOf !== undefined) throw new StoreBadRequestError('append: swipeOf у system-заметки не бывает')
      const meta = { createdAt: new Date().toISOString(), ...(appendOpts?.context === true ? { context: true } : {}) }
      const node = await store.appendNode(sid, { role: 'system', parts, meta })
      return messageAfter(sid, node.id)
    }
    if (swipeOf === undefined) {
      const direction = (role ?? 'user') === 'user' ? directionOf(appendOpts?.direction) : undefined
      if (appendOpts?.direction !== undefined && !direction) throw new StoreBadRequestError('append.direction: ожидается {intent, …} у реплики игрока')
      const node = await store.appendNode(sid, { role: role ?? 'user', parts, ...(direction ? { meta: { createdAt: new Date().toISOString(), [DIRECTION_META]: direction } } : {}) })
      if (direction) await markPicked(sid, direction)
      return messageAfter(sid, node.id)
    }
    if (!store.setActiveLeaf) throw new NotSupportedError('messages.append.swipeOf')
    const target = (await store.load(sid)).nodes.find((n) => n.id === swipeOf)
    if (!target) throw new StoreNodeNotFound(swipeOf)
    if (role !== undefined && role !== target.role) {
      throw new StoreBadRequestError(`append: swipeOf ${swipeOf} — сообщение ${target.role}, а не ${role}`)
    }
    // Корень (первое сообщение сессии) — `parent: null`: иначе драйвер допишет к активному листу.
    const node = await store.appendNode(sid, { role: target.role, parts, parent: target.parent ?? null })
    await store.setActiveLeaf(sid, node.id)
    return messageAfter(sid, node.id)
  }

  /**
   * put (attachments-spec §2–3): проверка и сборка части ДО записи байтов —
   * отказ не оставляет сирот. Байты — в драйвер, если он умеет assets (ref
   * его формы), иначе в память бэкенда.
   */
  async function putAttachment(sid: string, fileName: string, data: Uint8Array, mime?: string): Promise<AttachmentPutResult> {
    const part = attachmentPart({ name: fileName, data, mime, ref: '', maxBytes: attachmentMaxBytes })
    let ref: string
    if (store.assets) {
      ref = (await store.assets.put(sid, fileName, data, mime)).ref
    } else {
      await store.load(sid) // сессии нет → not_found драйвера, а не вложение в пустоту
      ref = `mem:${sid}/${sha256Hex(data).slice(0, 12)}-${fileName}`
      let perSession = blobs.get(sid)
      if (!perSession) blobs.set(sid, (perSession = new Map()))
      perSession.set(ref, mime === undefined ? { data: data.slice() } : { data: data.slice(), mime })
    }
    part.meta.ref = ref
    return { ref, part }
  }

  /**
   * get (v1.10): байты по ref из `put` — драйвера, если он умеет `assets.get`,
   * иначе памяти бэкенда. mime драйвер может не хранить — тогда по имени.
   */
  async function getAttachment(sid: string, ref: string): Promise<AttachmentContent> {
    const blob = await readBlob(sid, ref)
    const mime = blob.mime ?? fileMime(ref)
    return attachmentContent(mime === undefined ? { ref, data: blob.data } : { ref, data: blob.data, mime })
  }

  async function readBlob(sid: string, ref: string): Promise<{ data: Uint8Array; mime?: string }> {
    if (store.assets) {
      if (!store.assets.get) throw new NotSupportedError('attachments.get')
      return store.assets.get(sid, ref)
    }
    await store.load(sid) // сессии нет → not_found драйвера
    const blob = blobs.get(sid)?.get(ref)
    if (!blob) throw new StoreAssetNotFound(ref)
    return blob
  }

  /**
   * Картинки-вложения для генерации (П-1): в ленте `ImagePart` хранит `meta.ref`
   * (`file:<sid>.assets/…` драйвера, `mem:` памяти), байтов в сообщении нет —
   * генерация получает их `data:`-URL в `meta.url` и путь файла в `meta.path`
   * (`attachmentPath`). Копия: модель стора не трогается. Вложение не читается —
   * картинка уходит как была (генерация её пропустит), ран важнее.
   */
  async function withImageBytes(sid: string, messages: Message[]): Promise<Message[]> {
    if (!messages.some((m) => m.parts.some(needsBytes))) return messages
    const out: Message[] = []
    for (const m of messages) {
      if (!m.parts.some(needsBytes)) {
        out.push(m)
        continue
      }
      const parts: Part[] = []
      for (const p of m.parts) {
        if (!needsBytes(p)) {
          parts.push(p)
          continue
        }
        const ref = p.meta.ref as string
        const meta: Record<string, unknown> = { ...p.meta }
        try {
          const blob = await readBlob(sid, ref)
          const mime = blob.mime ?? (p.meta.mime as string | undefined) ?? fileMime(ref) ?? sniffImageMime(blob.data) ?? 'application/octet-stream'
          meta.url = `data:${mime};base64,${base64Of(blob.data)}`
        } catch {
          // нет байтов — генерация картинку пропустит
        }
        const path = opts.attachmentPath?.(sid, ref)
        if (path) meta.path = path
        parts.push({ ...p, meta } as Part)
      }
      out.push({ ...m, parts })
    }
    return out
  }

  /** personas-spec §3, §5: документ целиком; правка посреди рана — busy, как мутации ленты. */
  const personasOps = personasOn
    ? {
        async list(sid: string): Promise<PersonasDoc> {
          await store.load(sid) // сессии нет → not_found драйвера
          return personasOf(sid)
        },
        async save(sid: string, personas: Persona[], userId?: string): Promise<PersonasDoc> {
          const invalid = validatePersonas(personas, userId)
          if (invalid) throw new StoreBadRequestError(`personas: ${invalid}`)
          await store.load(sid)
          await guardBusy(sid)
          const doc: PersonasDoc = { personas: structuredClone(personas) }
          if (userId !== undefined) doc.userId = userId
          if (personaStore) await personaStore.set(sid, doc)
          else personaDocs!.set(sid, doc)
          return personasOf(sid)
        },
      }
    : undefined

  const backend: ProtocolBackend = {
    async capabilities(): Promise<Capabilities> {
      const c = await store.capabilities()
      // v1.43: `client` рана пишется в мету реплики.
      const caps: Capabilities = { protocol: 1, cancel: true, client: true }
      if (name !== undefined) caps.name = name
      // append — не capability драйвера, а механика бэкенда поверх appendNode.
      caps.edits = { ...(c.edits ?? {}), append: true }
      if (c.swipes) caps.swipes = true
      // Форк драйвера пишет `parentSessionId` новой сессии (конформанс) — сессии
      // складываются в дерево веток (П-13): панель фронта строится по нему.
      if (c.fork) caps.fork = 'tree'
      // Вложения есть всегда: без assets у драйвера байты держит память (§3).
      caps.attachments = { maxBytes: attachmentMaxBytes, mimes: [...ATTACHMENT_MIMES] }
      // get — из памяти всегда, из драйвера — если он отдаёт байты назад.
      if (!store.assets || store.assets.get) caps.attachments.get = true
      // Ран без user-сообщения — генерация по текущей ветке (§5.1 «продолжай»).
      caps.run = { continue: true, vars: true }
      if (opts.commands?.length) caps.run.commands = [...opts.commands]
      if (c.sessionMeta) caps.sessionMeta = true
      // models заявляется ровно тогда, когда задан каталог (§5). select всегда:
      // выбор держится этой механикой, а не драйвером.
      if (catalog) caps.models = { select: true, thinking: catalog.some((m) => (m.thinking?.length ?? 0) > 0) }
      // profiles — тоже ровно при заданном каталоге (profiles-spec §5); правка
      // в памяти есть всегда, раз каталог наш (profile-editor-spec §4).
      if (profileCatalog) caps.profiles = { switch: true, edit: true }
      // v1.59: скиллы сессии с режимами — хост знает, где их папки.
      if (opts.skillDir && store.meta) caps.skills = { session: true }
      if (opts.catalogs) {
        const kinds: NonNullable<Capabilities['catalogs']> = {}
        if (opts.catalogs.tools) kinds.tools = true
        if (opts.catalogs.skills) kinds.skills = true
        if (opts.catalogs.extensions) kinds.extensions = true
        caps.catalogs = kinds
      }
      // Пространство есть, но оно одно и неподвижное (workspace-spec §4):
      // хранилище задано опцией при сборке — переключать нечего. Файлы — при опции.
      if (promptsOpt) caps.prompts = true
      if (personasOn) caps.personas = { edit: true, multi: true }
      if (opts.impersonate) caps.impersonate = true
      caps.workspace = memoryFiles
        ? { files: { write: true, watch: true, search: true } }
        : filesRouter
          ? { files: await filesRouter.capability().catch(() => ({})) }
          : {}
      if (opts.services) caps.services = await opts.services.capability()
      if (opts.ask?.length) caps.ask = [...opts.ask]
      if (opts.promptDebug && opts.ask?.includes(PROMPT_DEBUG_ASK_KIND)) caps.promptDebug = true
      if (opts.sessionTools) caps.tools = { session: true }
      if (cwdOn) caps.workspace.perSession = true
      if (projects) {
        caps.workspace.switch = true
        caps.workspace.projects = true
        if (repos) caps.workspace.repos = true
        if (projects.create && projects.update) caps.workspace.edit = true
      }
      // v1.55: архив и теги — на мете; перенос — примитив драйвера.
      if (c.sessionMeta) caps.sessions = { ...caps.sessions, archive: true }
      if (store.move) caps.sessions = { ...caps.sessions, move: true }
      // v1.57: окно ленты и поиск/окно списка.
      caps.sessions = { ...caps.sessions, page: true }
      caps.history = { page: true }
      return caps
    },

    // workspace (§4): у store-бэкенда пространство единственное — само
    // хранилище. `switch` нет: сменить store у собранного бэкенда нельзя.
    // С проектами (v1.26) пространства — проекты реестра, текущий — переключаемый.
    workspace: {
      async current(): Promise<WorkspaceInfo> {
        return projects ? currentInfo() : { ...workspaceInfo }
      },
      async list(): Promise<WorkspaceInfo[]> {
        if (!projects) return [{ ...workspaceInfo }]
        const all = await projectList()
        // Запись-алиас (v1.35, spaces-spec §1) — в списке, но скрыта: её сессии видны в пространстве.
        const hidden = aliasIds(all)
        return all.map((p) => (hidden.has(p.id) ? { ...projectInfo(p), hidden: true } : projectInfo(p)))
      },
      ...(projects && repos
        ? {
            async repos(o?: { workspace?: string }): Promise<ProjectInfo[]> {
              return structuredClone(repos!.list(await projectById(o?.workspace ?? currentProject)))
            },
          }
        : {}),
      ...(projects
        ? {
            async switch(id: string): Promise<WorkspaceInfo> {
              const p = await projectById(id)
              const changed = currentProject !== p.id
              currentProject = p.id
              if (changed) filesRouter?.switched()
              return projectInfo(p)
            },
          }
        : {}),
      ...(projects?.create && projects.update
        ? {
            async create(input: WorkspaceProject & { id?: string }): Promise<WorkspaceInfo> {
              const want = (input as { id?: unknown }).id
              if (want !== undefined && typeof want !== 'string') throw new ProjectBadRequestError('id: ожидается строка')
              const project = expandProject(checkProject(input, false), projects.expand?.bind(projects))
              await checkRoot(project.root)
              const id = newProjectId(want, project.name, (await projectList()).map((p) => p.id))
              return projectInfo(await projects.create!({ id, ...project }))
            },
            async update(id: string, patch: WorkspaceProjectPatch): Promise<WorkspaceInfo> {
              const cur = await projectById(id)
              const clean = expandProject(checkProject(patch, true), projects.expand?.bind(projects))
              const next = patchProject(cur, clean)
              if (clean.root) await checkRoot(next.root)
              return projectInfo(await projects.update!(id, clean))
            },
          }
        : {}),
      ...(files ? { files } : {}),
    },

    sessions: {
      async list(listOpts?: SessionListOpts): Promise<SessionInfo[]> {
        // Поиск и окно (v1.57) — по готовому списку, в самом конце.
        return pageSessions(await listRows(listOpts), listOpts)
      },
      async create(input?: SessionCreateOpts): Promise<SessionInfo> {
        // Проект новой сессии (v1.26): явные cwd/профиль/модель — поверх проекта.
        let createOpts = input
        let projectId: string | undefined
        let repo: ProjectInfo | undefined
        if (projects) {
          const p = await projectById(input?.workspace ?? currentProject)
          projectId = p.id
          // Проект пространства (v1.35): неизвестный — отказ до создания; его корень — cwd.
          if (input?.project) {
            if (!repos) throw new NotSupportedError('sessions.create.project')
            repo = repos.find(p, input.project)
            if (!repo) throw new ProjectNotFoundError(`${p.id}/${input.project}`)
            createOpts = { ...(input ?? {}) }
            if (createOpts.cwd === undefined && cwdOn) createOpts.cwd = repo.root
            if (createOpts.profile === undefined && repo.agent && profileCatalog) {
              const agent = agentFor(repo.agent, p.id)
              if (agent !== undefined) createOpts.profile = agent
            }
            if (createOpts.model === undefined && repo.model && catalog?.some((m) => m.id === repo!.model)) createOpts.model = { model: repo.model }
          }
          if (p.id !== DEFAULT_PROJECT_ID) {
            createOpts = { ...(createOpts ?? {}) }
            if (createOpts.cwd === undefined && cwdOn) createOpts.cwd = p.root
            if (createOpts.profile === undefined && p.profile && profileCatalog) {
              const agent = agentFor(p.profile, p.id)
              if (agent !== undefined) createOpts.profile = agent
            }
            if (createOpts.model === undefined && p.model && catalog?.some((m) => m.id === p.model)) createOpts.model = { model: p.model }
          }
        }
        // cwd (v1.20): не умеем или путь негоден — отказ ДО создания, без сирот.
        if (createOpts?.cwd !== undefined) {
          if (!cwdOn) throw new NotSupportedError('sessions.create.cwd')
          await checkCwd(createOpts.cwd)
        }
        const info: Partial<SessionInfo> = {}
        if (createOpts?.title) info.title = createOpts.title
        if (createOpts?.botId) info.botId = createOpts.botId
        if (projectId && projectId !== DEFAULT_PROJECT_ID) info.workspace = projectId
        if (repo) info.project = repo.id
        // Модель новой сессии (§3): выбор фиксируется до первого рана.
        const applied = createOpts?.model && catalog ? applyChoice(createOpts.model) : undefined
        // Профиль новой сессии: неизвестный — отказ ДО создания, без сирот.
        // Агент проекта по id: каталог глазами проекта, документ — если у стенда его нет.
        const asked = typeof createOpts?.profile === 'string' && projectId && projectId !== DEFAULT_PROJECT_ID ? (agentFor(createOpts.profile, projectId) ?? createOpts.profile) : createOpts?.profile
        const profile = asked && profileCatalog ? pickProfile(asked) : undefined
        const created = await store.create(Object.keys(info).length ? { info } : undefined)
        if (applied) chosen.set(created.id, applied)
        if (profile !== undefined) rememberProfile(created.id, profile)
        await persistChoice(created.id, { ...(applied ? { model: applied } : {}), ...(profile ? { profile: profile.id } : {}) })
        const startSkills = [...new Set((createOpts?.skills ?? []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()))]
        // Имя при создании (мит по крону, задача) — защищённое: агент и карточка его не перепишут.
        const titled = !!createOpts?.title && !!store.meta
        const startObjects = store.meta ? sessionObjectsOf(createOpts?.objects) : []
        if (createOpts?.cwd !== undefined || (startSkills.length && store.meta) || titled || startObjects.length) {
          const next = mergeSessionMeta((await store.meta!.get(created.id)) as SessionMetaDoc, {
            ...(createOpts?.cwd !== undefined ? { workspace: { cwd: createOpts.cwd } } : {}),
            ...(startSkills.length ? { skills: startSkills } : {}),
            ...(startObjects.length ? { objects: startObjects } : {}),
            ...(titled ? { titleSource: 'create' } : {}),
          } as SessionMetaDoc)
          if (store.meta!.set) await store.meta!.set(created.id, next as Record<string, unknown>)
          else await store.meta!.patch(created.id, next as Record<string, unknown>)
        }
        return withModel(created)
      },
      async get(id: string): Promise<SessionInfo> {
        const info = (await store.load(id)).info
        await hydrate(id)
        return withModel(info)
      },
      async delete(id: string): Promise<void> {
        if (!store.delete) throw new NotSupportedError('sessions.delete')
        await store.delete(id)
      },
      // rename — примитив смены title (отдельный от sessionMeta): выставляется,
      // если драйвер его несёт, иначе метода нет → биндинг ответит not_supported.
      // Переименование через протокол — рука человека (`titleSource: user`).
      ...(store.rename
        ? {
            rename: async (id: string, title: string) => {
              await store.rename!(id, title)
              if (store.meta) await store.meta.patch(id, { titleSource: 'user' }).catch(() => undefined)
            },
          }
        : {}),
      ...(store.forkCopy
        ? { fork: (id: string, atMessageId?: string) => store.forkCopy!(id, atMessageId) }
        : {}),
      // Перенос в другое пространство (v1.55): алиас → настоящее id, проект — если он
      // есть и в целевом (тот же id по маскам целевого), иначе сбрасывается. Агент не меняется.
      ...(store.move
        ? {
            move: async (id: string, to: SessionMoveInput): Promise<SessionInfo> => {
              await guardBusy(id)
              const info = (await store.load(id)).info
              let ws = to.workspace
              let project: string | undefined
              if (projects) {
                const all = await projectList()
                const owner = all.find((p) => p.id !== ws && p.aliases?.includes(ws))
                if (owner) ws = owner.id
                const space = all.find((p) => p.id === ws)
                if (!space && ws !== DEFAULT_PROJECT_ID) throw new ProjectNotFoundError(ws)
                const want = to.project === undefined ? info.project : (to.project ?? undefined)
                if (want && space && repos?.find(space, want)) project = want
              }
              await store.move!(id, { workspace: ws, ...(project ? { project } : {}) })
              return withModel((await store.load(id)).info)
            },
          }
        : {}),
    },

    ...(personasOps ? { personas: personasOps } : {}),

    async history(id: string, hopts?: HistoryOpts): Promise<HistoryPage> {
      // Лента по версии файла — из кэша: 36 МБ сессия — 2.5 с разбора на каждый вызов.
      // Версия до чтения: файл поменялся между ними — запись под старой версией, следующая её не найдёт.
      const version = store.version ? await versionOf(id) : undefined
      let messages = version ? historyCache.get(id)?.version === version ? historyCache.get(id)!.messages : undefined : undefined
      if (!messages) {
        messages = toHistory(await store.load(id))
        if (version) {
          historyCache.delete(id)
          historyCache.set(id, { version, messages })
          if (historyCache.size > HISTORY_CACHE_MAX) historyCache.delete(historyCache.keys().next().value!)
        }
      }
      // Окно (v1.57): без опций — вся лента и без `more/total`, как раньше.
      if (!hopts || (hopts.limit === undefined && !hopts.before)) return { messages, version: version ?? (await versionOf(id)) }
      return { ...historyWindow(messages, hopts), version: version ?? (await versionOf(id)) }
    },

    run,

    async cancel(id: string, runId: string): Promise<void> {
      // runId сверяем: запоздалый cancel старого рана не должен убивать следующий
      // (один активный ран на сессию не спасает от гонки между последовательными).
      const ctl = runControls.get(id)
      if (!ctl || ctl.runId !== runId) return
      ctl.ac.abort()
    },

    // respond (§5.3): ответ на ask живого рана — ровно при опции `ask`.
    ...(opts.ask
      ? {
          respond: async (id: string, askId: string, answer: unknown): Promise<void> => {
            const state = runAsks.get(id)
            if (state) return state.answer(askId, answer)
            // Ран идёт в другом процессе (внешний kv) — ответ ему через kv.
            if (opts.kv && (await answerRemote(opts.kv, id, askId, answer))) return
            throw new StoreBadRequestError(`respond: у сессии ${id} нет живого рана`)
          },
        }
      : {}),

    messages,

    // models (§5): каталога нет → метода нет → биндинг ответит not_supported.
    ...(catalog
      ? {
          models: {
            list: async () => catalog,
            set: async (sid: string, want: SessionModel) => {
              // Смена посреди рана — busy (§3); применяется к следующему run.
              await guardBusy(sid)
              const applied = applyChoice(want)
              await hydrate(sid)
              chosen.set(sid, applied)
              await persistChoice(sid, { model: applied })
              return applied
            },
          },
        }
      : {}),

    // profiles (profiles-spec §5): каталога нет → метода нет → not_supported.
    ...(profileCatalog
      ? {
          profiles: {
            // Каталог глазами проекта клиента (v1.27; агенты проекта —).
            list: async (o?: ProfilesListOpts) => {
              refreshProfiles(o?.workspace)
              const out = [...profileCatalog.values()].map(profileInfoOf)
              if (o?.workspace !== undefined) refreshProfiles()
              return out
            },
            set: async (sid: string, profile: string | ProfileDoc): Promise<ProfileInfo> => {
              // Смена посреди рана — busy: у настоящего бэкенда профиль —
              // свойство процесса, и фикстура обязана отказывать там же.
              await guardBusy(sid)
              const picked = pickProfile(profile)
              await hydrate(sid)
              rememberProfile(sid, picked)
              await persistChoice(sid, { profile: picked.id })
              return picked.info
            },
            // Наружу — только копии: мутация полученного документа не должна
            // менять каталог мимо save.
            get: async (id: string, o?: ProfilesListOpts): Promise<ProfileDoc> => {
              if (o?.workspace === undefined) return structuredClone(profileDoc(id))
              const found = agentFor(id, o.workspace)
              if (found === undefined) throw new StoreProfileNotFoundError(id)
              return typeof found === 'string' ? structuredClone(profileDoc(id)) : found
            },
            save: async (doc: ProfileDoc): Promise<ProfileDoc> => {
              if (!isProfileId(doc?.id)) {
                throw new StoreBadRequestError(`save: id профиля ${JSON.stringify(doc?.id)} — нужен [a-z0-9-]`)
              }
              const next = structuredClone(doc)
              // extra клиент не правит: дока без него — не «стереть прочие атрибуты».
              refreshProfiles()
              const prev = profileCatalog.get(doc.id)
              if (next.extra === undefined && prev?.extra) next.extra = { ...prev.extra }
              if (opts.profileStore) {
                const saved = await opts.profileStore.save(next)
                refreshProfiles()
                return structuredClone(saved)
              }
              profileCatalog.set(doc.id, next)
              return structuredClone(next)
            },
            delete: async (id: string): Promise<void> => {
              if (id === defaultProfileId) {
                throw new StoreBadRequestError(`delete: ${id} — профиль сессий без выбора, не удаляется`)
              }
              profileDoc(id)
              if (opts.profileStore) {
                await opts.profileStore.delete(id)
                refreshProfiles()
                return
              }
              profileCatalog.delete(id)
            },
            duplicate: async (id: string, newId: string): Promise<ProfileDoc> => {
              const source = profileDoc(id)
              if (!isProfileId(newId)) {
                throw new StoreBadRequestError(`duplicate: id профиля ${JSON.stringify(newId)} — нужен [a-z0-9-]`)
              }
              if (profileCatalog.has(newId)) throw new StoreProfileConflictError(newId)
              const copy = { ...structuredClone(source), id: newId }
              if (opts.profileStore) {
                const saved = opts.profileStore.duplicate ? await opts.profileStore.duplicate(id, newId) : await opts.profileStore.save(copy)
                refreshProfiles()
                return structuredClone(saved)
              }
              profileCatalog.set(newId, copy)
              return structuredClone(copy)
            },
          },
        }
      : {}),

    // catalogs (profile-editor-spec §4): статика опцией, вид ⇔ метод.
    ...(opts.catalogs
      ? {
          catalogs: {
            ...(opts.catalogs.tools ? { tools: async () => structuredClone(opts.catalogs!.tools!) } : {}),
            ...(opts.catalogs.skills ? { skills: async () => structuredClone(opts.catalogs!.skills!) } : {}),
            ...(opts.catalogs.extensions ? { extensions: async () => structuredClone(opts.catalogs!.extensions!) } : {}),
          },
        }
      : {}),

    /**
     * Мета сессии (session-meta-spec §2).
     *
     * Merge делает бэкенд, а не драйвер: правило патча (вложенный `prompt`,
     * `null` удаляет ключ) — часть контракта протокола, и оно обязано быть
     * одинаковым у всех хранилищ. Драйверу уезжает уже готовый документ.
     *
     * `set` — единственный способ записать документ с УДАЛЁННЫМ ключом.
     * Драйвер без него получает merged-документ через `patch`: вложенный merge
     * так работает, а удаление ключа — нет (о чём сказано в контракте store).
     */
    ...(store.meta
      ? {
          meta: {
            get: async (id: string): Promise<SessionMetaDoc> => {
              const doc = (await store.meta!.get(id)) as SessionMetaDoc
              const mds = effective.get(id) ?? (recipeStore?.effective ? await recipeStore.effective.get(id).catch(() => undefined) : undefined)
              return mds === undefined ? doc : { ...doc, effectivePrompt: mds }
            },
            patch: async (id: string, patch: SessionMetaPatch): Promise<SessionMetaDoc> => {
              // Удар живости: `toolsAlive` — в kv, в документ не пишется;
              // один удар — без записи и без `busy` (ран идёт — исполнитель жив).
              if (patch.toolsAlive !== undefined) {
                const { toolsAlive, ...rest } = patch
                if (toolsAlive !== null && typeof toolsAlive === 'object') await alive.mark(id, toolsAlive as Record<string, unknown>)
                patch = rest
                if (Object.keys(patch).length === 0) return (await store.meta!.get(id)) as SessionMetaDoc
              }
              // Скиллы сессии (v1.59): тул агента `skills_attach` пишет их посреди своего рана — не busy;
              // ран прочёл мету на старте, список вступит со следующего хода.
              if (!Object.keys(patch).every((k) => k === 'skills')) await guardBusy(id)
              if (cwdOn && patch.workspace !== undefined && patch.workspace !== null) {
                const cwd = (patch.workspace as { cwd?: unknown }).cwd
                if (cwd !== undefined && cwd !== null) {
                  if (typeof cwd !== 'string') throw new StoreBadRequestError('workspace.cwd: ожидается строка')
                  await checkCwd(cwd)
                }
              }
              const next = mergeSessionMeta((await store.meta!.get(id)) as SessionMetaDoc, patch)
              if (store.meta!.set) await store.meta!.set(id, next as Record<string, unknown>)
              else await store.meta!.patch(id, next as Record<string, unknown>)
              return (await store.meta!.get(id)) as SessionMetaDoc
            },
          },
        }
      : {}),

    attachments: store.assets && !store.assets.get ? { put: putAttachment } : { put: putAttachment, get: getAttachment },

    ...(opts.services
      ? {
          services: {
            call: (plugin: string, method: string, args?: unknown) => opts.services!.call(plugin, method, args),
            stream: (plugin: string, method: string, args?: unknown) => opts.services!.stream(plugin, method, args),
          },
        }
      : {}),

    ...(store.close || opts.services || filesRouter
      ? {
          close: async () => {
            filesRouter?.close()
            await opts.services?.close()
            await store.close?.()
          },
        }
      : {}),
  }

  return backend
}

// ────────────────────────────────────────────────────────────────────────────
// Мелочи
// ────────────────────────────────────────────────────────────────────────────

/** Элемент опции `profiles` → документ: витринный `promptMode` становится `prompt.mode`. */
function profileDocOf(p: ProfileDoc | ProfileInfo): ProfileDoc {
  const { promptMode, ...rest } = structuredClone(p) as ProfileInfo & ProfileDoc
  const doc: ProfileDoc = rest
  if (promptMode && !doc.prompt?.mode) doc.prompt = { ...doc.prompt, mode: promptMode }
  return doc
}

/** Заголовок по первой реплике юзера: 40 символов, пробелы схлопнуты. */
export function autoTitle(nodes: ReadonlyArray<Pick<StoreNode, 'role' | 'parts'>>): string | undefined {
  const first = nodes.find((n) => n.role === 'user')
  if (!first) return undefined
  const text = first.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  const chars = [...text]
  return chars.length > 40 ? `${chars.slice(0, 40).join('').trimEnd()}…` : text
}

/** userMessage (string | Part[]) → Part[]. */
function normalizeUserParts(userMessage: string | Part[]): Part[] {
  if (typeof userMessage === 'string') return [{ type: 'text', text: userMessage }]
  return userMessage
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Ошибка генерации → `run_end.error`: текст и машинный `code`, если генератор
 * его дал (`max_turns` — лимит ходов цикла: ходы до него в сессии, ран можно
 * продолжить).
 */
function errOf(err: unknown): { message: string; code?: string } {
  const code = (err as { code?: unknown } | null)?.code
  return typeof code === 'string' && code !== '' ? { message: errMsg(err), code } : { message: errMsg(err) }
}

/** Картинка-вложение без байтов в сообщении: ref есть, `data:`/`http` URL нет (П-1). */
function needsBytes(p: Part): p is Part & { meta: Record<string, unknown> } {
  if (p.type !== 'image') return false
  const meta = (p as { meta?: Record<string, unknown> }).meta
  return typeof meta?.ref === 'string' && meta.ref !== '' && !(typeof meta.url === 'string' && meta.url !== '')
}

/** base64 без Buffer (store-backend живёт и вне Node). */
function base64Of(data: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** Картинка без mime и расширения (вставка «image»/«blob»,/610) — по первым байтам. */
export function sniffImageMime(b: Uint8Array): string | undefined {
  const at = (i: number, ...xs: number[]) => xs.every((x, k) => b[i + k] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return undefined
}

/** `RunStartInput.vars` (v1.67): строки по id; пусто — `undefined`. */
function runVarsOf(v: unknown): Record<string, string> | undefined {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return undefined
  const out = Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === 'string' && x !== '').map(([k, x]) => [k, String(x)]))
  return Object.keys(out).length ? out : undefined
}
