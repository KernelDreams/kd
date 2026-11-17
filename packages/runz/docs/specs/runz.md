# runz — спецификация

## Что это

Runtime и framework для TypeScript-скриптов и NRD-документов.

Форкнул → `npm install` → `runz` в системе. Пишешь `.ts` или `.md` — запускаешь без package.json, без node_modules, без билда. Всё окружение предоставляет runz.

## Стек

- **Node 24+** — нативный TypeScript без tsx, без компиляции
- **ESM only** — `"type": "module"` везде
- **Enums запрещены** — используем `as const` объекты (Node strip-types не трансформирует enums)
- **Monorepo** — workspace `packages/*`: `@kerneldreams/runz-runtime`, `@kerneldreams/runz-runtime/web`, `@kerneldreams/runz-runtime/llm`
- **Библиотеки** — `@kerneldreams/nrd` (парсер, IContext, chain, `Result`/`isOk`/`isErr`), `@kerneldreams/nrd/web` (http, LLM providers, storage)

## Структура репозитория

```
runz/
  bin/runz.ts               ← CLI entry point
  packages/
    runtime/                ← загрузка скриптов, registry, chain, execute
    web/                    ← HTTP-сервис поверх runtime
    llm/                    ← LLM integration (deprecated, замена — `@kerneldreams/nrd/web`)
  scripts/                  ← встроенные скрипты (serve); publish-pkg.mjs — публикация пакетов
  tests/
  docs/
    specs/
  skills/                   ← runz.skill — генерат из nrchat.dev/use-nr (`runz skills build nrchat --build=runz`)
  package.json              ← workspaces: ["packages/*"]
```

Внешние зависимости:
- `@kerneldreams/nrd` — NRD парсер, resolver, IContext, chain, cast, `Result`/`isOk`/`isErr`
- `@kerneldreams/nrd/web` — http, LLM providers (openaiProvider, anthropicProvider, ollamaProvider), storage
- `nunjucks` — шаблонизатор

## Установка

### Разработка (ноут, основная машина)

```bash
git clone https://github.com/KernelDreams/kd   # CLI — packages/runz
cd runz
npm install
```

Шим `~/.local/bin/runz` (`exec node "$HOME/Studio/Projects/runz/bin/runz.ts" "$@"`) вызывает исходник напрямую. Изменил файл — сразу работает, без билда.

### Использование (ПК, мак, CI)

```bash
npm install -g runz    # из Gitea registry или npm
```

На новой машине: `cd ~/Studio/Projects/runz && npm install` (пересоздаёт `file:`-ссылки на nrlib в node_modules).

### Обновление

```bash
# dev
cd runz && git pull && npm install

# prod
npm update -g runz
```

## Что такое скрипт

Скрипт — `.ts` файл или `.md` документ который runz умеет запускать.

### Простой скрипт (`.ts`)

```ts
// scripts/hello.ts
import type { ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'
import type { IContext } from '@kerneldreams/nrd'
import { asText } from '@kerneldreams/nrd'

export default async function(ctx: IContext, meta: ScriptMeta): Promise<ScriptResult> {
  const name = asText(ctx.get(['name'])) ?? 'World'
  return { output: `Hello, ${name}!` }
}
```

Запуск:
```
runz hello --name=owner
runz ./my-script.ts --key=value
```

### NRD-документ (`.md` / `.mdz` / `.mdd` / `.mds`)

```markdown
$type: chat
$model: gemini-2.5-flash
$system: Отвечай кратко и по делу.

%user
${prompt}
```

Запуск:
```
runz chat.md --prompt="что такое рекурсия?"
```

### Разница

Нет принципиальной разницы. `.md` документ — это скрипт, handler определяется через `$type`. `.ts` — скрипт напрямую. Оба получают `IContext` (chain) + `ScriptMeta`, оба возвращают `ScriptResult`.

## Интерфейс скрипта

Скрипт получает два аргумента:

### `ctx: IContext` — chain с данными

Полный IContext из `@kerneldreams/nrd`. Скрипт работает с тем же API что и любой другой потребитель chain: `get(path)`, `cast()`, `func()`.

