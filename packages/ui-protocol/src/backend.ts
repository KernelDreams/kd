/**
 * nr-ui-protocol — ProtocolBackend: интерфейс бэкенда протокола (шов).
 *
 * Канон: nr-ui-protocol.dev/specs/backends-spec.md §2.
 *
 * Бэкенд — объект, не процесс. Реализации (pi, nr-engine, opencode) живут в
 * своих пакетах; транспорт (serveBackend / createHttpBackend) — в
 * @kerneldreams/backend-http. Здесь только типы + класс ошибки: инвариант пакета
 * (никакого транспорта, zero-dep) не нарушается.
 */

import type { SessionObjectRef } from './objects.js'
import type {
  AnyRunEvent,
  AttachmentContent,
  Capabilities,
  CatalogExtension,
  CatalogSkill,
  CatalogTool,
  FileContent,
  FileEncoding,
  FileEntry,
  FilePart,
  FileSearchHit,
  FileSearchQuery,
  ImagePart,
  Message,
  ModelInfo,
  Part,
  Persona,
  PersonasDoc,
  ProfileDoc,
  ProfileInfo,
  PromptView,
  RunStartInput,
  RunDirection,
  SteerResult,
  SessionInfo,
  SessionShare,
  SessionMetaDoc,
  SessionMetaPatch,
  SessionModel,
  ProjectInfo,
  WorkspaceInfo,
  WorkspaceProject,
  WorkspaceUpdateEvent,
  UserCreateInput,
  UserDevice,
  UserInfo,
  UserLink,
} from './types.js'
import type { ExternalFilesOps, HostOps } from './external.js'
import type { DEFAULT_FILE_READ_MAX_BYTES, compileFileSearch } from './files.js'
import type { ServiceEvent, ServicesCapability } from './services.js'
import type { SettingsOps } from './settings.js'
import type { SkinsOps } from './skins.js'
import type { PluginsOps } from './plugins.js'

// ────────────────────────────────────────────────────────────────────────────
// Вспомогательные DTO операций (§4 спеки протокола)
// ────────────────────────────────────────────────────────────────────────────

/** Вход `sessions.create` (§4.1 спеки протокола). */
export interface SessionCreateOpts {
  botId?: string
  greetingId?: string
  /** personas-spec §5: id `user`-персоны новой сессии — пишется как `userId` документа персон. */
  personaId?: string
  title?: string
  /** capability: models — модель новой сессии; без неё дефолт бэкенда (models-spec §3). */
  model?: SessionModel
  /**
   * capability: profiles — профиль новой сессии (profiles-spec §4): `ProfileInfo.id`
   * каталога либо документ, который встраивается в сессию (bot-as-session-spec §1:
   * `SessionInfo.profile` станет `'inline'`, документ — `profileDoc`; каталог не
   * трогается). Без поля — `default`.
   *
   * v1.34 (agents-spec §3): документ каталога (`source` есть, `id` не `inline`) — тот же агент
   * из общего каталога, которого нет у движка: `SessionInfo.profile` — этот id,
   * документ встроен в сессию (шаблон `template` читается с диска на каждом ране).
   */
  profile?: string | ProfileDoc
  /**
   * capability: workspace.perSession (v1.20) — рабочий каталог сессии, абсолютный
   * путь: тулы агента (файлы, exec) работают в нём, а не в каталоге окружения.
   * Пишется в мету сессии (`SessionMetaDoc.workspace.cwd`); сменить потом —
   * `meta.patch({workspace: {cwd}})`. Бэкенд без capability — `not_supported`
   * до создания (сессия-сирота не появляется).
   */
  cwd?: string
  /**
   * capability: workspace.projects (v1.26) — проект новой сессии (`WorkspaceInfo.id`):
   * его `$root` — `cwd`, `$profile`/`$model` — если не переданы явно. Нет — текущий
   * проект бэкенда. Неизвестный — `not_found` до создания.
   */
  workspace?: string
  /**
   * capability: workspace.repos (v1.35, spaces-spec §3) — проект пространства
   * (`ProjectInfo.id` из `workspace.repos`): cwd — его корень, контекст-пакет — в
   * префиксе после агента, каталог пакета — к `additionalDirectories`. Пишется в
   * `SessionInfo.project`. Неизвестный — `not_found` до создания.
   */
  project?: string
  /**
   * capability: workspace.repos (v1.35) — доп. скиллы старта: `SKILL.md` каждого — в
   * префиксе после проекта (`SessionMetaDoc.skills`).
   */
  skills?: string[]
  /**
   * capability: engines (v1.29) — движок новой сессии (`EngineInfo.id`). Нет —
   * `engine` агента (`ProfileInfo.engine`, v1.34), `$engine` проекта, затем `engines.default`. Неизвестный — `bad_request`,
   * недоступный — ошибка до создания.
   */
  engine?: string
  /**
   * Объекты в контекст новой сессии (v1.53, objects-spec §15.1 п.5): «Обсудить» у карточки. Бэкенд
   * кладёт их в `sessionMeta.objects` (с `hash`, `title`, `text`, если клиент их дал).
   */
  objects?: SessionObjectRef[]
}

