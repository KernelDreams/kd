# @kerneldreams/backend-fs

Workspace files on disk for the `@kerneldreams/ui-protocol` backend contract:
`createFsWorkspace(root)` returns `WorkspaceFilesOps` with `list` / `read` / `write` /
`delete` / `rename` / `stat` / `watch` / `search`, and `mountWorkspaces` adds mounted directories.

```sh
npm i @kerneldreams/backend-fs
```

It is not a backend but the file part of one: a backend exposes through it an agent's working directory or a project directory. Dependencies are Node builtins and `@kerneldreams/ui-protocol`.

```ts
import { createFsWorkspace } from '@kerneldreams/backend-fs'

const files = createFsWorkspace(process.cwd(), { write: true, watch: true })

caps.workspace = { files: files.capability }   // { write: true, watch: true }
backend.workspace = { current, list, files }

const off = files.watch!((ev) => console.log(ev.paths))   // workspace_update
await files.write!('notes/todo.md', '- [ ] ...', { revision: null })
off()
files.close()
```

| opt | default | meaning |
|---|---|---|
| `write` | `true` | `write` / `delete` / `rename`; `false` means no such methods and a capability without `write` |
| `watch` | `true` | `watch` via recursive `fs.watch` |
| `debounceMs` | `200` | window for merging changes into one event |
| `maxWatchPaths` | `500` | more paths in a window gives `paths: ['']` |
| `warn` | stderr | watch warnings |

A method exists if and only if its capability flag is declared, so `files.capability` can be passed to
`Capabilities.workspace.files` as is.

## Paths

Relative to the root, POSIX slashes, the root is `''`. Normalization and rejections come from the protocol's
`normalizeFilePath`: `..`, absolute paths, `\` and NUL give `bad_request`. On top of that, something only the disk
knows: **a symlink that resolves outside the root is `bad_request`**, even a broken one (writing through a broken
link would land outside). Links inside the workspace work; links pointing outside are not listed by `list`.

File operations do not modify the root or the trash (`.nr-trash`): `bad_request`.

## Operations

- **`list(path?)`** — one level: directories first, then by name. Files have `size` and `mime`, everything has
  `mtime`. `ignored` covers `.git` and `node_modules` at any depth, `.nr-trash` at the root, and directories'
  `.gitignore` (a subset of git: `!`, anchors, `dir/`, `*`, `?`, `**`, `[...]`). Sockets and FIFOs are not shown.
- **`read(path, {maxBytes})`** — UTF-8 without NUL is returned as text (BOM preserved), anything else as base64.
  A size above the limit (default 2 MB) gives `bad_request` with the size, before any bytes are read. `revision` is
  `size:mtimeMs` of the very descriptor that was read.
- **`write(path, content, {encoding, revision})`** — atomic: a temporary `.<name>.nr-tmp-*` next to the file plus
  `rename`; the permissions of an existing file are kept, and parent directories are created. If `revision`
  differs or the file is gone, `conflict`; `revision: null` over an existing file is `conflict`; without
  `revision` the write is unconditional. Returns the new `revision`. Mutations of one workspace are queued, so a
  revision check and the write never interleave within a process.
- **`delete(path)`** — does not erase: moves to `<root>/.nr-trash/<path>`; if that place is taken, a time suffix is
  added. A link is removed itself, not its target.
- **`rename(from, to)`** — `to` taken gives `conflict`; into itself gives `bad_request`; changing the case of a name
  works on a case-insensitive filesystem.
- **`stat(path)`** — a `FileEntry`; for the root `path` is `''` and `name` is the directory name.

A missing file is `not_found`. The codes are the protocol's `FileBadRequestError` / `FileNotFoundError` /
`FileConflictError`: a transport (`serveBackend`) returns them as codes.

## watch

`fs.watch(root, {recursive: true})` starts on the first subscriber and stops on the last. Events within the
`debounceMs` window are merged into one `workspace_update {paths}`; edits made by an agent arrive the same way as
your own.

- temporary files of atomic writes and the insides of `.git` are not events;
- everything inside an ignored directory collapses to the directory itself
  (`node_modules/x/y.js` becomes `node_modules`);
- more than `maxWatchPaths` paths, or a storm, gives `paths: ['']`, meaning "reread everything";
- if the watch fails (the root was deleted), the last event is `['']`, then silence.

## search

`search({query, regex?, case?, glob?, limit?})` → `{path, line, text, column}[]` over paths. It uses ripgrep from
PATH (`--hidden --no-require-git`, `--max-filesize 2M`), otherwise a walk in Node; every line from rg is re-checked
by the protocol's matcher (`compileFileSearch`), so regex is the JS dialect (lookbehind and the like make rg refuse
and Node answer), ignoring follows the workspace rules (`.git`, `node_modules`, `.gitignore`, the trash), and binary
files are skipped. A nested repo (its own `.git`) does not inherit the parent's `.gitignore` rules, so an umbrella
repo that ignores its sub-repos does not hide them; rg receives such repos as explicit paths. The option
`search: false` disables search, and `{rg: false}` forces the Node implementation.

## Mounted directories

`mountWorkspaces(main, {name: ws})` presents extra directories (for example a project's `$dirs`) as folders in the
root: list/read/write/stat/watch/search work across all roots with a prefix. A mount overrides a same-named node of
the main root; a mount's root itself cannot be modified; a rename across roots is `bad_request`.

## Trash and git

`.nr-trash/` is created in the workspace root on the first `delete`. The package does **not** add it to the
project's `.gitignore`, because it does not edit files it does not own. Add the line `.nr-trash/` yourself if the
workspace is a git repository.

## Development

```bash
npm test        # vitest: temporary directories, real fs.watch
npm run build   # tsc → dist
```
