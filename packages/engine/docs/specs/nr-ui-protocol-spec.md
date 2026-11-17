# nr-ui-protocol — универсальный протокол UI ⇄ бэкенд

**Статус:** черновик 1
**Дата:** 15.07.2026
**Место:** живёт в nr-engine/docs/specs как первый дом; протокол backend-agnostic, nr-engine — лишь первый бэкенд. Частично заменяет nr-engine-spec §3.3 (StreamEvent) и §8 (UI protocol) на уровне провода.

**Ревизии.** Нормативно для своей capability — спеки чат-линии `Projects/nrchat.dev/specs/`; этот файл — сводка провода. Реализация — `@kerneldreams/ui-protocol`.

| версия | дата | что | спека | пакет |
|---|---|---|---|---|
| v1.1 | 08.09.2026 | models; типизированный sessionMeta, режим промпта | `models-spec.md`, `session-meta-spec.md` | 0.5.0–0.6.0 |
| v1.2 | 09.09.2026 | workspace | `workspace-spec.md` | 0.7.0 |
| v1.3 | 13.09.2026 | вложения: `put → {ref, part}`, `messages.append`, capability-объект | `attachments-spec.md` | 0.8.0 |
| v1.4 | 13.09.2026 | профили сессии | `profiles-spec.md` | 0.9.0 |
| v1.5 | 14.09.2026 | конструктор профилей: `ProfileDoc`, `profiles.get/save/delete/duplicate`, catalogs | `profile-editor-spec.md` | 0.10.0 |
| v1.6 | 14.09.2026 | бот = сессия: `append` от assistant и `swipeOf`, встроенный профиль | `bot-as-session-spec.md` | 0.11.0 |
| v1.9 | 18.09.2026 | персоны сессии: `personas {edit, multi}`, `PersonasOps.list(sid)/save`, `MessageMeta.personaId`; сняты `GET /personas`, `/personas/:id`, `personas.get(id)` | `personas-spec.md` | 0.14.0 |
| v1.10 | 19.09.2026 | `run.continue` — ран без user-сообщения; `attachments.get(sid, ref)` — байты вложения | `personas-spec.md` §6 (continue), `attachments-spec.md` | 0.15.0 |
| v1.11 | 19.09.2026 | сервисы плагинов: capability `services {[pluginId]: {methods, streams}}`, `services.call/stream`, `ServiceEvent` | `plugin-services-spec.md` | 0.17.0 |
| v1.12 | 30.09.2026 | `MessageMeta.to?` (адресат-шёпот), `MessageMeta.seen?` (свидетели) — ядро ленты не трактует, `history()` отдаёт | `gamentic.dev/specs/port-front-1.md` §B | 0.18.0 |
| v1.13 | 30.09.2026 | `RunStartInput.segments?` (типизированное действие, схема бэкенда), `RunStartInput.wish?` (пожелание рассказчику); `Persona.gender?` | `gamentic.dev/specs/port-front-1.md` §A/§D | 0.19.0 |
| v1.14 | 30.09.2026 | HTTP сервиса: метод `http` → `GET\|HEAD /services/:plugin/http/*` (ответ сервиса как есть), `ServicesOps.url?(plugin, path)` — адрес для браузера у HTTP-транспорта | `plugin-services-spec.md` §2 | 0.20.0 |
| v1.15 | 30.09.2026 | `MessageMeta.speech?` (`{speaker, voice, instruct?}` — единица озвучки), `message_start.message.meta?` — мета до первого слова (`personaId`, `speech`); ядро ленты кладёт её в стримящееся сообщение, озвучку трактует плагин | `gamentic.dev/specs/port-voice-1.md` §A/§C | 0.21.0 |
| v1.16 | 03.10.2026 | тулы сессии: `SessionMetaDoc.tools: SessionToolDecl[]` (артефакт объявляет, исполняет фронт), capability `tools.session`, payload `ask` вида `tool` (`SessionToolCall`) | `backend-nr-spec.md` §6–7, `tools-spec.md` §7 | 0.23.0 |
| v1.17 | 03.10.2026 | апрув вызова тула: `ask` вида `tool_approval` (`ToolApprovalRequest {callId, name, args, title, preview: diff\|command\|text}`), ответ `ToolApprovalAnswer` (`allow`\|`allow_session`\|`deny` + `reason`), `TOOL_APPROVAL_ASK_KIND` | `tools-spec.md` §7 | 0.24.0 |
| v1.18 | 04.10.2026 | команды рана: `RunStartInput.command {name, args?}`, capability `run.commands`, `canCommand`; `compact` — компакция контекста; узел компакции — `role: 'system'` + custom `pi.compaction` (`COMPACTION_PART_HINT`, `CompactionPartData {summary, firstKeptEntryId, tokensBefore, details?}`, `compactionOf`) | `backend-nr-spec.md` поправка 04.10 | 0.25.0 |
| v1.19 | 04.10.2026 | адресат хода `RunStartInput.target?: ParticipantRef` (`{kind:'user'}` \| `{kind:'char', personaId?}`); impersonate бэкендом — capability `impersonate`, `canImpersonate`/`targetsUser`/`isParticipantRef`: ответ — события НЕсохраняемого сообщения `role: 'user'`, промпт — `activity` `PROMPT_ACTIVITY_KIND` (`PromptView` + `sent`); рецепт — `target`, `systemBlocks`, `reason` инъекции | `backend-nr-spec.md` поправка 04.10 | 0.26.0 |
| v1.20 | 05.10.2026 | рабочий каталог на сессию: `SessionCreateOpts.cwd` (абсолютный) → мета `workspace.cwd` (`SessionWorkspace`), смена — `meta.patch`; capability `workspace.perSession`, `canSessionCwd`/`sessionCwdOf`/`isAbsolutePath`; без capability `cwd` — `not_supported` до создания. Мета `pageContext` — снимок страницы виджета (backend-nr: инъекция `page.context`). `NotSupportedError` — `instanceof` по форме (name + code). Транспорт: ключ `Authorization: Bearer` (`$auth_key` стенда), 401 `unauthorized` | `widget-spec.md` | 0.27.0 |
| v1.21 | 06.10.2026 | скины как данные: `SkinsOps` (`list`/`css`/`save?`/`select?`), `SkinInfo`, capability `skins {save?, select?}`, `canSkins`; провод `GET /skins`, `GET|PUT /skins/<имя>.css`, `PUT /skins/current` — опцией транспорта `serveBackend({skins})` (свойство стенда, не бэкенда) | `nrchat.dev/specs/skin-spec.md` | 0.28.0 |
| v1.22 | 06.10.2026 | `Persona.card` (CCv3 `data` в персоне), `MessageMeta.greeting` (индекс гритинга сиблинга), `ProfileDoc.template`/`builder` — шаблон и билдер промпта агента | `nrchat.dev/specs/session-document-spec.md` | 0.29.0 |
| v1.23 | 10.10.2026 | отладка промпта: capability `promptDebug`, ask вида `prompt` (`PROMPT_DEBUG_ASK_KIND`) перед вызовом провайдера при флаге меты `SessionMetaDoc.debugPrompt` (`PROMPT_DEBUG_META_KEY`); payload `PromptDebugRequest {mds, json {system, messages}, model, tokens?, run?}`, ответ `PromptDebugAnswer` — `{action:'send'}` как есть \| `send`+`mds` (разбор обратно в сообщения) \| `send`+`json` как есть \| `{action:'cancel'}`; правка — на один ран; отмена до первого слова — ответ не пишется, `run_end cancelled` | `nrchat.dev/specs/ui-batch-5-spec.md` §4 | 0.30.0 |
| v1.24 | 13.10.2026 | внешние плагины фронта: capability `plugins: ExternalPluginInfo[]` (`{id, url, css?, version?, service?}`; `url`/`css` на проводе — от базы бэкенда, клиент делает абсолютными и кладёт ключ в `?auth=`), транспортный `PluginsSource` — опцией `serveBackend({plugins})` (свойство стенда, `$plugins`); `GET /plugins/<id>/<путь>` — файл `dist/` плагина (не Envelope, no-cache), SSE `/plugins/events` — `plugin_changed {id, version}`; клиент — `backend.plugins.watch` | `nrchat.dev/specs/core-boundary-spec.md` §3 | 0.31.0 |
| v1.25 | 13.10.2026 | `Usage` — опциональные `cacheRead`/`cacheWrite` (кэш промпта) и `context {used, size}` (контекст агента после хода): `MessageMeta.usage` ответа и `run_end.usage` | `nrchat.dev/specs/acp-daily-chat-spec.md` | 0.32.0 |
| v1.26 | 13.10.2026 | проекты стенда: `WorkspaceInfo` с `kind: 'project'`, `description?`, `project?: WorkspaceProject` (`{name, description?, root, dirs?, context?, profile?, model?, skills?, plugins?}` — запись реестра `projects/<id>.mdz`); capability `workspace.projects` (список — проекты, `sessions.list({workspace})` — сессии проекта, `SessionCreateOpts.workspace` → `$root`/`$profile`/`$model` проекта, пометка `SessionInfo.workspace` = id проекта, без пометки — `default`; мета `workspace.project`) и `workspace.edit` (`workspace.create(project & {id?})`, `workspace.update(id, WorkspaceProjectPatch)` — `null` снимает поле; удаления нет); `ExternalPluginInfo.workspace` — плагин проекта; хелперы `canProjects`, `sessionProjectOf`, `projectIdOf`, `isProjectId`, `pluginsForWorkspace`, `DEFAULT_PROJECT_ID` | `nrchat.dev/specs/projects-spec.md` | 0.33.0 |
| v1.28 | 14.10.2026 | полнотекстовый поиск по пространству: `workspace.files.search(FileSearchQuery {query, regex?, case?, glob?, limit?})` → `FileSearchHit[] {path, line, text, column?}` по путям (default 500, потолок 5000 строк; текст строки ≤ 400 знаков вокруг совпадения); capability `workspace.files.search`; HTTP `POST /workspace/files/search`; regex — JS-диалект, игнор пространства (`.git`, `node_modules`, `.gitignore`, корзина) и бинарное не ищутся; пустой запрос, битый regex — `bad_request`; общий матчер `compileFileSearch`, `fileGlobRegExp` (без `/` — по имени, с `/` — от корня, `{a,b}`, запятая) | `nrchat.dev/specs/notes-spec.md` §2 | 0.35.0 |
| v1.38 | 17.10.2026 | запущенные сессии: `sessions.live()` (`GET /sessions/live`) — идущие раны и живые процессы агентов по всем пространствам и движкам; `sessions.release(id)` (`POST /sessions/:id/release`) — погасить процесс агента простаивающей сессии; capability `sessions {live, release}`, `canListLive`/`canReleaseSession`; `SessionRun.last {kind, name?, at}`, `SessionInfo.process {idleSince}`. v1.29–v1.37 — в `nr-ui-protocol/src/index.ts` | `nrchat.dev`, `task-session-spec.md` | 0.42.0 |
| v1.40 | 19.10.2026 | настройки по слоям: capability `settings {layers, watch?}`; `GET\|PUT\|DELETE /settings` (`get/set/reset`), контекст `{session, space, project, agent, bot, noBot?}`; слои сессия · бот · агент · проект · пространство · пользователь · стенд собирает хост из файлов, устройство · дистрибутив · код — клиент; изменения файлов — стрим `settings.changes` пула сервисов (settings-spec) |
| v1.41 | 20.10.2026 | файл вне пространств и действия хоста: capability `files {external}` — `external.stat/read/list` по абсолютному пути (`~` раскрывает бэкенд), `GET /files/external/{stat,read,list,raw}?path=`; capability `host {open, apps}` — `host.reveal` (Finder, `open -R`), `host.open(path, {app})` (`open` / `open -a` из словаря стенда `$host_apps`), `POST /host/{reveal,open}`; закрытые пути (`~/.ssh`, ключи, `.env*`, `$external_deny`) — `forbidden`, доступ — owner стенда (file-links-spec) |
| v1.42 | 22.10.2026 | панель файлов: адрес файла `{host?, path}` — `host=` у всех `/files/external/*` (нет — хост хаба; чужой — `not_found`), `FileEntry.host`, `ExternalFileStat.host`; `files {write, search, watch, host, hosts}` — `POST /files/external/{write,mkdir,rename,delete,copy}` (удаление — в `~/.nr-trash/<абсолютный путь>` хоста, `permanent` — насовсем; `to` занят — `conflict`), `GET /files/external/search?path=&glob=&query=` (имя — хит `line: 0`), SSE `GET /files/external/events?path=` → `external_update {host?, paths}`; эскиз — `raw?…&thumb=<px>` (делает хост файла, не умеет — оригинал); закрытые пути — и на запись (file-panel-spec) |
| v1.43 | 22.10.2026 | откуда пишет человек: `RunStartInput.client {device?, place?, tz?}` — бэкенд пишет в мету реплики (`MessageMeta.client`, рядом `createdAt` — теперь и у user-узлов) и штампует модели хвост реплики `[14:30]` (дата — при смене дня, `· устройство (место)` — при смене; детерминированно из меты пути, кэш цел; `nr-chat-store/assembly` `contextStamps`); capability `client` — фронт шлёт поле только ей; у RP (каст персон) и агента `stamp: off` — без штампа; стенд — `$stamp`, `$devices` (реестр устройств строкой в system) |
| v1.44 | 22.10.2026 | вид чата и происхождение имени: `SessionInfo.kind` (`talk` · `run` · `review` · `probe` · `rp` · `auto`; явный `sessionMeta.kind`, иначе стор выводит из задачи/заголовка/пространства/профиля — `sessionKindOf`), `SessionInfo.titleSource` (`user` — переименование через протокол, `create` — `title` при создании, `agent` — заголовок агента, `auto` — автоимя/карточка; пишет бэкенд в `sessionMeta.titleSource`; `user`/`create` автоматика не переписывает — заголовок агента ACP их не перебивает), `SessionInfo.noCloud` (`sessionMeta.noCloud` — не в облачную разметку); `SessionInfo.task` теперь отдаётся и хабом для всех движков | `nrchat.dev` | 0.46.0 |
| v1.46 | 23.10.2026 | лорбук v2: `MessageMeta.lore` / `MessageMeta.loreOnce` — `[{book, entry, variant?}]` на реплике игрока (закрепления `sticky` и ротация вариантов `once`; пишет бэкенд чанком генерации `node_meta`, фронт только читает); system-сообщение посреди ленты провайдеру (вставки лорбука, `$lore_role: system`); `PromptDebugRequest.lore` (записи хода: `source` `lorebook:<источник>/<подача>: <имя>`, `reason` — книга, балл, позиция скана, вариант, якорь) и `PromptDebugRequest.macros` (нераскрытые макросы с местом `system`/`history`/`tail`) | `nrchat.dev/specs/lorebook-v2-spec.md` | 0.47.0 |
| v1.47 | 23.10.2026 | CYOA: `RunStartInput.direction` (`RunDirection {intent, axis?, tone?, length?, choice?}`; у impersonate — вход шаблона на этот ран, у реплики — `meta.direction`, `choice` → `picked` в `meta.choices` ответа бота), `MessageAppendOpts.direction` (то же без рана); служебные команды `choices`/`editor` (`RunCommand.options: SideCommandOptions {messageId, model?, count?, explicit?, pick?, avoid?, prefer?}`) — `PARALLEL_COMMANDS`, `isParallelRun`: идут параллельно ходу той же сессии (транспорт, attach и хаб замок «один ран на сессию» на них не держат), сообщений не пишут, итог — патч меты ответа бота (`meta.choices {choices[{label, intent, axis, explicit?}], pick?, picked?, previous?, model?}`, `meta.editorNotes`) кадром `activity` `node_meta` (`NodeMetaActivity {id, patch}`), запрос — кадром `prompt`; `MessageEditPatch.meta` (мелкий merge, только `MESSAGE_META_EDITABLE`: `choices`, `editorNotes`; без `parts`/`text` — и посреди хода); `MessageMeta.editorApplied [{from, i}]` (какие заметки редактора поданы в ход реплики, пишет бэкенд); слой настроек `persona` (карта user-персоны, между `session` и `bot`); гейты `canChoices`/`canEditor` — команда в `run.commands` | `nrchat.dev/specs/cyoa-spec.md` | 0.47.0 |
| v1.48 | 24.10.2026 | аккаунт Claude Code по пространству: `WorkspaceProject.claudeAccount` (`$claude_account` записи, id из таблицы `## $claude_accounts` стенда → `CLAUDE_CONFIG_DIR`; нет — аккаунт по умолчанию), `SessionInfo.account` (на чьём аккаунте идёт сессия; отдаёт ACP-бэкенд, у которого таблица аккаунтов задана) | `nrchat.dev` | 0.48.0 |
| v1.49 | 25.10.2026 | объекты и виды: сервис ядра `objects` хаба на проводе сервисов (`services.call('objects', …)`, гейт `canObjects` — сервис в `capabilities.services`): `types` (типы данными `envs/types/<id>.mdz` + ошибки загрузки), `list` (строки посчитаны бэкендом: `ObjectRow` — title/subtitle/avatar/badges/fields/metrics, фасеты), `get`/`create`/`save` (`ObjectSaveResult`: `doc` / `invalid` поля / `conflict` по хэшу), `remove` (в `.nr-trash`), `action` (`duplicate`, `import`, `export`, `avatar`), `links`, `history`, `render` (вид-шаблон ntpl), стрим `watch` (`changed {type, ids}` / `types`), картинки — `GET /services/objects/http/asset/<тип>/<id>`; адрес документа `objectHash` (`#/t/object?type=&id=&view=`) | `nrchat.dev/specs/objects-spec.md` | 0.49.0 |
| v1.50 | 25.10.2026 | персона в сессии: `PersonasCapability.context` (`all` — нет поля так же — все персоны в контекст, nr/RP; `user` — только персона игрока, заменой карточки пользователя, Claude Code через ACP; `none` — персоны хранятся, в контекст не идут), `personaContext(caps)`; `ObjectDoc.fieldsHash` — хэш полей без служебного, тот же, что `ObjectSourceRef.hash` копии: копия с другим «отстала». ACP-бэкенд заявляет `personas {edit, context}` и хранит персон в шапке `.mds` | `nrchat.dev/specs/objects-spec.md` §9 | 0.50.0 |
| v1.51 | 25.10.2026 | карточки работ, часть T7a: `ObjectTypeInfo.states` (`ObjectStates {field, transitions, labels, args}`, `stateActions`), `waiting` (фильтр «ждёт тебя»), `index` (оглавление коллекции); `objects.action {action: <целевое состояние>}` — переход `$states` (+ `decided_at`, `comment`, `until`), `action index`; `GET /services/objects/http/asset/<тип>/<id>/<rel>` — файл по относительному пути карточки внутри папки объекта; кодек `mdz` — тело полем `text`. Объекты сессии и группы связей — T7b, той же версией или следующей | `nrchat.dev/specs/objects-spec.md` §15.1 | 0.51.0 |
| v1.52 | 25.10.2026 | редакторы типа: `ObjectTypeInfo.editors` (`ObjectEditorInfo {id, view, title?, format: mdz\|json, text, file?}` — виды `$views: <вид>=<редактор>`, текст `editors/<редактор>.editor.mdz` рядом с типом, первый — по умолчанию, из него схема без `$schema`), `editorErrors`; каталог `editors/` следится (`types` в `watch`). Разбирает фронт (`@kerneldreams/forms`) | `nrchat.dev/specs/universal-editor-spec.md` §9 | 0.52.0 |
| v1.53 | 26.10.2026 | линия объектов: `ObjectTypeInfo.service` (не-файловый тип `$source: service\|protocol` — записи держит источник плагина фронта `objectSources`), `parent` (`$parent: <поле> → <тип>`), `discuss` (`$discuss.<заказчик>.agent/skills/space/scope`); `ObjectLink.group` (`discuss\|work\|mention`), `maybe`, `anchor`; `ObjectRow.group/groupTitle` (группы строк списка); объекты сессии — `SessionCreateOpts.objects`, `sessionMeta.objects` (`SessionObjectRef {type, id, hash?, title?, text?}`), блок промпта `object:<тип>/<id>` (`objectBlockSource`; nr — префикс рана, ACP — system после агента); `sessionMeta.agent` (`SessionAgentCopy {source?, voice?}` — копия агента в сессии); `SessionInfo.metrics` в `sessions.live` (токены in/out/кэш, контекст — копятся по `message_end` рана в `withRunAttach`) | `nrchat.dev/specs/objects-spec.md` §7, §15–16, T4/T8 | 0.53.0 |
| v1.54 | 26.10.2026 | резолвер ссылок: сервис ядра `links` хаба — `rules {agent?, space?, cwd?, user?}` → `LinkRules {links: LinkRuleDef[], actions: LinkActionDef[], off, layers, trusted}` (`links.mdz` слоёв агент → пространство → пользователь → стенд, первый сильнее; `## $link`, `## $action`, `$off`), `resolve {templates, vars}` → строки (`${}` об слой params), `run {action, vars, …слои}` → `LinkRunResult` (`$run: exec`/`script`, только при доверии), стрим `watch` → `changed`; гостю (`member`) гейт пользователей подкладывает `$caller` — слои кроме стенда без `exec`/`script`; `ExternalHostInfo.home` (маски `$home` реестра), `files.locate` — `GET /files/external/locate?path=` → `ExternalFileStat[]` (хосты, где путь есть); действия хоста на машине устройства — `POST /host/{reveal,open} {path, host?, on?, dryRun?}` → `HostActionResult {on, path, via: direct\|mount\|download, cmd, args}`, машины — `host.on`; гейты `canLinks`, `canExternalLocate`, `canHostOpenOn`, `hostByHome` | `nrchat.dev/specs/link-resolver-spec.md` | 0.54.0 |
| v1.55 | 27.10.2026 | порядок в чатах: архив и теги на мете сессии — `sessionMeta.archived` (дата ISO; `false` — вернули руками, автоархив её не трогает), `archivedBy: 'auto'`, `tags` (нижний регистр, без `#`) → `SessionInfo.archived/archivedBy/tags`; `sessions.list` архивные по умолчанию не отдаёт — `SessionListOpts.archived` (`true` — все, `'only'` — только архивные; HTTP `?archived=1\|only`); ход в архивной хаб возвращает её молча; `sessions.move(id, {workspace, project?})` (`POST /sessions/:id/move`): алиас → настоящее id, проект — если есть в целевом, иначе сбрасывается, агент и лента те же; capability `sessions {archive, move}`, гейты `canArchiveSessions`, `canMoveSession`, хелперы `isArchivedSession`, `pickArchived`, `archivePatch`; примитив стора `SessionStore.move` | `nrchat.dev/specs/session-archive-spec.md` | 0.55.0 |
| v1.56 | 27.10.2026 | лицо записи: `ObjectRow.hue` (оттенок OKLCH, градусы) / `color` (токен `$palette`) / `cover` / `icon` (пути ассетов сервиса, как `avatar`) / `coverState` (`missing \| queued \| ready \| stale \| locked \| manual`) / `coverError`; `ObjectTypeInfo.color` (`ObjectColorRule {by: hash \| field \| off, field?, steps}`, `$color`) и `cover` (`ObjectCoverInfo {refs, style?, styles, preset}`, `## $cover`); действия сервиса `objects`: `cover {mode: missing \| all \| one, ids?}`, `cover-lock {locked}`, `cover-style {style, scope: record \| type}`, `cover-styles`; хелперы `recordHue(id, steps)` (FNV-1a → ступень → градусы), `recordColor(hue, base \| accent)` = `oklch(from var(--nr-record-…) l c <hue>)` | `nrchat.dev/specs/objects-spec.md` §19 | 0.56.0 |
| v1.57 | 28.10.2026 | окна ленты и списка: `history(id, {limit, before})` (`HistoryOpts`; HTTP `GET /sessions/:id/history?limit=&before=`) — хвост по `limit`, догрузка вверх `before` = id первого загруженного, `HistoryPage.more` / `total`; без опций — вся лента, как раньше; capability `history {page}`; `SessionListOpts.query` (слова подстрокой без регистра в названии, первых словах, боте, тегах, id; `#тег` — тег) / `limit` / `offset` (HTTP `?q=&limit=&offset=`), capability `sessions.page`; гейты `canPageHistory`, `canPageSessions`, хелперы `matchSessionQuery`, `pageSessions`, `historyWindow`; старый клиент и старый бэкенд работают (без capability фронт берёт ленту целиком и фильтрует у себя) | `nrchat.dev/specs/perf-spec.md` | 0.57.0 |
| v1.58 | 28.10.2026 | срезы списка: `ObjectTypeInfo.slices` — `ObjectSlice {id, title, icon?, params}` из разделов `## $slice <id>` файла типа (`$title`, `$icon`, `$q`, прочие ключи — фасеты: `$template: slot` → `f.template: slot`, как параметры списка левой панели); фронт закрепляет срез в полосе как тип, свои срезы держит сам; поле необязательное — старый фронт его не видит | `nrchat.dev/specs/objects-spec.md` §18, `book-spec.md` §11 | 0.58.0 |
| v1.59 | 29.10.2026 | скиллы сессии с режимами: `SessionMetaDoc.skills: Array<string \| SessionSkill>` — `SessionSkill {name, mode: 'linked' \| 'loaded', source?}`, строка — `loaded` (скилл старта v1.35, как было); `linked` — в списке скиллов сессии и каталоге загрузки (`skill_load` / `skill`), агент грузит сам; `loaded` — `SKILL.md` в контексте каждого хода (префикс после проекта); бэкенд читает мету на каждом ходе, без рестарта сессии и стенда; патч одного ключа `skills` посреди рана — не `busy` (тул агента `skills_attach`); capability `skills {session}`; хелперы `canSessionSkills`, `sessionSkills`, `sessionSkillNames`; старый клиент пишет строки — работает | `nrchat.dev/specs/skills-spec.md` §4 | 0.59.0 |
| v1.60 | 02.11.2026 | субагенты у тулов: `meta.parent` у tool_use / tool_result — callId тула `Agent`/`Task`, чей субагент сделал вызов (Claude Code через ACP: `_meta.claudeCode.parentToolUseId` адаптера); `meta.subagentContext` у tool_result — окно субагента после вызова, токенов (у результата самого `Agent` — итог); такие части — в контексте субагента, а не чата: фронт рисует их вложенно под родителем и не считает в контекст чата; текст субагента в ответ чата не идёт; mds — ключи `parent`/`subagentContext` в мете `%%tool_use`/`%%tool_result`; хелпер `subagentParent`; без меток — как было | бэкенд ACP | 0.60.0 |
| v1.61 | 02.11.2026 | служебный движок хаба: `EngineInfo.create: false` — новых чатов на движке не заводят (хаб задач Claude Code: его сессии создаёт хост задач); фронт не показывает его в выборе движка новой сессии и в «сменить исполнителя», сессии движка видны, открываются и продолжаются как у всех; хаб — `HubEngine.create: false` (и `switch: false`); нет поля — как было | `nrchat.dev/specs/task-session-spec.md` §15 | 0.61.0 |
| v1.62 | 06.11.2026 | откуда имя устройства штампа (дополнение v1.43): `Capabilities.devices {list: DeviceInfo[], here?}` — реестр `## $hosts` стенда (`name`, `os`, `match` — короткий hostname, `client`), `here` — машина запроса по адресу tailnet (сокет хаба или последний `X-Forwarded-For` Caddy; через Cloudflare `cf-*` и ssh-проброс — нет); `RunStartInput.client.guess` — `device` есть догадка по браузеру: хаб заменяет её именем машины по адресу и снимает флаг до бэкенда (`createDevices`, опция `serveBackend({devices})`). Фронт выбирает имя по старшинству: настройка «Это устройство» → имя машины от оболочки (exz `shell_call host.name` → `match` реестра) → `devices.here` → догадка с `guess`; догадка `mac`/`windows`/`linux` при нескольких машинах этой ОС в реестре — один раз чип «Это устройство» над композером (выбор — в настройку слоя device), телефон не спрашивается. RP без штампа по умолчанию: вид `rp` меты, пространство или агент `rp` (nr и ACP); `stamp` агента главнее (`on` включает и RP); каст персон и impersonate — без штампа всегда (`nr-chat-store/assembly` `isRpSession`, `stampByAgent`) | `nrchat/src/session/client.ts`, `backend-http/src/devices.ts` | 0.62.0 |
| v1.63 | 06.11.2026 | лицо чата и агента (icons-spec §4.1): `SessionInfo.icon` — своя иконка чата из `sessionMeta.icon` (строка как `$icon` типа: имя lucide, эмодзи, адрес картинки, `file:` хоста; патч `{icon: null}` снимает); `ProfileInfo.icon` / `ProfileInfo.avatar` (и `ProfileDoc`) — `icon` / `avatar` в `%meta` агента `.mds`, `profileInfoOf` переносит. Лицо в списке: своя → персона (`botAvatar`) → агент → первая буква на цвете агента (`recordHue(id агента)`, не движка); обвеска (движок, внимание, кольцо рана) — фронт, протокол не меняет. Нет полей — как было | `nrchat.dev/specs/icons-spec.md` | 0.63.0 |
| v1.64 | 06.11.2026 | будильник хаба: сервис `wake` в capability `services` (`withWakeService` backend-http; встроен в стенд, не плагин) — `list {session?, all?}`, `get {id}`, `create {session, prompt, when, timeout?, title?}`, `cancel {id}`, `status`, `tools`/`tool`; запись `WakeRecord` (`when` — одно из `at` / `cron`+`tz` / `job` / `pid` / `file`+`match` / `task`; `status` waiting → pending → fired, а также timeout, cancelled, failed; `next`, `timeoutAt`, `reason`, `label`). Сработало — хаб шлёт в сессию безголовый `run` с user-сообщением `⏰ <prompt>` + что сработало; сессия занята — запись `pending` до следующего прохода. Тулы агентам `wake_at`, `wake_on`, `wake_list`, `wake_cancel`, `job_start`, `job_status`. Фронт: нет `services.wake` — нет UI. Новых полей ядра протокола нет | `nrchat.dev/specs/wake-spec.md` | — (типов в пакете нет) |
| v1.65 | 07.11.2026 | слой настроек `bot` записываемый (cyoa-spec §5): `settings.set/reset` с `layer: 'bot'` пишет в карту char-персоны сессии (`data.extensions.nrchat.settings` у CCv3, `extensions.nrchat.settings` у плоской) через `personas.save` — карта бота в сессии экземпляр, библиотечная не меняется; `SettingsLayerInfo.writable` у `bot` — как у `persona` (есть `personas.save`). Раньше — `forbidden`. Новых полей нет | `nrchat.dev/specs/cyoa-spec.md` §5, `settings-spec.md` | `backend-http` `settings.ts` |
| v1.67 | 10.11.2026 | бот и сборка: `RunStartInput.vars` — переменные пресета на один ран (чип, `{<id>: значение}`), бэкенд пишет их в `meta.vars` реплики игрока (`MessageMeta.vars`), верхний слой каскада чип → персона → бот → агент; кривое — `bad_request`. `PromptDebugRequest.warnings` — предупреждения сборки в окне отладки (нестабильный блок наверху). Фронт без чипа шлёт как раньше | `nrchat.dev/specs/bot-assembly-spec.md` §5, §2 | `nr-ui-protocol` `types.ts`, `backend-http` `store-backend.ts`, `nr-chat-store` `tree.ts` |
| v1.68 | 10.11.2026 | мультиплекс подписок: `ServicesOps.subscribe?` — долгая подписка (watch, events), кадры как у `stream`; HTTP — `POST /services/_mux/stream {streams: [{key, plugin, method, args?}]}` → SSE `event: service_mux {key, name, payload?}` / `{key, end: true}`, первый байт сразу (`: mux`). Набор подписок поменялся — клиент открывает новое соединение и закрывает старое после ответа нового. Причина — 6 соединений HTTP/1.1 на хост у браузера (loopback, ssh-проброс): по SSE на подписку пул кончался, `respond` и обычные запросы висели «pending». Старый сервер отвечает `not_supported` — клиент берёт стрим на подписку | (второй круг) | `nr-ui-protocol` `services.ts`, `nr-chat-client` `http-backend.ts` (`createMux`), `backend-http` `fetch-handler.ts` (`muxServices`), `nrchat` `src/backend/services.ts` |
| v1.69 | 10.11.2026 | активность сессий: поток встроенного сервиса хаба `nr.sessions`/`activity` (`SESSION_ACTIVITY_SERVICE`, `SESSION_ACTIVITY_STREAM`, кадр `activity` с `SessionActivity {id, kind: run_start \| run_end \| messages, runId?, at, headless?}`); заявка — дескриптор сервиса в `capabilities.services` (`canSessionActivity`). Сигнал шлёт слой, через который идут раны: `withRunAttach` и хаб (раны всех движков, внешний слой перекрывает внутренний), гейт пользователей — только видимые участнику сессии. Открытая вкладка на `run_start` чужого рана зовёт `sessions.attach`, на `run_end`/`messages` дочитывает ленту; без заявки — как раньше. Подписка — `services.subscribe` (мультиплекс v1.68) | `nrchat.dev/specs/wake-spec.md` §5 | `nr-ui-protocol` `activity.ts`, `backend-http` `session-activity.ts`, `run-attach.ts`, `hub.ts`, `gate.ts`; nrchat `src/session/activity.ts`, `store.ts` (`onSessionActivity`) |
| v1.70 | 10.11.2026 | обработчик гритинга ( §6): служебная параллельная команда `greeting` (`GREETING_COMMAND`, в `PARALLEL_COMMANDS`; гейт `canCommand(caps, 'greeting')`), `options: {messageId, vars?, model?, force?}` — гритинг под переменные пресета (язык, лицо, время): рукописный под те же `vars` — свайп на него, иначе вариант (кэш хоста или модель) сиблингом гритинга с `MessageMeta.generated {of, vars, model?, cached?, key?}` (`GREETING_GENERATED_META`), активным; оригинал — соседним свайпом. Кадр `activity` `node_meta` `{id, patch: {active: true}}`; клиент дочитывает ленту. Генерация хоста — чанк `sibling {of, match?, text?, meta?}` | `nrchat.dev/specs/bot-assembly-spec.md` §6, §15 | `nr-ui-protocol` `types.ts`, `nr-chat-store` `tree.ts`/`model.ts`, `backend-http` `store-backend.ts` (`placeSibling`), `backend-nr` `assembly/greeting.ts`, nrchat `plugins/rp/greeting-adapt.tsx` |

