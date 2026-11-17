# Context Engine — спека v2

**Статус:** закрыта, готова к реализации (CC-таска)
**Заменяет:** `S:\appz\chat2\docs\context-engine-spec.md` (черновик 2 от 10.06.2026)
**Дата:** 08.07.2026
**Живёт:** модуль в nr-engine (решение №5: session/assembler уже здесь, движок потребляет ISession; отдельный пакет — dependency-танцы без выгоды; интерфейсы чистые, выдернуть потом дёшево)
**Зависит от:** nr-engine FileSession (+ пререквизиты §10), nrd-core (IContext/chainContext/resolve), nr-infra (LLM types)

---

## 0. Принятые решения (08.07, диалог)

Сводка десяти решений, определяющих отличия v2 от черновика:

1. **Untrusted = отсутствие ambient authority.** Чужой контент (карточка, лорбук, импорт) резолвится только об ContextPackage-скоуп: без env-слоя, без fs-функций, без executor'а с правами процесса. Не запрет кода — выбор драйвера и цепочки. Механизм — `trusted: false`. Дефолт для всего своего — trusted, полная власть.
2. **Конфиг движка — данные, не TS-объекты.** Все настройки — атрибуты `$ctx-*` в каскаде (сессия > карточка > конфиг), обычный chainContext. TS-интерфейсы — только внутреннее представление после чтения из цепочки.
3. **События — через hooks nr-engine** (RunInput.hooks / StreamEvent-канал). Собственного эмиттера у движка нет.
4. **Trace — decision log** в `meta.decisions` + `--cmd=trace` в chat3 (dry показывает результат, trace — причины).
5. **Движок — модуль nr-engine.**
6. **`$collapsed: id` и `%summary`-блок в FileSession — пререквизит** этапа 2 (§10). Checkpoints, форки, attachments — осознанно позже.
7. **Injector: async `scan()` + инжектируемые capabilities + injector-в-документе.** Маринаровские pre-gen агенты (memory recall, world state) = injector'ы с LLM внутри.
8. **Бот-бандл** (данные + tools + injectors + hooks + стейт-блоки + манифест) — архитектурный слой в спеке, реализация — этап 3. Интерфейсы этапа 2 обязаны его не исключать.
9. **`$visibility: ui | model | both`** на блоках сообщений и инъекциях.
10. **Dogfooding:** LorebookInjector — первый плагин на публичном шве, ноль приватных хуков. Дыра в интерфейсе чинится в интерфейсе.

Урок платформ (Stages площадок карточек, Janitor user-scripts): платформа выигрывает не набором фич, а достаточностью примитива. Janitor не строил лорбуки — юзеры собрали их на шве. Юзер площадки собрал полный RPG (чарлисты, инвентарь, квесты) на Stages без правки платформы. **Критерий приёмки архитектуры: полный RPG-бот собирается на швах этой спеки без правки движка.**

---

## 1. Назначение

Без изменений против v1: движок решает **что** попадает в контекст LLM (какие сообщения, полные или summary, какие инъекции), не **как** оформляется (это ntpl/assembly).

Вход: сессия + карточка + персона + injector'ы + бюджет.
Выход: **ContextPackage** (IContext) → Prompt Assembly → LLMMessage[].

Разделение ответственности:
- Engine решает ЧТО включить; scoring + бюджет
- Injector'ы возвращают matched entries с тегами и метаданными
- Template решает КУДА положить (порядок, обёртки) — `tags` на инъекциях лишь подсказка

---

## 2. Конфигурация — атрибуты в каскаде (решение №2)

Движок читает конфиг из IContext-цепочки (та, что уже есть у chat3/runz: CLI > сессия > карточка > конфиг). Никаких отдельных конфиг-файлов движка.

