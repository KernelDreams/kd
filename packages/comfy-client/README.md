# @kerneldreams/comfy-client

A ComfyUI client for Node: HTTP API, websocket events with previews, a queue that iterates the events of its own prompt, PNG metadata (prompt/workflow) and editable workflow inputs. Requires Node >= 22 (global `fetch`/`WebSocket`, `zlib.crc32`); no runtime dependencies besides `@kerneldreams/nrd` types. The server address is `host:port` or `http(s)://host:port[/base]`.

```sh
npm i @kerneldreams/comfy-client
```

```ts
import { connect, editableInputs, objectInfo, parsePng, setInputs, view } from '@kerneldreams/comfy-client'

const server = '127.0.0.1:8188'

const { prompt, workflow } = parsePng(pngBytes)            // tEXt/iTXt/zTXt "prompt"/"workflow"
const inputs = editableInputs(prompt!, await objectInfo(server))
// → [{nodeId, nodeTitle, classType, name, type: STRING|INT|FLOAT|BOOLEAN|COMBO|IMAGE, value, options?, min?, max?, step?, multiline?, seed?}]

const conn = await connect(server)                         // ws /ws?clientId=...
const job = await conn.queue(setInputs(prompt!, [{ nodeId: '5', name: 'text', value: 'a cat' }]), { workflow })
for await (const e of job) {                               // only the events of this prompt
  if (e.kind === 'progress') console.log(e.value, '/', e.max)
  if (e.kind === 'preview') show(e.mime, e.bytes)          // binary preview frames
  if (e.kind === 'executed') for (const img of e.images) save(await view(server, img))
}                                                          // the end: execution_success | execution_error | execution_interrupted
const { status, images, error } = await job.done           // the result without iterating
await job.cancel()                                         // waiting in the queue: removed; running: /interrupt {prompt_id}
conn.close()
```

## API

- **HTTP** — `queuePrompt(server, prompt, {clientId, promptId, workflow, preview, front})` → `{promptId, number}`
  (a validation error is thrown, with `node_errors` parsed), `history`, `waitForResult` (polling),
  `view(server, imageRef)` → bytes, `upload(server, bytes, name, {subfolder, overwrite})` → `ImageRef`
  (the value for `LoadImage.image` is `imageInputValue(ref)`), `interrupt(server, promptId?)`,
  `queueState`, `objectInfo(server, {refresh})` — cached per process.
  Compatibility helpers for older scripts: `submitPrompt`, `viewImage`, `uploadImage(server, localPath)`,
  `collectOutputFiles`.
- **ws** — `connect(server, {clientId})` → `ComfyConnection` (`on(listener)` for all events, `queue`, `close`);
  `queue(server, prompt, {connection?})` opens its own connection for the duration of the prompt if none is given.
  Events `{kind}`: `status`, `execution_start`, `execution_cached`, `executing{node}`,
  `progress{node,value,max}`, `executed{node,output,images}`, `execution_success`,
  `execution_error{node,nodeType,message,traceback}`, `execution_interrupted`,
  `preview{mime,bytes,promptId?,node?}`, `other{type,data}`.
- **PNG** — `parsePng(bytes)` → `{prompt?, workflow?}`; `embedWorkflow(png, {prompt, workflow})` —
  existing chunks are replaced, and the JSON is written ASCII-escaped (as the server does).
- **Inputs** — `editableInputs(prompt, objectInfo)`: widgets only (literals, not links to nodes), in the schema's
  `input_order`; `LoadImage.image` and everything with `image_upload` is `IMAGE`; an input without a schema gets a
  type from its value (`inferred`). `setInputs(prompt, [{nodeId, name, value}])` returns a copy with the new values.
- **Roles** — `roles(prompt, objectInfo?)` → `{refs[], prompt, negative, size, seed, steps, denoise}`:
  each is `{nodeId, input}` or `null`. Titles come first (`ref1..ref10` on LoadImage, where the title tail is the slot
  label, `Positive`, `Negative`, `Image`, `Sampler`), then the graph from the sampler: backwards along
  `positive`/`negative` to a multiline STRING; a negative in the same node as the prompt is `negative_prompt`;
  `denoise` only if `latent_image` leads to `VAEEncode` (img2img). A link instead of a literal is not a role.
- **Empty refs** — `pruneEmptyLoaders(prompt, objectInfo?)`: an empty LoadImage is removed with a cascade and the
  consumer's input is cut off; with `objectInfo`, a required input is not cut off and the consumer is bypassed
  (ControlNetApply → conditioning, IPAdapter → model); if it cannot be bypassed, `PruneError` is thrown.
- **UI → API** — `detect(json)` → `{prompt?, workflow?}` (API graph, UI graph or a wrapper), `uiToApi(workflow,
  objectInfo)` → `{prompt, bind}`: subgraphs are expanded (`459:451`), Reroute/Primitive/Set/Get/bypass are
  resolved (writing edits back into the UI graph is not supported).
- **Image provider contract** — `comfyImageProvider({server, templatesDir, timeout?})` → `ImageProvider`
  (`@kerneldreams/nrd/contracts`). A model is a template: `*.json` (API or UI) / `*.png` with an embedded graph in
  `templatesDir` (a string or a list; the first wins), and the `id` is the file name without the extension. `models()`
  lists the templates, `edit`/`maxRefs` follow the ref slots. The schema is the roles: `prompt`, `negative`,
  `width`/`height`, `seed`, `steps`, `denoise` (img2img); an extra key is an error. `generate`: refs → `upload` →
  slots in order, empty ones go through `pruneEmptyLoaders`, queued over WS; `onProgress`: `queued` → `running`
  (`status` = node title/class, `step`/`total`, `preview` = preview bytes) → `downloading` → `done`. Images are
  `type: output` from the history. `seed` of -1 or absent is random, and the real one is in `meta.seed`; `signal`
  triggers `interrupt`. Also `.template(id)` — the graph and roles.

## Gotchas

- **The client assigns the prompt id** (`prompt_id` in `/prompt`) and subscribes before sending: a cached prompt
  finishes before the `/prompt` response arrives.
- **Previews** are not sent at all by a server started without `--preview-method`; `conn.queue` asks for
  `preview_method: auto` per prompt (`extra_data`), and `queuePrompt` does so only if `preview` is set. The client
  declares `supports_preview_metadata`, so type-4 frames carry `prompt_id`/`node_id`; type-1 frames (an old server)
  are attributed to the prompt currently executing.
- **A prompt removed from the queue** (`cancel` before start) is not announced by the server, so the client
  synthesizes `execution_interrupted` itself.

## Development

```
npm run build
npm test                                          # unit, no server needed
COMFY_SERVER=<host:port> npm run test:live        # live: t2i with preview/progress, interrupt
```
