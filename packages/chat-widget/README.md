# @kerneldreams/chat-widget

A chat for any web page as a vanilla Web Component: no framework, Shadow DOM, one bundle (`dist/nr-chat.js`, ~48 KB, ~15 KB gzip). It has a streaming feed, collapsible reasoning, tool calls as cards with results, approvals (allow / allow for the session / deny), model questions (choice, text), stop, minimal markdown, light and dark themes, and ru/en UI. Three transports: an HTTP + SSE backend speaking the `@kerneldreams/ui-protocol` (through `@kerneldreams/chat-client`), any ACP agent over WebSocket (`ws://.../acp`), and `local`, a backend running inside the page itself, with no server. The page can give the model its own tools and a snapshot of its own state.

```sh
npm i @kerneldreams/chat-widget
```

## Embedding in 5 lines

```html
<script type="module" src="https://your-host/nr-chat.js"></script>
<nr-chat backend="http://127.0.0.1:7800/api" profile="agent" style="height:520px"></nr-chat>
```

From a bundler or JS (importing the package registers the `<nr-chat>` element):

```js
import { mount } from '@kerneldreams/chat-widget'

const chat = mount(document.getElementById('chat'), { backend: 'http://127.0.0.1:7800/api', auth: 'secret-key' })
chat.registerTool({ name: 'get_state', description: 'Scene state' }, () => JSON.stringify(state))
```

Exports: `mount`, `NrChatElement`, `defineNrChat`, `Feed`, `renderMarkdown` and the types `PageToolDef`, `PageToolHandler`, `PageToolResult`, `WidgetOptions`.

## Attributes (and `mount` options)

| | |
|---|---|
| `backend` | backend URL: `http(s)://.../api` for the UI protocol, `ws(s)://.../acp` for ACP, `local` for a backend in the page |
| `transport` | `nr` (UI protocol over HTTP + SSE) \| `acp` \| `local` (by default derived from the URL scheme) |
| `session` | `auto` (default) opens a new session; an id opens an existing one (UI protocol: history goes into the feed; ACP: `session/load`) |
| `profile` | profile of a new session (UI protocol) / mode (ACP, `session/set_mode`) |
| `auth` | access key: UI protocol sends `Authorization: Bearer`, ACP sends `?auth=` |
| `cwd` | working directory of a new session (absolute; for a backend with `workspace.perSession`) |
| `lang` | `ru` \| `en` (by default the document language) |
| `theme` | `light` \| `dark` (by default `prefers-color-scheme`) |
| `placeholder` | input placeholder text |
| `provider-url`, `provider-key` | `backend="local"`: an OpenAI-compatible gateway (`.../v1`) and its key |
| `local-module` | `backend="local"`: URL of an ESM module with the page's backend (`createBrowserHost`, `createLocalBackend`); without it and without `el.localBackend` there is an error |
| `local-storage` | `backend="local"`: `auto` (OPFS, else IndexedDB) \| `opfs` \| `idb` |

Changing `backend`/`session`/`transport`/`auth`/`profile`/`cwd`/`provider-*`/`local-*` reconnects with a clean feed.

## No server: `backend="local"`

```html
<script type="module" src="nr-chat.js"></script>
<nr-chat backend="local" provider-url="https://gateway.example.com/v1" provider-key="..." profile="agent" local-module="local-backend.js"></nr-chat>
```

The backend lives in the page itself; the widget does not ship it, the page supplies it (a `local-module` module exporting `createBrowserHost` / `createLocalBackend`, or a ready `el.localBackend`). Expected behavior of such a backend: sessions and the agent's project are kept in OPFS (fallback IndexedDB), run state, indexes and the skill cache in IndexedDB; there are no `exec`/`process` tools (there are no processes in a browser, so the model does not see them). Profiles, skill source and working directory are set from JS: `chat.configure({ localOptions: { profiles, skillbox: {url, key}, cwd } })`; a ready backend is `chat.localBackend = await createLocalBackend({...})` (after connecting, the same object is running and has `.host.fs` for uploading files). The gateway must serve CORS; a skill source that does not needs a same-origin proxy.

## JS API

- `send(text)` sends (as if typed in the field) and resolves at the end of the run. `stop()` stops it.
- `registerTool(def, handler)` registers a page tool: `{name, description?, schema?}`, handler `(args) => string | {text, data?}` (may be async). UI protocol: the declaration goes in `sessionMeta.tools` (the executor is the front end, protocol v1.16), the call is an `ask` of kind `tool`, then the handler, then `respond`; leaving the page unregisters the tools. ACP: not supported (an agent cannot be told about them), so an `error` event is raised.
- `onContext(() => state)` provides a page snapshot before every turn. UI protocol: `sessionMeta.pageContext`, which the backend inserts before the user's message (recipe source `page.context`); ACP: as a resource in the prompt.
- `sessionId`, `ready` (a promise of connection), `busy`, `feed` (the feed, read-only).
- Events (bubbling, composed): `session` `{id, transport}`, `message` `{id, role, text}` (a reply is finished), `run-start`, `run-end` `{status, error?}`, `tool-call` `{name, args, callId, page}`, `error` `{message}`.

## Theme

CSS variables on the element: `--nr-bg`, `--nr-fg`, `--nr-muted`, `--nr-border`, `--nr-surface`, `--nr-user-bg`, `--nr-accent`, `--nr-accent-fg`, `--nr-danger`, `--nr-ok`, `--nr-code-bg`, `--nr-radius`, `--nr-font`, `--nr-mono`. Parts: `::part(feed)`, `::part(composer)`.

## Cross-origin and the key

The widget works from any origin: a backend served with `serveBackend` answers CORS (`*`, including the `Origin: null` of sandboxed iframes) and Private Network Access on preflight. A backend with an access key requires it in the `auth` attribute; without it the connection fails (401). An ACP agent with a key accepts any Origin; without a key, only localhost.

## What it does not do

History edits, swipes, fork, regeneration, attachments, a prompt panel, artifact plugins, and model/profile selection in the UI: those belong to a full chat front end. In ACP, history is only what the widget has seen (or a `session/load` replay), and there are no page tools or session meta.

## Demo and development

```sh
npm install && npm run build && npm run size
npm test                         # unit: jsdom against a store backend (UI protocol) and createAcpAgent (ACP)
npm run demo                     # static server: http://127.0.0.1:7820/demo/index.html (UI protocol 7800 / ACP 7811)
npx playwright test              # live acceptance tests against running backends and local (e2e/local.spec.ts)
```

`demo/local.html?provider=...&key=...&profile=agent|chat|skills|agent-exec` is a chat with no server: the agent edits a project in OPFS, with "Download zip" and "Export session", and the session survives a reload. The static server of `npm run demo` serves `/local-backend/*` from the directory in `NR_CHAT_LOCAL_BACKEND_DIST` (a build of the page backend; without it the `local` demo does not work) and proxies `/skillbox/*` (`NR_CHAT_SKILLBOX`).

`demo/index.html?nr=...&acp=...&auth=...&profile=...&cwd=...&tab=nr|acp` has two tabs; `demo/artifact.html?backend=...` is an artifact with a `get_state` page tool.
