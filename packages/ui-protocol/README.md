# @kerneldreams/ui-protocol

A universal UI ⇄ backend protocol (v1): the wire types and mapping helpers that let one generic front end talk to any backend over a single wire. The package contains **only types and helpers** — no engine, no transport.

```bash
npm i @kerneldreams/ui-protocol
```

```ts
import {
  serializeRunEvent, parseRunEvent, parseSSEStream,
  derivedText, isTextPart,
} from '@kerneldreams/ui-protocol'

// One SSE frame: `event: <type>\ndata: {json}\n\n`
const frame = serializeRunEvent({ type: 'part_delta', runId: 'r1', messageId: 'm1', part: 0, delta: 'hello' })

const event = parseRunEvent(frame)   // AnyRunEvent | null (null for a broken frame)
if (event?.type === 'part_delta') console.log(event.delta)

// derivedText(message) — the flat text of a message (the concatenated text parts)
```

Adapters for concrete backends (engines, agents, other chat runtimes) depend on this package without pulling an engine in. The only runtime dependency is `@kerneldreams/chat-store`, whose message model (`Part`, `Message`, `SessionInfo`, ...) is re-exported here. For a ready-made HTTP + SSE transport see `@kerneldreams/backend-http`.

## Entry points

| import | what |
|---|---|
| `@kerneldreams/ui-protocol` | types, guards, serialization, helpers |
| `@kerneldreams/ui-protocol/service` | the plugin `service.ts` contract: `ServiceMeta` (`pluginId`, `root`, `dataDir`, `pluginDir`, `on`, `stream`), `ServiceFn`, `ServiceCallHandler`, `ServiceStreamHandler`, `ServiceSink` (types only) |
| `@kerneldreams/ui-protocol/links-rules` | link rules |

## What is inside

### Types

