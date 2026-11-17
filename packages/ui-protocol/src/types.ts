/**
 * nr-ui-protocol — типы протокола UI ⇄ бэкенд (v1).
 *
 * Канон: nr-engine/docs/specs/nr-ui-protocol-spec.md
 * Пакет содержит ТОЛЬКО типы + хелперы: никакого транспорта/сервера/клиента.
 *
 * Инверсия (chat-store-spec §1, §9): анатомия сообщения (Part/Message/
 * SessionInfo/…) переехала в @kerneldreams/chat-store — она общая реальность
 * хранения и провода. Протокол её импортирует и **ре-экспортирует** (§2.1–2.3
 * канона: существующие импорты не ломаются), себе оставляя wire: RunEvent,
 * Capabilities, Envelope, RunStartInput, ask.
 */

// ────────────────────────────────────────────────────────────────────────────
// §2.1–2.3 Модель — ре-экспорт из chat-store (дом анатомии сообщения)
// ────────────────────────────────────────────────────────────────────────────

export type {
  // §2.1 Session
  SessionInfo,
  SessionShare,
  SessionRun,
  SessionTask,
  // v1.44: вид чата и происхождение имени
  SessionKind,
  TitleSource,
  Participant,
  // profile-editor-spec §2 — документ профиля; дом — chat-store, раз его
  // несёт `SessionInfo.profileDoc` (bot-as-session-spec §1)
  ProfileDoc,
  AgentVoice,
  // §2 models-spec — выбор модели сессии (в chat-store зовётся ModelSelection:
  // имя SessionModel там занято хранимой сессией; форма одна и та же)
  ModelSelection,
  ModelSelection as SessionModel,
  // §2.2 Message
  Message,
  MessageFlags,
  MessageMeta,
  MessageSpeech,
  Usage,
  // §2.3 Part
  Part,
  KnownPartType,
  UnknownPart,
  AnyPart,
  TextPart,
  ThinkingPart,
  ToolUsePart,
  ToolResultPart,
  FilePart,
  ImagePart,
  ErrorPart,
  CustomPart,
  // personas-spec §1
  Persona,
  PersonaKind,
  PersonasDoc,
} from '@kerneldreams/chat-store'

import type { SessionObjectRef } from './objects.js'
import type { AgentVoice, Message, MessageMeta, Part, Persona, PersonasDoc, Usage } from '@kerneldreams/chat-store'
import type { ServicesCapability } from './services.js'
import type { SettingsCapability } from './settings.js'
import type { ExternalFilesCapability, HostCapability } from './external.js'
import type { SkinsCapability } from './skins.js'
import type { ExternalPluginInfo } from './plugins.js'

// ────────────────────────────────────────────────────────────────────────────
// §2 models-spec — модели (capability `models`)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Модель бэкенда (models-spec §2). Протокол не знает ни провайдеров, ни
 * ключей — только идентификаторы и метки; что за ними стоит, знает бэкенд.
 */
export interface ModelInfo {
  /** Opaque для клиента ('nr/glm-5.3-flash'): сравнивать, а не разбирать. */
  id: string
  /** Отображаемое имя; отсутствует = показывать `id`. */
  name?: string
  /** Группировка в UI ('nr', 'nr-openrouter'). */
  provider?: string
  /** Свободные метки ('vision' | 'reasoning' | 'sub' | …) — UI рисует бейджами. */
  tags?: string[]
  /** Уровни рассуждения этой модели; пусто/нет = уровней нет. */
  thinking?: string[]
  contextWindow?: number
  /**
   * Движок модели (v1.29, users-spec §1): у хаба каталог — общий, модели
   * подключённых движков помечены их id; без поля — модель встроенного движка.
   * Сессии клиент предлагает модели её движка (`engineModels`).
   */
  engine?: string
}

// ────────────────────────────────────────────────────────────────────────────
// workspace-spec §2 — рабочее пространство (capability `workspace`)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Рабочее пространство бэкенда (workspace-spec §2).
 *
 * Бэкенд для клиента непрозрачен: за адресом порта стоит cwd, о котором клиент
 * не знает. Пространство — это «где я»: для агента папка проекта, для чата —
 * каталог историй. Свойство хранилища/проектов, не транспорта.
 */
export interface WorkspaceInfo {
  /** Opaque для клиента: сравнивать, а не разбирать. У pi — cwd. */
  id: string
  /** Короткое имя: basename каталога, имя проекта. */
  name: string
  /** Абсолютный путь, если его есть смысл показывать (title в UI). */
  path?: string
  /** `'directory' | 'project' | …` — словарь свободный, UI не обязан знать. */
  kind?: string
  /** Описание проекта (v1.26, projects-spec §3) — строка под именем в переключателе. */
  description?: string
  /**
   * Запись реестра (v1.26, `kind: 'project'`): поля `projects/<id>.mdz` — форма
   * «Новый проект…»/правка читает и шлёт их же (`workspace.create/update`).
   */
  project?: WorkspaceProject
  /**
   * Запись-алиас другого пространства (v1.35, spaces-spec §1): её id — в `$aliases`
   * другой записи. Пикер её не показывает; сессии видны в том пространстве.
   */
  hidden?: boolean
  /**
   * Роль пользователя запроса в проекте (v1.30, users-spec §3) — у стенда с
   * пользователями (`Capabilities.users`). `viewer` — файлы только на чтение.
   * Нет — стенд без пользователей (всё можно).
   */
  role?: ProjectRole
}

/** Роль в проекте (users-spec §3): owner — всё и участники, editor — файлы на запись, viewer — на чтение. */
export type ProjectRole = 'owner' | 'editor' | 'viewer'

/**
 * Проект реестра стенда (v1.26, projects-spec §1): `envs/projects/<id>.mdz`.
 * Обязательны `name` и `root`; нет поля — значение стенда. Пути — абсолютные
 * или от `~` (раскрывает бэкенд).
 */
export interface WorkspaceProject {
  /** Имя проекта (`$name`). */
  name: string
  /** Описание (`$description`) — одна строка. */
  description?: string
  /** Корень — cwd агента новых сессий (`$root`). */
  root: string
  /** Дополнительные каталоги агента (`$dirs`: ACP `additionalDirectories`). */
  dirs?: string[]
  /** Контекст-пакет проекта (`$context`) — только чтение. */
  context?: string
  /** Профиль новых сессий (`$profile`). */
  profile?: string
  /** Модель новых сессий (`$model`). */
  model?: string
  /** Скиллы проекта — имена skillbox или пути (`$skills`). */
  skills?: string[]
  /** Папки внешних плагинов фронта (`$plugins`) — к плагинам стенда при открытом проекте. */
  plugins?: string[]
  /** Движок новых сессий проекта (`$engine`, v1.29, users-spec §3): `nr`, `acp`, `pi`. */
  engine?: string
  /**
   * Участники (`$members`, v1.30, users-spec §3): id пользователя → роль. Нет в
   * списке — проекта не видно (owner стенда видит всё). Нет поля — проект только
   * owner стенда (и личный проект — его хозяину).
   */
  members?: Record<string, ProjectRole>
  /** Проекты, которые агент сессий этого проекта читает (`$reads`, ПМ; v1.30). */
  reads?: string[]
  /** Ключ проекта Projektor — журнал задач пространства (`$projektor`, v1.35, spaces-spec §1). */
  projektor?: string
  /**
   * Проекты пространства — пути и маски (`$projects`, v1.35, spaces-spec §2): `*` —
   * один уровень; проект — каталог из маски, кроме `*.dev`, `*.skills`, скрытых.
   * Список — `workspace.repos`.
   */
  projects?: string[]
  /**
   * Старые id пространства (`$aliases`, v1.35, spaces-spec §1): сессии с
   * `workspace: <алиас>` видны здесь; запись-алиас в списке — `hidden`.
   */
  aliases?: string[]
  /**
   * Слияние ветки задачи (`$merge`, v1.36, task-session-spec §6): `before-accept` — хост
   * вливает ff в master по успешному ходу исполнителя, приёмка на dev; `after-accept` —
   * приёмка до слияния, вливает хост по вердикту. Нет — `after-accept`.
   */
  merge?: 'before-accept' | 'after-accept'
  /**
   * Аккаунт Claude Code сессий пространства (`$claude_account`, v1.48): id из
   * таблицы аккаунтов стенда (`## $claude_accounts` в `contours.mdz` → `CLAUDE_CONFIG_DIR`).
   * Нет — аккаунт стенда по умолчанию.
   */
  claudeAccount?: string
  /**
   * Аккаунт «на остатке» (`$claude_account_leftover`): пространство без своего
   * `claudeAccount` идёт на этот аккаунт, только пока стенд считает, что его неделя
   * недоедена перед сбросом (окно `## $claude_leftover` реестра контуров); иначе — по умолчанию,
   * без аккаунта пространства-владельца алиаса.
   */
  claudeAccountLeftover?: string
}