v1.7 (файлы пространства) и v1.8 (промпт сообщения) в эту сводку ещё не сведены — нормативны их спеки (`workspace-files-spec.md`, `prompt-recipe-spec.md`).

Правка 14.09.2026: §2.1, §2.3, §2.5, §3, §4, §9, §10.5 приведены к пакету 0.11.0. §2.2 (флаги сообщения) не тронут — расхождение с кодом записано в `nrchat.dev/DEBT.md`.

---

## 1. Назначение и принципы

Один протокол между универсальным фронтом (dreams-web и наследники) и любым бэкендом: nr-engine/dreams, pi, opencode, будущие.

### 1.1 Протокол принадлежит клиенту (LSP-принцип)

Словарь протокола определяется тем, что UI умеет рендерить и какие интеракции даёт — не объединением возможностей бэкендов. Бэкенды маппятся в словарь через адаптеры. Протокол-суперсет всех бэкендов не строим: это погоня за горизонтом.

### 1.2 Универсальность = graceful degradation, не полнота

«Любой возможный бэкенд» достигается двумя механизмами:

1. **Capabilities** — бэкенд декларирует, что умеет. UI гасит фичи по флагам, не падает на отсутствующих операциях.
2. **Opaque part** — неизвестный тип части рендерится fallback'ом (collapsed JSON + type badge), не роняет клиент. Неизвестные поля в известных структурах игнорируются.

