# ntpl — NRD Template Engine

**Статус:** спека v3
**Зависимости (ядро):** `@kerneldreams/nrd`, `@kerneldreams/nrd`, `nunjucks`
**Capabilities (приносит потребитель):** Node template loading через `@kerneldreams/nrd/node`
**Расположение:** `S:\nrlib\ntpl` (либа `@kerneldreams/nrd/template`) + тонкий CLI `S:\appz\ntpl` (`runz ntpl`)

## 1. Назначение

Рендер Nunjucks-шаблонов поверх IContext.

Вход: IContext (из nrd-context или собранный вручную) + шаблон. Выход: текст.

Основные сценарии:
- Рендер карточек персонажей → человекочитаемый mdd
- Prompt assembly для LLM → `%role` поток → `parseMessages()`
- Генерация любых текстовых артефактов из структурированных данных

**ntpl не знает:** откуда данные (файл, API, база — задача nrd-context).
**ntpl знает:** Nunjucks, делимитеры, фильтры, wrapContext.

**Ключевой принцип:** данные часто содержат Handlebars-синтаксис (`{{user}}`, `{{char}}`), который является частью данных, а не инструкцией шаблонизатора. Поэтому Nunjucks с кастомными делимитерами — `<{ }>` для тегов, `<< >>` для переменных. Handlebars в данных проходит сквозь рендер нетронутым.

**Структура — либа + тонкий CLI.** `@kerneldreams/nrd/template` (либа) несёт движок: `extractNrd`, `createEnv`, `render`, helpers, template resolution. `runz ntpl` (appz) — тонкая CLI-обёртка поверх либы. forge/show и прочие потребители **импортят `@kerneldreams/nrd/template` напрямую**, не вызывая CLI. Это и есть основа, на которой встанут forge и show-утилиты.

**Переносимость.** Движок рендера (`createEnv`, `render`, `extractNrd`) — portable (Nunjucks работает в браузере). Платформенная часть — загрузка шаблонов с диска (`FileSystemLoader`, upward search) — инъектируется через loader, Node-реализация в `@kerneldreams/nrd/node`. Тот же паттерн, что capabilities в nrd-context.

## 2. Архитектура

```
CLI args / URL
     │
     ▼
  route()          — URL → { params, template } (site plugin, опционально)
     │
     ▼
  findTemplate()   — resolver: .ntpl/ upward + builtin (Node, через loader)
     │
     ▼
  extractNrd()     — вырезать <{ nrd }>...<{ endnrd }> из шаблона
     │
     ▼
  buildContext()   — nrd-context: NRD-блок → sources → chain → IContext
     │                (с nodeCapabilities — fs/exec/http готовы)
     ▼
  wrapContext()    — nrd-context: IContext → JS Proxy
     │
     ▼
  render()         — Nunjucks env + proxy context
     │
     ▼
  output           — stdout или -o файл
```

Слои:
- **`@kerneldreams/nrd/template` (либа):** findTemplate, extractNrd, render, createEnv, helpers, site resolution.
- **`@kerneldreams/nrd`:** buildContext, wrapContext (ntpl зовёт, передавая `nodeCapabilities()`).
- **`runz ntpl` (appz, тонкий):** entry point — собирает args, зовёт либу, output.
- **Site plugins:** маршрутизация URL → шаблон (опциональный слой).

## 3. Формат шаблона

```markdown
<{ nrd }>
$required: character
$profile: alice-example

## $source bot
$nr-type: cardsite
$resource: characters
$path: ${profile}/${character}
<{ endnrd }>
# << bot.name >>

**<< bot.fullPath >>**
Stars: << bot.starCount >>

<{ if bot.tagline }>
## Tagline

<< bot.tagline | safe >>
<{ endif }>

<{ for greeting in bot.alternate_greetings }>
## @greeting

<< greeting | safe >>
<{ endfor }>
```

### 3.1 NRD-блок

