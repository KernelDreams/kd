# @kerneldreams/chat-client

A thin, dependency-free client for an nrchat backend (the HTTP binding of the UI protocol): sessions, runs streamed
over SSE, answers to questions and approvals, cancel, profiles, models, access key. Works in the browser and in Node
(`fetch` plus stream reading, not `EventSource` — a run is started with a POST that has a body and carries the key
header). Types come from `@kerneldreams/ui-protocol` (`import type` only; the protocol is not shipped at runtime).

```sh
npm i @kerneldreams/chat-client
```

```js
import { createClient } from '@kerneldreams/chat-client'

const chat = createClient('http://127.0.0.1:7800', { auth: 'access key' })
const s = await chat.sessions.create({ profile: 'agent' })
const end = await chat.run(s.id, 'hello', { onEvent: (ev) => ev.type === 'part_delta' && print(ev.delta) })
```

## API

`createClient(baseUrl, { auth?, fetch?, headers?, capabilitiesTtl? })`:

| method | description |
|---|---|
| `capabilities()` | what the backend can do (cached until `close`) |
| `sessions.list/create/get/history` | sessions; `create({profile, model, cwd, title…})` takes the protocol's `SessionCreateOpts` |
| `sessions.meta.get/patch` | session meta: prompt, `tools` (page tools), `workspace.cwd` |
| `run(sid, input, {target, onEvent, signal})` | a whole run, resolving to `run_end`. `input` is text, parts or a `RunStartInput`. `signal` sends `cancel` to the server; the result is `run_end` `cancelled`. A refusal before the stream (`not_supported`, `busy`, 401) rejects; a run error is `run_end` `error` |
| `stream(sid, input, {target, signal})` | the same run as an async iterator (`for await`) |
| `respond(sid, askId, answer)` | answer an `ask`: `tool_approval` (`allow` / `allow_session` / `deny`), `select`, `text`, `tool` (result of a page tool) |
| `cancel(sid, runId)`, `profiles()`, `models()`, `close()` | |
| `backend` | the full `ProtocolBackend` (edits, swipes, attachments, files, services) |

`clientOf(backend, baseUrl = 'local')` is the same client on top of any `ProtocolBackend` (for example a backend
running in the page's own process).

`createHttpBackend(url, opts)` is a full `ProtocolBackend` over HTTP. Errors: `BackendError {code, status}` and
`NotSupportedError` (`err instanceof NotSupportedError` from the protocol, version 0.27 and later, holds for it too).

## Access key

A server configured with an access key requires `Authorization: Bearer <key>` on every request, SSE included. The
client's `auth` option sets the header for you; without a key you get a `BackendError` with `status: 401` and
`code: 'unauthorized'`.

## Development

```sh
npm install && npm run build
npm test          # unit tests against a mock HTTP-binding server
npm run typecheck
```
