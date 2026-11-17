# nrd-context — Context Assembly

**Статус:** спека v2
**Зависимости (ядро):** `@kerneldreams/nrd`
**Capabilities (приносит потребитель):** `@kerneldreams/nrd/web` (Storage, http), `@kerneldreams/nrd/node` (Executor)
**Расположение:** `S:\nrlib\nrd-context`

## 1. Назначение

Сборка данных из произвольных источников в единый IContext (chain).

Потребители: ntpl, chat2, show, forge, CLI утилиты, Telegram боты, **браузер, Android app** — любой код, которому нужны структурированные данные из нескольких источников.

**Ключевой принцип:** nrd-context не знает про LLM, шаблоны, UI, ботов. Он знает только: «вот конфиг с источниками → вот IContext». Что потребитель делает с контекстом — не его дело.

**Переносимость (как в nrd-exec).** Ядро nrd-context (парс конфига, chain, plugin resolution) зависит только от nrd-core и работает везде, где есть JS. Платформенные возможности — чтение файлов (`Storage`), исполнение кода (`Executor`), сеть (`http`) — **инъектируются через `SourceContext`**, потребитель приносит их под свою платформу. Ровно как `createStorage({ driver })` в core или `execBlock({ executor })`. Тогда `file` source на Node читает диск, а в браузере — localStorage/IndexedDB/REST, и ядро не тянет `node:fs`.

## 2. Архитектура

```
Конфиг (mdz)
  ## $source bot     → source plugin → IContext
  ## $source session → source plugin → IContext
  ## $transform ...  → transform plugin → IContext → IContext
       ↓
  chain(bot, session) → единый IContext
       ↓
  wrapContext(chain) → JS Proxy (для шаблонизаторов)

Capabilities (инъекция, потребитель приносит под платформу):
  storage   — file/json source читают; Sink/Store пишут
  executor  — exec/script source (делегирует nrd-exec.execBlock)
  http      — http source
```

Три примитива:
- **Source** — откуда данные, в каком формате
- **Transform** — модификация IContext → IContext
- **Chain** — композиция с приоритетами

Ядро (`buildContext`, `chain`, plugin resolution) — `nrd-core` only, portable. Плагины используют capabilities из `SourceContext`; если нужной нет — понятная ошибка (как `supports` в Executor).

## 3. Конфигурация

Обычный mdz-документ с `$` сигилом. Может быть отдельным файлом, встроен в шаблон (`<{ nrd }>...<{ endnrd }>`), собран программно.

### 3.1 Source block

```
## $source <name>
$nr-type: <plugin>
...plugin-specific attrs...
```

- `name` — имя в контексте. `## $source bot` → `bot` через `chain.get(['bot'])`.
- `$nr-type` — имя source plugin (**хендлер: как получить данные**). file/inline/json/env/exec/script + внешние.
- `$nr-parse` — **формат: как распарсить полученное** (text/json/mdd/mdz). Отдельно от `$nr-type`.
- Остальные атрибуты — аргументы плагина. nrd-context не интерпретирует, передаёт как есть.

Примеры (обрати внимание: mdd/mdz — это `$nr-parse`, не `$nr-type`):

```
## $source bot
$nr-type: file
$path: ./bot.mdd
$nr-parse: mdd

## $source lorebook
$nr-type: file
$path: ./lorebook.mdz
$nr-parse: mdz

## $source card-bot
$nr-type: cardsite
$resource: characters
$path: alice/first-page

## $source config
$nr-type: json
$path: ./config.json

## $source env
$nr-type: env
$keys: CARDSITE_KEY, LLM_MODEL, LLM_PROVIDER

## $source dynamic
$nr-type: script
$engine: zx
$path: ./fetch-data.mjs

## $source inline-data
$nr-type: inline
$nr-parse: mdz

@name: Luna
@personality: curious, warm
```

### 3.2 Transform block

```
## $transform <name>
$input: <source-name>
$nr-type: <plugin>
...plugin-specific attrs...
```

