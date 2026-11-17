# nrd-exec — Исполнение блоков

**Статус:** спека v2
**Зависимости:** `@kerneldreams/nrd`, `@kerneldreams/nrd/web`
**Расположение:** `S:\nrlib\nrd-exec`

## 1. Назначение

Исполнение блоков кода внутри NRD-документов. Блок `## $shell` / `## $ts` / `## $zx` → выполнить тело → результат как IContext.

Потребители: nrd-context (`exec`/`script` source-плагины), ntpl, runz-скрипты напрямую, chat-движки, CLI, Telegram-боты, **браузер, Cloudflare Worker, Android-WebView**.

**Ключевой принцип — переносимость.** nrd-exec не знает, *как* исполняется код. Он знает блок-семантику: распознать `## $ts`, снять fence, резолвить `${}`, распарсить результат → IContext. Само исполнение инъектируется через `Executor` — ровно как `createStorage({ driver })` в core принимает драйвер хранилища. Тогда ядро `execBlock` работает везде, где есть JS, а платформенная часть (spawn процесса) изолирована.

## 2. Архитектура — три уровня

```
## $shell блок
   ↓  execBlock (nrd-exec, PORTABLE): engine, fence, резолв ${}, parse результата
   ↓  executor.run(ExecInput) → ExecOutput          ← инъекция (как driver в createStorage)
   ↓
   ├─ spawnExecutor (nrd-exec, Node-only экспорт) ──→ nr-infra.execShell / runFile (примитив, child_process)
   ├─ inProcessExecutor (клиентский) ──────────────→ new AsyncFunction (browser/edge)
   └─ remoteExecutor (клиентский) ─────────────────→ HTTP на раннер
```

Три уровня, строго в одну сторону:

1. **nr-infra.execShell / runFile** — голый примитив Node-IO. Spawn процесса, команда → `{stdout, stderr, code}`. Ноль зависимостей (`child_process`). **Не знает слова `Executor`, не знает формат.**
2. **nrd-exec — `Executor` интерфейс + `spawnExecutor`.** `Executor` — контракт исполнения (язык блок-семантики, потому здесь). `spawnExecutor` — его Node-реализация, склеивает контракт с `nr-infra.execShell`. Отдельный экспорт: браузер его не импортит (tree-shake).
3. **nrd-exec — `execBlock` (PORTABLE).** Блок-семантика. Принимает `Executor` параметром, зовёт `executor.run(...)`. Ни одного `child_process`. Зависит от nrd-core для семантики.

Зависимости: `nrd-exec → nr-infra → ∅`, `nrd-exec → nrd-core`. **Ноль цикла.** `nr-infra` не знает про `Executor` — даёт только примитив снизу.

## 3. Синтаксис блока

```
## $<engine> <id>
$attr: value
` ``<lang>
<код>
` ``
```

(fence записан с пробелом для читаемости спеки — в реальности без пробела)

- **engine** — движок: `shell` / `ts` / `zx`. **Имя блока роутит исполнение.**
- **id** — идентификатор (опционален; ссылки/диагностика).
- **Атрибуты** (`$attr:`) — локальные переменные, доступны в `${attr}` внутри тела. Служебные: `$nr-parse`, `$cwd`, `$env`, `$nr-raw`, `$timeout`, `$nr-mode`.
- **Тело** — fenced-код. **Fence обязателен** — отделяет декларацию (mdz-атрибуты) от исполняемого тела. Это механизм «объявить переменные в нотации mdz внутри блока».
- **Info-string** fence (` ```cmd `, ` ```ts `) — подсветка редактору. **Движок берётся из имени блока, не из info-string.**

### 3.1 Примеры

```
## $shell greet
$name: world
` ``cmd
echo hello ${name}
` ``
```

```
## $ts compute
$base: 40
` ``ts
const n = ${base} + 2
console.log(JSON.stringify({ result: n }))
` ``
```

```
## $zx gitlog
` ``ts
const out = await $`git log --oneline -5`
console.log(out.stdout)
` ``
```

## 4. Резолв тела

Тело резолвится **перед исполнением**: `resolve(body, chain)` из nrd-core. **Резолв включён по умолчанию** — смысл блока в параметризации кода данными.

Контекст резолва — chain с приоритетом:
1. **Block-local атрибуты** (`$attr:` блока) — высший приоритет
2. **Внешний контекст** (`external`, передан вызывающим)

`chain([blockLocals, external])`, first-wins. **Block-local перебивает external.**

```
## $shell x
$test: local
` ``cmd
echo ${test}      # "local" — block-local, даже если снаружи test=other
echo ${bot.name}  # из внешнего контекста
` ``
```

Отключить резолв (тело сырым) — `$nr-raw: true`.

### 4.1 Конфликт с shell-синтаксисом `$`

Три уровня, не конфликтуют:

