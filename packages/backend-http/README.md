# @kerneldreams/backend-http

The HTTP transport for the UI protocol (`@kerneldreams/ui-protocol`): **both sides of the wire** — a server that exposes any `ProtocolBackend` over HTTP + SSE, and a client that turns that URL back into a `ProtocolBackend`.

```bash
npm i @kerneldreams/backend-http
```

```ts
import { serveBackend, createHttpBackend } from '@kerneldreams/backend-http'

const srv = await serveBackend(myBackend, { port: 7331 })   // myBackend: any ProtocolBackend
const backend = createHttpBackend(srv.url)                  // the same interface, over the wire

for await (const ev of backend.run(sid, { userMessage: 'hello' })) {
  if (ev.type === 'ask') await backend.respond!(sid, ev.askId, { allow: true })
}

await srv.close()
```

```
ProtocolBackend ── serveBackend(b) ── HTTP+SSE ── createHttpBackend(url) ── UI
   (an object)       (server)                        (the same interface)
```

A backend is an object, not a process. Where it is hosted (a launcher, a service module, a long-running service) is up to the consumer; the transport between the UI and a backend is always HTTP + SSE, even in-process. The UI holds a `ProtocolBackend` and cannot tell whether it is local or remote.

Both sides live in one package on purpose: they must evolve in lockstep and are tested against each other (loopback).

## Install

```bash
npm i @kerneldreams/backend-http
```

The wire itself needs only Node built-ins and `@kerneldreams/ui-protocol`. There is no engine or agent runtime here — this is the wire, not a backend.

Entry points:

| import | what |
|---|---|
| `@kerneldreams/backend-http` | everything: `serveBackend`, `createHttpBackend`, `createFetchHandler`, `createStoreBackend`, hub, users gate, ... |
| `@kerneldreams/backend-http/serve` | `serveBackend` (Node only) |
| `@kerneldreams/backend-http/client` | `createHttpBackend` |
| `@kerneldreams/backend-http/store` | `createStoreBackend`, the client and workspace files — no `node:*` (browser, Worker) |
| `@kerneldreams/backend-http/objects` | `createObjectsService` — the objects service engine |
| `@kerneldreams/backend-http/links` | `createLinksService` — the core `links` service (link rules) |

## serveBackend

```ts
import { serveBackend } from '@kerneldreams/backend-http'

const srv = await serveBackend(myBackend, { port: 7331 })
console.log(srv.url)   // http://127.0.0.1:7331
await srv.close()      // does not touch backend.close() — the backend's life is not the server's
```

| opt | default | what |
|---|---|---|
| `port` | `0` (any free port) | the actual port is in `srv.port` |
| `host` | `'127.0.0.1'` | the server is not exposed outside unless you ask |
| `cors` | `false` | CORS headers + preflight (dev) |
| `basePath` | `''` | `'/api'` → `/api/sessions`; `srv.url` already includes it |
| `maxBodyBytes` | 10 MB | larger → `413` |

Behavior:

- **Errors** become an Envelope: `NotSupportedError` → `{ok:false, error, code:'not_supported'}` (501), anything else → `{ok:false, error}` (500).
- **A failure in a stream after it has started** → a `run_end{status:'error'}` frame, then close (the headers are already sent, so an Envelope error cannot be returned). Before the first frame → an Envelope.
- **A dropped SSE connection does NOT cancel the run**: the iterator is drained to the end, the run lives on the server, and the client resyncs through `history`. Cancellation is only through the `cancel` endpoint.
- **One active run per session**: a second `POST /run` while one is live → `409 {code:'busy'}`.

## createFetchHandler — the wire core without Node

```ts
import { createFetchHandler } from '@kerneldreams/backend-http/store'

const handle = createFetchHandler(backend, { basePath: '/api', authKey })
export default { fetch: (req: Request) => handle(req) }   // Cloudflare Worker, Deno, Bun
```

`(Request) => Promise<Response>` on Web Fetch, with not a single `node:*` inside. Options: `cors`, `basePath`, `maxBodyBytes`, `authKey` (same as `serveBackend`), `capabilities(caps)` — extend the advertised capabilities with your own. `withRunAttach` is applied for you if the backend has no attach support.