Принимает IContext, возвращает IContext. Модификация, фильтрация, маппинг.

```
## $transform flatten-greetings
$input: bot
$nr-type: script
$path: ./flatten-greetings.js
```

Если `$input` не указан — получает весь chain на момент вызова.

### 3.3 Chain конфигурация

По умолчанию: порядок `## $source` блоков = порядок chain. Первый = высший приоритет.

Явное переопределение:

```
$chain: bot, lorebook, session
```

Chain = `chain(bot, lorebook, session)` из nrd-core. `get(['name'])` ищет first-wins.

### 3.4 Параметры и подстановки

Корневые атрибуты конфига = параметры. Доступны в `${name}` внутри значений атрибутов блоков:

```
$profile: alice-example
$base_path: S:\bots

## $source bot
$nr-type: file
$path: ${base_path}/${profile}/bot.mdd
$nr-parse: mdd
```

`${name}` резолвится из:
1. Программные аргументы (CLI, вызывающий код)
2. Корневые атрибуты конфига
3. Переменные окружения (fallback)

Программные аргументы перекрывают корневые. Стандартный nrd-core resolve через chain.

### 3.5 Required параметры

```
$required: profile, base_path
```

Если после merge required-параметр отсутствует — ошибка с понятным сообщением.

## 4. Интерфейсы

### 4.1 SourceContext (с capabilities)

```typescript
import type { Value, IContext } from '@kerneldreams/nrd'
import type { Storage } from '@kerneldreams/nrd/web'
import type { Executor } from '@kerneldreams/nrd/node'

interface HttpClient {
  get(url: string, opts?: { headers?: Record<string, string> }): Promise<Result<{ status: number; body: string }>>
  post(url: string, body: string, opts?: { headers?: Record<string, string> }): Promise<Result<{ status: number; body: string }>>
}

interface SourceContext {
  baseDir: string
  params: Record<string, Value>
  log: Logger
  // инъектированные возможности — потребитель приносит под платформу:
  storage?: Storage        // полный CRUD; file/json читают, Sink/Store пишут
  executor?: Executor      // exec/script → nrd-exec.execBlock
  http?: HttpClient        // http source
}
```

Плагин, которому нужна отсутствующая capability, возвращает понятную ошибку («file source requires `storage` in current environment»).

### 4.2 Source plugin

```typescript
export interface SourcePlugin {
  readonly name: string
  resolve(attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext>
}
```

Возвращает IContext. Как получает — его дело (через capabilities из ctx).

### 4.3 Transform plugin

```typescript
export interface TransformPlugin {
  readonly name: string
  transform(input: IContext, attrs: Record<string, Value>, ctx: SourceContext): Promise<IContext>
}
```

### 4.4 Встроенные source plugins

| Plugin | $nr-type | Capability | Описание |
|--------|----------|-----------|----------|
| **file** | `file` | `storage` | Прочитать ресурс по `$path` через storage. `$nr-parse` (text/json/mdd/mdz). |
| **inline** | `inline` | — (portable) | Тело блока = данные. `$nr-parse` формат. |
| **json** | `json` | `storage` | Shorthand для file + json parse. `$path`. |
| **env** | `env` | — (portable) | Переменные окружения. `$keys: KEY1, KEY2`. |
| **exec** | `exec` | `executor` | Shell-команда → `nrd-exec.execBlock` (`$shell`) → результат. `$cmd`, `$nr-parse`. |
| **script** | `script` | `executor` | JS/zx скрипт → `nrd-exec.execBlock` (`$ts`/`$zx`). `$path` или inline body. `$engine: node/zx` → `ts`/`zx`. |

**exec/script делегируют исполнение в `nrd-exec.execBlock`**, передавая `executor` из `SourceContext`. Они НЕ исполняют код сами — собирают виртуальный `$shell`/`$ts`/`$zx` блок и зовут `execBlock({ executor, external: chain })`. Так nrd-context не дублирует исполнение и остаётся переносимым (executor приносит потребитель).