### 1.3 Чат — вырожденный случай агентного рана

Единица генерации — **run**: процесс с событиями, который может породить несколько сообщений (assistant → tool_result → assistant), задавать вопросы (ask), быть отменён. Простой чат = run из одного сообщения с одной text-part.

### 1.4 Транспорт — деталь биндинга

Протокол = операции + события. Референсный биндинг — HTTP + SSE (§9). Адаптер pi мостит stdio-RPC, адаптер opencode фильтрует глобальный /event — это их внутреннее дело.

### 1.5 Формат хранения протокол не трогает

Протокол говорит «part типа tool_use с полями X». Как это лежит в .mds / JSONL / SQLite — дело бэкенда. mds остаётся hub-форматом хранения (пруф — pims); этот протокол — hub-формат провода.

---

## 2. Модель данных

### 2.1 Session

```ts
interface SessionInfo {
  id: string
  title?: string
  createdAt?: string        // ISO
  updatedAt?: string        // ISO
  messageCount?: number
  // презентация (capability: catalog)
  botId?: string
  botName?: string
  botAvatar?: string        // URL/ref
  accentColor?: string
  participants?: Participant[]
  // ветвление (capability: fork)
  file?: string                    // путь файла сессии у файловых сторов: справочное, клиент по нему не адресует
  parentSessionId?: string
  forkMessageId?: string
  // модель (capability: models, v1.1)
  model?: SessionModel      // { model, thinking? }
  // рабочее пространство (capability: workspace, v1.2)
  workspace?: string        // WorkspaceInfo.id
  // профиль (capability: profiles, v1.4; встроенный — v1.6)
  profile?: string          // ProfileInfo.id; 'inline' — встроенный профиль
  profileDoc?: ProfileDoc   // есть ровно при profile: 'inline'
  // задача (v1.36) и вид чата (v1.44)
  task?: { issue: string; role: 'executor' | 'acceptor'; parent?: string }
  kind?: 'talk' | 'run' | 'review' | 'probe' | 'rp' | 'auto'
  titleSource?: 'user' | 'create' | 'agent' | 'auto'
  noCloud?: boolean         // sessionMeta.noCloud: не уходит в облачную разметку (карточки, сводки)
}

interface Participant {
  id: string
  type: 'human' | 'ai'
  name: string
  avatar?: string
}
```