/** Вход `sessions.list` (v1.26). */
export interface SessionListOpts {
  /**
   * capability: workspace.projects — только сессии проекта (`SessionInfo.workspace`;
   * сессия без пометки — `default`). Нет — все, как раньше.
   */
  workspace?: string
  /**
   * capability: engines (v1.29) — перечитать хранилища движков (сессии, созданные
   * на движке мимо хаба). Без него хаб отдаёт свой индекс.
   */
  refresh?: boolean
  /**
   * capability: users.admin (v1.30) — сессии всех пользователей (режим списка
   * «все пользователи», `SessionInfo.owner` — автор). Без него — свои и
   * расшаренные.
   */
  all?: boolean
  /**
   * capability: sessions.archive (v1.55) — архивные сессии (`SessionInfo.archived` —
   * дата): нет / `false` — без них, `true` — все, `'only'` — только архивные.
   */
  archived?: boolean | 'only'
  /**
   * capability: sessions.page (v1.57) — поиск на сервере: слова через пробел,
   * каждое — подстрокой без регистра в названии, первых словах, боте, тегах, id; `#тег` — тег.
   */
  query?: string
  /** capability: sessions.page (v1.57) — не больше стольких строк (после фильтра). */
  limit?: number
  /** capability: sessions.page (v1.57) — пропустить столько строк от начала (порядок — последняя активность). */
  offset?: number
}

/**
 * Окно ленты (v1.57, capability `history.page`): хвост по `limit`, догрузка вверх —
 * `before` = id первого загруженного сообщения. Без опций — вся лента, как раньше.
 */
export interface HistoryOpts {
  /** Не больше стольких сообщений с конца окна. */
  limit?: number
  /** Сообщения строго до этого id (линия текущего пути). Нет такого — с конца. */
  before?: string
}

/**
 * Перенос сессии в другое пространство (v1.55): `workspace` — id пространства
 * (алиас `$aliases` бэкенд переписывает на настоящее id); `project` — проект в целевом:
 * нет такого — сбрасывается. Агент и лента не меняются.
 */
export interface SessionMoveInput {
  workspace: string
  project?: string | null
}

/**
 * Вход `profiles.list`/`profiles.get` (v1.27): каталог глазами проекта
 * клиента. У бэкенда, чьи профили зависят от проекта (ACP-стенд: слепки
 * `<dir>/profiles/` проекта поверх стенда), — каталог проекта `workspace`, а не
 * того, куда последним переключился процесс; две вкладки в разных проектах
 * видят каждая свой. Нет — текущий проект бэкенда, как раньше.
 */
export interface ProfilesListOpts {
  workspace?: string
  /**
   * Хаб (v1.33, П-7): профили движка (`EngineInfo.id`) — у ACP свои слепки.
   * Нет — профили стенда (встроенного движка).
   */
  engine?: string
}

/**
 * Патч `messages.edit` (§4.2 спеки протокола): либо полный `parts`, либо
 * шорткат `text` (заменить text-части одним text-part — семантика бэкенда).
 * `ifHash` — optimistic concurrency по `Message.hash`.
 */
export interface MessageEditPatch {
  parts?: Part[]
  text?: string
  ifHash?: string
  /**
   * Патч меты сообщения (v1.47): мелкий merge, `null` снимает ключ;
   * содержимое не трогается (без `parts`/`text`). Только ключи плагинов —
   * {@link MESSAGE_META_EDITABLE} (`choices`, `editorNotes`); прочие — `bad_request`.
   */
  meta?: Record<string, unknown>
}

