# Context scopes — sys / settings / document

runz собирает контекст скрипта не одной плоской цепочкой, а тремя типовыми
**скоупами**. Каждый скоуп — своя `chainContext` (приоритет слева направо,
first-wins). Тулза получает **document**; `sys`/`settings` доступны из него
только явными путями через маунты.

Реализация: `packages/runtime/src/chain.ts` → `buildScopes()`.
Основание: спека `docs/specs/context-scopes-spec.md`.

## Модель

```
sys      = argv → explicit/script config → project config → global(~/.runz) config → env
settings = project config → global config
document = argv → doc            (+ маунт-слой sys/settings; + переходный sys-хвост)
```

- **document** — то, что тулза получает как `ctx` в
  `export default async function(ctx, meta)`. Протокол `(ctx, meta)` НЕ меняется.
- **sys** — провайдер-блоки (`## $provider`), root-config, переменные окружения.
  Здесь живут секреты и `env`.
- **settings** — пользовательские настройки. У runz пока нет отдельных
  settings-файлов, поэтому scope маппится на конфиг-слои (project → global) без
  `env` и без sys-секретов.

## Маунты

В хвост document-цепочки вклеен слой `objectContext({ sys, settings })`. Поэтому
из документа sys/settings видны **только по явному пути**:

```
${sys.gitea.token}     → значение из sys-скоупа
${settings.editor}     → значение из settings-скоупа
```

Голый `${token}` из документа в sys НЕ проваливается через маунт-неймспейс —
это и есть изоляция скоупов. (Единственное исключение сейчас — переходный
sys-хвост, см. ниже.)

## Переходный sys-хвост (обратная совместимость)

На **этапе 1** document-цепочка ВРЕМЕННО включает sys-хвостом (после маунтов),
чтобы существующие appz, читающие из `ctx` то, что теперь живёт в sys, не
ломались:

```ts
ctx.get(['provider', name])   // ещё работает через sys-хвост
${sys.env.OPENROUTER_API_KEY} // env — только под неймспейсом `env.`
```

Хвост помечен `// TODO migration` в `chain.ts`. Снятие хвоста —
**отдельным коммитом** после миграции потребителей и прогона всех appz-смоуков
(изоляция скоупов по умолчанию).

## `$nr-scope` — пер-тулза расширение (план)

Тулза сможет декларативно попросить вклеить settings-цепочку в document:

```
$nr-scope: document+settings
```

Дефолт — изоляция (только document + маунты). Пока не реализовано; зарезервировано
спекой.

## Untrusted — `--untrusted` / `$nr-trusted: false`

Недоверенный документ (например, звено пайплайна из внешнего источника) не должен
видеть окружение, ФС и sys-секреты. Два способа включить:

- CLI-флаг: `runz <script> --untrusted`
- Самодекларация в документе: `$nr-trusted: false`

Untrusted document-цепочка собирается **без sys-хвоста, без маунтов и без env** —
только `doc`-слои + `argv`:

```
document (untrusted) = argv → doc
```

Итог: `${sys.*}` остаётся литералом, `${env.VAR}` из окружения не резолвится,
`ctx.get(['provider', …])` возвращает `undefined`.

> Параллельный механизм на уровне сборки контекста — `BuildContextOptions.trusted`
> в `@kerneldreams/nrd` (buildContext, default `true`). При `trusted: false` пропускаются
> source-блоки `exec`/`script`/`file`/`env`, не подключаются FS-функции
> (`loadMDD`/`loadMDZ`/`loadJSON`/`readFile`) и `env` не входит в params-цепочку.
> Флаг `strictUntrusted` превращает warn+skip в ошибку.

## Migration note для авторов appz

Если ваша тулза лазила в sys-данные напрямую из `ctx`, переведите её на явный
доступ **до** снятия переходного sys-хвоста:

| Было (сломается после п.4)        | Стало                                            |
|-----------------------------------|--------------------------------------------------|
| `ctx.get(['provider', name])`     | `resolveProviderConfig(...)` (получает sys-scope) |
| `${OPENROUTER_API_KEY}` в доке    | `${env.OPENROUTER_API_KEY}` или provider-конфиг   |
| голый `${gitea.token}`            | `${sys.gitea.token}`                              |

Провайдер-конфиги вида `$api_key: ${env.OPENROUTER_API_KEY}` резолвятся об sys-цепочку
(там есть env под неймспейсом `env.`) — голым ключом окружение не резолвится нигде: env — слабейшее звено, и служебный ключ в нём (`_`, `HOME`, `PWD`) молча
подменял отсутствующее значение.
