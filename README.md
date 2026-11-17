# kd

KernelDreams core: a small set of libraries and tools for working with language models through plain-text documents.

- **Documents.** The `mdz` / `mdd` / `mds` text formats — configuration, recipes, prompts and chat sessions in one human- and model-readable grammar — with a parser, a `${}` resolver, context assembly and templates (`@kerneldreams/nrd`).
- **Running them.** `runz` runs TypeScript scripts and documents; `kd` is the single command over tools, documents and actions, with generated help, completion and forms (`@kerneldreams/runz`, `@kerneldreams/kd`).
- **Chat.** A UI-to-backend protocol, a session store with branching and swipes, HTTP/SSE transport, a client and an embeddable chat web component.
- **Agent tools.** Files, processes, web search and fetch, MCP — one tool set for any agent host.
- **UI building blocks.** Forms and an object editor, a node-graph canvas, a CodeMirror editor, skins as data, keymaps.

One repository, packages as folders under `packages/`, npm scope `@kerneldreams`, one version for all of them.

Author: Denys Vynohradskyi — https://kerneldreams.com

## Install

Each package is installed on its own:

```
npm i @kerneldreams/nrd
npm i @kerneldreams/chat-store @kerneldreams/backend-http
npm i -g @kerneldreams/kd
```

Node >= 24, ESM. Every package has its own README with a minimal example.

## Packages

