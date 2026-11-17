# @kerneldreams/backend-local

A `ProtocolBackend` over a directory on disk: no network, no model. Sessions are stored as `.mds` files, and the
directory's files are exposed through the workspace API.

```sh
npm i @kerneldreams/backend-local
```

```ts
import { createLocalBackend } from '@kerneldreams/backend-local'

const backend = createLocalBackend({ root: '/path/to/project' })
const s = await backend.sessions.create({ title: 'Notes' })
await backend.messages!.append!(s.id, [{ type: 'text', text: 'hello' }])
await backend.close!()
```

Built from existing pieces:
- **sessions** — `createStoreBackend` (`@kerneldreams/backend-http`) on the `.mds` driver of `@kerneldreams/chat-store`:
  `.mds` files, edits, swipes, fork, session meta stored in the file;
- **files** — `createFsWorkspace(root)` (`@kerneldreams/backend-fs`): list/read/write/delete/rename/stat/watch.

The backend knows nothing about transport. In a desktop app it can live in a sidecar behind
`@kerneldreams/backend-local/tauri`; in tests and dev it can run anywhere.

## Options

| opt | default | description |
|---|---|---|
| `root` | — | workspace directory; throws if missing |
| `sessionsDir` | `root` | directory of `.mds` sessions; a relative path is resolved from `root` |
| `file` | — | a single session file (relative to `root`); fork is unavailable |
| `generate` | — | a `GenerateFn`. Without it, `run` answers `not_supported` |
| `name` | `local` | `Capabilities.name` |
| `files` | `{write: true, watch: true}` | backend-fs options (`write`, `watch`, `debounceMs`) |
| `attachmentMaxBytes` | 2 MB | size limit for a single attachment |
| `warn` | stderr | watch warnings sink |
| `services` | — | plugin services layer (`createServicesHost` from `@kerneldreams/backend-local/services`) |

## Capabilities

`edits {edit, delete, hide, append}`, `swipes`, `fork: 'copy'`, `attachments`, `sessionMeta`,
`workspace.files {write, watch}`. **Not provided:** `models`, `profiles`, `catalogs`, `ask`, `workspace.switch` and,
without `generate`, `cancel` and `run.continue`. With `services`, the `services` capability lists what the plugin
services registered.

## Plugin services

`createLocalBackend({ root, services: createServicesHost({ root, plugins }) })` runs the Node halves of nrchat
plugins inside the backend process: `backend.services` (`call` / `stream`) and the `services` capability. A plugin
whose module failed to load is left out of the capability. `close()` on the backend also closes the services.

## run

Without `generate`, `run()` rejects with `NotSupportedError` on the first `next()` — **before** the user message is
written, so a session never receives a question without an answer. With `generate`, the run lifecycle of
`createStoreBackend` applies as is (streaming, cancel, writing the reply).

## Workspace

There is exactly one: `workspace.current()` = `{id: root, name, path: root, kind: 'directory'}`; there is no
`switch`. Sessions written by the backend show up in the file listing and arrive as `workspace_update` events like
any other change.

## Attachments

Bytes are stored in `<root>/.nr/attachments/<sha256:16>-<name>` rather than in an `{id}.assets/` folder next to the
session, so the user's directory does not grow a folder per session. Identical bytes share one file, so forking or
deleting a session never breaks references. The `ref` is `file:` plus a path relative to the sessions directory
(`file:.nr/attachments/…`), by the same rule as driver links.

Note: a deleted session leaves its attachments behind — there is no garbage collection. `.nr/` is visible in the
file tree; if the workspace is a git repository, add `.nr/` and `.nr-trash/` to `.gitignore` yourself.

## Development

```bash
npm test        # vitest: temp directories, real fs.watch, loopback through a fake Tauri invoke
npm run build   # tsc → dist
```