1. **Голый `$VAR`** (`$HOME`, `$PATH`, `$1`) — НЕ плейсхолдер (нужны скобки), парсер nrd не трогает. Уходит в shell как есть.
2. **`${name}`** — резолвится из контекста. Целевое поведение.
3. **`${UNKNOWN}`** со скобками — если ключа нет, lenient-резолв оставляет литералом → shell резолвит свою переменную.

Коллизия только если имя shell-переменной со скобками совпало с ключом контекста — эскейп `\${VAR}` (opt-out, format-spec §2.5). На практике неймспейсы не пересекаются.

## 5. Движки и executor

Движок (`shell`/`ts`/`zx`) — это то, что блок *хочет* исполнить. Executor — это то, что *умеет* исполнять в текущем окружении. Их связывает `supports`: каждый executor честно объявляет, какие движки тянет.

| Executor | supports | где |
|----------|----------|-----|
| `spawnExecutor` | `shell, ts, zx` | Node (наш) |
| `inProcessExecutor` | `ts` | browser/edge (клиентский) |
| `remoteExecutor` | по конфигу раннера | любое (клиентский) |

`execBlock` на `## $shell` под executor'ом без `shell` в `supports` → внятный `Result.err` («движок shell не поддерживается текущим executor'ом»), а не криво падает. Это честная граница, которую даёт явный `supports`.

**Почему shell не в `inProcessExecutor`:** в браузере нет оболочки в принципе. shell исполним только там, где есть процессы (Node — `spawnExecutor`) или удалённый раннер (`remoteExecutor`).

## 6. Результат

`ExecOutput` несёт два возможных канала:
- **`stdout`** — текст (даёт любой executor). Парсится по `$nr-parse`.
- **`value`** — нативный return (даёт только in-process executor через `AsyncFunction`; spawn оставляет `undefined`).

`execBlock` собирает IContext так:
1. Если `value` присутствует (in-process) — обернуть его напрямую в IContext (богатый объект, parse не нужен).
2. Иначе — распарсить `stdout` по `$nr-parse`:

| `$nr-parse` | Действие | Результат |
|-------------|----------|-----------|
| `text` | как есть | `objectContext({ content: stdout })` |
| `json` | `JSON.parse(stdout)` | IContext из объекта |
| `mdd` | `parseDocument(stdout, { sigil: '@' })` | IContext |
| `mdz` | `parseDocument(stdout, { sigil: '$' })` | IContext |

Default `$nr-parse`: `text`. Если `code ≠ 0` — `Result.err` со stderr, ничего не парсится.

## 7. Интерфейсы

### 7.1 nr-infra: примитив исполнения (Node-IO)

```typescript
// nr-infra/src/exec.ts — НЕ знает про Executor

export interface ExecOptions {
  cwd?: string
  env?: Record<string, string>   // merge поверх process.env
  timeout?: number               // мс; kill процесса по истечении
  shell?: string | boolean       // оболочка: true=системная, строка=путь
  input?: string                 // stdin
}
export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/** Выполнить shell-команду. child_process.spawn, ноль зависимостей. */
export function execShell(cmd: string, opts?: ExecOptions): Promise<Result<ExecResult>>

/** Запустить файл: node <path> args. */
export function runFile(path: string, args?: string[], opts?: ExecOptions): Promise<Result<ExecResult>>
```

`Result.err` при `code ≠ 0` / spawn-ошибке; `ExecResult` доступен в обоих исходах (stderr для диагностики).

### 7.2 nrd-exec: контракт Executor (PORTABLE)

```typescript
// nrd-exec/src/executor.ts — платформо-нейтральный, ноль Node-специфики

export interface ExecInput {
  engine: 'shell' | 'ts' | 'zx'
  code: string                         // тело после резолва ${}
  env?: Record<string, string>         // строки, не process.env
  cwd?: string                         // опционален — браузер игнорирует
  timeout?: number
  input?: string                       // stdin
}
export interface ExecOutput {
  stdout: string
  value?: unknown                      // return value (in-process даёт, spawn — нет)
  stderr: string
  code: number
}
export interface Executor {
  readonly id: string
  readonly supports: ReadonlySet<'shell' | 'ts' | 'zx'>
  run(input: ExecInput): Promise<Result<ExecOutput>>
}
```

### 7.3 nrd-exec: spawnExecutor (Node-only экспорт)

```typescript
// nrd-exec/src/executors/spawn.ts — реализует Executor поверх nr-infra
import { execShell, runFile } from '@kerneldreams/nrd/web'

export const spawnExecutor: Executor
// supports = {shell, ts, zx}
// shell → execShell(code, opts)
// ts/zx → временный файл (или stdin) + runFile; zx инъектирует import 'zx/globals'
// ОБЯЗАТЕЛЬНО try/finally cleanup временных файлов (см. §11)
```

Отдельный модуль/экспорт — браузерный бандл его не тянет (tree-shake), `execBlock` остаётся portable.

### 7.4 nrd-exec: execBlock (PORTABLE ядро)