Обрамлён `<{ nrd }>` ... `<{ endnrd }>`. Содержимое — конфиг для nrd-context (mdz, `$` сигил). Передаётся в `buildContext()` как есть. ntpl не интерпретирует содержимое — только извлекает текст между тегами. Формат конфига (`## $source`, `$nr-type`, `$nr-parse`, `$required`, `$chain`) описан в nrd-context-spec.md — ntpl ссылается, не дублирует.

### 3.2 Тело шаблона

Всё за пределами `<{ nrd }>...<{ endnrd }>` — Nunjucks с кастомными делимитерами:

| Стандартный Nunjucks | ntpl |
|---------------------|------|
| `{% tag %}` | `<{ tag }>` |
| `{{ var }}` | `<< var >>` |
| `{# comment #}` | `<# comment #>` |

### 3.3 extractNrd()

```typescript
function extractNrd(template: string): { nrdBlock: string | null; body: string }
```

Вырезает содержимое между `<{ nrd }>` и `<{ endnrd }>`. Возвращает `nrdBlock` (mdz текст или null) и `body` (шаблон без NRD-блока). ~15 строк. Regex: `/<\{\s*nrd\s*\}>([\s\S]*?)<\{\s*endnrd\s*\}>/`. **Portable** (чистая строковая операция).

## 4. Nunjucks Environment

### 4.1 Setup

```typescript
function createEnv(opts: {
  loader: nunjucks.ILoader        // инъекция: FileSystemLoader (Node) или иной (browser)
  helpers?: HelperRegistrar[]     // дополнительные фильтры
}): nunjucks.Environment {
  const env = new nunjucks.Environment(opts.loader, {
    tags: {
      blockStart: '<{', blockEnd: '}>',
      variableStart: '<<', variableEnd: '>>',
      commentStart: '<#', commentEnd: '#>',
    },
    autoescape: false,
    trimBlocks: true,
    lstripBlocks: true,
  })
  loadBuiltinHelpers(env)
  for (const reg of opts.helpers ?? []) reg(env)
  return env
}
```

Loader инъектируется → движок portable. Node-обёртка (`@kerneldreams/nrd/node`) даёт `FileSystemLoader` + upward search.

### 4.2 Render

```typescript
function render(env: nunjucks.Environment, template: string, ctx: IContext): string {
  const proxy = wrapContext(ctx)        // из nrd-context
  return env.renderString(template, proxy)
}
```

Шаблон видит `<< bot.name >>` → Proxy → `chain.get(['bot']).get(['name'])`. Рекурсия Proxy обеспечивает вложенность любой глубины. **Portable.**

### 4.3 Safe filter

`| safe` — для HTML-контекста. Благодаря кастомным делимитерам `{{user}}` и так не интерпретируется Nunjucks; `| safe` нужен только если ntpl рендерит HTML.

## 5. Helpers (фильтры)

Встроенные — в либе; кастомные грузятся из `.ntpl/helpers/` (upward search, Node).

### 5.1 Встроенные (core)
- `section(text, header)` — извлечь секцию по заголовку
- `json(value)` — JSON.stringify
- `yaml(value)` — YAML-подобный вывод
- `trimEmpty(text)` — убрать пустые строки
- `indent(text, n)` — отступ

### 5.2 Встроенные (collection)
- `unique(arr, key?)`, `groupBy(arr, key)`, `sortBy(arr, key)`, `pluck(arr, key)`, `join(arr, sep)`, `first(arr)`, `last(arr)`, `flatten(arr, depth = 1)`

### 5.2а Морфология

`rod`, `adj(who, padej)`, `pron(padej, mode)`, `name(padej)`, `byRod(h, s, o?, m?)` — род и падеж для
значения-актёра (объект с `sex` / `rod`): `<< p | pron("t") >>` → «ним» / «ней», `<< "послушный" | adj(p) >>`,
`<< p | pron("v", "en") >>` → him / her. Род `h|s|o|m`, падеж `i|r|d|v|t|p`; таблица прилагательных — перенос
ngen-core, местоимения — своя таблица; имена собственные — формы у актёра (`forms.<падеж>`). Код —
`src/template/helpers/morph.ts`.

### 5.3 Кастомные