**The boundary:** the wire core is everything `createStoreBackend` serves. For those routes `serveBackend` calls the same code (`createWireCore`, with an adapter `IncomingMessage → Request`, `Response → ServerResponse`, SSE as a stream) — one implementation.

| wire core (`createFetchHandler`) | Node-only (`serveBackend`) |
|---|---|
| `GET /capabilities` (Node adds its own) | `/files/external/*`, `/host/*` — files outside workspaces, remote hosts |
| `/sessions`, `/sessions/live`, `/sessions/:id` (get/patch/delete) | `/pty*` and WebSocket `/pty/:id/attach` — terminal |
| `/sessions/:id/{history,meta,personas,engine,release,share,fork}` | `/plugins/*` — external plugin bundles and rebuild SSE |
| `/sessions/:id/{run,attach,cancel,steer,respond}` — run and SSE | `/settings`, the `services/settings/changes/stream` stream |
| `/sessions/:id/{model,profile}` | `/skins*` — skins and user.css |
| `/sessions/:id/attachments[/:ref]`, `/sessions/:id/messages[/:mid[/prompt\|swipe\|hide]]` | `/workspace*`, `/workspaces*` — workspaces, projects, files |
| `/models`, `/profiles[/:id[/duplicate]]`, `/catalogs/*` | `/auth/*` — users and sign-in |
| `/services/:plugin/:method[/stream]`, `/services/:plugin/http/*` | `/bots*` — the bot catalog |

One difference from the older Node-only code: Web `Headers` trims whitespace around a header value (RFC 9110 §5.5) — the response of `services/…/http` too.

## createHttpBackend

```ts
import { createHttpBackend } from '@kerneldreams/backend-http'

const backend = createHttpBackend('http://127.0.0.1:7331')

for await (const ev of backend.run(sid, { userMessage: 'hello' })) {
  if (ev.type === 'ask') await backend.respond!(sid, ev.askId, { allow: true })
}
```

| opt | default | what |
|---|---|---|
| `fetch` | `globalThis.fetch` | your own implementation (tests, an authenticating wrapper) |
| `headers` | — | transport headers; auth is outside the protocol |
| `capabilitiesTtl` | ∞ | ms; by default the cache lives until `close()` |

Behavior:

- Browser and Node: built on `fetch`, **no EventSource** — a run starts with a POST that carries a body.
- `capabilities()` is cached.
- **A dropped stream** → a synthetic `run_end{status:'error', error:{code:'connection_lost'}, version:''}` instead of an exception: the run may have finished on the server, the UI tells the cases apart by the code and resyncs through `history`. An empty `version` means "token unknown".
- **Unknown events travel upward opaque**, they are not filtered (graceful degradation).
- `close()` aborts live requests and forbids new ones.

### Optional methods are always present on the client

The protocol rule "a method exists ⇔ the capability is declared" is enforced by the **backend behind the wire**: `capabilities()` is asynchronous while the factory is synchronous, so they cannot be known when the object is built. Calling an undeclared operation comes back as a `NotSupportedError` with a code. The UI switches features off by `capabilities()`, not by the presence of a method.

## Routes