/**
 * Проект пространства (v1.35, spaces-spec §2) — каталог на диске из масок
 * `$projects`: cwd сессии и контекст-пакет в префиксе (`SessionCreateOpts.project`).
 */
export interface ProjectInfo {
  /** Имя каталога; конфликт внутри пространства — `<родитель>/<имя>`. */
  id: string
  name: string
  /** Абсолютный корень — cwd сессии. */
  root: string
  /** Каталог контекст-пакета (`<root>.dev`, `<root>/<имя>.dev`) — `additionalDirectories`. */
  context?: string
  /** Файлы контекста в префикс (абсолютные): `SKILL.md`, `HANDOFF.md` пакета или `$files` проекта. */
  files: string[]
  /** `.nrchat/project.mdz`: скиллы, агент и модель проекта по умолчанию. */
  skills?: string[]
  agent?: string
  model?: string
}

// ────────────────────────────────────────────────────────────────────────────
// workspace-files-spec §1 — файлы пространства (capability `workspace.files`, v1.7)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Файловые операции пространства (workspace-files-spec §1). Объект заявлен ⇔
 * есть `workspace.files` (`list`/`read`/`stat`); `write` — `write`/`delete`/
 * `rename`; `watch` — бэкенд шлёт `workspace_update` при изменении на диске.
 */
export interface WorkspaceFilesCapability {
  write?: boolean
  watch?: boolean
  /** v1.28: есть `search` — полнотекстовый поиск по пространству. */
  search?: boolean
}

/**
 * Узел файлового дерева пространства.
 *
 * `path` — относительный от корня пространства, POSIX-слэши, без `./`; у корня
 * — пустая строка. `ignored` — `.gitignore`, `node_modules`, `.git`, корзина:
 * в списке узел есть, UI его сворачивает.
 */
export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'dir'
  /** Байт; у каталогов нет. */
  size?: number
  /** ISO-время последнего изменения. */
  mtime?: string
  /** По расширению; у каталогов и неизвестных типов нет. */
  mime?: string
  ignored?: boolean
  /** v1.42: хост записи `files.external`; нет — хост хаба. У пространства не бывает. */
  host?: string
}

/**
 * Запрос полнотекстового поиска по пространству (`workspace.files.search`,
 * v1.28). `query` — подстрока (по умолчанию без учёта регистра) либо
 * JS-regex при `regex`; `glob` — фильтр путей (без `/` — по имени файла);
 * `limit` — сколько строк вернуть (default {@link DEFAULT_FILE_SEARCH_LIMIT}).
 * Игнорируемое (`.git`, `node_modules`, `.gitignore`, корзина) и бинарные
 * файлы не ищутся. Пустой запрос, битый regex — `bad_request`.
 */
export interface FileSearchQuery {
  query: string
  regex?: boolean
  /** Учитывать регистр. Default false. */
  case?: boolean
  glob?: string
  limit?: number
}

/** Строка-совпадение поиска: путь пространства, номер строки (с 1), текст строки (обрезан). */
export interface FileSearchHit {
  path: string
  line: number
  text: string
  /** Столбец начала первого совпадения в `text`, с 1. */
  column?: number
}

/** Кодировка содержимого на проводе: текст как есть либо байты в base64. */
export type FileEncoding = 'utf8' | 'base64'

/**
 * Содержимое файла (`workspace.files.read`).
 *
 * `utf8` — файл читается как UTF-8 без NUL-байтов (BOM сохранён: сохранение
 * обязано вернуть файл байт в байт); иначе `base64`. `revision` — opaque токен
 * версии: его приносят в `write`, расхождение — `conflict`.
 */
export interface FileContent {
  path: string
  content: string
  encoding: FileEncoding
  size: number
  mime?: string
  revision: string
}

/**
 * Байты вложения (`attachments.get`, протокол v1.10). Кодировка — по правилу
 * `fileContent`: UTF-8 без NUL — текстом, иначе base64; картинка почти всегда
 * base64 (SVG — текстом). `mime` — сохранённый при `put`, если бэкенд его знает.
 */
export interface AttachmentContent {
  ref: string
  content: string
  encoding: FileEncoding
  size: number
  mime?: string
}

/**
 * Файлы пространства изменились (workspace-files-spec §1, capability
 * `workspace.files.watch`): затронутые пути, клиент перечитывает их каталоги.
 *
 * Не событие рана — едет отдельным SSE-каналом `GET /workspace/events`, `runId`
 * у него нет. `''` в `paths` — корень: «перечитай всё» (переподключение, смена
 * пространства, слишком много изменений разом).
 */
export interface WorkspaceUpdateEvent {
  type: 'workspace_update'
  paths: string[]
}

// ────────────────────────────────────────────────────────────────────────────
// prompt-recipe-spec §1–2 — промпт сообщения (capability `prompts`, v1.8)
// ────────────────────────────────────────────────────────────────────────────

/** Роль инъекции рецепта: куда в запрос она встала. */
export type PromptInjectionRole = 'system' | 'user' | 'assistant'

/** Инъекция рецепта: кусок, вставленный вокруг истории (пост-промпт, лорбук, снимок). */
export interface PromptRecipeInjection {
  role: PromptInjectionRole
  /** sha256[:16] текста; сам текст — у бэкенда по хэшу. */
  hash: string
  /** Кто вставил: `'meta.pre'` | `'meta.post'` | … Метка для UI, не контракт. */
  source?: string
  /**
   * Почему вставлено (v1.19): у записи лорбука — что сработало (`constant`,
   * `ключ «Rico»`, `карточка: ключ «башн»`), у отброшенного — `бюджет`. Для UI.
   */
  reason?: string
}

/**
 * Блок итогового system в порядке сборки (v1.19): откуда кусок (`profile`,
 * `meta.pre`, `lorebook:bot: <имя>`, `persona.user`, `persona`, `skills`…) и
 * хэш его текста. Склейка блоков через пустую строку — это и есть system.
 */
export interface PromptSystemBlock {
  source: string
  hash: string
}

/**
 * Рецепт промпта ответа (prompt-recipe-spec §1): что ушло в модель, без
 * дублирования истории — хэши кусков и id сообщений, а не тексты.
 */
export interface PromptRecipe {
  /** ISO, момент рана. */
  at: string
  /** Модель, которой ушёл запрос. */
  model?: string
  /** sha256[:16] итогового system prompt. */
  systemHash: string
  /** Инъекции в порядке вставки. */
  injections: PromptRecipeInjection[]
  /** id сообщений в порядке, как ушли в контекст (после отсечений и компакции). */
  messageIds: string[]
  /**
   * Короткие хэши (sha[:8]) сообщений `messageIds` на момент рана, по индексу.
   * По ним бэкенд помечает `edited`; `''` или нет элемента — сравнивать не с чем.
   * Чем хэшировать — дело бэкенда: клиент хэши не сравнивает.
   */
  messageHashes?: string[]
  tokens?: { input?: number; output?: number }
  /** Чей это ответ (personas-spec §4): персона хода, либо та, чьё имя модель поставила префиксом. */
  personaId?: string
  /**
   * Тулы, с которыми ушёл запрос (имена активных тулов движка на старте рана).
   * `[]` — без тулов (RP-профиль `$tools: none`); нет поля — бэкенд не сообщил.
   */
  tools?: string[]
  /**
   * От чьего лица собран промпт (v1.19, `RunStartInput.target`): нет — обычный
   * ход бота; `{kind: 'user'}` — impersonate (такой рецепт в сессию не пишется,
   * он уходит кадром {@link PROMPT_ACTIVITY_KIND}).
   */
  target?: ParticipantRef
  /** System по блокам с источниками (v1.19); нет — бэкенд не сообщил. */
  systemBlocks?: PromptSystemBlock[]
}

/** Инъекция в развёрнутом промпте: текст вместо хэша. */
export interface PromptInjection {
  role: string
  text: string
  source?: string
  /** Почему вставлено — {@link PromptRecipeInjection.reason}. */
  reason?: string
}

