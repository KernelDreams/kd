# @kerneldreams/engine

A universal LLM execution pipeline: **assemble a prompt, send it to an LLM, handle the response**.

An engine for chatbots, translators, commit-message generators, agents — any task that calls an LLM and does something
with the answer.

```sh
npm i @kerneldreams/engine
```

```ts
import { run } from '@kerneldreams/engine'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'

const store = createMemoryStore()
const { id } = await store.create({})

const result = await run(
  { handler: 'raw', orchestrator: 'simple', model: 'google/gemini-2.5-flash', provider: 'openrouter' },
  {
    target: { store, sessionId: id },
    systemPrompt: 'Translate to English. Output only the translation.',
    userMessage: 'Bonjour, le monde',
  },
)
console.log(result.output)
```

The API key comes from `EngineConfig.apiKey` or the `LLM_API_KEY` environment variable. For tests and in-process
embedding, pass `RunInput.provider` (an `LLMProvider`) to skip the network entirely.

## How it fits together

Storage is a `SessionStore` from `@kerneldreams/chat-store`, passed as `RunInput.target` (`{ store, sessionId }`, or a
registered `storeName` plus `storeOpts`). The engine itself only generates. Three pluggable interfaces, resolved by
convention from `EngineConfig`, plus the single `run(config, input?)` entry point:

| Interface | What it does | Implementations |
|-----------|-----------|------------|
| `IAssembler` | builds the prompt | `DirectAssembler` |
| `IOrchestrator` | drives the LLM calls | `SimpleOrchestrator`, `AgentOrchestrator` (tool loop) |
| `IHandler` | handles the response | `ChatHandler`, `RawHandler`, `TranslateHandler`, `ExtractHandler` |

`run` seeds the input into the store, loads history, runs the context engine (token budget, lorebooks, injectors),
assembles the prompt, orchestrates the call (with hooks and a typed `onEvent` stream), and hands the response to the
handler. `RawHandler` returns the text and saves nothing; `ChatHandler` appends the reply to the session.

The engine does not know where data comes from, how templates are rendered, or how HTTP is done — it only
orchestrates calls between those pieces.

## Dependencies

- `@kerneldreams/chat-store` — session store and the dialogue model (`Message`, `Part`)
- `@kerneldreams/nrd` — `IContext`, `Value`, context resolution; its `/web` entry provides `LLMProvider` with the
  OpenAI and Anthropic providers, and `/node` provides `fsStorage`

## Documentation

- `docs/specs/nr-engine-spec.md` — specification
- `docs/API.md` — public API

## Tests

```
npx tsc --noEmit          # typecheck
npx vitest run            # unit/integration tests plus one live test (skipped without a key)
```

The live test through OpenRouter is enabled by the `OPENROUTER_API_KEY` (or `LLM_API_KEY`) variable.