/** Ключи меты сообщения, которые правит клиент (`MessageEditPatch.meta`, v1.47). */
export const MESSAGE_META_EDITABLE: readonly string[] = ['choices', 'editorNotes']

/** Цель `messages.swipe` (§4.2): направление либо абсолютный индекс. */
export interface SwipeTo {
  dir?: 'prev' | 'next'
  index?: number
}

/** Выход `history(id)` (§4.1): лента + sync-токен сессии (§8.x). */
export interface HistoryPage {
  messages: Message[]
  version: string
  /** v1.57: выше окна ещё есть сообщения (догрузка — `history(id, {before})`). Нет — окно до начала. */
  more?: boolean
  /** v1.57: сколько сообщений в ленте всего (для счётчика «ещё N»). */
  total?: number
}

/**
 * Бинарный ассет каталога (§9: `GET /bots/:id/assets/:file`).
 * Протокол не описывает DTO бота/персоны — они остаются opaque для UI-провода
 * (`unknown`), а ассет обязан ехать байтами, иначе аватарку не отдать в `<img>`.
 */
export interface AssetData {
  data: Uint8Array
  mime?: string
}

// ────────────────────────────────────────────────────────────────────────────
// Группы операций
// ────────────────────────────────────────────────────────────────────────────

/** Операции над сессиями (§2 backends-spec). fork/rename — capability-gated. */
export interface SessionsOps {
  list(opts?: SessionListOpts): Promise<SessionInfo[]>
  create(opts?: SessionCreateOpts): Promise<SessionInfo>
  get(id: string): Promise<SessionInfo>
  delete(id: string): Promise<void>
  /** capability: fork */
  fork?(id: string, atMessageId?: string): Promise<SessionInfo>
  /** capability: edits */
  rename?(id: string, title: string): Promise<void>
  /**
   * capability: engines.switch (v1.29, users-spec §1) — сменить исполнителя:
   * лента та же (`.mds` переезжает к движку `engine`, id не меняется), новый
   * движок получает её пересобранной под себя; в ленте — заметка
   * «исполнитель: acp → nr» (скрытая от контекста). Посреди рана — `busy`;
   * движок недоступен — ошибка, сессия на месте. Возвращает сессию на новом движке.
   */
  setEngine?(id: string, engine: string): Promise<SessionInfo>
  /**
   * capability: users (v1.30, users-spec §4) — «поделиться»: участникам проекта
   * и/или пользователям, на чтение или с правом хода; `null` — снова приватна.
   * Только автор сессии и owner стенда.
   */
  share?(id: string, share: SessionShare | null): Promise<SessionInfo>
  /**
   * capability: sessions.live (v1.38) — запущенные сессии: с идущим ходом
   * (`SessionInfo.run`, с `run.last`) или живым процессом агента (`SessionInfo.process`),
   * по всем пространствам, проектам и движкам. Видимость — как у `list`.
   */
  live?(): Promise<SessionInfo[]>
  /**
   * capability: sessions.move (v1.55) — перенести сессию в другое пространство
   * ({@link SessionMoveInput}). Посреди хода — `busy`; неизвестное пространство — `not_found`.
   * Возвращает сессию с новым `workspace` / `project`.
   */
  move?(id: string, to: SessionMoveInput): Promise<SessionInfo>
  /**
   * capability: sessions.release (v1.38) — погасить процесс агента сессии
   * (ACP: `session/close`). Лента цела, следующий ход поднимет сессию из неё. Посреди
   * хода — `busy`. Процесса нет — ничего не делает.
   */
  release?(id: string): Promise<void>
  /**
   * capability: sessions.attach (v1.31, run-resume-spec §1) — подписка на
   * идущий ран: сначала снимок (`run_start`, сообщения рана — закрытые
   * `message_start`+`message_end`, незакрытое — частями с накопленным текстом,
   * ждущие `ask`), потом живой поток с того же места до `run_end`. Рана нет —
   * пустой поток. Подписчиков у рана сколько угодно; `respond` — от любого,
   * ответ гасит ask у всех (`ask_end`). Обрыв подписки ран не трогает.
   */
  attach?(id: string): AsyncIterable<AnyRunEvent>
}