```
GET    /capabilities
GET    /sessions                          POST   /sessions  { title?, model?, profile?: id | ProfileDoc }
GET    /sessions/:id                      DELETE /sessions/:id
PATCH  /sessions/:id                      { title } → rename, { meta } → meta.patch
POST   /sessions/:id/fork                 { atMessageId? }
GET    /sessions/:id/history              { messages, version }
POST   /sessions/:id/run                  → SSE stream of RunEvent
GET    /sessions/:id/attach               → SSE of a running run: snapshot + live stream (v1.31; no run — empty)
POST   /sessions/:id/cancel               { runId }
POST   /sessions/:id/respond              { askId, answer }
POST   /sessions/:id/messages             { parts, role?: user | assistant, swipeOf? } → messages.append
PATCH  /sessions/:id/messages/:mid        { parts | text, ifHash }
DELETE /sessions/:id/messages/:mid
POST   /sessions/:id/messages/:mid/swipe  { dir | index }
GET    /sessions/:id/messages/:mid/prompt → PromptView: recipe, system, injections, messages
POST   /sessions/:id/model                { model, thinking? } → the applied choice
GET    /models                            catalog ModelInfo[]
GET    /workspace                         the current workspace WorkspaceInfo
GET    /workspaces                        known workspaces WorkspaceInfo[]
POST   /workspace                         { id } → switch (workspace.switch)
POST   /workspaces                        WorkspaceProject & {id?} → a new project (workspace.edit, v1.26)
PATCH  /workspaces/:id                    WorkspaceProjectPatch → edit a project (null clears a field)
GET    /workspace/files?path=             FileEntry[] of one level (no path — the root)
GET    /workspace/file?path=&maxBytes=    FileContent
PUT    /workspace/file                    { path, content, encoding?, revision? } → { revision }; revision: null — create
DELETE /workspace/file?path=              to the workspace trash
POST   /workspace/file/rename             { from, to }
GET    /workspace/events                  → SSE workspace_update { paths } (capability workspace.files.watch)
GET    /profiles                          catalog ProfileInfo[]
POST   /sessions/:id/profile              { id } | { doc } → the session profile (profiles.set; doc — an inline profile)
GET    /profiles/:id                      ProfileDoc
PUT    /profiles/:id                      ProfileDoc → the saved one (profiles.save; id comes from the address)
DELETE /profiles/:id                      profiles.delete (default — bad_request)
POST   /profiles/:id/duplicate            { id } → a copy (an occupied id — conflict)
GET    /catalogs/{tools,skills,extensions} catalogs for the profile editor
GET    /bots, /bots/:id, /bots/:id/assets/:file
GET    /sessions/:id/personas             PersonasDoc { personas, userId? }
PUT    /sessions/:id/personas             { personas, userId? } → the applied one (personas.save; invalid — 400)
GET    /sessions/:id/attachments/:ref     AttachmentContent { ref, content, encoding, size, mime? } (attachments.get, v1.10)
POST   /services/:plugin/:method          { args? } → the result of a plugin service (services, v1.11)
POST   /services/:plugin/:method/stream   { args? } → SSE service_event {name, payload?} … service_end (v1.11)
```

Three more routes that the operations need, added for symmetry (both sides of the package know them):

```
GET    /sessions/:id/meta                 meta.get (the base set only has PATCH)
POST   /sessions/:id/messages/:mid/hide   { hidden }  messages.hide
GET    /workspace/file/stat?path=         workspace.files.stat
```

## Workspace files

- Input is validated before it reaches the backend: a missing `path` on read/delete, a non-string `content`, a foreign `encoding`, a `revision` that is neither string nor null, a malformed `maxBytes` — all `400`. Backend errors keep their own codes: `conflict` 409, `not_found` 404, `bad_request` 400.
- `GET /workspace/events` is a separate SSE channel, not a run stream: a comment `: workspace events` on connect, `event: workspace_update` frames, a `: ping` keepalive every 25 s. It lives as long as the client holds the connection.
- Client: `workspace.files.watch(listener) → unsubscribe` is synchronous, the channel runs in the background. A drop or a 5xx → reconnect (500 ms, doubling up to 30 s); after a reconnect the subscriber receives `paths: ['']` — "re-read everything". 4xx and `not_supported` → no retries. `close()` stops the watch too.
- `createStoreBackend({ files })` — a memory FS for fixtures (`createMemoryFiles`, exported): a `path → content` map, a key ending in `/` is an empty directory. Semantics match the disk-backed files backend: a `.nr-trash` trash directory, revision `size:mtimeMs`, `ignored` from a `.gitignore` in the same map; watch is emulated on its own mutations. Without the option the `workspace` capability stays `{}`.

`code` is not part of the base Envelope either — it travels as an additional field. A client that does not know `code` does not break (unknown fields are ignored).

## Projects (protocol v1.26)

The option `createStoreBackend({projects})` is a project registry with the `ProjectsRegistry` interface (`list`, optionally `create`/`update`); the host writes the `projects/<id>.mdz` files, fixtures use `createMemoryProjects({root, projects})`. The registry's `list` always carries `default` (`$root` = the process `$cwd`).