/** Сообщение контекста в развёрнутом промпте — текст из ТЕКУЩЕЙ версии сессии. */
export interface PromptMessage {
  id: string
  role: string
  text: string
  /** Сообщение удалено после рана: текста нет (`''`), в UI — плейсхолдер. */
  missing?: boolean
  /** Сообщение правили после рана: текст — уже новый, не тот, что ушёл. */
  edited?: boolean
}

/**
 * Развёрнутый промпт ответа (`messages.prompt`, prompt-recipe-spec §2):
 * рецепт + тексты по хэшам + сообщения контекста в порядке, как ушли.
 */
export interface PromptView {
  recipe: PromptRecipe
  system: string
  injections: PromptInjection[]
  messages: PromptMessage[]
  /** System по блокам (v1.19): тексты `recipe.systemBlocks` по порядку. */
  systemBlocks?: Array<{ source: string; text: string }>
  /**
   * Запрос, как ушёл провайдеру (v1.19): system первым, история, инъекции —
   * роли и тексты. Есть у кадра {@link PROMPT_ACTIVITY_KIND} (impersonate:
   * сообщений в сессии нет, ссылаться не на что); у `messages.prompt` — нет.
   */
  sent?: Array<{ role: string; content: string }>
}

/**
 * `activity`-кадр рана с промптом, собранным для него (v1.19): payload —
 * {@link PromptView}. Шлётся раном impersonate (`target: {kind: 'user'}`), у
 * которого рецепту в сессии лечь некуда; UI показывает его у кнопки «запрос».
 */
export const PROMPT_ACTIVITY_KIND = 'prompt'

// ────────────────────────────────────────────────────────────────────────────
// personas-spec §1, §3 — персоны сессии (capability `personas`, v1.9)
// ────────────────────────────────────────────────────────────────────────────

// Persona, PersonaKind, PersonasDoc (personas-spec §1) переехали в nr-chat-store
// (общая сборка) и ре-экспортируются выше.

/**
 * Персоны (personas-spec §3). `edit` — есть `personas.save`; `multi` — бэкенд
 * ведёт больше одной `char`-персоны (ход выбирается `RunStartInput.personaId`).
 */
export interface PersonasCapability {
  edit?: boolean
  multi?: boolean
  /**
   * Что из персон движок подаёт в контекст (v1.50, objects-spec §9): `all` (нет поля — так же) —
   * все персоны (nr/RP); `user` — только персона игрока, заменой карточки пользователя (Claude Code
   * через ACP); `none` — персоны хранятся, но в контекст не идут (панель так и пишет).
   */
  context?: PersonaContext
}

export type PersonaContext = 'all' | 'user' | 'none'

// ────────────────────────────────────────────────────────────────────────────
// profiles-spec §4 — профили сессии (capability `profiles`, протокол v1.4)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Профиль сессии (profiles-spec §2, §4): набор настроек процесса, с которыми
 * бэкенд поднимает сессию — тулы, скиллы, модель, system prompt.
 *
 * Здесь только то, что показать в UI. Сами настройки (флаги, env) — дело
 * бэкенда: провод их не видит и не передаёт.
 */
export interface ProfileInfo {
  /** Opaque для клиента: сравнивать, а не разбирать. У pi — имя файла профиля. */
  id: string
  /** Отображаемое имя; у профиля без имени — его `id`. */
  name: string
  description?: string
  /** `'none'` — без тулов; `'all'` — все; список — только эти; нет поля — как у окружения. */
  tools?: string[] | 'none' | 'all'
  /** Скиллы, которые профиль добавляет. */
  skills?: string[]
  /** Модель профиля (`ModelInfo.id`); нет — модель окружения. */
  model?: string
  /** Режим промпта, с которым создаётся сессия (session-meta-spec §7). */
  promptMode?: SessionPromptMode
  /**
   * Движок агента по умолчанию (agents-spec §3, v1.34): `engine` в `%meta`
   * агента; у агента, который есть только в каталоге одного движка хаба
   * (старый слепок ACP), — этот движок. Нет — `$engine` проекта / дефолт хаба.
   * «Профиль на проводе = агент»: имя группы `profiles.*` — DEBT.
   */
  engine?: string
  /** Откуда агент (agents-spec §2): `agents/` — новый каталог; `legacy` — старые `profiles/`. */
  source?: 'agents' | 'legacy'
  /** Карточка агента (`card` в `%meta`, memory-spec). */
  card?: string
  /**
   * Лицо агента (v1.63, icons-spec §4.1): `icon` — строка как `$icon` типа (имя lucide, эмодзи,
   * картинка), `avatar` — картинка. Лицо чата: своя иконка → персона → агент → буква на цвете агента.
   */
  icon?: string
  avatar?: string
  /**
   * Распознавание 🎤 в сессиях агента (`voice` в `%meta`, v1.39, LLM-12):
   * `mode` → `start.mode` потока speak, `refine` → пакет (`always` — всегда,
   * `auto` — когда live сломан, `off` — нет). Перебивает глобальную настройку
   * клиента; нет поля — как настроено в клиенте.
   */
  voice?: AgentVoice
}

// ────────────────────────────────────────────────────────────────────────────
// profile-editor-spec §2–3 — документ профиля и каталоги (протокол v1.5)
// ────────────────────────────────────────────────────────────────────────────

// ProfileDoc (profile-editor-spec §2) переехал в nr-chat-store вместе с
// `SessionInfo.profileDoc` (bot-as-session-spec §1) и ре-экспортируется выше.

/** Тул окружения (`catalogs.tools`, profile-editor-spec §3). `id` — то, что пишется в `ProfileDoc.tools`. */
export interface CatalogTool {
  id: string
  description?: string
  /** `builtin` — штатный тул движка; `extension` — зарегистрирован расширением. */
  source: 'builtin' | 'extension'
  /** id расширения-владельца (`CatalogExtension.id`), у `source:'extension'`. */
  extension?: string
}

/** Режим скилла сессии (v1.59): `linked` — агент грузит сам, `loaded` — в контексте хода. */
export type SessionSkillMode = 'linked' | 'loaded'

/** Скилл сессии (`SessionMetaDoc.skills`, v1.59, skills-spec §4). */
export interface SessionSkill {
  /** Имя скилла (skillbox / каталог) или абсолютный путь его папки. */
  name: string
  mode: SessionSkillMode
  /** Откуда взят (`skillbox`, `project`, `local`…) — для UI, не контракт. */
  source?: string
}

/** Скилл, доступный профилю (`catalogs.skills`). В `ProfileDoc.skills` пишется `id`. */
export interface CatalogSkill {
  id: string
  name: string
  description?: string
  /** Абсолютный путь пакета скилла. */
  path: string
}

/** Расширение (`catalogs.extensions`). `enabled` — уже подключено окружением, профилю добавлять незачем. */
export interface CatalogExtension {
  id: string
  name: string
  path: string
  enabled: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// §3 Capabilities
// ────────────────────────────────────────────────────────────────────────────

/** Лимиты вложений (attachments-spec §2). Поле отсутствует = бэкенд его не объявляет. */
export interface AttachmentsCapability {
  /** Максимальный размер одного файла, байт. */
  maxBytes?: number
  /**
   * Принимаемые типы: точные mime (`application/json`) и маски (`text/*`).
   * Файлы исходников бэкенд вправе принимать и по расширению — mime у них в
   * браузере часто пустой или чужой (`.ts` → `video/mp2t`).
   */
  mimes?: string[]
  /**
   * Байты вложения по `ref` — есть `attachments.get` (протокол v1.10). Без него
   * картинка вложения после перезагрузки видна только через `url`, если бэкенд
   * его кладёт.
   */
  get?: boolean
}

/**
 * Что умеет ран сверх «user-сообщение → ответ» (протокол v1.10).
 *
 * `continue` — ран без `userMessage` и без `regenerate` (§5.1 «продолжай»):
 * модель говорит следующей репликой, в ленту не пишется user-сообщение. Не
 * заявлен — такой ран бэкенд отвергает `not_supported` до `run_start`.
 */
export interface RunCapability {
  continue?: boolean
  /**
   * Команды рана (v1.18): имена, которые бэкенд понимает в
   * `RunStartInput.command` (`compact` — компакция контекста сессии). Нет имени
   * в списке — ран с такой командой отвергается `not_supported` до `run_start`.
   */
  commands?: string[]
  /**
   * v1.68: бэкенд понимает `RunStartInput.vars` (переменные пресета чипом) — пишет их в
   * `meta.vars` реплики игрока, на свайпе и «продолжить» — в мету последней. Не заявлено — фронт
   * чип не рисует.
   */
  vars?: boolean
}

/** Машина реестра стенда (v1.62, `Capabilities.devices`). */
export interface DeviceInfo {
  /** Имя секции `## $hosts <name>` — им подписывается штамп реплики. */
  name: string
  /** `$os`: `darwin` / `linux` / `win32`. */
  os?: string
  /** `$match`: короткий hostname машины (`scutil --get LocalHostName` / `hostname -s`). */
  match?: string
  /** `$client: true` — тонкий клиент (с него пишут), не сервер. */
  client?: boolean
}

export interface Capabilities {
  protocol: 1 // версия протокола
  name?: string // имя бэкенда ('dreams', 'pi-bridge', 'opencode-bridge')