### 2.2 Message

```ts
interface Message {
  id: string                // opaque handle; бэкенд может отдавать позиционный ('pos:N')
  role: string              // 'user' | 'assistant' | 'system' | 'tool' | 'narrator' | ...
  name?: string             // отображаемое имя (group chat)
  parts: Part[]             // первичное содержимое
  flags?: {
    visible?: boolean       // ось UI: юзер видит (default true); false — в ленте нет, модель видит (запечённые промпты, пресеты)
    disabled?: boolean      // ось модели: выключено осознанно (тумблер/трансформ) — из промпта вычтено, в ленте приглушено
    frozen?: boolean        // всегда в контексте: компакция/отсечение не трогают (карточка, правила, ключевые ходы)
    injected?: boolean      // происхождение: вставлено системой (pre/post, лорбук), не юзером; в ленте не показывается
    hidden?: boolean        // @deprecated chat2 = disabled; драйверы мапят hidden→disabled на чтении, не пишут
  }
  swipes?: { active: number; count: number }   // capability: swipes
  hash?: string             // optimistic concurrency для edit
  meta?: { createdAt?: string; model?: string; usage?: Usage }
}

interface Usage { input: number; output: number }
```

`content: string` в протоколе **нет**. Плоский текст — derived: конкатенация text-parts, считает клиент. Инверсия относительно dreams v1, где blocks были довеском к content.