```ts
// простое значение
const name = asText(ctx.get(['name']))

// вложенный путь
const email = asText(ctx.get(['user', 'email']))

// cast
const doc = ctx.cast<NRDocument>('NRDocument')

// всё что умеет IContext — без обёрток, без фасадов
```

### `meta: ScriptMeta` — метаданные запуска

То чего нет в chain — информация о самом запуске:

```ts
interface ScriptMeta {
  /** Путь к исходному файлу (null если виртуальный запуск) */
  file: string | null

  /** NRD-документ (null если запущен .ts напрямую) */
  doc: NRDocument | null

  /** Корень проекта — директория содержащая .runz/ (walk up от cwd). null если глобальный контекст */
  projectDir: string | null

  /** Директория для персистентных данных скрипта.
   *  Default: {projectDir}/.runz/data/{name}/ если в проекте, ~/.runz/data/{name}/ если глобальный.
   *  Переопределяется через $dataDir в chain (конфиг скрипта, CLI, документ) */
  dataDir: string

  /** --runz-debug */
  debug: boolean

  /** --runz-dry */
  dry: boolean
}
```

### Chain — откуда берутся значения

Chain собирается перед вызовом скрипта. Приоритет (first wins):

1. **CLI аргументы** — `--key=value`
2. **Документ** — `$key: value` в .md файле (если запущен .md)
3. **Конфиг скрипта** — `<script-name>.config.md` рядом со скриптом
4. **Проектный конфиг** — `.runz/config.md` (walk up от cwd)
5. **Глобальный конфиг** — `~/.runz/config.md`

Каждый слой опционален. CLI достаточно для запуска чего угодно.

Явный конфиг через `--runz-config=path` вставляется между документом и конфигом скрипта.

#### Профили — инклюд по выбору

Поле формы `$models: preset models/*.mdz // Модели` (в любом `## $form` документа) делает
корневой `$models` профилем: значение — файл маски (`models/opus.mdz`, короткое `opus`,
абсолютный путь), его корневые атрибуты встают сразу после строки `$models: …` — поверх того,
что выше (рецепт, база), под тем, что ниже. `--models=opus` в CLI — то же поверх документа;
явные `--key=` сильнее профиля. `$title`/`$description` профиля — подпись выбора, в цепочку
не идут. Опечатка — ошибка с перечнем профилей. Реализация — `nrd/node` `presets.ts`
(`loadProgram(file, kind, {presets})`); ею же пользуются формы и задачи.

#### Окружение — только под неймспейсом `env.`

Переменные окружения в цепочке есть, но **голым ключом не резолвятся**:

```
${env.OPENROUTER_API_KEY}      ✅  ctx.get(['env', 'HOME'])   ✅
${OPENROUTER_API_KEY}          ❌  ctx.get(['HOME'])          → undefined
```

Причина: env — слабейшее звено цепочки, и служебные ключи в нём есть
всегда. Голый `ctx.get(['_'])` без позиционального аргумента молча отдавал
`process.env._` — путь бинаря runz, — и скрипт уходил работать с мусором вместо
честного `undefined`. Явный неймспейс убирает весь класс таких подмен.

В `sys`-скоупе окружение живёт по тому же пути: `${sys.env.VAR}`. Недоверенный
документ (`--untrusted` / `$nr-trusted: false`) не видит env вовсе.

## ScriptResult

```ts
interface ScriptResult {
  /** Текст в stdout */
  output?: string

  /** Дописать в исходный файл (chat append-mode) */
  append?: string

  /** Exit code (default 0) */
  exitCode?: number

  /** Что произвёл скрипт — для машинных потребителей. CLI это поле не печатает,
   *  его отдаёт только `--runz-json`; `output` остаётся человеческой сводкой. */
  outputs?: ScriptArtifact[]
}

type ScriptArtifact =
  | { type: 'text'; text: string }
  | { type: 'image'; path: string; meta?: Record<string, unknown> }
  | { type: 'file'; path: string }
```

`--runz-json`: stdout — `JSON.stringify(ScriptResult)` одной строкой (`output`,
`exitCode`, `outputs`); на ошибке runz тоже пишет JSON (`{output: 'runz: …',
exitCode: 1}`), текст ошибки дублируется в stderr. Вызывающий (сервис `runz-run`,
форма) парсит stdout, а не stderr. Тип `ScriptArtifact` — из `@kerneldreams/runz-runtime`.

