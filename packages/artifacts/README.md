# @kerneldreams/artifacts

Artifact runtime: manifest, collections, permissions, static checks, native esbuild JSX compile, the init / finalize / revert lifecycle, and the bridge host that serves an artifact to a sandboxed page.

An artifact is a folder with HTML/JS (+ CSS, optionally JSX and a `service.ts`) that opens in a host app tab or window without an author-side build step.

```
npm i @kerneldreams/artifacts
```

## Minimal example

```ts
import { initArtifact, finalizeArtifact, listCollections, listArtifacts } from '@kerneldreams/artifacts'

// Create an artifact in the workspace collection (`<workspace>/.nr/artifacts`).
const workspace = process.cwd()
const { id, dir } = initArtifact({ name: 'Hello', template: 'jsx', workspace })

// ...edit files in `dir`, then validate, compile-check and bump the version:
const result = await finalizeArtifact(id, { workspace })
console.log(result.version, result.errors, result.warnings)

console.log(listArtifacts(listCollections({ workspace })).map((a) => a.id))
```

Templates: `html`, `jsx`, `jsx+service`, `jsx+skins`, `stand`.

## Entry points

- `.` — manifest (`meta.mdz`, NRD), collections and registry (`$artifacts`, the workspace's `.nr/artifacts`, demo),
  permissions (`$uses` + scopes `$fs-read` / `$fs-write` / `$run-allow`, a single `checkAccess`), static check, JSX
  compiled by native esbuild, `initArtifact` / `finalizeArtifact` (version, `.history/`, `expectedVersion`) /
  `revertArtifact`, the `requestOpen` queue. Runtime errors (`runtime.ts`): the artifact's error journal
  (`readRuntimeErrors`) and the post-finalize check (`requestOpen({check})` → `awaitRuntimeCheck`: `checked` |
  `no-client` | `timeout`) — kept as files in the plugin data directory. `checkRuntime(finalizeResult, reg)` is the
  whole "finalize → open in the host app → window → errors" composition for agents.
- `./host` — `createArtifactHost`: static HTTP for the guest on 127.0.0.1 (bridge prelude, import map pointing at the
  vendored React, initial theme; addresses inside the page are relative), `http()` — the same static content for a
  backend route (`/services/artifacts/http/…`, for a remote client), bridge v2 operations, `run` through
  `@kerneldreams/runz-run`, artifact `service.ts` processes, collection events, `reportErrors` / `checked` (errors
  reported from the tab).
- `./prelude.js` — the guest side of the bridge (`window.__host`).

### Capabilities of the host

- **`comfy`** (`src/comfy.ts`): ComfyUI generation through the backend, using `@kerneldreams/comfy-client`. The server
  address is `opts.comfy` (the environment's `$comfy` attribute, otherwise `NR_COMFY`). Job events are a stream,
  `comfyEvents(key)` (the guest's `comfy` channel); images and previews are served by the host over HTTP at
  `/c/<key>/view?…` and `/c/<key>/p/<id>` (and through the backend, like static content). The address is the service
  context: `$comfy` of the environment, or `$comfy` in `~/.runz/config.md` (the runz chain).
- **`image`** (`src/image.ts`): generation with any provider that implements the `ImageProvider` contract. The source
  `opts.image {providers(), provider(name)}` is supplied by the embedding application; no keys ever reach the iframe.
  Events are a stream, `imageEvents(key)` (the `image` channel); previews and results are served over HTTP at
  `/i/<key>/<id>/p` and `/i/<key>/<id>/<n>`.
- **`viewer`** (`src/viewer.ts`): `viewer.open` checks the permission and normalizes the list, and the shell opens the
  viewer (`{delegate}`, like the clipboard).
- **Window file** the manifest's `$handles` is a list of kinds (`ArtifactInfo.handles`);
  `open(ref, {file, kinds, instance})` opens a file tab: `getContext().file/kinds`, the file gets a `{user-selected}`
  grant, `instance` is the session's own key per window; `setFile(key, file, kinds)` — the window's file changed.
- **File folder**: the scope `$file-dir` (synonym `{file-dir}`) in `$fs-read` / `$fs-write` is the window file's folder
  with its subfolders; without a file it is empty (`capability not declared: $file-dir`); `getContext().dir`.
  `fileUrl` is `/f/<key>/<folder base64url>/<name>` (`fileUrlPath`): it ends with the file name, so relative links
  resolve in the same folder; the old `/f/<key>?p=` form stays until the next major. `fileBlob(path)` returns the same
  bytes over the bridge (`readFileBinary`) as a `Blob` typed by extension: an image in a canvas without a URL or cookie
  (a stand with a key, a remote client).
- **Chat session** (`src/session.ts`): the `session` permission, scopes `$session-read: meta, personas, history`
  (default: all) and `$session-write: meta, personas` (default: none). `checkAccess` checks the permission, the scope
  and the argument shape (`checkSession`); the bridge answers `{delegate: 'session.*', value: <normalized arguments>}`
  and the front end executes it (the session data lives with the protocol client). The static check verifies that
  `__host.session.<area>.<method>` exists and is covered by a scope; a write scope without read, or scopes without the
  permission, is an error. `metaHash` is the meta version for `ifHash` (without `effectivePrompt` / `tools` /
  `pageContext`). The `jsx` template ships `lib/session.js` (`useSessionMeta()`).

### Agent tools

`src/agent.ts`: `AGENT_TOOLS` + `runAgentTool(name, args, {registry})` — `artifact_init/finalize/open/list/errors/revert/profile`
for a host that has no agent extension (a plugin service exposes them to the backend through the `tools` / `tool`
convention); `formatFinalize` produces the same text an agent extension would show.

### Guest side (`./prelude.js`)

The prelude sends runtime errors to the host (`onerror`, `unhandledrejection`, a `<script>` that failed to load) and
`loaded`; the guest's `localStorage` / `sessionStorage` live under a prefix of the artifact id.

- `__host.comfy` — `parse`, `objectInfo`, `inputs`, `upload`, `queue` → `{id, done}` + `onEvent`, `on`, `wait`,
  `interrupt`, `view`, `save`.
- `__host.image` — `providers`, `models(provider)`, `schema(provider, model)`,
  `generate(provider, {model, prompt, refs, params}, {onEvent})` → `{id, done}`, `cancel`, `bytes(id, n)`,
  `save(id, n, path)`, `url`, `on`, `wait`.
- `__host.viewer.open(images, index?)` — a URL, `{url, name}`, a comfy image or an `<img>`.
- `__host.on('file', cb)` — the window's file changed (`{file, dir, kinds}`).
- `__host.session` — `meta.get(path?)` → `{ok, value, hash}`, `meta.set(path, value, {ifHash}?)`,
  `meta.on(cb)` → `{meta, hash, personas, sessionId, title}`; `personas.list/get/set`; `history.list({limit})`;
  `tools.register({name, description, schema}, handler)` / `unregister` (a call arrives as `host-ev tool`, the reply
  is `tool-res`).

Consumers: artifact plugin services and agent extensions of host applications.

## Development

```
npm run build   # tsc + dist/assets (prelude, vendored React)
npm test
```

## License

MIT