| Атрибут | Дефолт | Смысл |
|---|---|---|
| `$ctx-max-tokens` | из провайдера/модели | context window |
| `$ctx-reserve-output` | 1024 | резерв под ответ |
| `$ctx-recent-depth` | 5 | N: полный набор блоков |
| `$ctx-summary-depth` | 30 | M: порог замены на summary |
| `$ctx-tools-in-middle` | false | tool-блоки в средних сообщениях |
| `$ctx-card-score` | 10000 | base score карточки |
| `$ctx-history-score` | 1000 | base score свежей истории |
| `$ctx-summary-score` | 500 | base score summarized-истории |
| `$ctx-collapsed-score` | 750 | score collapsed-summary (среднее fresh/old, v1 открытый №4 — закрыт) |
| `$ctx-examples-score` | 100 | dialogue examples |
| `$ctx-scan-depth` | 10 | глобальная глубина сканирования injector'ов |
| `$lorebooks` | — | список лорбуков сессии (name-list) |

Следствия бесплатны: пер-сессионный оверрайд — дописать строку внизу файла (блокнот, last-wins); CLI-оверрайд — существующий каскад; chat3-wiring — движок читает из ctx, который уже прокинут.

Внутреннее представление: `readEngineConfig(ctx): EngineCtxConfig` — единственная точка чтения, дальше движок работает с типизированным объектом.

---

## 3. Assembly

### 3.1 Scoring — без изменений против v1

Рюкзак по score. `Infinity` — frozen/system (не влезло → ошибка). Жадный набор по score desc, **без density-оптимизации** (v1 открытый №5 — закрыт: жирный entry с высоким score честно вытесняет мелочь, предсказуемо как в Таверне; trace покажет).

```ts
interface ScoredItem {
  content: string
  tokens: number
  score: number
  source: 'system' | 'card' | 'history' | 'injector' | 'example'
  metadata: Record<string, unknown>
}
```

Recency boost для injector entries — как в v1: триггер свежим сообщением → выше.

### 3.2 Алгоритм — как в v1 §3.3, с дельтами

```
1. Обязательные (Infinity): system, frozen → если > available → ошибка
2. Card data → scored items
3. Injector'ы (§5, async) → scored items
4. История: skip $hidden · $collapsed: id → один item из тела ссылки ·
   block filtering по глубине (§4) · %summary-блок → замена text для старых
5. Examples → низкий score
6. Сортировка по score desc → набор в бюджет
7. ContextPackage + decision log (§7)
8. Не влезло → hook 'budget:exceeded' (§6)
```

### 3.3 ContextPackage — как в v1 §3.4, плюс:

```ts
interface ContextPackage {
  card: IContext
  persona: IContext
  messages: ContextMessage[]
  injections: TaggedInjection[]
  examples: string[]
  meta: {
    totalTokens: number
    budget: number
    historyFull: number
    historySummarized: number
    historyDropped: number
    injectionsMatched: number
    injectionsIncluded: number
    injectionsDropped: number
    dropped: DroppedItem[]
    decisions: Decision[]      // НОВОЕ — §7
  }
}
```

**Резолв чужого контента (решение №1):** текст карточки, лорбука и любых injector-данных, пришедших извне, резолвится только об ContextPackage-скоуп (untrusted-цепочка nrd-context: без env, без fs-функций, без маунтов). Одна строка, весь класс дыр (`${sys.gitea.token}` в лоре чужого бота) закрыт по построению.

---

## 4. Block Filtering + $visibility (решение №9)

Таблица глубины — как в v1 §3.5 (recent: text+thinking+tools; middle: text; old: summary-если-есть; usage/embedding/annotation — никогда).

**Новое — ось видимости.** На блоке сообщения и на инъекции:

```
$visibility: model | ui | both     (дефолт: both)
```

- `model` — уходит в контекст, не показывается в UI (служебные инъекции)
- `ui` — показывается юзеру, НЕ уходит модели. Кейс площадок карточек: стат-панель, инвентарь, карта — модель, видящая свои стат-блоки в истории, начинает их имитировать. Площадка для этого хранит system-сообщения отдельно от ответов LLM; у нас та же семантика достигается флагом на блоке ленты.
- `both` — обычное поведение

Фильтр видимости применяется ДО глубинного фильтра. Assembler получает уже отфильтрованное.

---

## 5. Injectors

### 5.1 Интерфейс (решение №7 — async + capabilities)