### 2.3 Part

Закрытое ядро типов + escape hatch:

```ts
type Part =
  | { type: 'text';        text: string }
  | { type: 'thinking';    text: string; meta?: { signature?: string } }
  | { type: 'tool_use';    data: unknown; meta: { callId: string; name: string } }
  | { type: 'tool_result'; data?: unknown; text?: string;
      meta: { callId: string; name?: string; error?: boolean } }
  | { type: 'file';        text?: string;
      meta: { name: string; mime?: string; url?: string; ref?: string; tokens?: number } }
  | { type: 'image';       text?: string;
      meta: { mime?: string; url?: string; ref?: string; alt?: string; tokens?: number } }
  | { type: 'error';       text: string; meta?: { code?: string } }
  | { type: 'custom';      data?: unknown; text?: string;
      meta: { hint: string; [k: string]: unknown } }   // hint — подсказка рендереру
```

Правила:

- Порядок parts в сообщении = порядок генерации/отображения.
- `tool_use` и `tool_result` связаны по `callId`. Один запуск тула = два part (возможно в разных сообщениях — зависит от бэкенда; UI матчит по callId).
- Стейтфульные тулы бэкендов (opencode part с lifecycle pending→running→completed) маппятся на пару: tool_use (input) + tool_result (стримящийся output). Состояние «running» = tool_result part открыт, но не закрыт.
- `custom.hint` — строка для выбора рендера ('marinara.stats', 'pi.compaction', ...). Нет рендера → collapsed JSON.
- `file` / `image`: `text` — извлечённый текст вложения, ровно то, что едет в LLM; `meta.tokens` — оценка бэкенда, сколько вложение стоит в контексте (оценка, не счёт; v1.3).

### 2.4 Адресация part в стриме

Part адресуется парой `(messageId, part)` где `part` — индекс в массиве parts (0-based, append-only в рамках рана). Отдельных part-id нет: в покое индекс стабилен, в стриме append-only.

### 2.5 Типы capability-блоков (v1.1–v1.10)

Форма; семантика — в спеках из таблицы ревизий.

```ts
// models-spec §2 (v1.1)
interface ModelInfo { id: string; name?: string; provider?: string; tags?: string[];
  thinking?: string[]; contextWindow?: number }
interface SessionModel { model: string; thinking?: string }

// session-meta-spec §2, §7 (v1.1)
interface SessionMetaDoc {
  prompt?: { pre?: string; post?: string; mode?: 'append' | 'replace' }
  notes?: string
  effectivePrompt?: string    // read-only: промпт последнего рана; patch его игнорирует
  tools?: SessionToolDecl[]   // v1.16: тулы сессии, исполнитель — фронт
  workspace?: { cwd?: string; project?: string } // v1.20: рабочий каталог сессии (capability workspace.perSession); v1.26 project — id проекта
  pageContext?: unknown       // v1.20: снимок страницы (виджет onContext)
  [key: string]: unknown
}
// SessionMetaPatch — та же форма, null удаляет ключ

// workspace-spec §2 (v1.2)
interface WorkspaceInfo { id: string; name: string; path?: string; kind?: string; description?: string /* v1.26 */; project?: WorkspaceProject /* v1.26 */ }
// projects-spec §1 (v1.26): запись реестра стенда; пути — абсолютные или ~/…
interface WorkspaceProject { name: string; description?: string; root: string; dirs?: string[]; context?: string; profile?: string; model?: string; skills?: string[]; plugins?: string[] }

// attachments-spec §2 (v1.3; role 'assistant' и swipeOf — v1.6)
interface AttachmentsCapability { maxBytes?: number; mimes?: string[]; get?: boolean /* v1.10 */ }
interface AttachmentPutResult { ref: string; part: FilePart | ImagePart }
// v1.10: байты по ref; кодировка — правило fileContent: UTF-8 без NUL — utf8, иначе base64
interface AttachmentContent { ref: string; content: string; encoding: 'utf8' | 'base64'; size: number; mime?: string }
interface MessageAppendOpts { role?: 'user' | 'assistant'; swipeOf?: string }

// profiles-spec §4 (v1.4)
interface ProfileInfo { id: string; name: string; description?: string;
  tools?: string[] | 'none' | 'all'; skills?: string[]; model?: string; promptMode?: 'append' | 'replace' }

// profile-editor-spec §2–3 (v1.5)
interface ProfileDoc {
  id: string; name: string; description?: string
  model?: string; thinking?: string
  tools?: 'all' | 'none' | string[]; skills?: string[]; extensions?: string[]
  systemPrompt?: string                                        // замена штатного промпта процесса
  prompt?: { mode?: 'append' | 'replace'; pre?: string; post?: string }   // дефолт меты новой сессии
  extra?: Record<string, string>                               // прочие атрибуты файла как есть
}
interface CatalogTool { id: string; description?: string; source: 'builtin' | 'extension'; extension?: string }
interface CatalogSkill { id: string; name: string; description?: string; path: string }
interface CatalogExtension { id: string; name: string; path: string; enabled: boolean }
```

`ProfileDoc` живёт в nr-chat-store вместе с `SessionInfo.profileDoc`, протокол его ре-экспортирует. Id `'inline'` зарезервирован за встроенным профилем (v1.6): каталожный профиль так называться не может.

---

## 3. Capabilities

`GET /capabilities` — первый запрос клиента. Всё за пределами ядра — capability.