/**
 * Пользователи стенда (v1.30, users-spec §2) — capability `users.admin`.
 * Вход по ссылке (`/auth/join`, `/auth/login`) — транспорт, не группа: кука
 * устройства ставится ответом сервера.
 */
export interface UsersOps {
  list(): Promise<UserInfo[]>
  /** Новый пользователь + приглашение (`link`); личный проект — при первом входе. */
  create(input: UserCreateInput): Promise<{ user: UserInfo; link: UserLink }>
  /** Новое приглашение (7 дней), прежние неиспользованные гаснут. */
  invite(id: string): Promise<UserLink>
  /** Ссылка входа для нового устройства (24 ч, один раз). */
  loginLink(id: string): Promise<UserLink>
  devices(id: string): Promise<UserDevice[]>
  /** Отозвать устройство: его кука — 401. */
  revoke(id: string, deviceId: string): Promise<void>
}

/** Опции `messages.append` (attachments-spec §2, bot-as-session-spec §1). */
export interface MessageAppendOpts {
  /**
   * Роль сообщения; default `user`. `assistant` — реплика без рана: гритинг
   * бота, с которого сессия начинается.
   */
  role?: 'user' | 'assistant' | 'system'
  /**
   * Заметка хоста в контекст (v1.36, task-session-spec §8): только с `role: 'system'`.
   * `true` — модель увидит заметку следующим ходом (отчёт задачи в ствол); нет —
   * заметка только в ленте. Ран заметка не запускает: ствол сам не отвечает.
   */
  context?: boolean
  /**
   * capability: swipes — не дописать в ветку, а добавить альтернативу
   * существующему сообщению: сиблинг `swipeOf` с тем же родителем, и он же
   * становится активным (свайпы первого сообщения). Роль — роль `swipeOf`;
   * явная другая — `bad_request`.
   */
  swipeOf?: string
  /**
   * Реплика написана по направлению (v1.47, cyoa-spec §3 `impress.send: send`):
   * то же, что `RunStartInput.direction` у рана — `meta.direction` и `picked` варианта.
   */
  direction?: RunDirection
}

/** Операции над сообщениями (capability: edits / swipes). */
export interface MessagesOps {
  /**
   * capability: edits.append. Дописать сообщение в активную ветку БЕЗ рана
   * (attachments-spec §2): вложение ложится отдельным user-сообщением, текст
   * пользователя и ран — следующим обычным `run`. Посреди рана — `busy`.
   * `role: 'assistant'` — гритинг; `swipeOf` — альтернатива существующему
   * сообщению (bot-as-session-spec §1).
   * Возвращает записанное сообщение (id, hash, swipes — как из `history`).
   */
  append?(sid: string, parts: Part[], opts?: MessageAppendOpts): Promise<Message>
  /** capability: edits.edit */
  edit?(sid: string, mid: string, patch: MessageEditPatch): Promise<Message>
  /** capability: edits.delete */
  delete?(sid: string, mid: string): Promise<void>
  /** capability: edits.hide */
  hide?(sid: string, mid: string, hidden: boolean): Promise<void>
  /** capability: swipes */
  swipe?(sid: string, mid: string, to: SwipeTo): Promise<Message>
  /**
   * capability: prompts (prompt-recipe-spec §2). Что ушло в модель для ответа
   * `mid`: рецепт, system, инъекции и сообщения контекста в том порядке, как
   * ушли. Тексты сообщений — из текущей версии сессии (`edited`/`missing`).
   * Рецепта у сообщения нет (не ответ, ран до расширения) — `not_found`.
   */
  prompt?(sid: string, mid: string): Promise<PromptView>
}

/**
 * Каталог ботов (capability: catalog). DTO бота протокол не описывает —
 * `unknown`: провод не знает, что рендерит каталог конкретного бэкенда.
 */
export interface CatalogOps {
  bots(): Promise<unknown[]>
  bot(id: string): Promise<unknown>
  asset?(botId: string, file: string): Promise<AssetData>
}

/**
 * Персоны сессии (capability: personas, personas-spec §3). Живут в сессии:
 * каталог уровня окружения — вне v1.9.
 */