```ts
interface IContextInjector {
  id: string
  scan(context: ScanContext, caps: InjectorCapabilities): Promise<InjectedEntry[]>
}

interface InjectorCapabilities {
  llm?: LLMCallFn          // provider.chat-обёртка; нет — injector без LLM
  storage?: IStorage       // scoped: свой namespace, не вся ФС
  log: Logger
}
```

Driver pattern: власть injector'а определяется тем, что инжектнули, не тем, что запретили. Маринаровский pre-gen агент (memory recall с embedding-вызовом, world-state tracker) — обычный injector с caps.llm. Post-gen агенты = afterTurn hooks (§6), отдельного механизма нет.

ScanContext / InjectedEntry — как в v1 §4.1, плюс в InjectedEntry:
- `visibility?: 'model' | 'ui' | 'both'` (§4)
- `matchedKeys?: string[]` — какие ключи сработали (для trace §7)

### 5.2 LorebookInjector — первый плагин (решение №10)

Реализуется СТРОГО через публичный IContextInjector + caps. Ни одного приватного хука в движок. Matching-алгоритм — v1 §4.2 без изменений (primary OR, secondary AND, constant, cooldown, scanDepth; recursive — не в MVP). Формат — mdd, v1 §4.6 (ST JSON — импортером, с потерей exotic-полей).

Привязка — v1 §4.7: per-session (`$lorebooks`) > per-card > global, конфликты по id — ближний побеждает.

### 5.3 Injector-в-документе (решение №7)

Injector объявляется в mdz-документе (карточка, сессия, конфиг) — по образу playground action-блоков:

```
## $injector world-state
$nr-type: script        ← TS-файл или инлайн-тело
$tags: @[world, at_depth]
$priority: 800
...тело: путь к .ts или инлайн-код...
```

Загрузка — через nrd-exec/loader machinery (существующая). Исполнение — executor'ом хоста: твой ноут — полные права; платформа (закрытые генерённые боты) — песочный драйвер + scoped storage + caps без fs/env. LLM-generated код недоверен по построению — и не требует ревью, потому что физически не может больше, чем ему дали.

### 5.4 Embed / RAG / Memory — как v1 §4.3–4.5, не в MVP. Все — тот же интерфейс.

---

## 6. События — hooks, не эмиттер (решение №3)

`IContextEngine.on()` из v1 — удалён. События едут существующим каналом nr-engine (RunInput.hooks):

- `budget:exceeded` { totalRequired, available, dropped } — не всё влезло
- `history:large` { messageCount, totalTokens, suggestedRange? } — рекомендация collapse

Движок compaction/summarization НЕ делает — плагин/UI решает (для РП — дроп норм, для рабочего чата — предложить collapse). afterTurn — как в v1 §2.2 (token stats, injector cooldowns; фоновая суммаризация — no-op в MVP).

---

## 7. Trace — decision log (решение №4)

Движок пишет лог решений во время assembly:

```ts
type Decision =
  | { kind: 'matched';  entry: string; injector: string; keys?: string[]; triggeredBy?: string }
  | { kind: 'scored';   item: string; source: string; base: number; boost?: number; final: number }
  | { kind: 'included'; item: string; tokens: number; budgetLeft: number }
  | { kind: 'dropped';  item: string; reason: 'budget' | 'hidden' | 'filtered' | 'visibility'; detail?: string }
  | { kind: 'replaced'; item: string; by: 'summary' | 'collapsed' }
```

Лежит в `meta.decisions`. chat3: `--cmd=trace` — человекочитаемый рендер (dry = что получилось, trace = почему); `--cmd=trace --json` — machine-readable сразу (задел под ui-protocol, NDJSON-транспорт потом — данные уже готовы). Это дёшево: логируются решения, которые движок и так принимает.

---

## 8. Интеграция

Как v1 §7: `engine.assemble()` → ContextPackage → ntpl render → provider.stream. ContextPackage — IContext, шаблон видит `${card.personality}`, `${messages}`, `injections | tag('lore')`.

```ts
interface IContextEngine {
  assemble(session: ISession, ctx: IContext): Promise<ContextPackage>
  afterTurn(session: ISession, response: ContextMessage): Promise<void>
}
```