  /**
   * Модели (models-spec §2). Заявлена ⇔ у бэкенда есть `models.list`.
   * `select` — можно ли менять модель per-session (⇔ есть `models.set`);
   * `thinking` — есть ли уровни рассуждения.
   */
  models?: { select?: boolean; thinking?: boolean }

  /**
   * Рабочее пространство (workspace-spec §2). Заявлена ⇔ у бэкенда есть
   * `workspace.current`/`list`; `switch` — можно ли менять текущее (⇔ есть
   * `workspace.switch`); `files` — файловые операции (workspace-files-spec §1,
   * ⇔ есть `workspace.files`), флаги внутри — запись и watch.
   */
  workspace?: {
    switch?: boolean
    files?: WorkspaceFilesCapability
    /**
     * Проекты (v1.26, projects-spec §3): `list` — реестр стенда (`kind:
     * 'project'`), сессия помечена проектом (`SessionInfo.workspace`), клиент
     * просит `sessions.list({workspace})` своего текущего и создаёт сессии с
     * `SessionCreateOpts.workspace` — `$root`/`$profile`/`$model` проекта.
     */
    projects?: boolean
    /**
     * Проекты пространства на диске (v1.35, spaces-spec §2): есть `workspace.repos`,
     * `SessionCreateOpts.project`/`skills`, `SessionInfo.project`.
     */
    repos?: boolean
    /** Запись реестра формой (v1.26): есть `workspace.create`/`update`. Удаления нет. */
    edit?: boolean
    /**
     * Рабочий каталог на сессию (v1.20): `SessionCreateOpts.cwd` и
     * `SessionMetaDoc.workspace.cwd` бэкенд применяет к тулам агента. `false`
     * или нет — каталог один на окружение, поле `cwd` в мете ни на что не
     * влияет (pi). Гейт — `canSessionCwd(caps)`.
     */
    perSession?: boolean
  }

  /**
   * Профили сессии (profiles-spec §4). Заявлена ⇔ у бэкенда есть
   * `profiles.list`; `switch` — можно ли менять профиль существующей сессии
   * (⇔ есть `profiles.set`). Выбор при создании — `SessionCreateOpts.profile`.
   * `edit` — конструктор профилей (profile-editor-spec §3): есть
   * `profiles.save`/`delete`/`duplicate`.
   */
  profiles?: { switch?: boolean; edit?: boolean }

  /**
   * Каталоги для конструктора профилей (profile-editor-spec §3): что можно
   * вписать в `ProfileDoc`. Каждый флаг ⇔ соответствующий метод `catalogs.*`.
   */
  catalogs?: { tools?: boolean; skills?: boolean; extensions?: boolean }

  /**
   * Скиллы сессии (v1.59, skills-spec §4): `session` — бэкенд читает
   * `SessionMetaDoc.skills` с режимами на каждом ходе (`linked` — в список скиллов и
   * каталог загрузки, `loaded` — `SKILL.md` в контекст), без рестарта сессии и стенда.
   * Патч одного ключа `skills` посреди рана — не `busy` (тул агента `skills_attach`).
   * Гейт — `canSessionSkills(caps)`.
   */
  skills?: { session?: boolean }

  // операции над историей
  /** `append` — `messages.append`: сообщение в ветку без рана (attachments-spec §2). */
  edits?: { edit?: boolean; delete?: boolean; hide?: boolean; append?: boolean }
  swipes?: boolean
  fork?: false | 'copy' | 'tree' // copy = fork-файл/копия; tree = полноценное дерево
  cancel?: boolean // отмена рана
  /**
   * Сообщение человека в идущий ран (v1.37): бэкенд умеет влить его в
   * ход, не дожидаясь конца (`steer`). Нет — UI держит сообщения в очереди и
   * отправляет обычным `run` после конца хода. Гейт — `canSteer(caps)`; у движка
   * хаба может отличаться (`EngineInfo.caps.steer`).
   */
  steer?: boolean
  /**
   * Бэкенд принимает `RunStartInput.client` (v1.43): пишет устройство и
   * время в мету реплики и штампует их модели. Нет — фронт поле не шлёт.
   */
  client?: boolean
  /**
   * Машины пользователя (v1.62): реестр `## $hosts` стенда (`$devices`) — имя, ОС,
   * `match` (короткий hostname машины). `here` — машина, с которой пришёл запрос
   * capabilities (адрес tailnet совпал с `$mcp.addr` хоста); через Cloudflare и ssh-проброс
   * его нет. Фронт: имя оболочки → `name` по `match`; догадка `mac`/`windows`/`linux` при
   * нескольких машинах этой ОС — чип «Это устройство».
   */
  devices?: { list: DeviceInfo[]; here?: string }
  /** Режимы рана (v1.10): `continue` — ран без user-сообщения. Гейт — `canContinue(caps)`. */
  run?: RunCapability
  /**
   * Impersonate бэкендом (v1.19): ран с `target: {kind: 'user'}` собирает промпт
   * «от лица» игрока (шаблон профиля, тайные поля персоны) и стримит реплику
   * НЕ записывая её в ленту. Гейт — `canImpersonate(caps)`. Нет — UI делает
   * impersonate сам (плагин `rp`, путь pi).
   */
  impersonate?: boolean

  /**
   * Отладка промпта (v1.23): флаг сессии `SessionMetaDoc.debugPrompt` —
   * перед вызовом провайдера бэкенд шлёт `ask` вида {@link PROMPT_DEBUG_ASK_KIND}
   * с собранным промптом и ждёт {@link PromptDebugAnswer}: как есть, правленое
   * (на один ран) или отмена. Нет — переключателя у фронта нет.
   */
  promptDebug?: boolean

  // интеракции
  ask?: string[] // поддерживаемые kinds: 'permission' | 'select' | 'text' | ...
  /**
   * Тулы (v1.16): `session` — бэкенд читает `SessionMetaDoc.tools` и отдаёт их
   * модели, вызов — `ask` вида `tool` (backend-nr-spec §6).
   */
  tools?: { session?: boolean }
  activity?: boolean // шлёт ли activity-события (суб-агенты, стадии)

  // контент
  /**
   * Вложения (attachments-spec §2): `attachments.put` + вложение отдельным
   * сообщением. `true` — без объявленных лимитов; объект — лимиты, которые UI
   * проверяет до загрузки (бэкенд всё равно отвергнет лишнее `bad_request`).
   * Нормализация обеих форм — `attachmentLimits(caps)`.
   */
  attachments?: boolean | AttachmentsCapability
  catalog?: boolean // /bots
  /**
   * Персоны сессии (personas-spec §3): `personas.list`, при `edit` — `save`.
   * `true` — прежняя форма (до v1.9), читается как `{}`; нормализация — `personasCapability(caps)`.
   */
  personas?: boolean | PersonasCapability
  sessionMeta?: boolean // документ меты сессии (SessionMetaDoc): пре/пост-промпт, notes
  /** Промпт сообщения (prompt-recipe-spec §2): есть `messages.prompt` — что ушло в модель для ответа. */
  prompts?: boolean
  collapsed?: boolean // collapsed-секции в истории
  checkpoints?: boolean

  /**
   * Сервисы плагинов (plugin-services-spec §2, v1.11): ключ — `plugin.id`,
   * значение — что сервис зарегистрировал. Заявлена ⇔ у бэкенда есть
   * `services`; `{}` — слой есть, сервисов нет. Гейт — `canService(caps, id, method)`.
   */
  services?: ServicesCapability

  /**
   * Скины как данные (v1.21, skin-spec §5): `skins.list`/`css`; `save` —
   * запись в рабочую область, `select` — текущий выбор пользователя (выжимка
   * агенту). Гейт — `canSkins(caps, op?)`.
   */
  skins?: SkinsCapability