export interface PersonasOps {
  /** Документ персон по активной ветке; персон нет — `{ personas: [] }`. */
  list(sid: string): Promise<PersonasDoc>
  /**
   * capability: personas.edit. Полный документ, не патч (как мета в файле).
   * Возвращает применённый документ. Битый документ (`validatePersonas`) —
   * `bad_request`; посреди рана — `busy`.
   */
  save?(sid: string, personas: Persona[], userId?: string): Promise<PersonasDoc>
}

/**
 * Мета сессии (capability: sessionMeta, session-meta-spec §2).
 *
 * `get` на сессии без меты отдаёт `{}`, а не бросает: «меты ещё не клали» —
 * не ошибка, а стартовое состояние. `patch` возвращает ПРИМЕНЁННЫЙ документ
 * целиком — клиенту не нужно повторять merge у себя, чтобы узнать результат.
 */
export interface SessionMetaOps {
  get(id: string): Promise<SessionMetaDoc>
  patch(id: string, patch: SessionMetaPatch): Promise<SessionMetaDoc>
}

/**
 * Модели (capability: models, models-spec §3).
 *
 * `list` — каталог бэкенда; `set` — выбор per-session, гейт `models.select`.
 * Смена модели посреди рана — ошибка `busy`; применяется к следующему run.
 * Если модель сменилась не через клиента (`/model` в TUI на той же сессии,
 * автоматический fallback), бэкенд шлёт `session_update{fields:['model']}`.
 */
export interface ModelsOps {
  list(): Promise<ModelInfo[]>
  /** capability: models.select. Возвращает ПРИМЕНЁННОЕ (бэкенд вправе поправить). */
  set?(sessionId: string, model: SessionModel): Promise<SessionModel>
}

/**
 * Профили сессии (capability `profiles`, profiles-spec §4).
 *
 * `list` — каталог профилей бэкенда; `set` — смена профиля существующей
 * сессии, гейт `profiles.switch`. Профиль — свойство процесса, поэтому смена
 * применяется к СЛЕДУЮЩЕМУ рану; посреди рана — ошибка `busy`. Неизвестный
 * id — `bad_request`.
 *
 * Конструктор (profile-editor-spec §3, гейт `profiles.edit`): `get` — документ
 * профиля, `save`/`delete`/`duplicate` — правка каталога. Сохранение живые
 * сессии не трогает и `session_update` не шлёт: новые настройки применяются при
 * следующем спавне процесса, а UI после save сам перечитывает `list`.
 */
export interface ProfilesOps {
  /** `opts.workspace` (v1.27) — каталог проекта клиента; бэкенду без профилей проекта — без разницы. */
  list(opts?: ProfilesListOpts): Promise<ProfileInfo[]>
  /**
   * capability: profiles.switch. `profile` — id каталога либо документ,
   * встраиваемый в сессию (bot-as-session-spec §1). Возвращает профиль, который
   * теперь у сессии; у встроенного — витрина документа с `id: 'inline'`.
   */
  set?(sessionId: string, profile: string | ProfileDoc): Promise<ProfileInfo>
  /** Документ профиля. Неизвестный id — `not_found`. `opts.workspace` — как у `list` (v1.27). */
  get(id: string, opts?: ProfilesListOpts): Promise<ProfileDoc>
  /**
   * capability: profiles.edit. Create или update по `doc.id`; битый id —
   * `bad_request`. Возвращает документ, как он лёг (перечитанный).
   */
  save?(doc: ProfileDoc): Promise<ProfileDoc>
  /** capability: profiles.edit. `default` не удаляется — `bad_request`; неизвестный — `not_found`. */
  delete?(id: string): Promise<void>
  /** capability: profiles.edit. Копия под `newId`; занятый `newId` — `conflict`. */
  duplicate?(id: string, newId: string): Promise<ProfileDoc>
}

/**
 * Каталоги конструктора профилей (capability `catalogs`, profile-editor-spec §3).
 * Метод есть ⇔ заявлен одноимённый флаг capability.
 */
export interface CatalogsOps {
  /** capability: catalogs.tools */
  tools?(): Promise<CatalogTool[]>
  /** capability: catalogs.skills */
  skills?(): Promise<CatalogSkill[]>
  /** capability: catalogs.extensions */
  extensions?(): Promise<CatalogExtension[]>
}