```ts
interface Capabilities {
  protocol: 1                       // версия протокола
  name?: string                     // имя бэкенда ('dreams', 'pi-bridge', 'opencode-bridge')

  // окружение бэкенда (v1.1–v1.5)
  models?: { select?: boolean; thinking?: boolean }          // select ⇔ models.set
  workspace?: { switch?: boolean; files?: boolean; perSession?: boolean; projects?: boolean; edit?: boolean }  // switch ⇔ workspace.switch; v1.20 perSession — cwd сессии применяется; v1.26 projects — пространства-проекты, edit ⇔ workspace.create/update
  profiles?: { switch?: boolean; edit?: boolean }           // switch ⇔ profiles.set; edit ⇔ save/delete/duplicate
  catalogs?: { tools?: boolean; skills?: boolean; extensions?: boolean }   // флаг ⇔ метод catalogs.*

  // операции над историей
  edits?: { edit?: boolean; delete?: boolean; hide?: boolean; append?: boolean }   // append ⇔ messages.append (v1.3)
  swipes?: boolean
  fork?: false | 'copy' | 'tree'    // copy = ветвление новой сессией (sessions.fork → parentSessionId/forkMessageId);
                                    // tree = ветки живут внутри сессии: regenerate/edit создают siblings,
                                    // навигация — swipes; sessions.fork при 'tree' работает как copy-вариант
                                    // (уточнено 18.07, диалог + nr-session-spec)
  cancel?: boolean                  // отмена рана
  run?: { continue?: boolean; commands?: string[] }  // v1.10: continue ⇔ ран без userMessage/regenerate («продолжай», §5.1); v1.18: commands — имена RunStartInput.command
  impersonate?: boolean           // v1.19: ран с target {kind:'user'} — реплика игрока бэкендом, без записи (§5.1)

  // интеракции
  ask?: string[]                    // поддерживаемые kinds: 'permission' | 'select' | 'text' | ...
  activity?: boolean                // шлёт ли activity-события (суб-агенты, стадии)

  // контент
  attachments?: boolean | AttachmentsCapability   // v1.3: объект — лимиты, которые UI проверяет до загрузки; true — без лимитов; get ⇔ attachments.get (v1.10)
  catalog?: boolean                 // /bots
  personas?: boolean | { edit?: boolean; multi?: boolean }   // v1.9: персоны сессии; true — форма до v1.9 (= {}); edit ⇔ personas.save, multi — больше одной char
  sessionMeta?: boolean             // документ меты сессии SessionMetaDoc (v1.1): пре/пост-промпт, notes
  collapsed?: boolean               // collapsed-секции в истории
  checkpoints?: boolean

  services?: Record<string, { methods: string[]; streams: string[] }>   // v1.11: ключ — plugin.id; {} — слой есть, сервисов нет
  skins?: { save?: boolean; select?: boolean }   // v1.21: скины как данные (skin-spec §5); save ⇔ skins.save, select ⇔ skins.select
  plugins?: ExternalPluginInfo[]                 // v1.24: внешние плагины фронта (core-boundary-spec §3): что грузить до первого рендера
}
```

Ядро (обязательное для любого бэкенда): capabilities, список сессий, создание/открытие, история, run со стримом. Всё остальное опционально.

UI-контракт: отсутствующая capability = фича скрыта/погашена. UI не эмулирует чужие фичи и не шлёт операции вне заявленных capabilities.

---

## 4. Операции

Абстрактные операции; HTTP-биндинг — §9. Все ответы в envelope:

```ts
interface Envelope<T> {
  ok: boolean
  result?: T
  error?: string
  code?: string           // машинный код ошибки: 'not_supported' | 'busy' | ... (добавлено 16.07, требование backends-spec §3.1)
  version?: string        // sync-токен сессии (см. §8)
}
```

### 4.1 Ядро

| Операция | Вход | Выход |
|---|---|---|
| `capabilities()` | — | Capabilities |
| `sessions.list(opts?)` | workspace? — id проекта (v1.26, workspace.projects; без — все) | SessionInfo[] |
| `sessions.create(opts)` | botId?, greetingId?, personaId?, title?, model? (models), profile? — id \| ProfileDoc (profiles), cwd? — абсолютный каталог (v1.20, workspace.perSession), workspace? — id проекта (v1.26: его `$root`/`$profile`/`$model`, если не заданы явно) | SessionInfo |
| `sessions.get(id)` | — | SessionInfo |
| `sessions.delete(id)` | — | — |
| `history(id)` | — | { messages: Message[], version } |
| `run.start(id, input)` | см. §5 | стрим событий |
| `run.cancel(id, runId)` | — | — |

### 4.2 Capability-gated

| Операция | Capability |
|---|---|
| `sessions.fork(id, atMessageId?)` | fork |
| `sessions.rename(id, title)` | edits |
| `messages.edit(sid, mid, parts \| text, ifHash?)` | edits.edit |
| `messages.delete(sid, mid)` | edits.delete |
| `messages.hide(sid, mid, hidden)` | edits.hide |
| `messages.swipe(sid, mid, dir \| index)` | swipes |
| `ask.respond(sid, askId, answer)` | ask |
| `catalog.bots()` / `catalog.bot(id)` / `catalog.asset(...)` | catalog |
| `personas.list(sid)` → `{personas, userId?}` | personas (v1.9) |
| `personas.save(sid, personas, userId?)` → применённый документ | personas.edit (v1.9) |
| `sessions.meta.get/patch(id)` | sessionMeta |
| `messages.append(sid, parts, {role?, swipeOf?})` → Message | edits.append (`swipeOf` — ещё swipes) |
| `attachments.put(sid, name, data, mime?)` → `{ref, part}` | attachments |
| `attachments.get(sid, ref)` → `AttachmentContent` | attachments.get (v1.10) |
| `models.list()` | models |
| `models.set(sid, {model, thinking?})` | models.select |
| `workspace.current()` / `workspace.list()` | workspace |
| `workspace.switch(id)` | workspace.switch |
| `workspace.create(project)` / `workspace.update(id, patch)` → WorkspaceInfo | workspace.edit (v1.26) |
| `profiles.list()` / `profiles.get(id)` | profiles |
| `profiles.set(sid, id \| ProfileDoc)` → ProfileInfo | profiles.switch |
| `profiles.save(doc)` / `profiles.delete(id)` / `profiles.duplicate(id, newId)` | profiles.edit |
| `catalogs.tools()` / `catalogs.skills()` / `catalogs.extensions()` | catalogs.tools / .skills / .extensions |
| `services.call(plugin, method, args?)` → JSON | services[plugin].methods (v1.11) |
| `services.stream(plugin, method, args?)` → AsyncIterable `{name, payload?}` | services[plugin].streams (v1.11) |
| `services.url?(plugin, path)` → string (синхронно; только HTTP-транспорт) | services[plugin].methods ∋ `http` (v1.14) |

Сервисы (v1.11, plugin-services-spec §2): незаявленный плагин/метод — `not_supported` до кадров; throw хендлера — у call `ok:false` с message, у открытого стрима — кадр `{name:'error', payload:{message, code?}}` и конец. Закрыть стрим (`stream.close` / обрыв SSE / `break`) — сервису abort.

`messages.edit` принимает либо полный `parts: Part[]`, либо `text: string` (шорткат: заменить text-части одним text-part, остальные сохранить — семантика бэкенда, задекларировать в адаптере).

`messages.swipe` переключает активный путь: меняется не одно сообщение, а весь хвост от точки свайпа до листа. Ответ несёт новый `version`; клиент делает resync через `history()` (§8.x). Общее правило: любая мутация, меняющая активный путь дальше затронутого сообщения (swipe; edit/delete при fork 'tree'), → version + полный resync, частичных диффов истории в v1 нет (добавлено 18.07).

**Вложения и append (v1.3, v1.6).** `attachments.put` сессию не мутирует: пишет байты и возвращает `ref` с готовой частью (текст извлечён, `meta.tokens` посчитан); превышение лимита или неподдержанный тип — `bad_request`. Сообщение появляется только через `messages.append`: он дописывает в активную ветку **без рана** и возвращает записанное `Message` (id, hash, swipes — как из `history`); посреди рана — `busy`. `role: 'assistant'` — реплика без рана (гритинг бота). `swipeOf: mid` — альтернатива существующему сообщению: сиблинг с тем же родителем и ролью цели (явная другая роль — `bad_request`), он же становится активным.

**Профили (v1.4–v1.6).** Профиль — свойство процесса бэкенда: `profiles.set` применяется к следующему рану, посреди рана — `busy`, неизвестный id — `bad_request`. Вместо id в `sessions.create` и `profiles.set` можно передать `ProfileDoc` — он встраивается в сессию (`SessionInfo.profile: 'inline'`, документ — в `profileDoc`), каталог не трогается. `profiles.save`/`delete`/`duplicate` правят каталог и живые сессии не трогают: новые настройки применяются при следующем спавне процесса, `session_update` не шлётся. `default` не удаляется (`bad_request`), занятый `newId` — `conflict`, неизвестный id в `get` — `not_found`.

**Модели и пространство (v1.1–v1.2).** `models.set` применяется к следующему рану, посреди рана — `busy`. После `workspace.switch` клиент обязан перечитать `sessions.list`: прежние id — из другого пространства.

---

## 5. Run и стрим

### 5.1 Старт

```ts
run.start(sessionId, {
  userMessage?: string | Part[]    // append user-сообщения перед генерацией
  personaId?: string               // чей ход: id char-персоны (v1.9); без него — активная char
  regenerate?: { messageId }       // пересгенерировать: бэкенд сносит ран целиком, не последний message
  segments?: unknown[]             // v1.13: типизированное действие (кнопки, режимы композера); схема — бэкенда
  wish?: string                    // v1.13: пожелание рассказчику — не реплика, в ленту не пишется
  command?: { name: string; args?: string }  // v1.18: команда вместо хода (`compact`); не в run.commands — not_supported
  target?: { kind: 'user' } | { kind: 'char'; personaId?: string }  // v1.19: кто отвечает; user — impersonate (гейт impersonate)
})
```

