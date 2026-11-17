# MIGRATION — шесть пакетов → `@kerneldreams/nrd@1.0.0`

Слияние по спеке `nr-system.dev/specs/nrd-merge-spec.md` (08.09.2026). Сливались
`nrd-core`, `nrd-context`, `nrd-exec`, `nr-runtime`, `nr-infra`, `ntpl`.
Фасадов на старых именах нет — импорты потребителей переписаны механически.

## 1. Карта импортов

| Было | Стало |
|---|---|
| `@kerneldreams/nrd` | `@kerneldreams/nrd` |
| `@kerneldreams/nrd/format` | `@kerneldreams/nrd/format` |
| `@kerneldreams/nrd` | `@kerneldreams/nrd` |
| `@kerneldreams/nrd/node` | `@kerneldreams/nrd/node` |
| `@kerneldreams/nrd/node`, `@kerneldreams/nrd/node/executor` | `@kerneldreams/nrd` |
| `@kerneldreams/nrd/node` | `@kerneldreams/nrd/node` |
| старый `nr-runtime` | `@kerneldreams/nrd/node` |
| `@kerneldreams/nrd/template` | `@kerneldreams/nrd/template` |
| `@kerneldreams/nrd/node` | `@kerneldreams/nrd/node` |

`@kerneldreams/nrd/web` — единственный, где перенос **по символу**, а не по пакету:

| Символ | Ступень |
|---|---|
| `Result`, `AsyncResult`, `ok`, `err`, `isOk`, `isErr`, `generateId`, `IncludeResolver`, `fileIncludeResolver` | `@kerneldreams/nrd` |
| `httpGet`, `httpPost`, `httpPostStream`, `HttpOptions`, `HttpResponse` | `@kerneldreams/nrd/web` |
| `memoryStorage` | `@kerneldreams/nrd/web` |
| LLM: `openaiProvider`, `anthropicProvider`, `ollamaProvider`, `parseSSE`, `LLMError`, все `LLM*`-типы | `@kerneldreams/nrd/web` |
| `fsStorage` | `@kerneldreams/nrd/node` |
| `execShell`, `runFile`, `ExecError`, `ExecOptions`, `ExecResult` | `@kerneldreams/nrd/node` |
| `IStorage` (тип) | и `/web`, и `/node` (канон — `@kerneldreams/nrd/contracts`) |

## 2. Коллизий имён при слиянии не было

Спека (§6) предупреждала о вероятных коллизиях `parse` / `resolve` / `functions`
при склейке шести `index.ts` в один корень. По факту слияние прошло без единого
переименования: `nrd-core` отдаёт `parse`/`resolve`, `nrd-context` — `parseRaw`/
`parseMode`, файлы `functions.ts` разошлись по разным каталогам. Список
переименований пуст.

## 3. Поведенческие изменения (единственные — §2.4, §2.5 спеки)

### 3.1 fs-функции `${loadMDD}` / `${loadMDZ}` / `${loadJSON}` / `${readFile}`

Раньше корень `nrd-context` импортил их напрямую, а они — `node:fs`. Теперь ядро
portable, и функции живут на node-ступени.

```ts
// было
import { buildContext } from '@kerneldreams/nrd'
await buildContext(cfg, { baseDir })            // loadMDD доступен неявно

// стало
import { buildContext } from '@kerneldreams/nrd'
import { builtinFunctions } from '@kerneldreams/nrd/node'
await buildContext(cfg, { baseDir, privilegedFunctions: builtinFunctions })
```

`privilegedFunctions` — новая опция `BuildContextOptions`. При `trusted:false`
не подключается, ровно как раньше не подключались `builtinFunctions`
(§.3). Обычный `functions` работает как работал.

`buildRuntimeContext` из `@kerneldreams/nrd/node` (бывший `nr-runtime`) уже
передаёт найденные функции туда сам — потребителям этого пути менять нечего,
кроме имени импорта.

Сама фабрика доступна из корня: `fileFunctions(io: SyncFileIO)` — если нужен
не-Node носитель файлов (GAS, браузерный VFS), достаточно реализовать порт
`SyncFileIO` (`readText` / `isAbsolute` / `resolve`).

### 3.2 Движки шаблонов стали асинхронными

`nunjucks` и `handlebars` переехали из `dependencies` в optional
`peerDependencies` и грузятся ленивым `import()`. Четыре функции стали `async`:

| Функция | Было | Стало |
|---|---|---|
| `createEnv(opts)` | `Environment` | `Promise<Environment>` |
| `nunjucksEngine(opts)` | `TemplateEngine` | `Promise<TemplateEngine>` |
| `handlebarsEngine()` | `TemplateEngine` | `Promise<TemplateEngine>` |
| `nodeLoader(dirs)` | `FileSystemLoader` | `Promise<FileSystemLoader>` |

`render(env, template, ctx)` осталась синхронной.

```ts
// было
const env = createEnv({ loader: nodeLoader() })
// стало
const env = await createEnv({ loader: await nodeLoader() })
```

Отсутствие движка теперь бьёт по вызову, а не по загрузке `nrd/template`:
импортировать ступень можно и без установленных `nunjucks`/`handlebars`.

### 3.3 `discoverFunctions` и `trusted:false`

Найденные по соглашению функции из `.nrd/functions/` теперь уезжают в
`privilegedFunctions`, а не в `functions`. Следствие: при `trusted:false`
проектные функции больше не подключаются. Раньше подключались — это была
дыра того же класса, что и `builtinFunctions` (§.3): произвольный
`.ts`-модуль с диска в недоверенном контексте.

## 4. Что НЕ менялось

- Поверхность формата (`parse`, `serialize`, `parseWithSchema`, `cast`, …) — 1:1.
- Поверхность `execBlock` / `Executor` / `spawnExecutor` — 1:1.
- Поверхность LLM-провайдеров — 1:1, сменилась только ступень импорта.
- Встроенный сайт-плагин площадки карточек из ntpl вынесен из ядра: сайты регистрируются снаружи
  (`registerSite(plugin)` из `nrd/template`, свои шаблоны — полем `templatesDir`); `builtinSites` больше нет.
- `zx` остаётся в `dependencies`: `spawnExecutor` резолвит `zx/globals` для
  движка `zx`. Но теперь он только на node-ступени.