```typescript
// .ntpl/helpers/my-filters.ts
export default function register(env: nunjucks.Environment) {
  env.addFilter('myFilter', (val) => ...)
}
```

## 6. Template Resolution (Node, `@kerneldreams/nrd/node`)

Upward search от CWD или директории шаблона:

```
./                         ← текущая директория
./.ntpl/templates/         ← локальные шаблоны
./.ntpl/helpers/           ← локальные фильтры
./.ntpl/sites/             ← локальные site-плагины
../  ../.ntpl/...           ← уровень выше
...                        ← до stop-маркера (.git, .server) или корня
<site>.templatesDir         ← каталоги зарегистрированных site-плагинов (registerSite)
```

First-wins. Локальный перекрывает сайтовый. Этот слой — Node (fs); в `@kerneldreams/nrd/node`. Браузерный loader — клиентский, контракт `ILoader` готов.

## 7. Site Plugins (роутинг)

Опциональный слой. Если первый аргумент — URL/shorthand, ntpl ищет site-плагин для маршрутизации к шаблону.

```typescript
// sites/<name>.ts
export const hostname: string[]                      // ['example.com', 'www.example.com']
export function parseUrl(arg: string): ParsedUrl | null
export function matchShorthand(arg: string): boolean
export const defaultTemplates: Record<string, string>
export const templatesDir?: string                   // свой каталог шаблонов (Node-слой ищет после .ntpl/templates)
```

Ядро своих сайтов не держит: приложение регистрирует площадку в точке входа — `registerSite(plugin)` из
`@kerneldreams/nrd/template`; `discoverSites` (Node) отдаёт локальные `.ntpl/sites/` + зарегистрированные.

`parseUrl()` → `{ resource, path, ... }` попадают в params, доступны в `${resource}`, `${path}` внутри NRD-блока.

Site plugin — про маршрутизацию (URL → какой шаблон + параметры). Source plugin в nrd-context — про данные (как загрузить). Разные слои.

## 8. CLI / Runz Interface

`runz ntpl` (appz) — тонкая обёртка над `@kerneldreams/nrd/template`.

```
runz ntpl <url-or-template> [--key value ...] [-o output] [--profile name]
```

Примеры:
```bash
runz ntpl alice/first-page                 # site plugin (shorthand)
runz ntpl https://example.com/pages/alice/first-page
runz ntpl example/page --page first-page          # прямой шаблон
runz ntpl alice/first-page -o out.md       # вывод в файл
```

### 8.1 Entry Point (appz/ntpl, тонкий)

```typescript
import { resolveRoute, findTemplate, extractNrd, createEnv, render, nodeLoader, searchDirs } from '@kerneldreams/nrd/template'
import { nodeCapabilities } from '@kerneldreams/nrd/node'
import { buildContext } from '@kerneldreams/nrd'
import { objectContext } from '@kerneldreams/nrd'

export default async function(ctx: IContext, meta: ScriptMeta): Promise<ScriptResult> {
  const arg = meta.args[0]
  const route = resolveRoute(arg, ctx)
  const templatePath = findTemplate(route.template)
  const templateText = readFileSync(templatePath, 'utf-8')

  const { nrdBlock, body } = extractNrd(templateText)
  const params = { ...route.params, ...cliArgs(ctx) }
  const chain = nrdBlock
    ? await buildContext(nrdBlock, { ...nodeCapabilities(), params, baseDir: dirname(templatePath) })
    : objectContext(params)

  const env = createEnv({ loader: nodeLoader([dirname(templatePath), ...searchDirs()]) })
  const result = render(env, body, chain)

  const outFile = ctx.get(['o']) as string | undefined
  if (outFile) writeFileSync(outFile, result)
  return { output: result }
}
```

Ключевое: `buildContext(nrdBlock, { ...nodeCapabilities(), ... })` — fs/exec/http готовы одной строкой.

### 8.2 Программное использование (forge, show, custom)

