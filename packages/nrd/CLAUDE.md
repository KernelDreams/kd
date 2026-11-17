# nrd 1.0 — `@kerneldreams/nrd`

Интерпретатор NRD одним пакетом: формат mdd/mdz, resolver, сборка контекста,
исполнение блоков, шаблоны. Слит 08.09.2026 из шести пакетов (`nrd-core`,
`nrd-context`, `nrd-exec`, `nr-runtime`, `nr-infra`, `ntpl`) по спеке
`~/Studio/Projects/nrchat.dev/specs/nrd-merge-spec.md`. Переезд импортов — `docs/MIGRATION.md`.

## Лестница платформ — главное правило

Subpath режут пакет НЕ по бывшим пакетам, а по тому, что модуль просит у среды.
Ступень определяется одним вопросом: где это обязано работать.

| Subpath | Что можно | Где работает |
|---|---|---|
| `nrd` | ноль environment API: ни `node:`, ни `fetch` | + GAS |
| `nrd/web` | WinterCG: fetch, streams, crypto | + браузер, CF Workers |
| `nrd/node` | fs, spawn, process, discovery | только Node |
| `nrd/template` | ntpl; движки — optional peers | как `nrd` + движок |
| `nrd/format` | фасад кодека mdd/mdz | + GAS |
| `nrd/batch` | комбинаторика документа: оси, оси-таблицы, группы `## $batch` | + GAS |

Новый модуль кладётся на САМУЮ ВЕРХНЮЮ ступень, где он ещё честен. Понадобился
`node:` в portable-слое — это сигнал вынести платформенную часть в порт и
инъектировать (образец — `SyncFileIO` в `src/context/functions.ts` +
`src/node/fs.ts`), а не опустить весь модуль в `/node`.

## Структура

```
src/
  index.ts          корень = core + context + exec + infra
  core/             парсер-фасад, IContext/IArray, resolver, walk, NRDocument
  context/          buildContext: mdz-конфиг → chain, source/transform-плагины
  exec/             execBlock, контракт Executor
  infra/            Result, generateId, fileIncludeResolver
  program/          документ как программа: реестр деклараций, мост mds, fn/template
  web/              http, llm/*, memoryStorage, embed (normText/hash/f16/cachedEmbed)
  node/             fs, storage, exec, spawn, capabilities, runtime, ntpl-loader,
                    detect/loadProgram, presets (профили — инклюд по выбору),
                    nodeCodeLoader, helpers, sqliteEmbedStore
  template/         ntpl (engine, helpers, route, sites)
  format/           фасад кодека
  batch/            оси (списки, tbl), достижимость через лексер ${}, группы батчей
test/               core в корне, остальное по подпапкам — один vitest
docs/specs/         спеки всех шести бывших пакетов (перенос, не правка)
docs/MIGRATION.md   карта переезда импортов и поведенческие изменения
scripts/smoke-pack  pre-publish проверка упакованной установки
```

## Команды

```
npm install
npm run build     # tsc
npm test          # vitest run — 666 тестов
npm run smoke     # упаковка → чистый проект → импорт всех шести subpath
```

## Ограничения

- TypeScript, ESM, strict.
- Зависимости — только вниз по ярусу (DECISIONS nrchat.dev, `[nr-system]` 16.07): рантайм —
  `@kerneldreams/nrd/contracts`, `@kerneldreams/nrd/md`, `@kerneldreams/nrd/json5`,
  `@kerneldreams/nrd/chat`, `zx` (только node-ступень). Отдельный npm `json5`
  не заводить.
- Формат `%role` ядро НЕ реализует: разбор — `parse` из nr-chat, форма
  сообщения — `ChatMessage`.
- Парсер НЕ резолвит `${}` — только распознаёт; тело отдаёт сырой строкой.
- `${}` разбирать brace-balanced сканером, НЕ regex. Коэрсия — строковыми
  примитивами, НЕ regex-диалектами.
- `nunjucks`/`handlebars`/`ajv` — optional peers. Импорт движка только ленивым
  `import()`: `nrd/template` обязан импортироваться без них (проверяет smoke).
- Перед публикацией — `npm run smoke`. Публикация внутренних пакетов идёт
  через `nr libs publish` (переписывает `file:` в `^version`); прямой
  `npm publish` уносит `file:` как есть.
