# @kerneldreams/kd

`kd` is one entry point for tools, documents and actions over anything. It is the successor of the `runz` CLI: the document format (mdz / mdd / mds) is unchanged, the `runz` runtime executes it, and existing `runz` tools run through `kd` as they are.

```
npm i -g @kerneldreams/kd     # installs the `kd` command
```

Node >= 24.

```
kd                         catalog of tools
kd <tool> [words] [--fields]   run a tool
kd <file>                  a document with steps runs; .mds is a chat session; anything else: show / actions by kind
kd <address|object> [action]   by the rules in links.mdz
kd <tool> --help
kd completion zsh|bash|powershell
```

Service flags go before the tool name: `--dry`, `--json`, `-v`, `--help`, `--retry=<step>`.

Exit codes: `0` done, `1` the tool failed, `2` invalid call, `3` something required is missing (model, key, machine), `4` interrupted — rerun the same command to continue. On codes 2 and 3 the last line of stderr is the corrected command.

## Declaring a tool

A tool is declared by an extension of `## $form`: a field takes `$pos=N`, `$kind=<kind>` (a vocabulary of kinds from the link rules), `$for=<actions>`, `$rest`; the tool takes `## $action <name>` blocks (no code; `$default`, `$title`, `$repeatable`, `$dry`, `$effects`, `$examples`) and root-level `$needs`, `$examples`, `$action_arg`. A field default is the root variable of the same name.

A `.ts` / `.mjs` tool exports `export const tool = { description, fields, defaults, actions, needs, aliases }`, or ships a `tool.mdz` next to `index.ts`. From one declaration `kd` derives command-line parsing, help, Tab completion, the question about anything missing, a form (`FormView`), a `ToolDef` (`toolDefOf`, one shared `kd` + `kd_describe` pair) and palettes. A tool without a declaration works the old way: words go to `$_`, flags as given. One normalization serves every path: `normalize()` (native call, `--params -|@file` as mdz or JSON, command line).

Long text in `--params` goes as the body of a `## $field` section (lines that look like markup go into a four-backtick fence); CRLF and BOM are handled the same way. PowerShell 5.1 pipes stdin to a native program as ASCII — before `@'…'@ | kd <tool> --params -` set `$OutputEncoding = [Text.UTF8Encoding]::new($false)`; pwsh 7 sends UTF-8 itself.

## Layers

kit (`dist/tools`, `links.mdz`) → profile layers (`$layers` in `~/.kd/settings.mdz`: tool directories and runz configs with their `$paths`) → `~/.kd` (`KD_HOME`): tools, rules, providers, keys, application registrations `apps/<id>.mdz`, the question inbox `inbox/` → the data of the build you run → project `.kd/` (adds, does not override).

A copy mode is set by `kd-copy.mdz` next to the copy (`$mode: installed|portable`, `$id`, `$shared: read`, `$register`). A tool brings its own object rules in a `links.mdz` next to `index.ts`; an action for kd is `$run: kd` plus `$cmd` (the words of the kd call with `${text}`, `${path}` and template groups).

The catalog cache (`<data>/cache/catalog.json`) depends on the layer settings: editing `settings.mdz` or a `$layers` file (by time and size) rebuilds it on the next Tab. There is no need to delete it by hand.

## Questions

A question raised during a run (an agent asks a human) goes to the `inbox/` directory; it is answered by the terminal of the run, the `kd ui` window, or a companion app. With no human around (no terminal, no window) the default answer is taken immediately. With a hub configured — `$hub: http://…/api` (and `$hub_key` for a protected hub) in `settings.mdz`, or `KD_HUB` / `KD_HUB_KEY` — the question is mirrored to the hub's `questions` service and the answer from there is written back to the inbox. If the hub is unreachable, one warning line is printed and the question stays in the inbox.

## Palettes

`@kerneldreams/kd/palette` provides data for command palettes: the catalog with forms (`paletteCatalog`; action fields via `fields` / `formFor`), actions for a pasted text (`paletteMatch`), a call plan (`planTool`) and a task command for a queue (`jobCommand`). Other entries: `@kerneldreams/kd` (core: declarations, call, errors, describe, params) and `@kerneldreams/kd/node` (layers, catalog, rules, palette, inbox, copy info).

```ts
import { loadLayers, loadCatalog, paletteCatalog } from '@kerneldreams/kd/node'

const catalog = loadCatalog(loadLayers(process.cwd()))
const tools = await paletteCatalog(catalog)
```

## Kit tools

`agent` (an agent in a folder: `--check`, `-c` / `-r`, `--ui`), `acp`, `ui`, `chat`, `job` (`--on`, `--pool`, `--wait`), `worker`, `provider`, `app`, `info`, `completion`.

## Extensions

The open `kd` declares extension points; the installation provides the implementation (see `@kerneldreams/runz-runtime`, `extensions.ts`): the `agent` slot is the agent loop, the `acp` slot is an ACP agent over stdio. An extension is a file `<slot>.mjs` in `~/.runz/extensions/`, in the directory from `$extensions_dir`, or in the path from `KD_EXTENSIONS`. Without an extension `kd agent` and `kd acp` report that the extension is not installed and say how to add it; documents, tools and jobs work regardless.

## License

MIT
