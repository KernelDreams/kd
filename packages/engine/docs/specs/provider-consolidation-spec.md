# Provider consolidation — одна точка chain → ProviderOptions

**Статус:** spec ready
**Репо:** `S:\nrlib\nr-engine` (+ правки потребителей: `S:\appz\chat3`, `S:\appz\playground`, пометки в `S:\Projects\runz`)
**Основание:** ревью 07.07 — четыре LLM-слоя в системе; lookupProvider скопирован в chat3 и playground и разъехался. Решение принято (DECISIONS 07.07).

## Цель

Единственная точка резолва «имя провайдера + цепочка → ProviderOptions» — в nr-engine. Потребители не знают форму `## $provider`-блоков.

## Работы

### 1. nr-engine: `resolveProviderConfig(ctx: IContext, name: string): ProviderConfig`

Новый экспорт (src/providers.ts). Семантика — эталон = текущий chat3.lookupProvider (самый свежий, 07.07), объединённый с playground-версией:

```ts
interface ProviderConfig {
  apiKey?: string      // <name>_api_key | <name>-api-key | блок.api_key | блок.api-key
  baseUrl?: string     // блок.base_url | блок.base-url
  type?: string        // блок.type
  think?: boolean      // блок.think
  timeout?: number     // блок.timeout (ms; заголовки + idle одним значением)
}
```

Блок = `ctx.get(['provider', name])`. Плюс существующий `buildProvider` принимает результат (уже принимает после 07.07: timeout → ProviderOptions.timeout+idleTimeout).

Тесты: цепочка с блоком/без, фолбэки api_key, приоритет CLI-слоя над конфигом (chainContext).

### 2. chat3: локальный lookupProvider удалить, импортировать из nr-engine

Удаление санкционировано этой спекой. Поведение не меняется — проверка: `runz chat3 S:\tmp\chat3-test.mds --debug` даёт идентичный дамп тела (файл существует, провайдер pc-2).

### 3. playground: локальный lookupProvider удалить, импортировать из nr-engine

### 4. playground: helpers.llm — стрим + extra

`helpers.llm(opts)` перевести с `provider.chat` на `provider.stream` с fold:
- наружу тот же Promise<string>;
- opts дополняется `extra?: Record<string, unknown>` (прокидывается в LLMRequest.extra) и `onProgress?: (e: {tokens: number}) => void`;
- thinking-чанки не входят в результат (отбрасываются или отдаются через onProgress-канал `{thinking: true}` — на усмотрение, задокументировать);
- idle-watchdog nr-infra (07.07) начинает защищать батчи автоматически (стрим-путь).

Обоснование: не-стрим путь не имеет прогресса и ранней смерти зависшей ноды; согласовано 07.07.

### 5. runz: deprecation-пометки (НЕ удалять)

- `packages/llm/**` — заголовочный комментарий в каждом файле + README.md в директории: «DEPRECATED 07.2026: канон — @kerneldreams/nrd/web (транспорт) + @kerneldreams/engine resolveProviderConfig (конфиг). Новый код сюда не добавлять.»
- `scripts/chat.ts`, `scripts/llm.ts` — тот же комментарий в шапку.

## Критерии приёмки

- nr-engine: tsc чистый, vitest зелёный (42+ и новые).
- chat3 smoke: `runz chat3 <тест-сессия> --debug` — тело запроса идентично до/после (сравнить дампы).
- playground smoke: `runz playground <файл с $type: playground и llm-экшеном>` работает; extra доносится (проверить --debug-подобным дампом или llama-server /slots).
- grep по chat3/playground: строка `function lookupProvider` отсутствует.

## Запреты

- Ничего в runz/packages/llm не удалять и не рефакторить — только пометки.
- Легаси S:\libs (там свой llm/) — не трогать вообще.