`ctx` — цепочка вызывающего (конфиг §2 читается из неё). Кастомные реализации (GameContextEngine и т.п.) — замена всего IContextEngine, v1 §6.2.

---

## 9. Бот-бандл — архитектурный слой (решение №8, реализация этап 3)

Бот-с-механикой = данные + код + стейт, одновременно персонаж и агент:

- **Механики = tools**: кубики, инвентарь — tool_use; оркестратор nr-engine tool-loop уже умеет. Бандл регистрирует свои tools в сессию.
- **Стейт = блоки ленты**: `## $state` / `$charsheet` / `$world` в сессионном файле. Позиция в ленте = версия стейта: блок, дописанный после хода N, по last-wins виден ходам после N; свайп/форк от хода N автоматически видит стейт на момент N — из семантики формата, без кода восстановления (площадки карточек решают это тремя типами state и restore-machinery — у нас бесплатно).
- **Стейт в контекст** — constant-injection из блока (обычный injector).
- **Обновление** — tool-результат или afterTurn hook (post-gen агент).
- **Манифест** склеивает: карточка (mdd) + лорбук (mdd) + tools (TS) + injectors + hooks + engine-конфиг (`$ctx-*`) — по образу meta.mdz скилла.

Этап 2 реализует ТОЛЬКО швы (async caps injectors, hooks, $visibility, стейт-блоки читаются как любые блоки); регистрацию tools из бандла и манифест — этап 3. Интерфейсы этапа 2 обязаны этап 3 не исключать — проверка: RPG-бот из §0 собирается без правки движка.

---

## 10. Пререквизиты в FileSession (решение №6)

До или в составе таски:
1. `$collapsed: id` — ссылочная модель session-format §: сообщение-ссылка, тело = summary диапазона. Engine видит как один item.
2. `%summary`-блок внутри сообщения (message-format-spec) — parse + доступ из ContextMessage.blocks.
3. `$visibility` — атрибут блока, parse + прокидка в blocks[].

Checkpoints, форки, attachments, sidecar-индекс — НЕ в скоупе.

---

## 11. Token counting

Как v1 §5: приближённый (кириллица /3, латиница /4), занижаем бюджет. Pluggable ITokenCounter — потом, когда заболит (v1 открытый №3 — закрыт). Cost tracking — интерфейс LLMUsage предусмотрен, не в MVP.

---

## 12. MVP scope

**Включено:** assemble + бюджет · scoring (конфиг из `$ctx-*` каскада) · $hidden/$frozen/$collapsed → summary · %summary per-message · block filtering по глубине + $visibility · LorebookInjector (async, через публичный шов, keyword, без recursive) · decision log + `--cmd=trace`/`--json` в chat3 · hooks budget:exceeded/history:large · untrusted-резолв чужого контента · пререквизиты §10.

**Не включено:** автосуммаризация · Embed/RAG/Memory injectors · recursive scan · точный tokenizer · cost tracking · бот-бандл/tools-регистрация (этап 3) · ui-protocol/NDJSON (данные готовы через --json).

---

## 13. Критерии приёмки

1. Все существующие тесты nr-engine зелёные; новые: scoring, бюджет, block filtering, $visibility, collapsed/%summary, lorebook matching, untrusted-резолв (env не утекает в контент лорбука), decision log.
2. chat3: `--cmd=dry` показывает промпт с инъекциями; `--cmd=trace` объясняет каждое решение; лорбук из `$lorebooks` сессии срабатывает end-to-end об живой llama-server.
3. Dogfooding-проверка: LorebookInjector не импортирует ничего приватного из движка (grep).
4. Смоук ленты-стейта: блок `## $state`, дописанный между ходами, виден injector'у только после своей позиции.
5. `$visibility: ui` блок присутствует в файле, отсутствует в dry-промпте, помечен в trace как dropped(visibility).

---

## Открытые вопросы v1 — все закрыты

1. Формат лорбука — mdd (было закрыто). 2. Summary-генерация — event-driven, плагин, не MVP. 3. Токены — приближённо, точный когда заболит. 4. Collapsed score — 750 ($ctx-collapsed-score). 5. Лимит entry — нет, жадный score-набор, trace покажет.
