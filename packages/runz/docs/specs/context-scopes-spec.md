# Context scopes — sys/settings/document, маунты, trusted

**Статус:** spec ready
**Репо:** `~/Studio/Projects/runz` (runtime) + `~/Studio/kd/packages/nrd` (слой `context`, бывший пакет nrd-context)
**Основание:** решения 07.07 (DECISIONS, «Слоистые контексты», «Типовые слои»). Принято: изоляция скоупов по умолчанию, доступ через маунты, trusted как выбор цепочки.

## Модель

Три типовых скоупа, каждый — своя цепочка (chainContext, приоритет слева направо):

```
sys      = argv(nr-*) → appz-config → root-config(~/.runz/config.md) → env (только под `env.`)
settings = user-settings → default-settings
document = argv → doc → user-doc → default-doc
```

- **document** — то, что тулза получает как `ctx` (протокол `export default async function(ctx, meta)` НЕ меняется).
- **sys/settings** доступны из document только явными путями через **маунты**: слой `objectContext({ sys: sysChain, settings: settingsChain })` в хвосте document-цепочки. `${sys.gitea.token}`, `${settings.editor}` — работают; голые `${token}` из document в sys НЕ провalиваются.
- Провайдер-блоки (`## $provider`) и env живут в sys-scope. `resolveProviderConfig` (nr-engine, спека provider-consolidation) получает sys-цепочку — конфиги вида `$api_key: ${env.OPENROUTER_API_KEY}` резолвятся об sys, где env есть. Окружение — только неймспейсом `env.`: голый `${OPENROUTER_API_KEY}` не резолвится нигде, ни в sys, ни в document; из документа — `${sys.env.VAR}`. Недоверенный документ env не видит вовсе.
- Пер-тулза расширение: тулза может декларативно попросить `$nr-scope: document+settings` (атрибут в своём главном файле/конфиге appz) — тогда settings-цепочка вклеивается в document. Дефолт — изоляция.

## Работы

### 1. runz/runtime: сборка скоупов

`chain.ts`: вместо одной плоской цепочки строить три (рецепты выше), document получает маунт-слой. `buildChain()` → `buildScopes(): { sys, settings, document }`; `execute` передаёт document как ctx.

Обратная совместимость — ключевой риск: существующие appz, читающие из ctx то, что теперь в sys (напр. `ctx.get(['provider', name])` в chat3/playground!). Решение: переходный слой — document-цепочка ВРЕМЕННО включает sys-хвостом (после маунтов), с пометкой `// TODO migration: убрать sys-хвост`. Итог этапа 1: маунты работают, ничего не сломано, изоляция ещё не включена.

### 2. runz: `--untrusted` / untrusted-режим

Флаг CLI + `$nr-trusted: false` в документе (self-declared недоверие для пайплайнов). Untrusted document-цепочка: без sys-хвоста, без маунтов, без env; только doc-слои + argv.

### 3. nrd (`buildContext`, бывший nrd-context): `BuildContextOptions.trusted` (default `true`)

`trusted: false` →
- источники `exec`, `script`, `file`, `env` — пропускаются с warn (или err — behaviour flag `strictUntrusted`);
- `builtinFunctions` (loadMDD/loadMDZ/loadJSON/readFile) — не подключаются;
- envContext не входит в params-цепочку.

Тест: документ с `${env.OPENROUTER_API_KEY}` и `${readFile("/etc/secret")}` при trusted:false → плейсхолдеры остаются литералами (lenient) / err (strict), env-значение НЕ утекает.

### 4. Изоляция (после миграции потребителей)

Убрать sys-хвост из document (TODO из п.1). Отдельный коммит, прогон всех appz-смоуков. Если объём миграции всплывёт большим — остановиться, доложить, не ломать.

### 5. Документация

`runz/docs/scopes.md`: модель, рецепты, маунты, nr-scope, untrusted, migration note для авторов appz (`ctx.get(['provider',...])` → `resolveProviderConfig`/`${sys.provider...}`).

## Критерии приёмки

- Все существующие runz-тесты зелёные + новые на buildScopes/маунты/untrusted.
- Смоук: `runz chat3 <сессия> --debug` работает без правок chat3 (этап 1, переходный слой).
- Untrusted-тест из п.3 зелёный.
- `runz <скрипт> --untrusted` — документ не видит env/fs.

## Зависимости и порядок

После provider-consolidation (chat3/playground перестают лазить в provider-блоки сами — миграция п.4 дешевеет). Пункты 1–3 можно делать сразу, п.4 — после.

## Запреты

- Протокол `(ctx, meta)` не менять.
- Существующие appz не править в этой таске (кроме смоук-проверок) — миграция потребителей отдельным решением после п.4-доклада.