  /**
   * Настройки по слоям (v1.40, settings-spec §3): хост собирает слои сессия …
   * стенд из файлов, `get/set/reset` — на хабе, одна на все движки. Гейт —
   * `canSettings(caps)`; без неё фронт держит слои «устройство» и «код».
   */
  settings?: SettingsCapability

  /**
   * Файл вне пространств (v1.41): `external` — есть `external.stat/read/list`
   * по абсолютному пути (`~` раскрывает бэкенд). Гейт — `canExternalFiles(caps)`.
   */
  files?: ExternalFilesCapability

  /**
   * Действия на машине бэкенда (v1.41): `host.reveal`/`host.open`, `apps` —
   * словарь приложений стенда. Только macOS. Гейт — `canHostOpen(caps, app?)`.
   */
  host?: HostCapability

  /**
   * Внешние плагины фронта (v1.24, core-boundary-spec §3): бандлы из `$plugins`
   * стенда, фронт грузит их до первого рендера. Нет — встроенные только.
   */
  plugins?: ExternalPluginInfo[]

  /**
   * Движки хаба (v1.29, users-spec §1): стенд — хаб, сессии исполняют движки
   * (`nr` встроенный, `acp`, `pi` — отдельные процессы за ним). Список проекта —
   * сессии всех движков (`SessionInfo.engine`), операции идут движку сессии.
   * Нет — бэкенд одномоторный, как раньше. Гейт — `canEngines(caps)`.
   */
  engines?: EnginesCapability

  /**
   * Пользователи стенда (v1.30, users-spec §2–5): кто вошёл (`me`), может ли
   * управлять пользователями (`admin` — owner стенда: `users.*`, режим списка
   * «все пользователи» — `sessions.list({all})`). Сессии приватны (`SessionInfo.owner`),
   * «поделиться» — `sessions.share`. Нет — стенд одного владельца, как раньше.
   * Гейт — `canUsers(caps)`, `isStandOwner(caps)`.
   */
  users?: UsersCapability

  /**
   * Операции над сессиями сверх базовых (v1.31). `attach` — подключиться к
   * идущему рану (`sessions.attach`, run-resume-spec §1): снимок незакрытого
   * хода и ждущих ask, потом живой поток; идущий ран виден в `SessionInfo.run`.
   * Гейт — `canAttachRun(caps)`. `live` (v1.38) — `sessions.live()`: идущие раны и
   * живые процессы агентов (`canListLive`); `release` — `sessions.release(id)`,
   * погасить процесс простаивающей сессии (`canReleaseSession`).
   * `archive` (v1.55) — архив и теги на мете (`sessionMeta.archived` / `archivedBy` /
   * `tags` через `meta.patch`), `sessions.list` архивные по умолчанию не отдаёт
   * (`SessionListOpts.archived`), ход в архивной возвращает её молча (`canArchiveSessions`).
   * `move` (v1.55) — `sessions.move(id, {workspace, project?})`: перенос в другое пространство
   * (`canMoveSession`).
   * `page` (v1.57) — `SessionListOpts.query/limit/offset`: поиск и окно списка на сервере
   * (`canPageSessions`).
   */
  sessions?: { attach?: boolean; live?: boolean; release?: boolean; archive?: boolean; move?: boolean; page?: boolean }