Для long-running скриптов (сервисы):

```ts
interface ServiceResult {
  /** PID запущенного сервиса */
  pid: number

  /** URL для health-check */
  url?: string

  /** Лог-файл */
  log?: string
}
```

Скрипт возвращает `ScriptResult | ServiceResult`. Если `ServiceResult` — runz печатает handle и выходит, сервис живёт в отдельном процессе.

## Реестр скриптов

Как runz находит скрипт по имени.

### Порядок поиска

```
runz chat --prompt="..."
```

1. **Текущая директория** — `./chat.ts`, `./chat.md`, `./chat/index.ts`
2. **Проектный реестр** — `.runz/scripts/chat.ts` (walk up от cwd до root)
3. **$paths** — каждый путь из `$paths` в chain: `{path}/chat.ts`, `{path}/chat/index.ts`, `{path}/chat.md`
4. **Встроенные** — `runz/scripts/chat.ts` в дистрибутиве
5. **Глобальные** — `~/.runz/scripts/chat.ts`

Первое совпадение побеждает. Локальные скрипты перекрывают встроенные — это намеренный override-паттерн.

### Явный путь

```
runz ./experiments/my-thing.ts
runz /absolute/path/to/script.md
```

Путь с `/`, `./`, `\` или абсолютный — прямой запуск без поиска по реестру.

### Проектный реестр

Папка `.runz/` в любом git-проекте. Локальные скрипты + конфиг для этого проекта.

```
my-project/
  .runz/
    scripts/
      deploy.ts
      test-data.ts
    config.md           ← проектный конфиг (defaults для всех скриптов в проекте)
  src/
    ...
```

```
runz deploy              ← .runz/scripts/deploy.ts
runz test-data --count=5
```

### Глобальный реестр

`~/.runz/scripts/` — скрипты доступные из любого места. Персональные утилиты.

`~/.runz/config.md` — глобальные defaults (model, api keys через `${env.VAR}` — окружение только под неймспейсом `env.`, preferences).

### $paths — дополнительные директории скриптов

В любом конфиге (глобальном или проектном):

```markdown
$paths: ~/Studio/appz
```

runz ищет скрипты в каждой из перечисленных директорий. Работает как `PATH` в shell — список мест где искать, через chain. Порядок: слева направо, после проектного реестра, до встроенных.

### Пути в конфигах: `~` и относительные

Ведущий `~` в любом пути из цепочки (`$paths`, `$dataDir`, `--runz-config`, явный путь скрипта) раскрывается в домашнюю директорию — один глобальный конфиг работает на всех машинах:

```markdown
$paths: ~/Studio/appz
```

`~user` не поддерживается; `~` не в начале строки — обычный символ. Относительные пути резолвятся от cwd, `$dataDir` — от корня проекта. Нормализация живёт в одном месте: `packages/runtime/src/paths.ts`.

## Зарезервированные флаги

Префикс `--runz-*` зарезервирован за runz. Всё остальное — данные скрипта в chain.

```
--runz-debug       debug info в stderr
--runz-dry         резолв без исполнения
--runz-json        stdout = ScriptResult одной JSON-строкой (и на ошибке: {output, exitCode: 1})
--runz-config=X    явный конфиг (добавляется в chain)
--runz-chain=X     загрузить chain из JSON-файла (для отладки, тестирования)
--runz-help        справка
--runz-list        список доступных скриптов (все уровни реестра)
--runz-runtime=X   среда исполнения (node | electron)
```

### Справка и известные флаги скрипта

`--help` / `-h` у любого скрипта — справка рантайма, скрипт не исполняется: `.ts` — первый
док-комментарий (или `export const usage`; у `index.ts` без комментария — README до первого `##`),
документ — `$description` или начало текста; ниже — объявленные флаги. `runz -h` / `runz --help`
без скрипта — справка runz.

