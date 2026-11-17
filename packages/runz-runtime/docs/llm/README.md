# @kerneldreams/runz-runtime/llm — DEPRECATED (07.2026)

**DEPRECATED 07.2026: канон — [@kerneldreams/nrd/web](../../../../nrlib/nr-infra) (транспорт) + `@kerneldreams/engine` `resolveProviderConfig` (конфиг). Новый код сюда не добавлять.**

Этот пакет — исторический LLM-слой runz. Он оставлен рабочим для существующих
потребителей (`scripts/chat.ts`, `scripts/llm.ts`), но заморожен:

- **транспорт** (HTTP, стрим, провайдеры openai/anthropic/ollama) — теперь
  `@kerneldreams/nrd/web` (`openaiProvider` / `anthropicProvider` / `ollamaProvider`,
  `provider.stream`, idle-watchdog);
- **резолв провайдера** (имя + цепочка → apiKey/baseUrl/type/think/timeout) —
  теперь единственная точка `resolveProviderConfig(ctx, name)` из
  `@kerneldreams/engine` (см., `provider-consolidation-spec.md`).

Новую функциональность добавлять в nr-infra / nr-engine, а не сюда. Правки здесь —
только для поддержки существующего поведения (bugfix), без расширения API.
