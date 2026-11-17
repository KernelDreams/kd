# @kerneldreams/chat-store

A neutral chat-session model + the `SessionStore` storage contract + a driver
registry. One model, one set of tree math, N drivers: `.mds` files, pi JSONL, Claude Code
transcripts, and — through the registry — SQLite, opencode, thread backends, or anything else.

The `core` is **zero-dependency**: model types, pure tree math, and the driver
contract. Drivers plug in as subpaths (`./nr-chat` for `.mds` files, `./pi`, `./claude`), so a
consumer of one does not drag in the dependencies of the others.

```bash
npm i @kerneldreams/chat-store
```

```ts
import { toHistory } from '@kerneldreams/chat-store'
import { createMemoryStore } from '@kerneldreams/chat-store/memory'

const store = createMemoryStore()
const { id } = await store.create({ info: { title: 'demo' } })
await store.appendNode(id, { role: 'user', text: 'hello' })
console.log(toHistory(await store.load(id)))
```

## Idea

Message anatomy (`Part` / `Message` / `SessionInfo`) is the shared reality of
storage and wire: its home is here, at the bottom layer. A wire layer such as the
UI protocol (`@kerneldreams/ui-protocol`) re-exports these types and stays the wire (RunEvent, Capabilities,
SSE) on top of them.

A session is a **tree** of nodes with an explicit `parent`. Two projections of
the one tree:

- `toHistory(model)` — the active path + swipes; branches = *alternatives*
  (dialogue). This is a driver's `history()` for free.
- `toThread(model)` — the whole tree traversed (DFS, depth per node); all
  branches live (threads: reddit / discord / comments).

## Model

```ts
interface SessionModel {
  info: SessionInfo
  meta?: Record<string, unknown>   // sessionMeta; meta.activeLeaf — the active leaf
  nodes: StoreNode[]               // storage append order, the whole tree
}

interface StoreNode {
  id: string                       // stable; a driver with no native ids emits 'pos:N'
  parent: string | null            // EXPLICIT; null = root
  role: string
  name?: string
  parts: Part[]
  flags?: MessageFlags             // hidden / frozen / injected
  meta?: Record<string, unknown>   // model / usage / createdAt + driver specifics
}
```

`parent` in the model is always explicit. "Chain default" (no parent = the
previous node) and other encoding shortcuts are *driver* conventions: they are
unfolded on `load` and folded back on write. In the `.mds` driver `parent` is
three-state on write: unset → chain default, `null` → an explicit root
(a second root, serialized `{parent: null}`), a string → an explicit parent.

**`text` + `data` on a Part.** `tool_result` and `custom` may carry both a
machine value (`data`) and an extracted/display string (`text`). `data` is the
truth: it is serialized to the body with an automatic `format: 'json5'`, while a
coexisting `text` is preserved out-of-band. A read restores both — no silent
loss. `file`/`image` gained an optional `text` too: the extracted text that rides
into the LLM context (an attachment body) now has a home and survives edits.

## Driver contract

```ts
interface SessionStore {
  capabilities(): Promise<StoreCapabilities>
  list(opts?): Promise<{ sessions: SessionInfo[]; cursor?: string }>
  load(id): Promise<SessionModel>
  create(opts?): Promise<SessionInfo>
  delete?(id): Promise<void>

  appendNode(sid, node): Promise<StoreNode>        // parent default: the active leaf
  editNode?(sid, nid, patch): Promise<StoreNode>   // patch.ifHash → conflict
  deleteNode?(sid, nid): Promise<void>             // children → the deleted node's parent
  hideNode?(sid, nid, hidden): Promise<void>
  setActiveLeaf?(sid, nid): Promise<void>          // swipe primitive
  forkCopy?(sid, atNodeId?): Promise<SessionInfo>

  meta?; assets? (put, get? — bytes by ref); version?(sid); close?()
}
```

- **Fully async** — a driver can be cloud-backed (HTTP, login, cursor
  pagination). Local drivers don't pay for cloud problems.
- **Optional method ⟺ capability**: a read-only driver = only `list`/`load` — is
  legal. What is not declared is absent.