Скрипт объявляет известные флаги сам: `.ts` — `export const flags = ['dry', 'force']` или
`{ dry: 'что войдёт' }` (с описаниями — в справке колонкой), документ — `$flags: $[dry, force]`.
Объявил — любой другой ключ командной строки отказ до запуска (`неизвестный флаг --dyr (может,
--dry?) — ничего не запущено`, список известных, код 1). Не объявил — не проверяется, как раньше.
Проверяются только аргументы командной строки, не ключи конфигов; ключи самого рантайма (`_`,
`paths`, `type`, `as`, `dataDir`) проходят всегда. `help` среди своих флагов — скрипт отвечает на
`--help` сам. Код — `packages/runtime/src/flags.ts`.

## Документ как программа

runz понимает четыре формата одним механизмом: `.mdz` / `.md` (сигил `$`),
`.mdd` (сигил `@`), `.mds` (лента `%role`). Что именно исполняется — объявлено
в самом файле; три источника, в порядке:

| В документе | Что исполняется |
|---|---|
| `$type: <appz>` (или `--type=`) | хендлер по имени: `(ctx, meta, helpers)` |
| `## $handler <id>` / `%handler <id>` | ts-тело внутри документа |
| `$run: <id>` в корне (или `--run=`) | именованный `fn` документа |
| ничего из перечисленного | **режим блокнота** |

Нестандартное расширение — `--as=mdz|mdd|mds`. Неизвестное — громкая ошибка,
не дефолт: `runz data.json` не «пытается импортировать», а говорит, чего ждал.

appz-хендлер документа получает третьим аргументом те же `helpers`, что и тело
`## $handler` (llm/embed/attr/list/render/run; провайдер и цепочка — те, что
видит хендлер, `run(id)` — `fn` документа). Программная цепочка (`$source`) для
него не собирается: документ читает хендлер. Виртуальный `--type` без документа —
без `helpers`. Тип — `DocumentHandlerFn` (`@kerneldreams/runz-runtime`).

### Режим блокнота

Исполняются, в порядке файла:

- `## $step <id>` — `fn` с автозапуском (то же даёт `$nr-auto: true` на любом
  `fn`-имени; `$nr-auto: false` снимает авто со `step`);
- `## $shell` / `## $zx` — через executor.

Результат шага кладётся в цепочку под id блока: следующий шаг видит его как
`${<id>}` (`${one.output}`). Декларации `source`/`template`/`data`
зарегистрированы до первого шага. `--run=<id>` исполняет один шаг.

Шаг, вернувший `ServiceResult` (долгоживущий сервис), — ошибка: блокнот
дочитывается до конца, ему некуда деть процесс. Документ, в котором нечего
исполнять, — тоже ошибка, а не тихий ноль.

### Команды документа

```
--cmd=debug         дамп документа (ключи, тело, блоки)
--cmd=tpl --template=<id>   рендер шаблона
--cmd=tpl_inspect   карта путей контекста в ntpl-нотации
```

### Тело `fn` — модуль

Тело `## $fn` / `%fn` грузится через capability `CodeLoader` (Node-адаптер
пишет временный файл рядом с документом и удаляет его после `import()`), а не
через `new Function`: тело импортирует пакеты и объявляет `export`. Импорты
резолвятся так же, как если бы тело лежало файлом рядом с документом.

`export default` вызывается как `(ctx, meta, helpers)`; `export const fn` —
регистрируется чистой функцией и доступна в `${name(args)}`.

Недоверенный документ (`--untrusted` / `$nr-trusted: false`) тело не исполняет:
capability исполнения кода ему не выдаётся вовсе.

## `runz test` — тесты скриптов и appz

```
runz test                    # тесты в cwd
runz test rz                 # цель по имени — через те же $paths, что и `runz <script>`
runz test ./lib              # явный путь (директория или файл теста)
runz test rz --filter=detect # подстрока пути файла
```

Под капотом — `node --test` с **resolve-хуком runz** (`--import`). Тот же хук,
что открывает скрипту `@kerneldreams/*` из воркспейса и цепочку
`.runz/`-окружений, теперь стоит и в тестовом процессе: у appz нет
`package.json`, и голый `node --test` не резолвил `@kerneldreams/nrd` — тесты
приходилось писать без nrd-импортов либо с рукописным хуком в каждом файле.