**Адресат хода (v1.19).** `target` — кто отвечает этим раном. `{kind: 'char', personaId?}` равносильно `personaId`. `{kind: 'user'}` — impersonate: бэкенд собирает промпт «от лица» игрока (тот же system, что у бота; шаблон impersonate профиля; тайные поля персоны игрока — только здесь), `userMessage` — не реплика, а указание (`{{input}}` шаблона), в ленту не пишется. Ответ — обычные события сообщения `role: 'user'` (`meta.personaId` — персона игрока), но сообщение **не записано**: `history` его не вернёт, `run_end.version` прежний. Промпт рана — кадр `activity` с `kind: 'prompt'` (`PROMPT_ACTIVITY_KIND`), payload — `PromptView` (+ `sent`: запрос ролями и текстом, как ушёл провайдеру). Не заявлена capability `impersonate` — `not_supported` до `run_start`; с `command`/`regenerate` — `bad_request`. Почему не новый `RunEvent` и не флаг в meta: ядро событий закрыто, а клиент, пустивший ран с `target`, и так знает, что сообщение — черновик (DECISIONS nrchat.dev 04.10).

Пустой input без regenerate = «продолжай» (continue): модель говорит следующей репликой, user-сообщение в ленту не пишется. С v1.10 это capability `run.continue`: не заявлена — бэкенд отвергает такой run() `not_supported` **до `run_start`** (не ошибкой рана), а UI не показывает «продолжить». pi-bridge заявляет её при расширении `pi-ext-session-meta` ≥0.5: у RPC pi continue нет, ход идёт командой расширения `/nr-continue` (реплика-маркер с флагом `nrContinue`, в ленте её нет). `personaId` — чей ход (v1.9). `segments` (v1.13) — вход без текста: UI собрал действие сам (у nr-play — сегменты gamentic, интерпретатор свободного текста пропускается); ран с одними `segments` — не «продолжай», гейт `run.continue` к нему не относится. `wish` — ремарка к ходу; с пустым входом — «продолжай» с пожеланием. Ядро UI и транспорт оба поля не трактуют.

### 5.2 События

```ts
type RunEvent =
  | { type: 'run_start';     runId: string }
  | { type: 'message_start'; runId: string; message: { id: string; role: string; name?: string; meta?: MessageMeta } }   // meta — v1.15
  | { type: 'part_start';    runId: string; messageId: string; part: number;
      partType: Part['type']; meta?: Record<string, unknown> }
  | { type: 'part_delta';    runId: string; messageId: string; part: number;
      delta: string; mode?: 'append' | 'replace' }
  | { type: 'part_end';      runId: string; messageId: string; part: number;
      payload?: Part }                        // финальный part (для tool_use — с input, и т.п.)
  | { type: 'message_end';   runId: string; message: Message }   // финальный DTO
  | { type: 'ask';           runId: string; askId: string; kind: string; payload: unknown }
  | { type: 'activity';      runId: string; kind: string; payload?: unknown }
      // эфемерный статус рана: суб-агенты, стадии, прогресс. Не персистится, UI вправе игнорировать
  | { type: 'session_update'; runId: string; fields?: string[] }
      // стейт сессии изменился посреди рана (game state, meta). Клиент перечитывает sessionMeta
  | { type: 'run_end';       runId: string;
      status: 'done' | 'cancelled' | 'error';
      error?: { message: string; code?: string };
      usage?: Usage; version: string }
```

Правила:

- **id-first**: message_start несёт id до появления контента. UI сразу имеет адрес для рендера.
- part_delta по умолчанию append. `mode: 'replace'` — для snapshot-бэкендов (opencode шлёт снапшоты part; адаптер вправе не диффать).
- user-сообщение, добавленное run.start'ом, тоже едет событиями (message_start + message_end) — клиент не дублирует его локально по догадке.
- Порядок гарантирован внутри рана. Вложенности нет: part_start N+1 закрывает семантику «текущего» part, но part_end обязателен (несёт payload).
- run_end.version — новый sync-токен сессии.
- `run_end.error.code` — машинный код причины, если бэкенд его знает. Известный: `max_turns` — цикл агента упёрся в лимит ходов; ходы до лимита уже в сессии, ран можно продолжить (ран без `userMessage`, `run.continue`), а не повторять.
- События неизвестного типа клиент игнорирует.

### 5.3 Ask

```
сервер:  { type: 'ask', runId, askId, kind: 'permission', payload: { tool: 'bash', input: {...} } }
клиент:  ask.respond(sessionId, askId, { allow: true })
```

- Run приостановлен до ответа (или таймаута бэкенда — тогда run_end/error или продолжение с дефолтом, декларирует бэкенд).
- Kinds ядра: `permission` (allow/deny), `select` (выбор из options), `text` (свободный ввод). Список расширяем — заявленные kinds в capabilities.ask.
- Ask транзиентен: в историю не пишется протоколом; бэкенд волен оседать результат обычным сообщением/part.
- Неизвестный kind → UI показывает generic-диалог с JSON payload и кнопками из `payload.options`, если есть; иначе только cancel.
- Расширенные kinds (v1.16–v1.23): `tool` (тул сессии), `tool_approval` (апрув вызова), `prompt` (отладка промпта, v1.23: окно «что уйдёт модели» до провайдера, ответ `PromptDebugAnswer`).

### 5.4 Reconnect (v1 — минимализм)

События рана не реплеятся. Клиент потерял стрим → `history(id)` + version, живой ран для клиента потерян (run продолжается на сервере; итог виден через history). Reattach к живому рану — вне v1, кандидат в v2 (см. открытые вопросы).

---

## 6. Маппинг: nr-engine / dreams

Самый близкий бэкенд. Изменения против текущего протокола dreams:

| dreams v1 | nr-ui-protocol |
|---|---|
| `delta {text}` | `part_delta` в text-part |
| `thinking {text}` | `part_delta` в thinking-part |
| `tool_use {name,id,input}` | `part_start(tool_use)` + `part_end{payload}` |
| `tool_result {id,content,error}` | `part_start(tool_result)` + `part_end{payload}` |
| `user_appended {message}` | `message_start` + `message_end` |
| `done {message, version}` | `message_end` + `run_end` |
| `cancelled {version}` | `run_end{status:'cancelled'}` |
| MessageDTO.content первичен | Message.parts первичен, content derived |
| id в done | id в message_start (id-first) |

ContentBlock (message-format-spec) ↔ Part — почти 1:1: text, thinking, tool_use, tool_result, summary→custom(hint:'nr.summary'), usage→Message.meta.usage. `%role`-envelope атрибуты → flags/meta. *(18.07: синтаксис хранения `` ````%type `` — легаси; канон хранения parts — `%%`-суб-ноды nr-session-spec §4, модель ContentBlock↔Part при этом не меняется.)*

Требования к nr-engine:

1. StreamEvent v2 = RunEvent (или изоморфен, с адаптером в один экран).
2. id-first: FileSession выдаёт id (стабильный или pos:N) в момент старта генерации.
3. `regenerate` сносит ран целиком (assistant + tool_result + assistant до предыдущего user), не `removeLast('assistant')`.
4. Ask — новый примитив в orchestrator hooks (handleToolUse уже есть; permission-ask — его брат).

Capabilities dreams: edits ✓, swipes ✓, fork 'copy', cancel ✓, ask ['permission'] (позже), catalog ✓, personas ✓, sessionMeta ✓, collapsed ✓, checkpoints ✓, attachments ✓.

## 7. Маппинг: pi

Адаптер = серверный мост (pi — stdio-процесс: `pi --mode rpc`, JSON по stdin/stdout; либо чтение session JSONL v3 для read-only).

| pi | nr-ui-protocol |
|---|---|
| session JSONL v3 запись | Message (через логику pims) |
| message_start / update / end | message_start / part_delta / message_end |
| content blocks (text, thinking, toolCall) | parts |
| tool_execution_start | part_start(tool_result) |
| tool_execution_update | part_delta **mode:'replace'** в tool_result (partialResult — накопленный снапшот, НЕ дельта; append задваивал бы вывод) |
| tool_execution_end | part_end |
| message_start/end того же toolResult-сообщения | дедуп: pi шлёт результат тула дважды (tool_execution_* + message_*), адаптер эмитит один раз |
| agent_settled | терминал рана (НЕ agent_end — после него возможен авторетрай) → run_end |
| дерево (parentId) | активный путь root→leaf = history; sibling-ветки assistant-узла = swipes; выбор другого leaf = fork 'tree' |
| compaction / branch_summary / custom / label | custom part (hint: 'pi.compaction', ...) |
| session_info / model_change | SessionInfo / Message.meta.model |

Capabilities pi-bridge: edits ✓ (edit/delete/hide/swipe; правка между ранами, подписи правленого дропаются), swipes ✓ (derived из дерева), fork 'tree', cancel ✓, ask ✗ (у pi нет permission-системы), catalog ✗, personas `{edit, multi}` и run.continue — при расширении pi-ext-session-meta (v1.9, v1.10), attachments `{…, get}`.

