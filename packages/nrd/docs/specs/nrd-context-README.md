# @kerneldreams/nrd

Сборка данных из источников в единый `IContext` (chain).

Ядро **portable** (зависит только от `@kerneldreams/nrd`): парс mdz-конфига, merge
параметров, `$required`, plugin resolution, chain. Платформенные возможности —
чтение файлов (`storage`), исполнение кода (`executor`), сеть (`http`) —
инъектируются через `SourceContext`. Потребитель приносит их под платформу.

Спека: [`docs/specs/nrd-context-spec.md`](docs/specs/nrd-context-spec.md) ·
API: [`docs/API.md`](docs/API.md)

## Установка

```jsonc
// package.json
"@kerneldreams/nrd": "file:../nrd-context"
```

## Использование (Node)

```typescript
import { buildContext, wrapContext } from '@kerneldreams/nrd'
import { nodeCapabilities } from '@kerneldreams/nrd/node' // fs + spawn + fetch

const chain = await buildContext(configText, {
  ...nodeCapabilities(__dirname),   // { storage, executor, http }
  params: { profile: 'alice-example' },
  baseDir: __dirname,
})

const obj = wrapContext(chain)       // JS Proxy для шаблонизаторов
```

В браузере потребитель приносит свои capabilities (`storage`/`executor`/`http`)
вместо `nodeCapabilities()`.

## Источники (builtin)

| `$nr-type` | Capability | Описание |
|------------|-----------|----------|
| `inline`   | —          | данные в теле/`$`-атрибутах блока |
| `env`      | —          | `$keys: KEY1, KEY2` → process.env |
| `file`     | `storage`  | `$path` через storage, `$nr-parse` (text/json/mdd/mdz) |
| `json`     | `storage`  | shorthand для file + json |
| `exec`     | `executor` | `$cmd` → делегирует `nrd-exec.execBlock` (shell) |
| `script`   | `executor` | `$path`/тело → `execBlock` (ts/zx); `$engine: node\|zx` |

`exec`/`script` **не исполняют код сами** — собирают виртуальный блок и зовут
`nrd-exec.execBlock`, передавая `executor` из `SourceContext`.

## Экспорты

- `@kerneldreams/nrd` — ядро (portable): `buildContext`, `chainSources`,
  `wrapContext`, типы, `builtinSources`.
- `@kerneldreams/nrd/node` — `nodeCapabilities()`, `fetchHttp` (тянет
  `nr-infra` + `nrd-exec`, tree-shake из браузерного бандла).