- `workspace.list` — projects (`kind: 'project'`, `path` = `$root`, `description`, `project` — the record); `switch` — the current project of the process; capability `workspace.{switch, projects}`, and `edit` when the registry has `create`+`update`.
- `sessions.list({workspace})` / `GET /sessions?workspace=` — the sessions of a project (`SessionInfo.workspace`, no mark means `default`); without the parameter — all of them.
- `sessions.create({workspace?})` — a project (none — the current one of the process): `$root` → `cwd` (with `sessionCwd`), `$profile`/`$model` — if present in the catalog and not given explicitly; the `workspace` mark goes into `SessionInfo` (the `.mds` header). `default` — no mark and no `cwd`, as before projects.
- `GenerateRequest.project` — the project record of the session (`dirs`, `skills`, `context`, ...).
- `workspace.create` — `id` derived from `name` (`projectIdOf`, taken — `-2`, ...), an explicit taken id — `conflict`; `name`/`root` are required, `root` is absolute and passes `sessionCwd`; strings are single-line. There is no delete.

## Message prompt

`createStoreBackend({ prompts })` — a simple implementation for fixtures: capability `prompts`, the recipe of every run is kept in process memory (the store is not touched). `prompts: { system }` — the base system prompt; the meta `pre` is prepended (`mode: 'replace'` — instead), `post` — a `user` injection with `source: 'meta.post'`; `messageIds` — exactly what went into `generate`. On read, message texts come from the current version of the session: edited after the run — `edited` (compared by `Message.hash[:8]`), deleted — `missing`. A message with no recipe → `not_found` (`StorePromptNotFoundError`); a backend without `messages.prompt` → `not_supported`.

## Personas