Контрактные факты pi (сняты с 0.80.6 при имплементации backend-pi, 16.07 — нормативно для адаптера):
- **id по стриму не приезжает** (entry_appended — только для расширений, персист после эмита): id-first — позиционные id, стабилизация на message_end через `get_entries {since}`.
- **Активный лист = последняя строка файла** (нигде не хранится отдельно): swipe = перестановка поддерева, ветки не теряются. Правки — по дереву (id цели известен); «лента первична» (правило pims) действует для активного пути; буквальная пересборка всей ленты сносила бы sibling-ветки (= убивала swipes). Правило pims «лист по max timestamp» с pi НЕ совпадает — не копировать.
- **Continue невозможен**: генерацию запускает только prompt, всегда дописывающий user-сообщение. Пустой run() → ошибка not_supported (легально, см. §5.1); regenerate = новая ветка, свайп садится на user-узел.

Заметь: pims уже содержит 80% маппинг-логики (10 типов записей → mds ↔ Message). Адаптер переиспользует её, не дублирует.

## 8. Маппинг: opencode

Адаптер = тонкий прокси на `opencode serve` (HTTP + OpenAPI SDK).

| opencode | nr-ui-protocol |
|---|---|
| session | Session |
| message (assistant/user) | Message |
| text / reasoning / file part | text / thinking / file part |
| tool part (pending→running→completed) | tool_use part (input) + tool_result part (стрим output); state running = tool_result открыт |
| глобальный SSE /event | адаптер фильтрует по sessionId → per-run стрим |
| message.part.updated (снапшоты) | part_delta mode:'replace' (или дифф на адаптере) |
| permission request | ask kind:'permission'; ответ → respond-эндпоинт opencode |
| revert | вне v1 (custom-операция или игнор) |

Capabilities opencode-bridge: edits частично, swipes ✗, fork ✗ (v1), cancel ✓, ask ['permission'], catalog ✗, personas ✗.

Точный список эндпоинтов/событий — сверить с OpenAPI-спекой `opencode serve` на момент имплементации адаптера (API у них движется).

## 8b. Валидация: Marinara (агентный RP-движок)

Не адаптер (свой фронт заменяет марину), а проверка протокола на выразительность в агентном RP. Источник — разбор кодовой базы (.context, generation-pipeline/agents).

| Marinara SSE / механика | nr-ui-protocol |
|---|---|
| token / thinking | part_delta (text / thinking) |
| content_replace (пост-процессинг переписывает отстримленное) | part_delta mode:'replace' |
| agent_update (thought bubbles, debug суб-агентов) | activity |
| game_state | session_update + sessionMeta |
| CYOA choices | ask kind:'select' |
| pendingCardUpdates (аппрув правок карточки) | ask kind:'permission' |
| regenerate-as-swipe | swipes + run.start regenerate |
| presets, lorebooks, contextKind, батчинг агентов | вне протокола (бэкенд-внутрянка) — граница подтверждена |

Вывод: агентный RP-кейс покрывается ядром + activity/session_update. Отдельных RP-примитивов протоколу не нужно.

---

## 9. Референсный HTTP-биндинг

```
GET    /capabilities
GET    /sessions                      list
POST   /sessions                      create
GET    /sessions/:id                  get
DELETE /sessions/:id                  delete
POST   /sessions/:id/fork
PATCH  /sessions/:id                  rename / meta
GET    /sessions/:id/meta             sessionMeta.get
GET    /sessions/:id/history          { messages, version }
POST   /sessions/:id/run              → SSE-стрим RunEvent (event: <type>, data: json)
POST   /sessions/:id/cancel           { runId }
POST   /sessions/:id/respond          { askId, answer }
PATCH  /sessions/:id/messages/:mid    edit  { parts|text, ifHash }
DELETE /sessions/:id/messages/:mid
POST   /sessions/:id/messages/:mid/swipe { dir|index }
POST   /sessions/:id/messages/:mid/hide  { hidden }
POST   /sessions/:id/messages         append { parts, role?, swipeOf? }                  (v1.3, v1.6)
PUT    /sessions/:id/attachments      raw body, x-name, content-type → { ref, part }    (v1.3; POST — тоже)
GET    /sessions/:id/attachments/:ref AttachmentContent — байты вложения                 (v1.10)
GET    /sessions/:id/personas         { personas, userId? }                             (v1.9)
PUT    /sessions/:id/personas         { personas, userId? } → применённый               (v1.9)
POST   /sessions/:id/model            { model, thinking? }                              (v1.1)
POST   /sessions/:id/profile          { id } | { doc } — ровно одно                     (v1.4, v1.6)
GET    /models                                                                          (v1.1)
GET    /workspace, /workspaces        current, list                                     (v1.2)
POST   /workspace                     { id } — switch                                   (v1.2)
GET    /sessions?workspace=           сессии проекта                                    (v1.26)
POST   /workspaces                    WorkspaceProject & { id? } — новый проект        (v1.26)
PATCH  /workspaces/:id                WorkspaceProjectPatch — правка проекта            (v1.26)
GET    /profiles                                                                        (v1.4)
GET|PUT|DELETE /profiles/:id          get / save (id — из адреса) / delete              (v1.5)
POST   /profiles/:id/duplicate        { id }                                            (v1.5)
GET    /catalogs/tools, /catalogs/skills, /catalogs/extensions                          (v1.5)
GET    /bots, /bots/:id, /bots/:id/assets/:file
POST   /services/:plugin/:method      { args? } → результат                             (v1.11)
POST   /services/:plugin/:method/stream { args? } → SSE: event: service_event {name, payload?}, …, event: service_end   (v1.11)
POST   /services/_mux/stream { streams: [{key, plugin, method, args?}] } → SSE: event: service_mux {key, name, payload?} | {key, end: true}   (v1.68)
GET    /services/:plugin/http/<путь>?<query> → call(plugin,'http',{method,path,query,headers}) → {status, headers, body: string|{__b64}} как есть, не Envelope (v1.14)
GET    /skins[?session=<id>]          → SkinInfo[]                                       (v1.21, skin-spec §5)
GET    /skins/:name.css[?session=<id>] → text/css (собранный, не Envelope); сломанный — 400, нет — 404   (v1.21)
PUT    /skins/:name.css {css, sessionId?, base?, mode?, description?} → SkinSaveResult  (v1.21, capability skins.save)
PUT    /skins/current {name, mode}    → —                                               (v1.21, capability skins.select)
GET    /plugins/:id/<путь>             → файл dist/ плагина (не Envelope, no-cache); нет — 404     (v1.24, capability plugins)
GET    /plugins/events                 → SSE `plugin_changed {id, version}` — бандл пересобран     (v1.24)
```

Стрим сервиса без кадра `service_end` перед закрытием — обрыв: клиент отдаёт кадр `error` с `code: 'connection_lost'`. Закрытое клиентом соединение — отмена (сервису abort).

`GET /personas`, `/personas/:id` и `personas.get(id)` сняты в v1.9 без депрекации: персоны живут в сессии, каталог уровня окружения — вне v1.9.

SSE-кадр: `event: part_delta\ndata: {...}\n\n`. respond — отдельный POST (SSE однонаправлен). WS-биндинг возможен позже, протокол не меняется.

Keepalive стрима рана (17.10.2026): `POST /run` и `GET /attach` начинают поток комментарием `: keepalive` и повторяют его раз в 25 с, пока ран ждёт ask или долгий тул. Клиент (`nr-chat-client`), увидев `: keepalive`, включает сторож тишины: нет ни байта дольше `idleTimeoutMs` (60 с) — синтетический `run_end{error, code: connection_lost}`, UI подхватывает ран через `attach` (снимок отдаёт и ждущий ask). Сервер без keepalive — сторожа нет (долгий тул ≠ обрыв).

### 8.x Version (sync)

`version` — opaque строка состояния сессии. Клиент шлёт её в мутациях опционально; расхождение → бэкенд вправе ответить полным resync (history). Наследует OperationResponse.scope-семантику nr-engine-spec §8.2, но scope в v1 не тащим: resync = клиент сам дёргает history.

---

## 10. Открытые вопросы

1. **Параллельные раны** в одной сессии (два агента одновременно). v1: один активный run на сессию, run.start при живом ране → error. Снять ограничение в v2?
2. **Reattach к живому рану** после reconnect (replay по offset / last-event-id). v2.
3. **Group chat**: выбор говорящего — personaId в run.start достаточно, или нужен ask kind 'speaker'?
4. **Collapsed/checkpoints на проводе**: history отдаёт collapsed-ссылку как custom part (hint:'nr.collapsed') + операция expand, или отдельные операции? Пока custom + `GET .../collapsed/:cid`.
5. ~~**Attachments upload**: multipart POST → ref, ref в file-part.~~ **Закрыто (backend-mds-spec §7):** `ProtocolBackend.attachments?.put(sid, name, data, mime?) → {ref}` (опциональный блок ↔ capability `attachments`); транспорт — `POST /sessions/:id/attachments` с raw-телом и заголовками `x-name`/`content-type` (без multipart-парсера, zero-dep). UI кладёт `ref` в file/image-part своего сообщения при `run.start`. **Уточнено v1.3 (attachments-spec §2):** `put` отдаёт `{ref, part}`, роут принимает и PUT, и POST, а вложение ложится отдельным сообщением через `messages.append` без рана — не частью `run.start`.
6. **Auth**: вне протокола (заголовки транспорта), но capability `auth?` может понадобиться для публичного dreams.
7. **Имя пакета**: @kerneldreams/ui-protocol (типы + маппинг-хелперы) — или типы живут в nr-engine? Склоняюсь к отдельному пакету: pi/opencode-адаптеры не должны тянуть движок.