  /**
   * Лента окнами (v1.57): `history(id, {limit, before})` — хвост и догрузка вверх,
   * `HistoryPage.more/total`. Нет — `history` всегда целиком (`canPageHistory`).
   */
  history?: { page?: boolean }
}

/** Роль пользователя стенда (users-spec §2): owner — всё, member — свои проекты и движки. */
export type UserRole = 'owner' | 'member'

/** Способ входа (users-spec §2): Access-JWT, устройство по ссылке, локальный процесс. */
export type UserAuthMethod = 'access' | 'link' | 'local'

/** Пользователь стенда (v1.30). */
export interface UserInfo {
  id: string
  name: string
  role: UserRole
  /** Разрешённые движки (`$engines` записи); owner — все. */
  engines: string[]
  /** Способы входа записи (`$auth`). */
  auth?: UserAuthMethod[]
  /** Email Access (`$auth.access`) — только в списке для админа. */
  email?: string
  /** Сколько устройств вошло по ссылке (список для админа). */
  devices?: number
  /** Личный проект (`user-<id>`). */
  home?: string
}

/** capability `users` (v1.30). */
export interface UsersCapability {
  /** Кто вошёл и чем (`via`). */
  me: UserInfo & { via: UserAuthMethod }
  /** Owner стенда: `users.*`, `sessions.list({all})`. */
  admin?: boolean
}

/** Устройство, вошедшее по ссылке (users-spec §2: `devices.json`). */
export interface UserDevice {
  id: string
  /** User-Agent первого входа, укороченный. */
  name?: string
  createdAt: string
  lastSeenAt?: string
  /** Отозвано — кука больше не пускает. */
  revoked?: boolean
}

/**
 * Одноразовая ссылка входа (users-spec §2): `join` — приглашение (7 дней),
 * `login` — новое устройство (24 ч). `path` — хэш-маршрут фронта
 * (`#/join/<токен>`), токен на сервере — только хэшем.
 */
export interface UserLink {
  kind: 'join' | 'login'
  token: string
  path: string
  expiresAt: string
}

/** Вход `users.create`. */
export interface UserCreateInput {
  id: string
  name?: string
  role?: UserRole
  engines?: string[]
  /** Email Access — вход через Cloudflare Access вместо ссылки. */
  email?: string
}

/** Движок хаба (v1.29). */
export interface EngineInfo {
  /** `nr` | `acp` | `pi` | … — то, что стоит в `SessionInfo.engine`. */
  id: string
  /** Подпись в UI («Claude Code»); нет — `id`. */
  name?: string
  /** Встроенный движок хаба (его capabilities — capabilities стенда). */
  local?: boolean
  /** Достучался ли хаб до движка на момент ответа. */
  available: boolean
  /**
   * Сессию можно перевести на этот движок (`sessions.setEngine`, v1.31): у
   * движка есть каталог `.mds`. `false` — в «сменить исполнителя» его нет
   * (pi без `.mds`); нет поля — как `engines.switch`.
   */
  switch?: boolean
  /**
   * Новых чатов на движке не заводят (v1.61): служебный движок — хаб задач,
   * его сессии создаёт хост задач. В выборе движка новой сессии и в «сменить
   * исполнителя» его нет; сессии видны, открываются и продолжаются как у всех.
   * Нет поля — можно.
   */
  create?: false
  /**
   * Где capabilities движка отличаются от стенда (v1.33, П-8): лимит вложений,
   * `models` (thinking), `profiles`, … — сессии этого движка гейтятся ими
   * (`engineCaps`). Нет — как у стенда. У встроенного нет: его — сам стенд.
   */
  caps?: EngineCapsOverride
}

/**
 * Поля capabilities, которыми движок хаба отличается от стенда (v1.33).
 * Сервисы и плагины — общие: хаб отдаёт их объединением (`services`, `plugins`).
 */
export type EngineCapsOverride = Partial<Pick<Capabilities, 'attachments' | 'models' | 'profiles' | 'edits' | 'swipes' | 'fork' | 'personas' | 'sessionMeta' | 'prompts' | 'impersonate' | 'steer'>>

/** capability `engines` (v1.29). */
export interface EnginesCapability {
  list: EngineInfo[]
  /** Движок новой сессии без выбора: `$engine` стенда, иначе встроенный. Проект может переопределить (`WorkspaceProject.engine`). */
  default: string
  /** Есть `sessions.setEngine` — смена исполнителя сессии (лента та же). */
  switch?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// session-meta-spec §2 — документ меты сессии (capability `sessionMeta`)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Как `pre` соотносится со штатным system prompt окружения (§7).
 *
 * `append` (default) — `pre` приклеивается к штатному промпту; `replace` — `pre`
 * становится system prompt целиком, штатный (coding assistant, список тулов) не
 * отправляется вовсе. `replace` — это «таверна»: чат с персонажем, которому
 * инструкции кодового агента не нужны и мешают.
 */
export type SessionPromptMode = 'append' | 'replace'

/**
 * Промпт сессии: то, что едет в модель вокруг истории.
 *
 * `pre` — приклеивается к system prompt В НАЧАЛО (перед AGENTS.md и прочим):
 * свойства чата важнее окружения, иначе окружение их переопределит.
 * `post` — инструкция ПОСЛЕ истории: инжектится сообщением перед каждым раном,
 * поэтому не тонет в длинной переписке (в отличие от system prompt).
 * `mode` — append/replace для `pre`; на `post` не влияет (§7).
 */
export interface SessionMetaPrompt {
  pre?: string
  post?: string
  /** Default `append`; ключа нет — дефолт окружения (§7). */
  mode?: SessionPromptMode
}

/**
 * Документ меты сессии (session-meta-spec §2).
 *
 * Живёт в файле сессии, а не в окружении: сессия переносима, промпт едет вместе
 * с историей. Открыт (`[key: string]: unknown`) намеренно — плагины и бэкенды
 * кладут своё, провод их ключи не знает и не трогает.
 */
export interface SessionMetaDoc {
  prompt?: SessionMetaPrompt
  /** Заметки автора; в модель НЕ идут. */
  notes?: string
  /**
   * READ-ONLY (§7): system prompt, реально ушедший в модель на последнем ране.
   *
   * Не часть документа, а его наблюдаемое следствие: пишет его тот, кто ран
   * собирает (pi-расширение), отдаёт `meta.get`, а `meta.patch` его молча
   * игнорирует — иначе клиент, отправивший назад то, что прочитал, подменил бы
   * факт («что ушло») своим желанием («что уйдёт»).
   */
  effectivePrompt?: string
  /**
   * Тулы сессии (backend-nr-spec §6, v1.16): объявлены артефактом или вкладкой,
   * исполняет их фронт. Бэкенд с `tools.session` отдаёт их модели, пока у тула
   * есть живой исполнитель; вызов — `ask` вида `tool` (см. {@link SessionToolCall}).
   */
  tools?: SessionToolDecl[]
  /**
   * Рабочее пространство сессии (v1.20, capability `workspace.perSession`):
   * `cwd` — абсолютный каталог, где работают тулы агента этой сессии. Нет —
   * каталог окружения. Ставится `SessionCreateOpts.cwd` или патчем меты.
   */
  workspace?: SessionWorkspace
  /**
   * Скиллы сессии (v1.59, skills-spec §4). Строка — скилл старта (v1.35,
   * `SessionCreateOpts.skills`): его `SKILL.md` в префиксе после проекта — то же, что
   * `{name, mode: 'loaded'}`. `linked` — скилл доступен: в списке скиллов сессии, агент
   * грузит его сам (`skill_load` / `skill`); `loaded` — `SKILL.md` в контексте каждого
   * хода, чистка не трогает. Читать — `sessionSkills(meta)`. Патч — список целиком.
   */
  skills?: Array<string | SessionSkill>
  /**
   * Снимок страницы (v1.20): виджет `<nr-chat>` (`onContext`) кладёт сюда
   * состояние встраивающей страницы перед ходом; backend-nr вставляет его
   * инъекцией перед последней репликой пользователя (источник рецепта
   * `page.context`). Строка — как есть, объект — JSON. `null` в патче — снять.
   */
  pageContext?: unknown
  /**
   * Отладка промпта (v1.23, capability `promptDebug`): `true` — каждый ран
   * сессии перед провайдером спрашивает фронт (`ask` вида `prompt`). Флаг сессии,
   * в модель не идёт.
   */
  debugPrompt?: boolean
  /**
   * Управляемый контекст (v1.32, front-context-spec §4): id вызовов тулов
   * (`callId` ленты). `pinned`/`dropped` пишет фронт патчем (объект целиком),
   * `cleared` — бэкенд, не теряя первых двух. См. {@link SessionContextMeta}.
   */
  context?: SessionContextMeta
  /**
   * Объекты в контексте сессии (v1.53, objects-spec §15.1 п.5): карточка слота, приёмка — со
   * ссылкой и хэшем полей. Подача — движком (nr — блок system, ACP — префикс), источник блока —
   * `object:<type>/<id>`. Пишет `sessions.create` (`SessionCreateOpts.objects`) или патч меты.
   */
  objects?: SessionObjectRef[]
  /**
   * Копия агента в сессии (v1.53): что сессия держит своим поверх шаблона агента —
   * голос, карточка; ссылка `source` на шаблон с хэшем полей на момент взятия («отличается от
   * шаблона», «обновить из шаблона» по полям). Модель — `models.set`, пре/пост-промпт —
   * `prompt`, карточка — `card` меты (как раньше): копия их не дублирует.
   */
  agent?: SessionAgentCopy
  [key: string]: unknown
}

/** `SessionMetaDoc.agent` (v1.53): поля агента, которые сессия держит своими. */
export interface SessionAgentCopy {
  /** Шаблон агента (`{type: 'agent', id, hash}`). */
  source?: { type: string; id: string; hash?: string }
  /** Голос агента в этой сессии (поверх `voice` шаблона; клиент читает его первым). */
  voice?: { mode?: 'smart' | 'verbatim'; refine?: 'auto' | 'always' | 'off'; emotions?: 'off' | 'emoji' | 'tags'; say?: string }
  [key: string]: unknown
}

/**
 * `SessionMetaDoc.context` (v1.32, front-context-spec §4).
 *
 * - `pinned` — заморожены: чистка/компакция их результаты не трогает (nr —
 *   переживают компакцию дословно; ACP — prune не срезает). Пишут фронт (📌) и
 *   тул агента `context_pin`.
 * - `dropped` — выкинуты пользователем: в промпт результат идёт заглушкой с
 *   адресом ({@link clearedStub}), пара tool_use/tool_result цела. `pinned`
 *   сильнее: id в обоих списках — не выкидывается.
 * - `cleared` — ПИШЕТ БЭКЕНД: id, чьи результаты сейчас НЕ в контексте модели
 *   целиком (заглушены, срезаны чисткой, ушли в саммари компакции). Фронт его
 *   только читает (метка «срезано» в ленте).
 *
 * Патч меты — объект целиком (shallow merge по верхним ключам): пишущий
 * сохраняет чужие поля.
 */
export interface SessionContextMeta {
  pinned?: string[]
  dropped?: string[]
  cleared?: string[]
}

/** `SessionMetaDoc.workspace` (v1.20). */
export interface SessionWorkspace {
  /** Абсолютный путь рабочего каталога сессии. */
  cwd?: string
  /**
   * Проект сессии (v1.26, projects-spec §2) — id реестра; нет — `default`
   * (сессии до проектов). Пишет бэкенд при `sessions.create`.
   */
  project?: string
}

/** Декларация тула сессии (`SessionMetaDoc.tools`). */
export interface SessionToolDecl {
  /** Имя для модели — уникально в реестре рана (с тулами профиля и сервисов). */
  name: string
  description?: string
  /** JSON Schema аргументов (`type: 'object'`). Нет — без аргументов. */
  schema?: Record<string, unknown>
  /** Кто исполняет. v1 — только фронт. */
  executor?: 'frontend'
  /** Артефакт-владелец: без живого артефакта тул в контекст не попадает. */
  artifactId?: string
}

/**
 * Payload `ask` вида `tool` (v1.16): бэкенд просит фронт исполнить тул сессии.
 * Ответ (`respond`) — строка (текст результата) или `{ text, data?, error? }`.
 */
export interface SessionToolCall {
  callId: string
  name: string
  args: unknown
  artifactId?: string
}

/** Ask-kind отладки промпта (v1.23): окно «что уйдёт модели» перед провайдером. */
export const PROMPT_DEBUG_ASK_KIND = 'prompt'

/** Ключ флага в мете сессии (`SessionMetaDoc.debugPrompt: true`). */
export const PROMPT_DEBUG_META_KEY = 'debugPrompt'

/**
 * Payload `ask` вида `prompt` (v1.23): собранный промпт рана до провайдера.
 * `mds` — prompt.mds билдера (`%meta` + узлы), `json` — что уйдёт провайдеру
 * (`{system, messages}`), `model` — id модели, `tokens` — оценка, `run` — вид рана.
 */
export interface PromptDebugRequest {
  mds: string
  json: { system: string; messages: unknown[] }
  model: string
  tokens?: number
  run?: 'turn' | 'impersonate'
  /**
   * Лорбук хода (v1.46): каждая запись — книга/подача/имя (`source`,
   * `lorebook:<источник>/<подача>: <имя>`), причина с баллом, позицией в окне
   * скана, вариантом и якорем (`reason`); не вошедшие и предупреждения — тоже.
   */
  lore?: Array<{ source: string; reason?: string; role: string }>
  /** Нераскрытые макросы карты (`{{roll:…}}`, опечатки) с местом: `system` / `history` / `tail` (v1.46). */
  macros?: Array<{ macro: string; place: 'system' | 'history' | 'tail' }>
  /** Предупреждения сборки (v1.67, §2): нестабильный блок наверху и т. п. */
  warnings?: string[]
}

/**
 * Ответ на `prompt`: `send` — как есть; `send` с `mds` — правленый .mds (парсится
 * обратно в сообщения), с `json` — правленые `{system, messages}` как есть; оба
 * сразу — ошибка. `cancel` — ран отменяется. Правка — на один ран, в историю и
 * шаблон не пишется.
 */
export type PromptDebugAnswer =
  | { action: 'send'; mds?: string; json?: { system?: string; messages: unknown[] } }
  | { action: 'cancel' }

/** Ask-kind апрува вызова тула (v1.17, tools-spec §7). */
export const TOOL_APPROVAL_ASK_KIND = 'tool_approval'

/** Что показать в карточке апрува: диф правки, команда с каталогом или текст. */
export type ToolApprovalPreview =
  | { kind: 'diff'; diff: string; path?: string }
  | { kind: 'command'; command: string; cwd: string }
  | { kind: 'text'; text: string }

/**
 * Payload `ask` вида `tool_approval` (v1.17): тул с политикой `ask` ждёт
 * решения пользователя. Ответ (`respond`) — {@link ToolApprovalAnswer}.
 */
export interface ToolApprovalRequest {
  callId: string
  name: string
  args: unknown
  /** Строка для заголовка карточки: «exec: npm test», «edit a.ts». */
  title: string
  preview?: ToolApprovalPreview
}

export type ToolApprovalDecision = 'allow' | 'allow_session' | 'deny'

/** Ответ на `tool_approval`: решение или решение с причиной (её видит модель). */
export type ToolApprovalAnswer = ToolApprovalDecision | { decision: ToolApprovalDecision; reason?: string }

/**
 * Патч меты (`meta.patch`): shallow merge по верхним ключам, `prompt` мержится
 * по своим, `null` удаляет ключ.
 *
 * Отдельный тип, а не `Partial<SessionMetaDoc>`: удаление ключа на проводе —
 * это `null`, а `Partial` его не пропускает (`prompt.pre` объявлен `string`).
 * Семантика ровно та, что в §2 спеки; форма — та, которую можно послать в JSON.
 *
 * `effectivePrompt` в патче не объявлен и `mergeSessionMeta` его выбрасывает:
 * ключ read-only (§7).
 */
export interface SessionMetaPatch {
  prompt?: { pre?: string | null; post?: string | null; mode?: SessionPromptMode | null } | null
  notes?: string | null
  [key: string]: unknown
}

// ────────────────────────────────────────────────────────────────────────────
// §4 Envelope
// ────────────────────────────────────────────────────────────────────────────

export interface Envelope<T> {
  ok: boolean
  result?: T
  error?: string
  version?: string // sync-токен сессии (§8.x)
}

// ────────────────────────────────────────────────────────────────────────────
// §5.1 Run start
// ────────────────────────────────────────────────────────────────────────────

/**
 * Вход рана. Ни `userMessage`, ни `regenerate` — «продолжай» (§5.1): только под
 * capability `run.continue` (v1.10), иначе `not_supported` до `run_start`.
 */
export interface RunStartInput {
  userMessage?: string | Part[] // append user-сообщения перед генерацией
  /**
   * Переменные пресета на этот ран (v1.67, §5, чип): `{language: 'ru', person: '1'}` —
   * бэкенд пишет их в `meta.vars` реплики игрока; верхний слой каскада (чип → персона → бот → агент).
   */
  vars?: Record<string, string>
  /** Чей ход (personas-spec §3): id `char`-персоны. Без него — активная char-персона сессии. */
  personaId?: string
  regenerate?: { messageId: string } // пересгенерировать: бэкенд сносит ран целиком
  /**
   * Типизированное действие хода (v1.13): сегменты, собранные UI (кнопки,
   * режимы композера), — схема бэкенда (у nr-play/gamentic — их `Segment`).
   * Ядро и транспорт не трактуют, прокидывают как есть. С `segments` без
   * `userMessage` ран законен и без `run.continue`: вход есть.
   */
  segments?: unknown[]
  /**
   * Пожелание к ходу (v1.13): ремарка рассказчику, не реплика — в ленту не
   * пишется. С пустым входом — «продолжай» с пожеланием (гейт `run.continue`).
   */
  wish?: string
  /**
   * Команда вместо хода (v1.18): `{name: 'compact', args?: 'фокус'}` — `/compact`
   * композера. Ран команды не пишет user-сообщение и не требует ответа модели;
   * что он пишет в ленту — дело команды (`compact` — узел компакции,
   * {@link COMPACTION_PART_HINT}). Гейт — `canCommand(caps, name)`.
   */
  command?: RunCommand
  /**
   * Кто отвечает этим раном (v1.19). Нет — обычный ход (`personaId` — чья
   * реплика). `{kind: 'char', personaId?}` — то же, что `personaId`.
   * `{kind: 'user'}` — impersonate (гейт `impersonate`): `userMessage` — не
   * реплика, а `{{input}}` шаблона (что сказать/сделать), в ленту не пишется;
   * ответ — события сообщения `role: 'user'` (`personaId` — персона игрока),
   * которое НЕ записано: `history` его не вернёт, `run_end.version` тот же.
   * Промпт — кадр `activity` {@link PROMPT_ACTIVITY_KIND}.
   */
  target?: ParticipantRef
  /**
   * Безголовый ран (v1.36, task-session-spec §4): начал хост (задача), человека у
   * сессии нет. Запрос подтверждения тула ждёт `$tool_timeout` и отклоняется с
   * текстом модели — ран не виснет. Нет — ран человека, апрув ждёт ответа.
   */
  headless?: boolean
  /**
   * Откуда пишет человек (v1.43): устройство, место, пояс. Бэкенд кладёт
   * в мету user-сообщения (`meta.client`) рядом с `createdAt`; из них — штамп
   * контекста модели (`nr-chat-store/assembly` `contextStamps`). Нет — без устройства.
   */
  client?: {
    device?: string
    place?: string
    tz?: string
    /**
     * `device` — догадка по браузеру (v1.62): хаб вправе заменить её именем машины
     * по адресу tailnet и снимает флаг до бэкенда. Имя из настройки или оболочки — без флага.
     */
    guess?: boolean
  }
  /**
   * Направление хода игрока (v1.47, cyoa-spec §3): намерение, ось, тон,
   * длина. С `target: {kind: 'user'}` (impersonate) — вход шаблона: что игрок
   * пытается сделать, тон и длина на этот ран. С `userMessage` — реплика написана
   * по этому направлению: бэкенд пишет его в `meta.direction` реплики, а
   * `choice` — `picked` у варианта ответа бота (`meta.choices`). Не `wish`: тот —
   * ремарка рассказчику.
   */
  direction?: RunDirection
}

/** Ось варианта хода (cyoa-spec §2): осторожный / дерзкий / социальный / не по сценарию. */
export type ChoiceAxis = 'cautious' | 'bold' | 'social' | 'offscript'

/** Допустимые оси вариантов; ось вне списка — вариант отброшен. */
export const CHOICE_AXES: readonly ChoiceAxis[] = ['cautious', 'bold', 'social', 'offscript']

/** Длина реплики impersonate (cyoa-spec §3.1): коротко / как обычно / развёрнуто. */
export type DirectionLength = 'short' | 'normal' | 'long'

/** Направление хода игрока (v1.47): `RunStartInput.direction`, `meta.direction` реплики. */
export interface RunDirection {
  /**
   * Намерение — не реплика и не исход: «попытаться отвлечь стражника разговором».
   * Пусто — только тон/длина (кнопка impersonate с чипами).
   */
  intent: string
  axis?: ChoiceAxis
  /** Тон на один ран: по значению с каждой оси (эмоция, регистр, темп). */
  tone?: string[]
  length?: DirectionLength
  /** Из какого варианта: ответ бота и индекс в его `meta.choices.choices`. */
  choice?: { messageId: string; index: number }
}

/**
 * Итог `steer` (v1.37). `injected` — сообщение влито в идущий ход: оно
 * приедет в потоке рана user-сообщением `meta.steered` на месте, где влилось.
 * `idle` — ран уже кончился (или не тот): ничего не сделано, UI шлёт сообщение
 * обычным `run`.
 */
export interface SteerResult {
  outcome: 'injected' | 'idle'
}

/**
 * Участник диалога как адресат хода (v1.19): игрок (`user`) или собеседник
 * (`char`, конкретная персона — `personaId`). Один механизм на impersonate и
 * адресата в группе.
 */
export type ParticipantRef = { kind: 'user' } | { kind: 'char'; personaId?: string }

/** Команда рана (v1.18). */
export interface RunCommand {
  name: string
  /** Всё после имени команды, как набрано (`/compact про тесты` → `про тесты`). */
  args?: string
  /** Параметры команды объектом (v1.47): у `choices`/`editor` — {@link SideCommandOptions}. */
  options?: Record<string, unknown>
}

/**
 * Служебные команды CYOA (v1.47, cyoa-spec §2, §4): варианты хода и
 * заметки редактора к ответу бота `options.messageId`. Ран команды не пишет
 * сообщений и идёт **параллельно** ходу той же сессии (busy не берёт): итог —
 * патч меты ответа бота (`meta.choices` / `meta.editorNotes`), он же приезжает
 * кадром `activity` {@link NODE_META_ACTIVITY_KIND}. Гейт — `canCommand(caps, name)`.
 */
export const CHOICES_COMMAND = 'choices'
export const EDITOR_COMMAND = 'editor'

/**
 * Команды, что идут параллельно ходу той же сессии (v1.47): транспорт, attach и
 * хаб не держат на них замок «один ран на сессию» и не регистрируют их живым раном.
 */
export const PARALLEL_COMMANDS: readonly string[] = [CHOICES_COMMAND, EDITOR_COMMAND, 'greeting']

/**
 * Обработчик гритинга (v1.70, bot-assembly-spec §6): служебная параллельная команда.
 * `options: {messageId, vars?, model?, force?}` — гритинг (первый ответ бота) под значения
 * переменных пресета (язык, лицо, время). Рукописный гритинг автора с теми же `vars`
 * побеждает (свайп на него); иначе вариант — сиблинг оригинала с {@link GREETING_GENERATED_META},
 * кэшируется хостом (второй запуск — без модели), оригинал не подменяется.
 * Ран пишет узел и делает его активным; кадр `activity` `node_meta` `{id, patch}`.
 */
export const GREETING_COMMAND = 'greeting'

/** Мета сгенерированного варианта гритинга: `{of: индекс оригинала, vars, model?, cached?}`. */
export const GREETING_GENERATED_META = 'generated'

export interface GreetingGeneratedMeta {
  of: number
  vars: Record<string, string>
  model?: string
  cached?: boolean
}

/** Ран — служебная параллельная команда ({@link PARALLEL_COMMANDS})? */
export function isParallelRun(input: Pick<RunStartInput, 'command'> | undefined): boolean {
  const name = input?.command?.name
  return typeof name === 'string' && PARALLEL_COMMANDS.includes(name)
}

/** `RunCommand.options` служебных команд (v1.47). */
export interface SideCommandOptions {
  /** Ответ бота, к которому варианты/заметки; путь до него — контекст. */
  messageId: string
  /** Модель вызова; нет — модель сессии. */
  model?: string
  /** `choices`: сколько вариантов (3–4). */
  count?: number
  /** `choices`: откровенные варианты — `allow` / `offer` (хотя бы один) / `never`. */
  explicit?: 'allow' | 'offer' | 'never'
  /** `choices`: попросить модель выбрать вариант (`pick`, автоход `auto.pick: model`). */
  pick?: boolean
  /** `editor`: чего избегать и что любить (свободный текст сессии). */
  avoid?: string
  prefer?: string
}

/**
 * Кадр `activity` (v1.47): бэкенд пропатчил мету узла ленты — `{id, patch}`
 * (мелкий merge, `null` снимает ключ). Шлёт ран служебной команды.
 */
export const NODE_META_ACTIVITY_KIND = 'node_meta'

/** Payload кадра {@link NODE_META_ACTIVITY_KIND}. */
export interface NodeMetaActivity {
  id: string
  patch: Record<string, unknown>
}

/** Команда компакции контекста (v1.18). */
export const COMPACT_COMMAND = 'compact'

/**
 * `meta.hint` custom-части узла компакции (v1.18): узел `role: 'system'`, часть
 * `{type: 'custom', text: summary, data: CompactionPartData, meta: {hint}}` —
 * так его отдают и pi-драйвер стора (запись `compaction` pi), и backend-pi.
 * Сообщения до `firstKeptEntryId` модель больше не видит — вместо них summary.
 */
export const COMPACTION_PART_HINT = 'pi.compaction'

/** `data` части узла компакции — тело записи `compaction` pi. */
export interface CompactionPartData {
  summary: string
  /** id первого сообщения, оставшегося в контексте после компакции. */
  firstKeptEntryId: string
  /** Оценка токенов контекста до компакции. */
  tokensBefore: number
  details?: unknown
  fromHook?: boolean
}

// ────────────────────────────────────────────────────────────────────────────
// §5.2 RunEvent
// ────────────────────────────────────────────────────────────────────────────

export interface RunStartEvent {
  type: 'run_start'
  runId: string
}

export interface MessageStartEvent {
  type: 'message_start'
  runId: string
  /**
   * `meta` (v1.15) — то, что известно до первого слова: `personaId` (кто
   * говорит), `speech` (озвучку можно начинать с первого предложения). Итог —
   * по-прежнему `message_end.message.meta`.
   */
  message: { id: string; role: string; name?: string; meta?: MessageMeta }
}

export interface PartStartEvent {
  type: 'part_start'
  runId: string
  messageId: string
  part: number
  partType: Part['type']
  meta?: Record<string, unknown>
}

export interface PartDeltaEvent {
  type: 'part_delta'
  runId: string
  messageId: string
  part: number
  delta: string
  mode?: 'append' | 'replace'
}

export interface PartEndEvent {
  type: 'part_end'
  runId: string
  messageId: string
  part: number
  payload?: Part // финальный part (для tool_use — с input, и т.п.)
}

export interface MessageEndEvent {
  type: 'message_end'
  runId: string
  message: Message // финальный DTO
}

export interface AskEvent {
  type: 'ask'
  runId: string
  askId: string
  kind: string
  payload: unknown
}

/**
 * Ask закрыт (v1.31, run-resume-spec §1): ответ пришёл — от любого подписчика
 * рана (`respond`) — или бэкенд снял вопрос сам. Клиент гасит карточку `askId`;
 * старый клиент событие игнорирует и гасит карточку на `run_end`, как раньше.
 */
export interface AskEndEvent {
  type: 'ask_end'
  runId: string
  askId: string
}

export interface ActivityEvent {
  type: 'activity'
  runId: string
  kind: string
  payload?: unknown
  // эфемерный статус рана: суб-агенты, стадии, прогресс. Не персистится, UI вправе игнорировать
}

export interface SessionUpdateEvent {
  type: 'session_update'
  runId: string
  fields?: string[]
  // стейт сессии изменился посреди рана (game state, meta). Клиент перечитывает sessionMeta
}

export interface RunEndEvent {
  type: 'run_end'
  runId: string
  status: 'done' | 'cancelled' | 'error'
  error?: { message: string; code?: string }
  /** Итог рана: вход/выход/кэш — сумма ходов, `context` — последний (v1.25). */
  usage?: Usage
  version: string // новый sync-токен сессии
}

/** Закрытое ядро событий рана (§5.2). */
export type RunEvent =
  | RunStartEvent
  | MessageStartEvent
  | PartStartEvent
  | PartDeltaEvent
  | PartEndEvent
  | MessageEndEvent
  | AskEvent
  | AskEndEvent
  | ActivityEvent
  | SessionUpdateEvent
  | RunEndEvent

/** Литеральные значения `type` для известных RunEvent. */
export type KnownRunEventType = RunEvent['type']

/**
 * Событие рана неизвестного типа (§5.2: «События неизвестного типа клиент
 * игнорирует»). Приезжает с провода при graceful degradation.
 */
export interface UnknownRunEvent {
  type: string
  runId?: string
  [k: string]: unknown
}

/** Любое событие рана, пришедшее с провода: известное либо opaque. */
export type AnyRunEvent = RunEvent | UnknownRunEvent

// ────────────────────────────────────────────────────────────────────────────
// §5.3 Ask kinds ядра
// ────────────────────────────────────────────────────────────────────────────

/** Kinds ядра ask (§5.3). Список расширяем — заявленные kinds в capabilities.ask. */
export type CoreAskKind = 'permission' | 'select' | 'text'