`createStoreBackend({ personas: true })` — a fixture: the session's personas document lives in process memory, capability `personas: { edit, multi }`, `personas.list` / `save` (the whole document; invalid — `bad_request` via `validatePersonas`, in the middle of a run — `busy`). During a run, the user message is signed with `userId`, the reply with the turn's persona (`RunStartInput.personaId`; without it — the first char, for regenerate — the persona of the regenerated reply; a foreign id — `bad_request` before any write). `generate` receives `personas`, `persona` and messages with names: `{{char}}` / `{{user}}` in `sessionMeta.prompt` are always expanded, while `Name: ` prefixes on user/assistant messages and the `system` block listing participants appear only when names are in play (more than one interlocutor, or the turn's persona has a `prompt`). A known persona's `Name:` prefix is stripped from the reply: the store text is clean, the name lives in `meta.personaId` (and `recipe.personaId`); the participants block in the recipe is a `system` injection with `source: 'persona'`.

HTTP: `GET /sessions/:id/personas`, `PUT /sessions/:id/personas` `{ personas, userId? }` — the transport validates the document before the backend.

## Continue and attachment bytes (protocol v1.10)

`createStoreBackend` declares `run: { continue: true }` — a run without `userMessage`/`regenerate` generates along the current branch, with no user message. `attachments.get` — bytes by a ref returned from `put`: from backend memory (mime from `put`) or from a driver with `assets.get` (`@kerneldreams/chat-store`; if the driver does not store the mime, it is derived from the name with `fileMime`). A driver with `assets` but no `get` — neither the method nor `attachments.get` in capabilities. A foreign ref → `not_found`.

## Plugin services (protocol v1.11)

`createStoreBackend({ services })` — a layer from `@kerneldreams/backend-local/services` (`createServicesHost` / `createMemoryServices`): `backend.services` + the `services` capability (what the services have registered); the backend's `close()` closes it too.

On the wire: `call` is a plain Envelope. `stream` is SSE; an undeclared stream (gated by capability) — a `not_supported` Envelope before the headers, a throw in the middle — an `error` frame, a normal end — `service_end`, a keepalive comment on silence. The client closed the connection — the iterator's `return()`, the service gets an abort. Client side: a close without `service_end` — an `error {code: 'connection_lost'}` frame; `return()` drops the connection immediately without waiting for a frame.

## Objects: `./objects` (protocol v1.49)

The engine of the core `objects` service. A type is a data file (`$type: object-type`, `$id`, `$source: files`, `$paths` with chain macros, `$format`, `$schema`, `$id_field`, `$title_field`, `$subtitle`/`$avatar` as ntpl, `$badges`, `$columns`, `$search` with weights, `$filters`, `$sort`, `$links`, `$views`, `$version`), a validator (an error is a string; the other types stay alive; a deployment overrides a plugin by id), template views `views/<id>.ntpl` (`<# type: persona; title: … #>`), codecs `ccv3` / `json` / `md` / `mdz` (`_id` on elements of object arrays), migrations `migrations/<from>-<to>.json`, rows and text search, facets, CRUD with a `.nr-trash` trash, a copy with a `source` link and "behind" detection, links (`$links` providers), git history, `render`, images through `http`, a `watch` stream.

```ts
import { createObjectsService } from '@kerneldreams/backend-http/objects'

export default createObjectsService({
  typeDirs: (meta) => [join(meta.root, 'types')],
  vars: (name, ctx) => ctx.get([name]),            // $paths: $personas
  render: (tpl, data) => ntpl(tpl, data),          // templates are supplied from outside
  importers: { ccv3: importPng }, exporters: { ccv3, png }, links: { 'sessions.personas': scan },
})
```

## Session meta

`meta.patch` in `createStoreBackend` applies the **protocol's** patch rule (`mergeSessionMeta`: a nested `prompt`, `null` deletes a key), and the driver receives a ready document — one rule for all stores, otherwise "meta" would mean different things in a fixture and in another driver. It is written through `store.meta.set` (a whole-document replace); a driver without `set` will not preserve key deletion, but the nested merge still works.

A fixture backend for front-end e2e is `createStoreBackend` over `@kerneldreams/chat-store/memory`: `sessionMeta` is there out of the box.

```ts
import { createStoreBackend } from '@kerneldreams/backend-http'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'

const backend = createStoreBackend({
  store: createMemoryStore(),
  async *generate(req) { yield { type: 'text', delta: 'hi' } },   // your model call goes here
})
```

## Attaching to a running run (protocol v1.31)

`withRunAttach(backend)` — a run lives in the process, not in the request stream that started it: if the consumer of `run()` went away (a tab closed, a tunnel dropped), the run keeps going. A run snapshot is its messages (closed ones — `message_start` + `message_end`, an unfinished one — as parts with the sum of deltas), pending `ask`s and the last `activity`. `sessions.attach(id)` — the snapshot, then the live stream until `run_end`; any number of subscribers. `respond` — from any of them, an accepted answer sends `ask_end` to everyone. `sessions.get/list` carry `SessionInfo.run {id, startedAt, waiting?}`. An ask waits without a timeout — the decision belongs to a human.

`serveBackend` wraps the backend itself (without `users`; with them — the gate, whose views share one snapshot). The hub wraps its built-in engine, and the `attach` of a connected one is proxied by its `serveBackend`. State lives in process memory: a restart kills the run anyway.

Hub: an engine without a `.mds` catalog is `switch: false` in `engines.list` (not a target for changing the executor); an engine's catalog index is re-read on an event through the hub (create/delete/fork/setEngine, end of a run), on `?refresh=1` and when the catalog mtime changes — not on every `sessions.list`.

## Without Node: `./store` and run state

`@kerneldreams/backend-http/store` — `createStoreBackend`, the client and workspace files without `node:*` (browser, Worker; `serveBackend` is only in the root and `./serve`). Session busy state and early answers to an `ask` live in a `KvStore` (`opts.kv`), not in process memory: with no option, an in-memory kv (`createMemoryKv`); with an external kv, two processes see each other's busy state, and a `respond` that arrives where the run is not going puts the answer into the kv — the run picks it up by polling (1 s). Only the process hosting the run holds its `AbortController` and pending promises. Fallback `Map`s (model/profile choice, recipes, personas, attachment bytes) are used when the driver has no matching capacity; a host without shared memory needs a driver that has them.

## Tests

Loopback (`test/loopback.test.ts`): a fake backend (in-memory, scripted scenarios) → `serveBackend` → `createHttpBackend`. All operations plus a full run (multi-message, tool parts, ask/respond, cancel, an error, a dropped stream). Acceptance — the events on the client equal the events of the fake backend.

```bash
npm test              # vitest
npm run build         # tsc → dist
npx tsc --noEmit      # types only
```

## License

MIT