- **Session:** `SessionInfo`, `Participant`
- **Message:** `Message`, `Usage`, `MessageFlags`, `MessageMeta`
- **Part** (a closed core plus the `custom` escape hatch): `Part`, `TextPart`, `ThinkingPart`, `ToolUsePart`, `ToolResultPart`, `FilePart`, `ImagePart`, `ErrorPart`, `CustomPart`; opaque variants `AnyPart` / `UnknownPart`
- **Models** (capability `models`): `ModelInfo`, `SessionModel` (also known as `ModelSelection` in `chat-store`), `SessionInfo.model`, `SessionCreateOpts.model`, `ModelsOps` (`list` / `set`)
- **Workspace** (capability `workspace`): `WorkspaceInfo`, `WorkspaceOps` (`current` / `list` / `switch`), `SessionInfo.workspace`
- **Projects** (protocol v1.26): `WorkspaceInfo.kind: 'project'`, `description`, `project` (`WorkspaceProject` — a project registry record, `projects/<id>.mdz`); capability `workspace.projects` (`sessions.list({workspace})`, `SessionCreateOpts.workspace` → the project's `$root`/`$profile`/`$model`, meta `workspace.project`) and `workspace.edit` (`workspace.create` / `update`, `WorkspaceProjectPatch`; there is no delete); `ExternalPluginInfo.workspace` — a project's plugin. Helpers `canProjects`, `sessionProjectOf`, `projectIdOf`, `isProjectId`, `pluginsForWorkspace`, `DEFAULT_PROJECT_ID`
- **Profiles** (capability `profiles`, protocol v1.4): `ProfileInfo`, `ProfilesOps` (`list` / `set`), `SessionInfo.profile`, `SessionCreateOpts.profile`
- **Profile editor** (protocol v1.5): `ProfileDoc`, `ProfilesOps.get` / `save` / `delete` / `duplicate` (capability `profiles.edit`); catalogs `CatalogsOps` (`tools` / `skills` / `extensions`, capability `catalogs`) — `CatalogTool`, `CatalogSkill`, `CatalogExtension`
- **Bot = session** (protocol v1.6): an inline profile — `SessionCreateOpts.profile` and `ProfilesOps.set` accept `string | ProfileDoc`, `SessionInfo.profile: 'inline'` + `SessionInfo.profileDoc`, `INLINE_PROFILE_ID`, `isProfileDoc`; `MessageAppendOpts.role: 'user' | 'assistant'` (a greeting without a run) and `MessageAppendOpts.swipeOf` (an alternative to a message, capability `swipes`). `ProfileDoc` lives in `chat-store` and is re-exported
- **Workspace files** (protocol v1.7): capability `workspace.files {write?, watch?}`, `WorkspaceOps.files` — `WorkspaceFilesOps` (`list` / `read` / `stat`; `write` / `delete` / `rename` — gated by `write`; `watch(listener) → unsubscribe` — gated by `watch`), `FileEntry`, `FileContent`, `FileEncoding`, `FileReadOpts`, `FileWriteOpts`, `WorkspaceUpdateEvent` (`workspace_update {paths}`, a separate SSE channel, not a run event)
- **Message prompt** (protocol v1.8): capability `prompts`, `MessagesOps.prompt(sid, mid) → PromptView` (`recipe`, `system`, `injections`, `messages` with `edited`/`missing` — texts come from the current version of the session), `PromptRecipe` (hashes of the chunks + `messageIds`/`messageHashes`), `PromptInjection`, `PromptMessage`; `PROMPT_RECIPE_CUSTOM_TYPE` (`nr-prompt-recipe`), `PROMPT_HASH_LENGTH` / `PROMPT_MESSAGE_HASH_LENGTH`, `isPromptRecipe`. HTTP: `GET /sessions/:id/messages/:mid/prompt`
- **Personas** (protocol v1.9): `Persona` (`id`, `kind: 'user'|'char'`, `name`, `avatar?`, `model?`, `prompt?`, `color?`), `PersonasDoc` (`personas`, `userId?`), capability `personas: { edit?, multi? }` (`true` is the pre-v1.9 form, normalized by `personasCapability`), `PersonasOps.list(sid)` / `save?(sid, personas, userId?)`, `MessageMeta.personaId`, `PromptRecipe.personaId`, `RunStartInput.personaId` — whose turn it is, `SessionCreateOpts.personaId` — the user persona. The record inside a session is `PERSONAS_CUSTOM_TYPE` (`nr-session-personas`); shape checks — `isPersona`, `isPersonasDoc`, the tolerant reader `personasDocOf`, the save check `validatePersonas`; who is who — `userPersona`, `charPersonas`, `turnPersona`, `personasVoiced`; names in text — `expandPersonaNames` (`{{char}}`/`{{user}}`), `personaPrefixed`, `stripPersonaPrefix`, `personasSystemBlock`, `PERSONA_INJECTION_SOURCE`. HTTP: `GET/PUT /sessions/:id/personas`
- **Continue and attachment bytes** (protocol v1.10): capability `run: { continue? }` (`RunCapability`, gate `canContinue`) — a run without `userMessage`/`regenerate`; without it the backend rejects such a run with `not_supported` before `run_start`; `attachments.get?: boolean` + `AttachmentsOps.get?(sid, ref)` → `AttachmentContent` (`ref`, `content`, `encoding: utf8|base64`, `size`, `mime?`), assembled with `attachmentContent`, for an `<img>` — `attachmentDataUrl`, gate `canGetAttachment`. HTTP: `GET /sessions/:id/attachments/:ref`
- **Plugin services** (protocol v1.11): capability `services: Record<pluginId, {methods, streams}>` (`ServicesCapability`, gate `canService(caps, plugin, method, kind?)`), `ProtocolBackend.services` — `ServicesOps.call(plugin, method, args?)` / `stream(...) → AsyncIterable<ServiceEvent>` (`{name, payload?}`); an undeclared call is a `NotSupportedError` before any frames, a throw in an open stream is an `error` frame (`serviceErrorEvent`) and an end. `ServicesHost` is a layer for assembling a backend (+`capability()`, `close()`). HTTP: `POST /services/:plugin/:method`, `POST /services/:plugin/:method/stream` → SSE `service_event`…`service_end` (`serializeServiceEvent`, `serializeServiceEnd`, `parseServiceFrame`). The `service.ts` contract is the subpath `@kerneldreams/ui-protocol/service`
- **Addressee and witnesses** (protocol v1.12): `MessageMeta.to?: string` — the addressee (a whisper), `MessageMeta.seen?: string[]` — ids of the personas in whose presence it was said. Optional; the feed core does not interpret them: a backend writes them to the node meta and `history()` returns them as is. Editable personas stay as before: `personas: { edit }` + `PersonasOps.save`
- **Turn input and persona gender** (protocol v1.13): `RunStartInput.segments?: unknown[]` — a typed action (segments of buttons and the composer; the schema belongs to the backend), `RunStartInput.wish?: string` — a wish to the narrator, not a line of dialogue; the core and the transport pass both through as is. `segments` without `userMessage` is a run with input (not "continue"); `wish` with empty input is "continue" with a wish (gated by `run.continue`). `Persona.gender?: string` (`female` | `male`) — for agreement in backend prompts; the UI does not interpret it
- **Speech** (protocol v1.15): `MessageMeta.speech?: MessageSpeech` — `{speaker, voice, instruct?}` (who speaks, the provider's voice id, `''` — no voice, the tone of the line); `MessageStartEvent.message.meta?: MessageMeta` — meta known before the first word (`personaId`, `speech`), so that synthesis can start on the first sentence. The feed core puts it on the streaming message and the final one in `message_end`; speech itself is handled by a plugin
- **Token estimate:** `estimateTokens(text)` — `ascii / 4.4 + nonAscii / 2.75` over code points (calibrated against usage on a corpus of older sessions); the earlier `chars / 3.5` under-counted non-Latin text and over-counted code
- **Capabilities:** `Capabilities`
- **Envelope:** `Envelope<T>`
- **Run:** `RunStartInput`, `RunEvent` (`run_start`, `message_start`, `part_start`, `part_delta`, `part_end`, `message_end`, `ask`, `activity`, `session_update`, `run_end`); opaque variants `AnyRunEvent` / `UnknownRunEvent`

Later protocol revisions (the full list is in the header comment of `src/index.ts`) add, among others: external frontend plugins (`Capabilities.plugins`), prompt debugging (`Capabilities.promptDebug`), `Usage` cache and context fields, per-project profile catalogs, workspace full-text search (`workspace.files.search`), multi-user support (`Capabilities.users`, `UsersOps`, session sharing, the `forbidden` code), attaching to a running run (`sessions.attach`, `ask_end`), managed context (`SessionContextMeta`), a hub of engines (`EngineInfo`, `engineCaps`), agents as profiles, steering a run mid-turn (`steer`), live sessions (`sessions.live`, `sessions.release`), files outside workspaces and host actions (`files.external`, `host`), session archive and tags, history and session list paging, session skills with modes, device names, run variables (`RunStartInput.vars`), subscription multiplexing (`ServicesOps.subscribe`), session activity (`SessionActivity`), a greeting handler command and signed raw-file URLs (`files.sign`).

### Helpers

```ts
import {
  derivedText, matchToolPair,
  isKnownPart, isKnownRunEvent, isRunEvent,
  isTextPart, isToolUsePart, /* ... the other guards */
  serializeRunEvent, parseRunEvent, parseSSEStream,
} from '@kerneldreams/ui-protocol'
```

- `derivedText(message)` — flat text = the concatenation of text parts (the protocol has no `content`; the client computes it).
- `matchToolPair(parts)` — matches `tool_use ↔ tool_result` by `callId` → `ToolPair[]`.
- Type guards for `Part` and `RunEvent`, narrowing by `type`.
- `isKnownPart` / `isKnownRunEvent` — recognition of the core; anything unknown is opaque and rendered by a fallback, the client does not crash (graceful degradation).

### Workspace files — rules for backends

Shared by disk-backed and in-memory fixture backends, so that both answer identically:

- `normalizeFilePath(path)` — a relative POSIX path without `.`; the root is `''`. `..` in any segment, an absolute path, `\`, NUL → `FileBadRequestError` (`bad_request`). Symlinks pointing outside are checked by the backend that has a disk.
- `fileContent({path, data, revision})` — UTF-8 without NUL as text (a BOM is preserved), otherwise base64; `decodeFileContent(content, encoding)` — the reverse.
- `checkFileReadSize(path, size, maxBytes?)` — the `read` limit (`DEFAULT_FILE_READ_MAX_BYTES`, 2 MB), rejects with the size.
- `isIgnoredPath(path, isDir, rulesOf)` + `parseGitignore` / `matchGitignore` — `FileEntry.ignored`: `.git`/`node_modules` at any depth, the `.nr-trash` trash at the root, then the `.gitignore` of directories (a subset of git).
- `FileNotFoundError` (`not_found`), `FileConflictError` (`conflict`), `fileMime`, `parentFilePath`, `isTrashPath`, `WORKSPACE_TRASH_DIR`.
- `serializeWorkspaceEvent` / `parseWorkspaceEvent` / `isWorkspaceUpdateEvent` — the frames of `GET /workspace/events`. `paths: ['']` means "re-read everything".

### SSE binding

A frame is `event: <type>\ndata: {json}\n\n`:

```ts
const frame = serializeRunEvent({ type: 'part_delta', runId: 'r1',
  messageId: 'm1', part: 0, delta: 'hello' })

const event  = parseRunEvent(frame)        // AnyRunEvent | null (null on a broken frame)
const events = parseSSEStream(sseText)      // AnyRunEvent[] — broken frames are dropped
```

There is no transport (fetch/EventSource/server) here — only serialization and parsing.

## Boundaries

- No transport, server or client implementation — only types, guards and serialization.
- Mappings for concrete backends belong to separate adapters, not to this package.

## Development

```bash
npm test              # vitest
npm run build         # tsc → dist
```

## License

MIT