/**
 * Результат `attachments.put` (attachments-spec §2): ref байтов и ГОТОВАЯ часть.
 *
 * `part` — то, что клиент кладёт в `messages.append` как есть: у текстового файла
 * `text` уже извлечён (ровно то, что уйдёт в контекст) и `meta.tokens` посчитан,
 * у картинки — `meta.mime/ref`. Клиенту не нужно знать правила извлечения.
 */
export interface AttachmentPutResult {
  ref: string
  part: FilePart | ImagePart
}

/**
 * Загрузка вложений в сессию (capability: attachments).
 *
 * Бэкенд пишет байты в своё хранилище и возвращает `ref` + готовую часть; форма
 * `ref` — дело бэкенда (opaque для провода). Неподдержанный тип или превышение
 * лимита — ошибка с кодом `bad_request` и человеческим текстом (его показывает UI).
 * `put` сессию не мутирует: сообщение появляется только через `messages.append`.
 */
export interface AttachmentsOps {
  put(sid: string, name: string, data: Uint8Array, mime?: string): Promise<AttachmentPutResult>
  /**
   * capability: attachments.get (v1.10). Байты вложения сессии по `ref` из
   * `put` — превью и аватар после перезагрузки. Чужой/битый ref — `not_found`
   * (ref не выходит за хранилище сессии).
   */
  get?(sid: string, ref: string): Promise<AttachmentContent>
}

/**
 * Рабочее пространство (capability `workspace`, workspace-spec §3).
 *
 * `current` — где бэкенд сейчас: `sessions.list` отдаёт сессии ЭТОГО
 * пространства, `sessions.create` создаёт в нём же. `list` — известные
 * пространства (у pi — недавние проекты каталога сессий); в нём всегда есть
 * `current`, даже если своих сессий у него ещё нет.
 *
 * `switch` — гейт `workspace.switch`: после него клиент обязан перечитать
 * `sessions.list` (прежние id уже из другого пространства).
 */
export interface WorkspaceOps {
  current(): Promise<WorkspaceInfo>
  list(): Promise<WorkspaceInfo[]>
  /** capability: workspace.switch */
  switch?(id: string): Promise<WorkspaceInfo>
  /**
   * capability: workspace.edit (v1.26) — новый проект в реестре (`projects/<id>.mdz`).
   * `id` — имя файла; нет — из `name`. Занят — `conflict`; нет `name`/`root` — `bad_request`.
   */
  create?(project: WorkspaceProject & { id?: string }): Promise<WorkspaceInfo>
  /** capability: workspace.edit — правка проекта: поля патча заменяют, `null` — снять. */
  update?(id: string, patch: WorkspaceProjectPatch): Promise<WorkspaceInfo>
  /**
   * capability: workspace.repos (v1.35, spaces-spec §2) — проекты пространства
   * `workspace` (нет — текущего) по маскам `$projects`. `GET /workspace/repos?workspace=`.
   */
  repos?(opts?: { workspace?: string }): Promise<ProjectInfo[]>
  /** capability: workspace.files (workspace-files-spec §1) */
  files?: WorkspaceFilesOps
}

/** Патч проекта (`workspace.update`): поле — заменить, `null` — снять (кроме `name`/`root`). */
export type WorkspaceProjectPatch = { [K in keyof WorkspaceProject]?: WorkspaceProject[K] | null }

/** Опции `workspace.files.read`. */
export interface FileReadOpts {
  /** Лимит размера; больше — `bad_request` с размером. Default {@link DEFAULT_FILE_READ_MAX_BYTES}. */
  maxBytes?: number
}

/** Опции `workspace.files.write`. */
export interface FileWriteOpts {
  /** Default `utf8`. */
  encoding?: FileEncoding
  /**
   * `revision` из `read`: файл с тех пор изменился (или пропал) — `conflict`.
   * `null` — создать: файл уже есть — `conflict`. Нет поля — записать как есть.
   */
  revision?: string | null
}

/** Подписчик `workspace.files.watch`. */
export type WorkspaceUpdateListener = (event: WorkspaceUpdateEvent) => void

/**
 * Файлы пространства (capability `workspace.files`, workspace-files-spec §1).
 *
 * Пути — относительные от корня пространства, POSIX-слэши; корень — `''` (или
 * отсутствующий путь у `list`). `..`, абсолютные пути и симлинки наружу —
 * `bad_request`; нет файла — `not_found`. Нормализация — `normalizeFilePath`.
 *
 * Мутации (`write`/`delete`/`rename`) — гейт `files.write`; `watch` — гейт
 * `files.watch`. Посреди рана файлы не блокируются: агент и пользователь пишут
 * в один каталог, от гонок защищает `revision`.
 */