```typescript
import { extractNrd, createEnv, render, nodeLoader } from '@kerneldreams/nrd/template'
import { nodeCapabilities } from '@kerneldreams/nrd/node'
import { buildContext } from '@kerneldreams/nrd'

// Из шаблона с NRD-блоком
const { nrdBlock, body } = extractNrd(templateText)
const chain = await buildContext(nrdBlock, { ...nodeCapabilities(), params })
const env = createEnv({ loader: nodeLoader([baseDir]) })
const result = render(env, body, chain)

// С готовым IContext (chat2, custom) — без nrd-context
const result = render(env, templateText, myChain)
```

## 9. Структура пакетов

**`@kerneldreams/nrd/template` (S:\nrlib\ntpl):**
- `src/extract.ts` — `extractNrd()` (portable, ~15 строк)
- `src/engine.ts` — `createEnv()`, `render()` (portable, loader инъектируется)
- `src/helpers/core.ts`, `src/helpers/collection.ts` — встроенные фильтры (portable)
- `src/route.ts` — `resolveRoute()`, site plugin matching
- `src/node.ts` (→ `@kerneldreams/nrd/node`) — `nodeLoader()` (FileSystemLoader + upward search), `nodeCapabilities()` re-export, `findTemplate()`, `searchDirs()` (Node fs)
- `sites.ts` — реестр site-плагинов (`registerSite` / `registeredSites`); конкретные площадки и их шаблоны (`templatesDir`) регистрируются снаружи

**`@kerneldreams/nrd/node`** — отдельный экспорт (тянет fs + nrd-context/node), tree-shake из браузерного бандла. Ядро (extract/engine/helpers/route) — portable.

**S:\appz\ntpl** — тонкий runz-app: `index.ts` (~60 строк, см. §8.1), зовёт `@kerneldreams/nrd/template`.

**Старый код** в `S:\Archives\apps\ntpl` — переносим `resolver.ts`, `loader.ts`, `route.ts`, `nrd-extension.ts`, `helpers/*` (адаптировать под новую структуру). Data pipeline (`data/exec.ts`, `data/file.ts` и пр.) НЕ переносим — он ушёл в nrd-context source-плагины.

## 10. Что НЕ делаем

- Data pipeline, source plugins, parse → **nrd-context**
- Publish/upload/fetch/gallery → **forge**
- Handlebars-движок → только Nunjucks
- Prompt assembly logic → **chat2** (ntpl рендерит, не решает что куда)
- Budget/token counting → chat2 context engine
- Браузерный loader (`ILoader` под не-Node) → клиентский код, контракт готов

## 11. Открытые решения (приняты в спеке, под ревью владельца)

- **A.** ntpl = **либа `@kerneldreams/nrd/template` (nrlib) + тонкий CLI `runz ntpl` (appz)**. forge/show импортят либу напрямую. Причина: forge/show строятся на ntpl программно, нужен import, не вызов CLI.
- **B.** Движок (extract/engine/helpers/route) — **portable**; template loading (`FileSystemLoader`, upward search) — Node через `@kerneldreams/nrd/node` (loader инъектируется в `createEnv`). Тот же паттерн, что capabilities в nrd-context.
- **C.** `buildContext` зовётся с `nodeCapabilities()` (из nrd-context/node) — fs/exec/http готовы. CLI и программный путь на Node работают из коробки.
- **D.** Реализация этой таски — **Node-путь** (FileSystemLoader, fs resolution, nodeCapabilities). Браузерный loader вне scope (контракт `ILoader` готов).
- **E.** `runz`, не runz2 (runz2 выведен).

## Без кодогенерации

`noEvalTemplate(nj, env, src).render(ctx)` — шаблон рендерится обходом AST (родной парсер, рантайм nunjucks),
без `new Function`: Cloudflare Workers, страницы с CSP без `unsafe-eval`. Экземпляр nunjucks не трогается.
`installNoEvalNunjucks(nj)` — то же на весь экземпляр (Worker-хост backend-nr). `createEnvWith(nj, opts)` —
синхронный `createEnv` над переданным модулем. Не поддержано (ошибка с именем узла): `extends`/`block`,
`include`/`import`, макросы, `call`, async-фильтры. Код — `src/template/noeval.ts` (перенесён из backend-nr).