Набор файлов собирает runz, а не автопоиск ноды: `*.test.ts` / `*.test.mts`
рекурсивно, без `node_modules`, `dist`, `.git`, `.runz`. Пустой набор — ошибка
(exit 1), а не зелёный прогон ни по чему. Цель не найдена — тоже ошибка.

`test` — встроенная подкоманда: скрипт с именем `test` ею перекрыт (как и `add`),
запускается явным путём — `runz ./test.ts`.

## Web-сервис

`@kerneldreams/runz-runtime/web` — HTTP-сервер. Тот же runtime, тот же реестр скриптов, вызов через API.

### Запуск

```
runz serve --port=3050 --key=secret123
```

Или как встроенный скрипт `serve` с конфигом:

```markdown
$type: serve
$port: 3050
$key: ${RUNZ_API_KEY}
```

### API

```
POST /run
Authorization: Bearer <key>
Content-Type: application/json

{
  "script": "chat",
  "args": { "prompt": "что такое рекурсия?", "model": "gemini-2.5-flash" }
}

→ 200 { "output": "Рекурсия — это...", "exitCode": 0 }
```

```
GET /scripts
Authorization: Bearer <key>

→ 200 { "scripts": ["template", "chat", "llm", "serve", ...] }
```

### Безопасность

- API-ключ через `--key`, `RUNZ_API_KEY` env, или `.runz/config.md`
- Без ключа — только localhost (127.0.0.1)
- С ключом — доступен извне
- Скрипты выполняются в том же процессе — доверяем коду на сервере

## Electron

Пакет `@runz/electron` в workspace (future).

Запуск: `runz --runz-runtime=electron my-app.ts`

Runner protocol: runz видит `--runz-runtime=electron` → запускает скрипт через `electron` binary вместо `node`. Скрипт получает тот же `IContext` + `ScriptMeta`.

## Среды исполнения (Runners)

```ts
interface Runner {
  name: string
  canRun(script: LoadedScript): boolean
  run(script: LoadedScript, ctx: IContext, meta: ScriptMeta): Promise<ScriptResult | ServiceResult>
}
```

Встроенные runners:
- **`node`** (default) — inline в текущем процессе
- **`electron`** — subprocess через electron binary, chain передаётся через stdin (JSON)

### Передача chain в subprocess

Три способа получить chain в процесс:

- **Inline** (node runner) — chain уже в памяти, ничего не передаём
- **stdin** (subprocess runner, production) — JSON, без лимитов на размер
- **`--runz-chain=file`** — загрузка chain из JSON-файла, для ручного запуска, отладки, тестов

### Debug: воспроизведение subprocess-запуска

При `--runz-debug` перед spawn'ом subprocess:

1. Chain дампится в файл: `.runz/debug/last-chain.json`
2. В stderr — команда для воспроизведения:

```
[runz:debug] chain → .runz/debug/last-chain.json
[runz:debug] reproduce: runz script.ts --runz-chain=.runz/debug/last-chain.json
```

## Зависимости скриптов

Скрипт не создаёт package.json. Импортирует из того что доступно в окружении.

### Окружения (.runz/)

`.runz/` — директория с `package.json` + `node_modules/`. Может существовать на любом уровне:

```
project/.runz/             ← проект. Зависимости конкретного набора скриптов.
~/Studio/.runz/            ← студия/команда (корень студии).
~/.runz/                   ← машина. User-level, персональные зависимости.
```

### Резолв зависимостей

ESM resolve-hook перехватывает импорты во всех скриптах и в телах `fn` документов
(временный модуль `.nrd-fn-*.ts` рядом с документом). Для любого bare specifier:

```
1. @kerneldreams/*            → сначала воркспейс runz (одна каноничная версия);
                                нет там — идёт дальше по цепочке
2. Локальные node_modules     → от импортирующего файла вверх (те же каталоги,
                                что прошла бы голая нода)
3. .runz/ env chain           → .runz/node_modules вверх от импортирующего файла,
                                затем вверх от cwd, затем ~/.runz/node_modules
4. runz/node_modules          → workspace fallback
```