| package | what it is |
|---|---|
| [`@kerneldreams/artifacts`](packages/artifacts) | Artifacts runtime: manifest, collections, permissions, static checks, native esbuild JSX compile, init/finalize/revert lifecycle and the v2 bridge host (static HTTP, artifact services, runz runs, ComfyUI capability). |
| [`@kerneldreams/backend-fs`](packages/backend-fs) | Workspace files on disk for the UI protocol: createFsWorkspace(root) with list/read/write/delete/rename/stat/watch/search, and mounted directories. |
| [`@kerneldreams/backend-http`](packages/backend-http) | HTTP transport for the UI protocol: serveBackend (node:http + SSE), createHttpBackend (fetch), store-backed backend, hub of engines, users gate with pluggable sign-in. |
| [`@kerneldreams/backend-local`](packages/backend-local) | ProtocolBackend over a local directory: .mds sessions and workspace files, no network and no model; services host and a Tauri transport. |
| [`@kerneldreams/chat-client`](packages/chat-client) | Zero-dependency UI protocol client for browser and Node: sessions, SSE runs over fetch, respond/cancel, profiles, models, auth, and a ProtocolBackend over HTTP. |
| [`@kerneldreams/chat-store`](packages/chat-store) | Neutral chat-session model, SessionStore contract, driver registry and storage drivers; zero-dependency core with model types, tree math and message anatomy for storage and wire. |
| [`@kerneldreams/chat-widget`](packages/chat-widget) | Chat as a vanilla Web Component (Shadow DOM, no framework): streaming feed, tool/approval/question cards, HTTP/SSE and ACP transports, page tools and page snapshot; one bundle. |
| [`@kerneldreams/comfy-client`](packages/comfy-client) | ComfyUI client: HTTP API, websocket events with previews, a queue that iterates events of its own prompt, PNG metadata (prompt/workflow) and editable workflow inputs. |
| [`@kerneldreams/editor`](packages/editor) | Text editor on CodeMirror 6: markdown live preview, mdz/mdd/mds syntax, code modes with a lazy TypeScript service. |
| [`@kerneldreams/engine`](packages/engine) | LLM execution pipeline: build the prompt, call the model, handle the response. |
| [`@kerneldreams/files`](packages/files) | File source of the record panel: file address {host, path}, Far-style sorting, panel tab state, directory tree, copy/move plans, batch rename via text, git; shared record-panel model, no DOM. |
| [`@kerneldreams/forms`](packages/forms) | Forms and the universal object editor: `## $form` field parser, DOM-free editor core (parseEditor, check, widget catalog, agent prompt, documents with patch history), React FormView and <ObjectEditor>. |
| [`@kerneldreams/host-agent`](packages/host-agent) | Remote host file agent: over ssh without installation or embedded in an installed agent; one zero-dependency script, JSON lines for stat/list/read/write/copy/trash/search/watch/thumb/exec. |
| [`@kerneldreams/kd`](packages/kd) | kd command: one entry point for tools, documents and actions over anything (successor of the runz CLI). |
| [`@kerneldreams/keymap`](packages/keymap) | Hot keys as data: binding tables in layers (scheme, plugins, user overrides), chords by physical key, `when` contexts, collisions and tooltip hints. Zero dependencies, no DOM. |
| [`@kerneldreams/mcp`](packages/mcp) | Agent hands on a machine: an installed host agent (file panel) and the agent tools over MCP Streamable HTTP in one bun binary. |
| [`@kerneldreams/nodes`](packages/nodes) | Schema editor core: schema model (spaces, entities, relations, composites) on the forms document, execution protocol, headless node-graph core and a React canvas (ports or free-form cards). |
| [`@kerneldreams/nrd`](packages/nrd) | NRD documents: mdd/mdz formats, resolver, context assembly, block execution and templates; one package with subpaths per platform (core, web, node, template, format). |
| [`@kerneldreams/plugins`](packages/plugins) | Plugins by git link: lock file with pinned commit and rollback, read-only registry repos with a cascade of sources, manifests of all weights, Plugin API version ranges. Node, no dependencies besides git. |
| [`@kerneldreams/pty`](packages/pty) | Shared terminal for a human and an agent: tmux session per terminal, node-pty attach for the screen, pipe-pane agent stream, OSC 133 command marks, run/read API, WebSocket attach. |
| [`@kerneldreams/runz`](packages/runz) | runz CLI: run TypeScript scripts and NRD documents (mdz), config chain, built-in scripts, runz test. |
| [`@kerneldreams/runz-run`](packages/runz-run) | runz template runner for hosts: values into a run document, runz in a separate process with cancel, results as outputs; jobs (long runs with a limited queue) and a machine pool (center, workers, leases). |
| [`@kerneldreams/runz-runtime`](packages/runz-runtime) | runz runtime: script and document loading, registry, context chain, resolve hook, providers and extension slots as files. |
| [`@kerneldreams/secrets`](packages/secrets) | Mask secrets in text before it leaves the machine: provider key shapes, context patterns (Bearer, ?key=, JSON fields, env/mdz lines) and known values from a config. Zero dependencies. |
| [`@kerneldreams/skins`](packages/skins) | Skins as data: token and selector contract, .skin.css header parsing, validator (css-tree), base inheritance, file source for serveBackend, Obsidian / SillyTavern / VS Code theme converters. |
| [`@kerneldreams/tools`](packages/tools) | Agent tools: files (read/ls/find/grep/write/edit/apply_patch), processes (exec/process), runz; one ToolDef set for any agent host, ACP and MCP; core without Node, Node in ./node. |
| [`@kerneldreams/ui-protocol`](packages/ui-protocol) | Universal UI-to-backend protocol (v1): wire types and mapping helpers, no engine; the message model is re-exported from @kerneldreams/chat-store. |
| [`@kerneldreams/web`](packages/web) | Web transport layer: fetch/cdp delivery, mdz adapters, live-Chrome supervisor, devtools. Carries raw bytes, understands nothing. |
| [`@kerneldreams/web-tools`](packages/web-tools) | Web search and page reading for agents: web_search (DuckDuckGo, Brave, SearXNG) and web_fetch (HTML to text, SSRF guard) as functions and ready tools. |

Parts that are specific to a host or a product — the agent loop, ACP, sign-in — are not part of this repository; the packages here expose extension points for them.

## Build from source

```
npm install
npm run build        # all packages, in build-order.json order
npm test             # import boundaries + build order + every package's tests
```

## Repository scripts

- `scripts/build.mjs [--affected=<dir>]` — build all packages or only the affected ones; `scripts/build-order.mjs` computes `build-order.json` from the dependency graph (`--check` verifies it).
- `scripts/boundaries.mjs` — import boundary guard (exceptions in `boundaries-allow.json`).
- `scripts/guard.mjs` — publish guard (`npm run guard` for the working tree, `--tree <ref>` for a commit); `npm run hooks` installs the pre-push hook.
- `scripts/version.mjs <x.y.z>` — set one version for every package; `scripts/link.mjs` links consumers to the workspace packages.
- `scripts/scrub.mjs`, `scripts/publish.mjs` — release tooling for maintainers.

## License

MIT © Denys Vynohradskyi