- **`ifHash` is an optional optimistic guard**: supply it and a mismatch → a
  `conflict` error (an edit over someone else's edit is refused); omit it and the
  edit proceeds. It is opt-in, not mandatory.
- **`list({ limit, cursor })` paginates honestly**: pass a `limit` and the driver
  returns at most that many sessions plus an opaque `cursor` when more remain;
  feed the cursor back for the next page. The cursor is a token — don't parse it.
- **Ids are path-safe**: session ids, node ids and asset names must match
  `/^[A-Za-z0-9._-]+$/` and not be `.`/`..` (they become filesystem path
  components). A violation throws `StoreInvalidId` (`code: 'invalid_id'`) before
  any IO — path traversal can't reach the disk.
- **Surgery is a contractual property of mutations**: records untouched by an
  operation are not rewritten in storage (`.mds` — bytes outside the span; pi —
  the raw JSONL line of every untouched entry, including foreign/malformed ones,
  is re-emitted verbatim; claude — append-only). Backward compatibility with
  foreign data in the same store is by construction.
- **Fidelity is mandatory — "escape hatch obligatory"**: every driver round-trips
  *all* Parts, flags (`hidden`/`frozen`/`injected`) and `node.meta`, even what its
  native format can't express. pi and claude park the whole neutral node in vendor
  `nrs*` fields their native reader ignores; the native content is written
  alongside, so foreign files still decode natively. append→load is loss-free on
  every driver.

## Drivers v1

| driver | capabilities | format |
|---|---|---|
| `./nr-chat` (**default**) | everything (edit/delete/hide, swipes, fork, rename, assets, sessionMeta) + extensions `choices`/`personas`/`recipes`/`compaction` | `.mds` files (subpath `./nr-chat`) |
| `./pi` (legacy, read old files) | edit/delete/hide, swipes, fork; with `piServiceEntries: 'hide'` also rename, sessionMeta and the same extensions | pi session JSONL v3 (+ other forms via `codecs`, e.g. `.mds`) |
| `./claude` | fork (read + append; edit/delete = false) | Agent SDK transcripts |

```ts
import { register, getStore, toHistory } from '@kerneldreams/chat-store'
import { createNrChatStore } from '@kerneldreams/chat-store/nr-chat'
import { createPiStore } from '@kerneldreams/chat-store/pi'
import { createClaudeStore } from '@kerneldreams/chat-store/claude'

register('mds', (o) => createNrChatStore(o as any))
const store = getStore('mds', { dir: './sessions' })

const { id } = await store.create({ info: { title: 'demo' } })
await store.appendNode(id, { role: 'user', text: 'hello' })
const model = await store.load(id)
console.log(toHistory(model))
```

pi driver, `piServiceEntries: 'hide'` (pi service entries are not feed nodes):
`rename` writes `session_info`; `meta` writes `custom`/`nr-session-meta` with the
full document (current = last on the active branch); `choices.get/set` keep the model (`model_change` +
`thinking_level_change`) and profile (`custom`/`nr-session-profile` `{name}`) in
the session — type `PiSessionStore`. `setActiveLeaf` carries service entries under
the node along, so meta/choices branch with the history. `list()` caches
`SessionInfo` per file by (path, mtime, size): only changed files are re-parsed.

### Which driver, in order

1. **`.mds` (`./nr-chat`)** — the default for everything new (local backends, agents, browser hosts). Everything file-level lives in the `%meta`
   header; forks, swipes and branch switches cannot lose it. The header stays
   human-readable: the marker line holds only short machine values
   (`id`, `title`, `profile`, `userId`, `model`, short `sessionMeta`); personas
   are `%%character <id> {kind, name, avatar, …, format}` sub-nodes with the card
   as the body (an injected `cardCodec` supplied by the host, or
   indented json5), an inline profile is `%%profile`, long session meta values
   are `%%<key>`. The bot of the listing comes from the first `char` persona.
   Older files (everything in the marker line) are read and re-laid out on the
   first header write; unchanged sub-nodes keep their bytes.
   `readabilityViolations(text)` checks the rule (marker ≤ 300, no `\n` in
   marker meta). A node's prompt recipe — `prompts/recipes/<node>.json`, chunk
   texts and the last run's prompt (`effective.mds`) — in `{id}.assets/prompts/`
   (an old `meta.recipe` is still read). `SessionInfo.file` — the file path. Compaction — a `system` node with a `pi.compaction`
   custom part. Writes are atomic (temp file + rename) and queued per session.
   `forkCopy` carries the header (sidecar refs rewritten) and keeps node ids.
2. **`pi`** — only to read old pi sessions (`.jsonl`, pi/2 `.mds`). New code does
   not write it.
3. **`./migrate`** — `migrateSession(pi, mds, sid)` copies a session through
   the contract and extensions (ids, parents, parts, flags, node meta, active
   leaf, header, meta, personas, choices, recipes with texts; attachments copied,
   refs rewritten); the source is never touched. `verifyMigration` compares
   `toHistory` of both sides. `withLegacySessions(mds, pi)` — a store that
   sees both: listing is the union, an old session is read from pi and reports
   `legacyFormat: 'pi/2'` in `meta.get`; **any write to it migrates it first**
   (one migration per id), then writes to the `.mds` store; deleting an old one is refused.

The extension interfaces are driver-neutral (`ExtendedSessionStore`,
`StoreChoicesApi`, `StorePersonasApi`, `StoreRecipesApi`, `StoreCompactionApi`
from the main entry); `Pi*` names are aliases.

External drivers (sqlite/opencode/…) register through the same `register` — the
built-in trio has no privileges.

### Storage (any host)

`./nr-chat` and `./pi` work over an `IFileSystem` (`@kerneldreams/nrd/contracts`
≥ 1.4): pass `storage` and the driver never touches `node:*` — OPFS/IndexedDB in
a browser, memory in tests, R2 in a Worker. Without `storage` the driver lazily
loads `./node-fs` (`node:fs`) — the previous behaviour, nothing to change for Node
consumers.

```ts
import { createMemoryFileSystem } from '@kerneldreams/chat-store/fs'
const store = createNrChatStore({ dir: '/sessions', storage: createMemoryFileSystem() })
```

`createNrChatStore({..., index: kv})` — optional (a cold `list()` of 300 sessions
× 170 KB takes ~235 ms without it, ~4 ms with it) — the session list cache (`SessionInfo` per
file by name, mtime, size) lives in a `KvStore` (key `nr-chat/index/<dir>`): a cold
`list()` re-parses only changed files.

pi driver: `listIndex: {kv, key?}` — the same list index in a `KvStore` (key
`pi/index/<dir>`) instead of `<dir>/.index.json`.

`./fs` — `createMemoryFileSystem`, `fsOf` (Result → exceptions), slash paths
(`join`/`resolve`/`relative`/`isInside`…), sync `sha256Hex`, base64 without
`Buffer`. `./node-fs` — `createNodeFileSystem()`. `./lore` — the profile lorebook
(`readProfileLore(storage, profile, base)`) over a host storage; `./lore-files` is
its `node:fs` twin.

`./builder` — the prompt builder (session-document-spec): an agent is
`build(document, model) → prompt.mds`. `PromptBuilder`/`BuildInput`/`BuildOutput`,
`defaultBuilders()`/`resolveBuilder()`, and `mdsTemplateBuilder` — an `.mds`
template (`%system`/`%user`/`%assistant prefill`/`%include`/`%meta`) whose node
bodies are ntpl with the tags `history`/`inject`/`impersonate` and the filters
`card`/`post`/`greeting`/`label`/`macros`. Pure: the host reads the template and
its includes.

## Dependencies

- `core` — zero-dep at runtime (`@kerneldreams/nrd/contracts` — types and `ok/err`).
- `./nr-chat` — optional peer `@kerneldreams/nrd/chat` (the `.mds` codec). Install it alongside when you use the `./nr-chat` subpath.
- `./nr-chat`, `./pi` — `@kerneldreams/nrd/contracts` (types), no `node:*`
  (default storage `./node-fs` is loaded lazily).
- `./builder` — optional peers `@kerneldreams/nrd/chat` (`.mds` codec),
  `@kerneldreams/nrd` and `nunjucks` (ntpl); no `node:*`.
- `./claude`, `./node-fs`, `./lore-files` — node builtins.
- **toon is a dependency nowhere**: body codecs (`format`) are injected by the
  consumer through `decoders`.

## License

MIT