Каждый шаг спрашивает ФС (`node_modules/<pkg>` — каталог есть?), а Node зовётся
один раз — от места, где пакет есть. «Попробовать и поймать» не годится: Node
24–26 запоминает промах поиска пакета по имени, а не по parentURL, и после первого
промаха отдаёт ту же ошибку на любой следующий parentURL.

Не нашлось нигде — ошибка `Cannot find package '<pkg>'` со списком реально
просмотренных `node_modules` и подсказкой `runz add <pkg> [--global]`.

Установленный пакет `@kerneldreams/runz-runtime` (хост вроде exz) ставит тот же хук; «runz/
node_modules» для него — `node_modules` хоста, куда пакет установлен.

### @kerneldreams/runz-runtime как пакет

В репе `exports` указывает на `src/*.ts` — runz исполняет себя из исходников,
сборка для работы не нужна. В реестр Gitea уходит `dist` (js + d.ts):
`npm run build` в `packages/runtime`, публикация — `node scripts/publish-pkg.mjs
packages/runtime` (временная копия: `publishConfig.exports` → `exports`, `file:`-депы
→ `^версия`). Условие `development` в `exports` не выбрано: его пришлось бы включать
во всём процессе (bin, `node --test`, vitest, порождённые node), иначе bin берёт
src, а appz через хук — dist, и в процессе два экземпляра runtime.

### runz add

Установка зависимостей в окружение:

```
runz add cool-lib              ← в ближайший .runz/ (walk up от cwd)
runz add cool-lib --global     ← в ~/.runz/
runz add cool-lib --env=~/Studio ← в ~/Studio/.runz/ (явный путь)
```

Под капотом: `npm install --prefix <env> <pkg>`.

### Из коробки

runz предоставляет без установки:

```ts
import { parseDocument, resolve, asText, isContext, objectContext, chainContext, isOk, isErr } from '@kerneldreams/nrd'
import type { IContext, IArray, Value, NRDocument } from '@kerneldreams/nrd'

import { openaiProvider, anthropicProvider } from '@kerneldreams/nrd/web'   // Result/isOk — из корня, не из /web
import type { LLMProvider, LLMMessage, LLMRequest } from '@kerneldreams/nrd/web'

import type { ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'

import { readFile } from 'node:fs/promises'
```

## LLM

LLM провайдеры — через `@kerneldreams/nrd/web`. Два типа: `openaiProvider` (OpenAI-compatible HTTP) и `anthropicProvider` (Anthropic HTTP).

Конфигурация в `~/.runz/config.md`:

```markdown
$default_provider: openrouter

## $provider openrouter
$type: openai
$base_url: https://openrouter.ai/api/v1
$api_key: sk-or-...

## $provider cloud
$type: openai
$base_url: https://api.example.com/v1
$api_key: CHK-...

## $provider anthropic
$type: anthropic
$base_url: https://api.anthropic.com
$api_key: sk-ant-...

## $provider mac
$type: openai
$base_url: http://127.0.0.1:11434/v1
$api_key: ollama
```

Subscription-провайдеры (Claude subscription, ChatGPT subscription) работают через прокси-сервисы, выставляющие OpenAI-compatible endpoint. Со стороны клиента это обычный `$type: openai` + нужный `$base_url`.

Типы провайдеров:

| `$type` | Транспорт | Когда использовать |
|---------|-----------|--------------------|
| `openai` | HTTP (OpenAI-compatible) | OpenRouter, Featherless, Ollama, llm-gate, любой прокси |
| `anthropic` | HTTP (Anthropic native) | Прямой доступ к Anthropic API |

### Провайдеры файлами

Новый `$type` блока `## $provider` — файл, а не правка runz. `resolveProvider` (текст),
`resolveImageProvider` и `listImageProviders` (медиа) сначала ищут файл `<type>.ts`
(`.mjs`, `.js`) в папках провайдеров, потом идут во встроенные типы (картинки: bfl, nanogpt,
comfy, google, vertex, gate, mock; текст: openai, anthropic, ollama, mock). Файл с именем
встроенного типа его **перекрывает**.

Папки — `$providers_dir` цепочки (строка или `$[…]`, `~` разворачивается); нет — по порядку:

