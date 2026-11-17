# @kerneldreams/files

The file source for a records panel: everything that depends on neither React nor a backend. DOM-free, so the same
code serves an nrchat collection plugin, a file-manager distribution and future non-React pages. The shared part of
the panel (masks, selection, list state, tree rows, marks, column captions) is the
`@kerneldreams/files/collection` entry, and it is re-exported from the main entry.

```sh
npm i @kerneldreams/files
```

```ts
import { joinPath, parentPath, sortEntries, planOp } from '@kerneldreams/files'

joinPath('/home/me', 'docs', 'a.txt')   // '/home/me/docs/a.txt'
parentPath('/home/me/docs/a.txt')       // '/home/me/docs'
```

| module | description |
|---|---|
| `address` | address `{host?, path}` (no host = the local host), POSIX paths without `node:path`: `normalizePath`, `parentPath`, `joinPath`, `isUnder`, `relativeTo`, `ancestors`, `extOf` |
| `entries` | `Entry` (a subset of the protocol's `FileEntry` over a collection `Item`), `kindOf` (image/video/code…), `sortEntries` (Far-style: directories first, numbers sorted the human way; `ext` is a custom key) |
| `state` | tab state: the collection list plus `{host, path, against}` ⇄ tab params (`encodeState` / `decodeState`, the `PANEL_SHAPE` form), views `tree \| far \| yazi \| thumbs` |
| `plan` | copy/move: `planOp(op, sources, dest)` — targets, conflicts, "into itself"; `freeName` (`a (2).txt`) |
| `rename` | batch rename as text: `renameText` → edit → `planRename` (errors, steps with temporary names for swaps) → `undoSteps`, `renameDiff` |
| `tree` | the directory "tree" view: `treeRows(root, dirs, expanded, {filter, hidden, sort})` over the collection's `buildTreeRows` |
| `git` | git helpers for the panel |

```
npm install && npm run build && npm test
```
