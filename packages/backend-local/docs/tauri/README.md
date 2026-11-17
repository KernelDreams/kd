# @kerneldreams/backend-local/tauri

Транспорт `nr-ui-protocol` через Tauri `invoke` — без HTTP. Обе стороны в одном пакете:

- **`createTauriBackend({ invoke, listen })`** — webview: `ProtocolBackend` поверх команды `protocol_call` и события
  `protocol_event`. UI не отличает его от `createHttpBackend`.
- **`createProtocolHost(backend, { emit })`** — sidecar: принимает вызовы, проверяет аргументы, стримит `run` и
  `workspace.files.watch` кадрами.
- **`createMemoryBridge(backend)`** — фейковый `invoke`/`listen` в одном процессе (JSON + асинхронная доставка):
  loopback-тесты и dev-сборки без Tauri.

Зависимости — только `@kerneldreams/ui-protocol`. `@tauri-apps/api` не импортируется.

Провод — [docs/TRANSPORT.md](docs/TRANSPORT.md).

## Webview

```ts
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createTauriBackend } from '@kerneldreams/backend-local/tauri/client'

const backend = createTauriBackend({ invoke, listen })
for await (const ev of backend.run(sid, { userMessage: 'привет' })) render(ev)
```

Без опций берёт `window.__TAURI__.core.invoke` / `window.__TAURI__.event.listen` (`app.withGlobalTauri`).

| opt | default | что |
|---|---|---|
| `invoke`, `listen` | `window.__TAURI__` | функции Tauri |
| `command` | `protocol_call` | имя команды |
| `event` | `protocol_event` | имя события кадров |
| `capabilitiesTtl` | навсегда | TTL кэша capabilities, мс |

Опциональные методы есть всегда; незаявленная у бэкенда операция приезжает `NotSupportedError`, прочие ошибки —
`BackendError{code}`. Порвался провод — `code: 'connection_lost'`, у рана — синтетический `run_end`.

## Sidecar

```ts
import { createProtocolHost } from '@kerneldreams/backend-local/tauri/host'
import { createLocalBackend } from '@kerneldreams/backend-local'

const host = createProtocolHost(createLocalBackend({ root }), {
  emit: (payload) => send({ event: payload }),        // оболочка: app.emit('protocol_event', payload)
})
onRequest(async ({ id, method, args }) => send({ id, reply: await host.call({ method, args }) }))
```

`host.call` не бросает. `host.close()` закрывает стримы, но не бэкенд.

## Тесты

```ts
import { createMemoryBridge, createTauriBackend } from '@kerneldreams/backend-local/tauri'

const bridge = createMemoryBridge(backend)
const client = createTauriBackend({ invoke: bridge.invoke, listen: bridge.listen })
bridge.kill() // sidecar умер: хост закрыт, окну — reset
```

## Разработка

```bash
npm test        # vitest: loopback fake-backend ⇄ host ⇄ memory bridge ⇄ client
npm run build   # tsc → dist
```