Внешние plugins (площадки, http, db) — отдельные пакеты или файлы в проекте. Подключаются по convention (см. §6).

### 4.5 Parse форматы

После получения сырых данных результат парсится по `$nr-parse`:

| $nr-parse | Действие | Результат |
|--------|----------|-----------|
| `text` | Как есть | `objectContext({ content: rawString })` |
| `json` | `JSON.parse()` → `objectContext()` | IContext из plain object |
| `mdd` | `parseDocument(text, { sigil: '@' })` | IContext |
| `mdz` | `parseDocument(text, { sigil: '$' })` | IContext |

Default: `text`. Если source plugin сам возвращает IContext (или exec/script вернул `value`) — `$nr-parse` игнорируется.

### 4.6 Обратная совместимость $type → $nr-type

Для конфигов, где `$type` уже занят (напр. `$type: chat2` для runz), alias в самом конфиге:

```
$nr-type: ${type}
```

nrd-context ищет `$nr-type` первым; если не найден — fallback на `$type` (где коллизии нет).

## 5. Builder API

```typescript
import { buildContext, wrapContext, chainSources } from '@kerneldreams/nrd'
// Node-комплект capabilities — отдельный экспорт (tree-shake для браузера):
import { nodeCapabilities } from '@kerneldreams/nrd/node'

// Из mdz-конфига на Node (fs + spawn + fetch готовы одной строкой):
const chain = await buildContext(configText, {
  ...nodeCapabilities(),                 // { storage: fsStorage, executor: spawnExecutor, http: fetchHttp }
  params: { profile: 'alice-example' },
  baseDir: __dirname,
})

// Для шаблонизаторов:
const obj = wrapContext(chain)           // JS Proxy, Nunjucks видит обычный объект

// В браузере — потребитель приносит свои capabilities:
const chain = await buildContext(configText, {
  storage: myIndexedDbStorage,
  executor: myInProcessExecutor,
  http: myFetchClient,
  params,
})
```

### 5.1 buildContext()

```typescript
async function buildContext(
  config: string,
  opts: {
    params?: Record<string, Value>
    baseDir?: string
    storage?: Storage                       // capabilities
    executor?: Executor
    http?: HttpClient
    plugins?: Record<string, SourcePlugin>  // дополнительные плагины
  }
): Promise<IContext>
```

1. `parseDocument(config, { sigil: '$' })`
2. Merge params: opts.params > корневые атрибуты
3. Проверить `$required`
4. Собрать `SourceContext` (baseDir, params, log + переданные capabilities)
5. Для каждого `## $source` → plugin по `$nr-type` → `resolve(attrs, ctx)` → IContext
6. Для каждого `## $transform` → plugin → `transform(...)`
7. `chain(sources...)` по порядку `$chain` (или порядку блоков)
8. Вернуть chain

### 5.2 nodeCapabilities() — `@kerneldreams/nrd/node`

```typescript
import { fsStorage, fetchHttp } from '@kerneldreams/nrd/web'
import { spawnExecutor } from '@kerneldreams/nrd/node'

export function nodeCapabilities(): { storage: Storage; executor: Executor; http: HttpClient } {
  return { storage: fsStorage, executor: spawnExecutor, http: fetchHttp }
}
```

Отдельный экспорт `/node` — тянет nr-infra + nrd-exec. Браузерный бандл его не импортит (tree-shake), ядро `@kerneldreams/nrd` остаётся portable (nrd-core only).

### 5.3 wrapContext()

Рекурсивный Proxy. Мост IContext → JS property access. (Реализация без изменений — см. ниже.)