1. `<стенд>/providers/` — рядом с ближайшим к cwd `.runz/` (`~/Studio/envs-lab/providers/` у lab);
2. `~/.runz/providers/`;
3. образцы пакета `@kerneldreams/runz-runtime` (`src/providers/`, в сборке `dist/providers/`) — `a1111`.

Первая папка с файлом выигрывает. Формата нового нет: файл отдаёт фабрику существующего
контракта — `ImageProvider` (`@kerneldreams/nrd/contracts`) или `StreamProvider`
(`@kerneldreams/nrd/node`) — и объявляет вид:

```ts
// ~/.runz/providers/myimg.ts
import type { ImageProvider } from '@kerneldreams/nrd/contracts'   // только типы — файл без зависимостей

export const kind = 'image'          // 'image' | 'video' | 'audio' (медиа) или 'llm' (текст); можно массив

export default function (cfg: { name: string; baseUrl?: string; apiKey?: string; timeout?: number }, ctx): ImageProvider {
  return {
    async generate(req) {
      const r = await fetch(cfg.baseUrl + '/gen', { method: 'POST', body: JSON.stringify({ prompt: req.prompt }) })
      const images = [new Uint8Array(await r.arrayBuffer())]
      return { ok: true, value: { images, mime: 'image/png', meta: { model: req.model } } }
    },
    // models?() / schema?() — для выбора модели в Pix / Media Gen
  }
}
```

```markdown
## $provider my
$type: myimg
$base_url: http://127.0.0.1:9000
```

`cfg` — `resolveProviderConfig` блока (`baseUrl`, `apiKey`, `type`, `timeout`, `think`) и `name`
(имя блока); прочие атрибуты блока — `ctx.get(['provider', cfg.name, '<ключ>'])`. LLM-файл
(`kind = 'llm'`) отдаёт `{ stream(req) }` (и, если умеет, `embed`).

`listImageProviders` узнаёт вид файла без импорта — по тексту `export const kind = …`, поэтому
`kind` пишется литералом. Ошибки громкие и с путём: файл не загрузился, нет `kind`, вид не тот,
нет `export default`, фабрика упала или вернула не провайдер. «Не умеет медиа» перечисляет и
встроенные типы, и найденные файлы.

**`a1111`** — Automatic1111 / Forge / SD.Next (`sdapi/v1`): `models()` — чекпойнты
`/sdapi/v1/sd-models` (`id` — title, уходит в `override_settings.sd_model_checkpoint`; `default` — не
переключать), `schema()` — `width`/`height`, `steps`, `cfg_scale`, `sampler_name` (enum из
`/sdapi/v1/samplers`), `seed`, `n` (→ `batch_size`), `denoising_strength`, 1 реф. Без рефа —
`txt2img`, с рефом — `img2img` (`init_images`, маска — `mask`). Прогресс — опрос `/sdapi/v1/progress`.
`$base_url` по умолчанию `http://127.0.0.1:7860`, `$api_key: user:pass` — `--api-auth` (Basic).
Файл — образец: копия в `~/.runz/providers/<свой>.ts` и правка.

## Решения (закрыто)

- **Имя**: `runz`
- **Структура**: monorepo, workspace `packages/*` (@kerneldreams/runz-runtime, @kerneldreams/runz-runtime/web, @kerneldreams/runz-runtime/llm)
- **Интерфейс скрипта**: `(ctx: IContext, meta: ScriptMeta) → ScriptResult`. Никаких фасадов
- **Глобальный конфиг**: `~/.runz/config.md`
- **Окружения**: `.runz/` на любом уровне, walk up
- **Публичные зависимости**: `@kerneldreams/nrd`, `@kerneldreams/nrd/web`, `nunjucks`
- **LLM**: через `@kerneldreams/nrd/web` (openaiProvider, anthropicProvider). Subscription — через прокси
- **Web-сервис**: `@kerneldreams/runz-runtime/web`, встроенный скрипт `serve`
- **Встроенные скрипты**: только `serve`. chat/llm/template — отдельные скрипты в `~/Studio/appz`
- **Enums**: запрещены, `as const` вместо них
- **Среда исполнения**: Node 24+ нативный TS
- **Зарезервированный префикс**: `--runz-*`