export interface WorkspaceFilesOps {
  /** Один уровень каталога; корень — пространство. Не каталог — `bad_request`. */
  list(path?: string): Promise<FileEntry[]>
  read(path: string, opts?: FileReadOpts): Promise<FileContent>
  /** capability: workspace.files.write. Родительские каталоги создаются. */
  write?(path: string, content: string, opts?: FileWriteOpts): Promise<{ revision: string }>
  /** capability: workspace.files.write. Не стирает — переносит в корзину пространства (`.nr-trash/`). */
  delete?(path: string): Promise<void>
  /** capability: workspace.files.write. `to` занят — `conflict`. */
  rename?(from: string, to: string): Promise<void>
  stat?(path: string): Promise<FileEntry>
  /**
   * capability: workspace.files.watch. Подписка на изменения файлов, включая
   * правки агента; возвращает отписку. Ошибки канала подписчику не бросаются:
   * транспорт переподключается сам и шлёт `paths: ['']` — «перечитай всё».
   */
  watch?(listener: WorkspaceUpdateListener): () => void
  /**
   * capability: workspace.files.search (v1.28). Строки-совпадения по
   * пространству в порядке путей; больше `limit` — обрезано. Правила запроса —
   * {@link compileFileSearch}.
   */
  search?(query: FileSearchQuery): Promise<FileSearchHit[]>
  /**
   * v1.33: файлы проекта `workspace` (проект вкладки), а не текущего
   * проекта процесса — две вкладки в разных проектах видят каждая свои дерево и
   * поиск. На проводе — `?workspace=` у `/workspace/files*` и `/workspace/events`.
   * Нет метода (бэкенд одного пространства) — файлы как есть.
   */
  at?(workspace: string): WorkspaceFilesOps
}

/**
 * Сервисы плагинов (capability `services`, plugin-services-spec §2, v1.11).
 *
 * `plugin` — `plugin.id`, `args` — JSON. Незаявленный плагин или метод —
 * {@link NotSupportedError}: у `call` — reject, у `stream` — throw первого
 * `next()`, до кадров. Throw хендлера: у `call` — ошибка с его message (и
 * `code`), у открытого стрима — кадр `{name:'error'}` и конец итерации.
 * Закрыть стрим (`break`, `return()`) — сервису приходит abort; ждать
 * следующего кадра для этого не нужно.
 */
export interface ServicesOps {
  call(plugin: string, method: string, args?: unknown): Promise<unknown>
  stream(plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent>
  /**
   * v1.14: адрес HTTP сервиса для браузера (`SERVICE_HTTP_METHOD`, iframe
   * статики) — `<база бэкенда>/services/<plugin>/http<path>`. Есть только у
   * транспорта, который сам ходит по HTTP (`createHttpBackend`); у in-process и
   * tauri метода нет — плагин берёт адрес, который вернул его сервис.
   */
  url?(plugin: string, path: string): string
  /**
   * v1.68: долгая подписка (watch, events) — кадры как у `stream`, но
   * транспорт вправе свести все подписки в одно соединение (HTTP —
   * `SERVICE_MUX_PATH`). Нет метода — подписчик зовёт `stream`.
   */
  subscribe?(plugin: string, method: string, args?: unknown): AsyncIterable<ServiceEvent>
}

/**
 * Слой сервисов для сборки бэкенда (`createServicesHost` в
 * `@kerneldreams/backend-local/services`): операции + что заявить в capability.
 * Бэкенд, получивший его композицией, выставляет `services` и заявляет
 * `capabilities().services = await host.capability()`.
 */
export interface ServicesHost extends ServicesOps {
  /** Зарегистрированное сервисами; плагины с упавшей загрузкой в нём отсутствуют. */
  capability(): Promise<ServicesCapability>
  /** Абортит живые стримы; дальше — `not_supported`. */
  close(): Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// ProtocolBackend
// ────────────────────────────────────────────────────────────────────────────

/**
 * Бэкенд протокола: объект, реализующий операции §4 и стрим §5.
 *
 * Правила (backends-spec §2):
 * - **Опциональный метод ⇔ capability**: метод есть ⇔ capability заявлена.
 *   Вызов незаявленного — {@link NotSupportedError}.
 * - `run()` — AsyncIterable. Ошибка рана — событие `run_end{status:'error'}`;
 *   throw из итератора — только транспортная/фатальная авария.
 * - Один активный run на сессию (v1): второй `run()` при живом — reject.
 */
export interface ProtocolBackend {
  capabilities(): Promise<Capabilities>