```typescript
function wrapContext(ctx: IContext): object {
  return new Proxy({}, {
    get(_, prop) {
      if (typeof prop !== 'string') return undefined
      if (prop === Symbol.toPrimitive || prop === 'toString' || prop === 'valueOf') {
        const text = ctx.cast('text')
        return () => text ?? ''
      }
      const val = ctx.get([prop])
      if (val && typeof val === 'object' && typeof val.get === 'function') {
        return wrapContext(val as IContext)
      }
      if (val && typeof val === 'object' && typeof val.iterate === 'function') {
        return [...val.iterate()].map(v =>
          v && typeof v === 'object' && typeof v.get === 'function'
            ? wrapContext(v as IContext) : v)
      }
      return val
    },
    has(_, prop) {
      if (typeof prop !== 'string') return false
      return ctx.get([prop]) !== undefined
    },
    ownKeys() {
      // После cast('keys') в nrd-core — честное перечисление ключей.
      const keys = ctx.cast('keys') as string[] | undefined
      return keys ?? []
    },
    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === 'string' && ctx.get([prop]) !== undefined) {
        return { configurable: true, enumerable: true, value: ctx.get([prop]) }
      }
      return undefined
    }
  })
}
```

### 5.4 chainSources() — программная сборка

```typescript
const chain = await chainSources([
  { name: 'bot', plugin: fileSource, attrs: { path: './bot.mdd', parse: 'mdd' } },
  { name: 'session', plugin: cardSource, attrs: { chat_id: 'abc123' } },
], { ...nodeCapabilities(), baseDir: __dirname })
```

Сборка без mdz-конфига — плагины и attrs передаются кодом. Code-плагин здесь — это и есть «богатый in-process» путь (плагин возвращает живой IContext напрямую).

## 6. Plugin Resolution

Upward search от baseDir:

```
./                          ← текущая директория
./.nrd-context/sources/     ← локальные source plugins
./.nrd-context/transforms/  ← локальные transforms
../                         ← уровень выше
../.nrd-context/...
...                         ← до stop-маркера (.git, .server) или корня
<nrd-context>/sources/      ← встроенные (builtin)
```

First-wins. Локальный plugin перекрывает встроенный. Plugin = `.ts` файл с `default export`, реализующий `SourcePlugin` / `TransformPlugin`.

## 7. Будущие расширения (заложено, не реализуется сейчас)

### 7.1 Sink — запись данных

Source — read-only. Для записи — отдельный интерфейс (использует тот же `storage` capability на запись):

```typescript
interface SinkPlugin {
  readonly name: string
  persist(data: IContext, attrs: Record<string, Value>, ctx: SourceContext): Promise<void>
}
```

Источник читает, Sink пишет. Один файл может экспортировать оба (`cardsite.ts` → source + sink). Полный `Storage` capability (с `write`) выбран ровно для того, чтобы Sink/Store не требовали расширять контракт задним числом.

### 7.2 Store — Source + Sink

```typescript
interface StorePlugin extends SourcePlugin, SinkPlugin {}
```

Двусторонние: file (read/write), площадка карточек (fetch/push), session (load/save). Однонаправленные: env, inline — только Source; stdout, webhook — только Sink.

## 8. Scope — что НЕ делаем

- LLM вызовы, стриминг, провайдеры → nr-infra / providers
- Prompt assembly, %role, messages → chat2 / ntpl
- Template rendering → ntpl
- Budget, token counting → chat2 context engine
- Конкретные API (площадки карточек, OpenRouter) → отдельные source/store plugins
- Исполнение кода (zx/shell/ts блоки) → **`@kerneldreams/nrd/node`** (готов); exec/script плагины делегируют в него
- **Реализации capabilities под не-Node платформы** (браузерный Storage-драйвер, inProcess/remote Executor, browser http) → **клиентский код.** Контракты (`Storage`, `Executor`, `HttpClient`) готовы; потребитель приносит реализацию под платформу
- Автодетект окружения / выбор capabilities по умолчанию → забота клиента (`nodeCapabilities()` — удобство для Node, не магия)
- Кэширование, persistence → потребители
- Запись данных (Sink/Store) → §7, будущее расширение

## 9. Примеры конфигов