```typescript
// nrd-exec/src/index.ts
import type { Block, NRDocument, IContext } from '@kerneldreams/nrd'
import type { Result } from '@kerneldreams/nrd/web'
import type { Executor } from './executor.js'

export interface ExecBlockOptions {
  executor: Executor        // ОБЯЗАТЕЛЕН — инъекция исполнения (как driver в createStorage)
  external?: IContext       // внешний контекст для резолва тела
  baseDir?: string          // cwd по умолчанию
}

export function execBlock(block: Block, opts: ExecBlockOptions): Promise<Result<IContext>>
export function execBlocks(doc: NRDocument, opts: ExecBlockOptions): Promise<Result<Record<string, IContext>>>
```

Алгоритм `execBlock`:
1. engine из `block.name` (`shell`/`ts`/`zx`); если executor не в `supports` — `Result.err`.
2. chain([blockLocals из атрибутов, external]).
3. Тело (снять fence), резолв `${}` через chain (если не `$nr-raw`).
4. `executor.run({ engine, code, env, cwd, timeout, input })`.
5. ExecOutput → IContext: `value` напрямую, иначе `stdout` по `$nr-parse`.
6. `Result.ok(ctx)` / `Result.err(stderr)`.

Служебные атрибуты блока: `$nr-parse`, `$cwd`, `$env`, `$timeout`, `$nr-raw`, `$nr-mode` (подсказка executor'у), `$shell-bin`.

## 8. Интеграция с nrd-context

`exec`/`script` source-плагины nrd-context — тонкие обёртки над `execBlock`. **Executor передаётся сверху** (клиент nrd-context знает своё окружение и приносит executor — в Node `spawnExecutor`, в браузере `inProcessExecutor`):

- `exec` плагин (`$nr-type: exec`) → виртуальный `$shell` блок (`$cmd` → тело) → `execBlock(block, { executor })`.
- `script` плагин (`$nr-type: script`, `$engine: ts/zx`) → `$ts`/`$zx` блок из `$path` или inline → `execBlock(block, { executor })`.

nrd-exec не дублирует исполнение и переиспользуем вне nrd-context.

## 9. Scope — что НЕ делаем

- Сборку контекста из источников, chain → **nrd-context**
- Шаблоны, рендер → **ntpl**
- LLM, провайдеры → **nr-infra / providers**
- Сетевой HTTP → **nr-infra.http**
- **`inProcessExecutor`, `remoteExecutor`, TS-стриппинг для браузера, детект окружения** → **клиентский код.** Контракт `Executor` готов; потребитель реализует executor под свою платформу и приносит его в `execBlock`. Мы не пишем браузерный/edge executor и не угадываем платформу.
- Выбор executor'а по умолчанию, автодетект — **забота клиента** (как выбор storage-драйвера).
- Кэширование результатов → потребители
- Песочница / security boundary — subprocess даёт базовую изоляцию, не более

## 10. Зависимости

- `@kerneldreams/nrd` — `parseDocument`, `IContext`, `resolve`, `chain`, `objectContext`
- `@kerneldreams/nrd/web` — `execShell`, `runFile`, `Result`
- `zx` — для движка `$zx` в `spawnExecutor` (прямая зависимость nrd-exec; в браузерный бандл не попадает, т.к. `spawnExecutor` tree-shake-нут)

`execBlock` + `Executor` — portable (только nrd-core + типы). `spawnExecutor` — Node-only опциональный экспорт.

## 11. Открытые решения (приняты в спеке, под ревью владельца)

- **A.** `execShell` → `Result<ExecResult>`, `child_process.spawn`, ноль deps (стандарт nr-infra).
- **B.** В `spawnExecutor` ts/zx исполняются через **временный файл** + `node` нативно (Node 24, без tsx) — честные стектрейсы с именем файла/строкой, zx работает (хочет файл-модуль). **Обязателен `try/finally` cleanup** — иначе хвосты (в core видны 20 висячих `tmpclaude-*`). Альтернатива — stdin-pipe (нет файла/мусора, ценой стектрейсов `[stdin]`). Выбор B: файл + гарантированный cleanup.
- **C.** Код shell-блока — в **теле** (fenced), не в `$cmd`. Унификация движков. (`$cmd` — краткая форма только для `exec`-плагина nrd-context.)
- **D.** `cwd` по умолчанию = `baseDir`, override `$cwd:`.
- **E.** `env` = `process.env` + merge `$env:`; данные контекста в код через резолв `${}`, не через env.
- **F.** zx — зависимость `nrd-exec` (в `spawnExecutor`), tree-shake из браузерного бандла. Потребитель zx не ставит.
- **G.** Результат — `value` если executor его дал (in-process), иначе `stdout` + parse по `$nr-parse` (spawn). Не «всегда stdout» — два канала, in-process отдаёт богатый return.
- **H.** `Executor` интерфейс — в `nrd-exec` (язык блок-семантики). `spawnExecutor` — тоже в `nrd-exec`, поверх `nr-infra.execShell`. nr-infra про `Executor` не знает. Ноль цикла зависимостей.