  sessions: SessionsOps

  /** `opts` — окно ленты (v1.57, capability `history.page`); без capability бэкенд его не смотрит. */
  history(id: string, opts?: HistoryOpts): Promise<HistoryPage>

  run(id: string, input: RunStartInput): AsyncIterable<AnyRunEvent>
  cancel(id: string, runId: string): Promise<void>
  /** capability: ask */
  respond?(id: string, askId: string, answer: unknown): Promise<void>
  /**
   * capability: steer (v1.37). Влить сообщение человека в идущий ран
   * `runId`, не дожидаясь конца хода: бэкенд отдаёт его агенту на ближайшей паузе
   * между тулами, в потоке рана оно приезжает user-сообщением (`meta.steered`)
   * на месте, где влилось. Ран кончился — `{outcome: 'idle'}`, ничего не сделано.
   * Без capability UI держит сообщение в очереди и шлёт обычным `run` после хода.
   */
  steer?(id: string, runId: string, userMessage: string | Part[]): Promise<SteerResult>

  messages?: MessagesOps
  /** capability: models */
  models?: ModelsOps
  /** capability: workspace */
  workspace?: WorkspaceOps
  /** capability: profiles */
  profiles?: ProfilesOps
  /** capability: catalogs */
  catalogs?: CatalogsOps
  catalog?: CatalogOps
  personas?: PersonasOps
  meta?: SessionMetaOps
  /** capability: attachments */
  attachments?: AttachmentsOps
  /** capability: services (v1.11) */
  services?: ServicesOps
  /** capability: skins (v1.21) */
  skins?: SkinsOps
  /** capability: settings (v1.40) — слои настроек стенда */
  settings?: SettingsOps
  /** capability: files.external (v1.41) — чтение по абсолютному пути вне пространств */
  external?: ExternalFilesOps
  /** capability: host.open (v1.41) — Finder / приложение на машине бэкенда */
  host?: HostOps
  /** capability: plugins (v1.24) — подписка на пересборку внешних плагинов */
  plugins?: PluginsOps
  /** capability: users.admin (v1.30) — пользователи стенда */
  users?: UsersOps

  /** Жизненный цикл: убить процессы, снять watch'и. */
  close?(): Promise<void>
}

// ────────────────────────────────────────────────────────────────────────────
// NotSupportedError
// ────────────────────────────────────────────────────────────────────────────

/** Код ошибки «операция не поддержана» на проводе (backends-spec §3.1). */
export const NOT_SUPPORTED_CODE = 'not_supported'

/**
 * Вызвана операция, которую бэкенд не заявил в capabilities (backends-spec §2).
 *
 * Транспорт транслирует её в Envelope-ошибку с `code: 'not_supported'`
 * (serveBackend) и восстанавливает обратно на клиенте (createHttpBackend) —
 * так семантика «не умею» доезжает до UI через провод, не теряясь в 500.
 */
export class NotSupportedError extends Error {
  /** Код для Envelope-ошибки; отличает «не умею» от «сломалось». */
  readonly code = NOT_SUPPORTED_CODE
  /** Имя незаявленной операции: 'sessions.fork', 'messages.edit', ... */
  readonly operation?: string

  constructor(operation?: string, message?: string) {
    super(message ?? (operation ? `Operation not supported: ${operation}` : 'Operation not supported'))
    this.name = 'NotSupportedError'
    this.operation = operation
  }

  /**
   * `instanceof` — по форме, не по прототипу (v1.20): клиент без зависимостей
   * (`nr-chat-client`) бросает свой класс с тем же `name` и `code`, и
   * `err instanceof NotSupportedError` у потребителя протокола остаётся верным.
   */
  static [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === 'NotSupportedError' && (value as { code?: unknown }).code === NOT_SUPPORTED_CODE
  }
}