### 9.1 Простой бот из файлов

```
$required: bot_file

## $source bot
$nr-type: file
$path: ${bot_file}
$nr-parse: mdd

## $source lorebook
$nr-type: file
$path: ./world-lorebook.mdz
$nr-parse: mdz
```

### 9.2 Бот с площадки карточек + сессия

```
$required: character, chat_id
$profile: alice-example

## $source bot
$nr-type: cardsite
$resource: characters
$path: ${profile}/${character}

## $source session
$nr-type: cardsite
$resource: chats
$chat_id: ${chat_id}

## $source user-profile
$nr-type: json
$path: ~/.nrd/profiles/${profile}.json
```

### 9.3 Инлайн (для тестов, простых случаев)

```
## $source card
$nr-type: inline
$nr-parse: mdd

@name: Sophie
@personality: nervous energy, chattiness, disarmingly honest

## $source config
$nr-type: inline
$nr-parse: mdz

$model: openai/gpt-4o-mini
$provider: openrouter
```

### 9.4 Встроенный в ntpl шаблон

```
<{ nrd }>
$required: character
$profile: alice-example

## $source bot
$nr-type: cardsite
$resource: characters
$path: ${profile}/${character}
<{ endnrd }>

# << bot.name >>
<< bot.description >>
<{ for greeting in bot.alternate_greetings }>
## Greeting
<< greeting | safe >>
<{ endfor }>
```

`extractNrd()` (в ntpl) вытаскивает mdz между тегами → `buildContext()` → chain → `wrapContext()` → Nunjucks рендер.

## 10. Зависимости

**Ядро:**
- `@kerneldreams/nrd` — parseDocument, IContext, chain, objectContext, resolve. Больше ничего — ядро portable.

**Capabilities (типы импортируются; реализации приносит потребитель):**
- `@kerneldreams/nrd/web` — `Storage` (file/json source), `HttpClient`/`fetchHttp` (http source). Через `/node` экспорт.
- `@kerneldreams/nrd/node` — `Executor` (exec/script source делегируют `execBlock`). Через `/node` экспорт (`spawnExecutor`).

`buildContext` + ядро плагинов (inline/env) — portable. `file`/`json`/`exec`/`script` требуют соответствующую capability в `SourceContext`. `nodeCapabilities()` (`/node` экспорт) даёт готовый Node-комплект. Конкретные внешние source plugins могут иметь свои зависимости (zx, fetch) — это их дело, не ядра.

## 11. Открытые решения (приняты в спеке, под ревью владельца)

- **A.** Платформенные возможности (fs, exec, http) инъектируются через `SourceContext` capabilities — паттерн `createStorage({ driver })` / `execBlock({ executor })`. Ядро nrd-context — `nrd-core` only, portable.
- **B.** Capability для file/json — **полный `Storage`** из nr-infra (не узкий read-only). Причина: `fsStorage` втыкается без адаптера; Sink/Store (§7) затребуют `write` — узкий контракт пришлось бы ломать; source просто не вызывает `write`, если не нужен.
- **C.** exec/script source **делегируют в `nrd-exec.execBlock`** (не исполняют сами), передавая `executor` и `external: chain`. Переносимость и ноль дублирования.
- **D.** `nodeCapabilities()` — отдельный экспорт `@kerneldreams/nrd/node`, тянет nr-infra + nrd-exec, tree-shake из браузерного бандла. Ядро остаётся portable. На Node — fs + spawn + fetch одной строкой (закрывает «работает сегодня»).
- **E.** mdd/mdz — `$nr-parse`, не `$nr-type` (исправлен баг §9 v1). `$nr-type` = хендлер (file/inline/json/env/exec/script), `$nr-parse` = формат.
- **F.** Реализация этой таски — **только Node-путь** (fsStorage + spawnExecutor + fetchHttp + все встроенные плагины, работающие на Node). Браузерные capability-драйверы — НЕ в scope (клиентский код, контракты готовы).
