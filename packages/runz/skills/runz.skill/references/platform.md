# platform — `nrd/web` и `nrd/node`

Лестница платформ у одного пакета. **Корень** — ноль environment API, работает
везде, включая GAS. **`nrd/web`** — только WinterCG (fetch, streams, crypto): Node,
браузер, CF Workers. **`nrd/node`** — fs, spawn, process, discovery: только Node.
Правило: импортируешь `/node` — твой код не портируем, не тащи его в библиотечный
слой. Шаблоны — своя ступень, `template.md`.

## `nrd/web` — HTTP

```ts
import { httpGet } from '@kerneldreams/nrd/web'
import { isErr } from '@kerneldreams/nrd'        // Result — из КОРНЯ, не из /web

const r = await httpGet(url, { timeout: 5000 })
if (isErr(r)) return { output: r.error.message, exitCode: 1 }
const j = r.value.json<T>()                       // тоже Result, не throws
```

`HttpOptions`: `headers`, `timeout` (ms, default 30000), `retries` (0),
`retryDelay` (1000), `idleTimeout` (300000, `0` = выключить). `HttpResponse`:
`status`, `headers`, `body`, `json<T>(): Result<T>`. Всё возвращает `AsyncResult` —
сеть не бросает исключений, она возвращает `err`.

`httpPostStream(url, body, opts)` → `AsyncResult<ReadableStream<Uint8Array>>`. Общий
`timeout` действует **только до заголовков**; дальше стрим держит idle-watchdog:
таймер сбрасывается каждым чанком, простой дольше `idleTimeout` → отмена и ошибка.
Без него зависший сервер вешает потребителя навечно. Статус ≥ 400 — `err`, не поток.

## `nrd/web` — LLM-провайдеры

Прямой вызов, без промежуточных слоёв. Три фабрики — `openaiProvider`,
`anthropicProvider`, `ollamaProvider` — дают один `LLMProvider`:
`chat(req): AsyncResult<LLMResponse>` и `stream(req): AsyncIterable<LLMChunk>`.

```ts
const p = ollamaProvider({ baseUrl: 'http://localhost:11434', apiKey: '', timeout: 60000, think: false })
for await (const ch of p.stream({ model, messages: [{ role: 'user', content: q }] })) {
  if (ch.type === 'text' && ch.text) process.stdout.write(ch.text)
}
```

- `ProviderOptions`: `baseUrl`, `apiKey`, `defaultModel?`, `defaultMaxTokens?`,
  `headers?`, `timeout?`, `idleTimeout?` (+ `think?` у ollama). `LLMRequest`: `model`,
  `messages`, `max_tokens?`, `temperature?`, `tools?`, `stream?`, `thinking?`,
  `extra?`. `LLMChunk.type`: `text`, `thinking`, `tool_call_start`,
  `tool_call_delta`, `done`.
- **Ошибки старта стрима** (401, 429, сеть) прилетают **throws из первого `next()`**:
  оборачивай цикл в try/catch, а не проверяй Result.
- «Таймаут N секунд» на стриминг одним параметром не выражается: `timeout` — только
  до заголовков, дальше `idleTimeout`; ставь оба, общего wall-clock дедлайна нет.
- `ollamaProvider` сам приводит `baseUrl` к корню хоста: хвост `/v1` **или `/api`**
  срезается, чат идёт на `/api/chat`, эмбеды — на `/v1/embeddings`. Модель с thinking
  может съесть весь `max_tokens` на размышление и отдать пустой текст — ставь
  `think: false`.
- `openaiProvider` в стриме сам шлёт `stream_options: {include_usage: true}` — без
  него llama-server и OpenAI не отдают usage в стриме (были нули у локальных
  моделей). Сервер, который флаг не переваривает, — переопредели через
  `extra.stream_options`.
- Готового диспетчера «`$type` из конфига → `LLMProvider`» в nrd **нет**: ветвление
  по `openai`/`anthropic`/`ollama` пишет потребитель; локальной ollama сойдёт
  `apiKey: ''`. Ошибки — `LLMError` с `code`; есть `parseRetryAfter`,
  `errorCodeFromStatus`, `parseSSE` и конвертеры под свой транспорт.

## `nrd/web` — эмбеды и CAS-кеш

`embed?(req)` у провайдера (nrd ≥ 1.4) — есть у `openaiProvider` и `ollamaProvider`
(OpenAI-вайр `/embeddings`), у `anthropicProvider` нет, поэтому метод опциональный:
проверяй `typeof p.embed === 'function'`. `EmbedRequest` = `{model, input: string[]}`
→ `AsyncResult<EmbedResponse>`, `EmbedResponse` = `{vectors: Float32Array[], model?}`
в порядке `input` (прогнано на шлюзе: `embed/giga`, dim 1536).

Вектор адресуется текстом: `textHash(t)` = sha256 от `normText(t)` (CRLF → LF,
пробельные прогоны → один пробел, 3+ перевода строки → два, trim; версия — `NORM_V`)
в **пространстве** — алиасе шлюза (`embed/giga`), который пинит модель. Один текст в
одном пространстве оплачивается один раз — навсегда.

```ts
const store = memoryEmbedStore()            // EmbedStore; на диске — sqliteEmbedStore (nrd/node)
const vecs = await cachedEmbed(texts, { space: 'embed/giga', store, embedder: (input) => p.embed!({ model: 'embed/giga', input }) })
```

`cachedEmbed(texts, {space, store, embedder, batch?=64, onProgress?})` →
`Float32Array[]` в порядке входа: стор → промахи пачками → embedder → `put` после
каждой пачки (упал посередине — оплаченное сохранено); дубли считаются один раз
(прогнано: 3 текста, 2 уникальных после нормализации → один вызов). Пустой после
нормализации текст, ошибка embedder, другая размерность в пространстве — **throw**,
не Result. Кеш хранит f16 (`toF16Bytes`/`fromF16Bytes`): повторно прочитанный вектор
не бит-в-бит с первым ответом — сравнивай по косинусу, не `===`.

## `nrd/web` — медиа: картинки, видео, музыка (BFL, nano-gpt, Google)

Контракт — `ImageProvider` из nr-contracts (≥ 1.6, реэкспорт в `nrd/web`; **один на все медиа**
с nr-contracts 1.8 / nrd 1.11, media-gen-spec; алиасы `MediaProvider`, `MediaRequest`…):
`generate({model, prompt?, refs?: Uint8Array[], params?, signal?, onProgress?})` →
`AsyncResult<{images: Uint8Array[], mime, meta: {model, id?, cost?, cost_unit?, seed?}}>`;
опционально `schema(model)` → `{fields: {имя: {type, enum?, min?, max?, image?, array?}}, maxRefs?}`
и `models()` → `[{id, name?, kind?, refRole?, edit?, maxRefs?, price?}]` (`price` — строка провайдера,
без пересчёта). **Вид выхода** — `kind: 'image' | 'video' | 'audio'` у модели и у схемы (нет — `image`);
`images` результата — файлы этого вида, `mime` — по сигнатуре (`video/mp4`, `audio/mpeg`, `audio/wav`…;
`sniffMediaMime`, `mediaExt`, `mediaKindOf`). `refRole: 'frames'` — рефы это кадры ролика: первый
начинает, последний (если умеет) заканчивает; без рефов — text-to-video.
`onProgress(e)` — `{stage: 'queued'|'running'|'downloading'|'done', status?, step?, total?, preview?: Uint8Array}`,
на смене stage/status/step; исключение колбэка генерацию не роняет (warn).
Ошибки — `Error` с `name`: `AuthError` (401/403), `RateLimitError` (429 после ретраев),
`ModerationError`, `ImageError` (прочее; тело ответа — в `.body`); конструктор `imageError`.

`bflImageProvider({baseUrl, apiKey, timeout?=600000, pollInterval?=2000})` (nrd ≥ 1.6) —
FLUX 3 и вся линейка BFL. `model` — путь эндпоинта (`flux-3-image`, `flux-2-pro`,
`flux-kontext-pro`, `flux-tools/erase-v1`). Схема — из `GET {baseUrl}/openapi.json`, один раз
на экземпляр. По ней тело проверяется **до сети**: ключ не из схемы → `err` с именем и
списком полей (не тихий отброс), строки приводятся к integer/number/boolean, enum и
min/max проверены; модели нет → `err` со списком ближайших. Рефы раскладываются под
модель: `images` → массив base64 (до 10 по описанию), `input_image`, `input_image_2`… (по
числу полей), `image_prompt` → первый, иначе `image`/`mask`, `person`/`garment` по порядку
схемы. Рефов больше `maxRefs` или реф на поле, заданное в `params`, — `err`, не обрезка.
**`flux-3-video`** (nrd ≥ 1.11) — модель вида `video`: тело — `oneOf` по `mode`; поля — t2v
(`duration` 5…20 | `auto` — «5» строкой уходит числом, `resolution` hd/fhd/qhd/uhd,
`aspect_ratio`, `generate_audio`, `draft`, `safety_tolerance`), рефы — кадры в `keyframes`
(`mode: i2v`, до 10), без рефов — `mode: t2v`; `mode`/`keyframes` в params — `err`.
Прогнано (10.10): лисичка первым кадром, 5 с hd без звука — 85 кредитов, ~100 с.
Опрос — строго `polling_url` из ответа POST (региональный id на глобальном `get_result`
даёт «Task not found»), 429 и 503 (over capacity) на POST — до 6 ретраев с паузой 5·k с; таймаут называет id задачи и последний статус. `meta.cost` — в
**кредитах** BFL (`meta.cost_unit: 'credits'`), MIME — по сигнатуре байтов
(`sniffImageMime`, `imageExt`; `toBase64`/`fromBase64` без `Buffer`). Прогресс (nrd ≥ 1.8):
`queued` после POST, `running` + `status` на каждой смене статуса опроса (`Pending`,
`Reasoning`, `Generating`), `downloading`, `done`. `models()` — все `POST /v1/*` openapi, кроме
файнтюнов, `delete_*` и видео-инструментов (`flux-tools/video-*`); `flux-3-video` — с `kind: 'video'`;
`name` — summary эндпоинта, цены у BFL в схеме нет.
Прогнано (07.10, eu): flux-2-pro с `width/height` и с двумя рефами (`input_image`,
`input_image_2`) — 3 и 6 кредитов. flux-3-image в тот день был перегружен: POST — 503
«over capacity», принятая задача висела в `Reasoning` больше 10 мин — дефолтного
`timeout` (600 с) FLUX 3 в часы нагрузки может не хватить.

```ts
const p = bflImageProvider({ baseUrl: 'https://api.eu.bfl.ai', apiKey })
const r = await p.generate({ model: 'flux-2-pro', prompt: 'a red fox', params: { width: '1024', height: 768 } })
```

`nanogptImageProvider({baseUrl: 'https://nano-gpt.com/api/v1', apiKey, timeout?=600000})`
(nrd ≥ 1.8) — синхронный `POST {baseUrl}/images` (Bearer). Список и схема — `GET
{baseUrl}/images/models` (без ключа), один раз на экземпляр: поля из `supported_parameters` —
`resolution` (enum из `resolutions`), `aspect_ratio`, `seed`, `output_format`, `thinking_level`,
`enable_web_search`, `rendering_speed`, `system_prompt`, `loras`; всегда `prompt`, `n`; лишний
ключ — `err` со списком полей. Рефы — **`imageDataUrls`** (data-URL): нормализованное
`input_references` из документации `flux-3/edit` не видит («requires between 1 and 10 reference
images», живьём 07.10). `n` → картинок по числу `data`. Ошибки: 401/403 `AuthError`, 429 — 6
ретраев 5·k с → `RateLimitError`, 400 с type `CONTENT_POLICY*`/`MODERATION*` → `ModerationError`,
прочее — `ImageError` с type и текстом (+ «не списано» у `IMAGE_PROCESSING_FAILED`). `meta`:
`id` = requestId, `cost` в **usd** (`cost_unit`), `balance`. `models()` — только
`image_generation`, `edit` = `image_to_image`, `price` — «$0.05/1k, $0.12/2k, $0.65/4k».
Прогнано (07.10): `black-forest-labs/flux-3/text-to-image` 1k — $0.05, ~40 с;
`black-forest-labs/flux-3/edit` с одним рефом — $0.05.

nano-gpt **видео** не поддержано: `POST /api/generate-video` (`x-api-key`) с полями под каждую
модель (`imageDataUrl`, `duration` то «5», то «5s», `num_frames`…), моделей со схемой нет
(`/api/v1/models?detailed=true` без `supported_parameters`), статусы разного регистра —
нормализации, как у картинок, нет.

**Гейт** (nrd) — `gateMediaProvider({baseUrl, apiKey?, timeout?, pollInterval?})`:
медиа через llm-gate (`POST /v1/media` → опрос `GET /v1/media/{id}` → файлы). Ключи провайдеров —
на гейте; `models()`/`schema()` — `/v1/media/models`, `/v1/media/schema`; прогресс задачи —
`onProgress`; `signal` прекращает опрос (задача на гейте доделается и останется в галерее).

**Google** (nrd ≥ 1.11, media-gen-spec §2) — два доступа одним кодом:
`googleMediaProvider({apiKey, baseUrl?, timeout?=900000, pollInterval?=10000})` — AI Studio
(ключ Gemini API; `baseUrl` с хвостом `/openai` срезается) и
`vertexMediaProvider({project, location?='global', mediaLocation?, token, candidates?, baseUrl?})` —
Vertex (`token: () => Promise<string>` — ADC инъекцией, кэш 45 мин; ступень web без `node:`).
Семейства по id: **картинки** `gemini-*-image`, `gemini-nano-banana-*` — `:generateContent`,
рефы `inlineData` перед текстом (до 14; у 2.5 — 3), поля `aspect_ratio`, `image_size`
(1K/2K/4K; 3.1-flash — ещё 512, lite — только 1K, 2.5 — нет), `thinking_level` (3.1),
`seed`, `temperature`; мысли (`thought: true`, промежуточные картинки) пропускаются;
`promptFeedback.blockReason` и `finishReason` IMAGE_SAFETY/PROHIBITED… — `ModerationError`.
**Видео** `veo-*` — `:predictLongRunning` → операция → опрос (AI Studio — `GET {name}`, Vertex —
`:fetchPredictOperation` в регионе `mediaLocation`, дефолт `us-central1` — в `global` Veo нет)
→ mp4 (AI Studio — `uri`, качается тем же ключом; Vertex — `bytesBase64Encoded`). Кадры —
`image`/`lastFrame` формы `{bytesBase64Encoded, mimeType}` у обоих доступов: `inlineData` из
документации AI Studio модель отвергает («inlineData isn't supported», живьём 10.10). Поля
`duration` 4/6/8, `resolution` 720p/1080p/4k (lite — без 4k), `aspect_ratio` 16:9/9:16,
`negative_prompt`, `person_generation` (с кадром — `allow_adult` по умолчанию: `allow_all`
API отвергает), `seed`; RAI-фильтр — `ModerationError` с причинами. **Музыка** `lyria-3*` —
`:generateContent` (`responseModalities: ['AUDIO','TEXT']`) → mp3, текст песни/описание — в
`meta.text`; рефы — картинки-вдохновение (до 10); на Vertex Lyria — только в `global`.
Список моделей — из API, не хардкодом: AI Studio — `GET models` (фильтр по семейству и методу),
Vertex — `publishers/google/models` (там только Gemini) + проба `VERTEX_MEDIA_CANDIDATES`
(`GET …/models/{id}`, бесплатно). Параметров модели Google не отдаёт — схема по семейству.
Цен в ответе нет: `meta.cost` — токены (`cost_unit: 'tokens'`, `meta.usage` — разбивка) у картинок
и Lyria, секунды ролика (`'seconds'`) у Veo. 429/503 — 6 ретраев 5·k с.
Прогнано (10.10): AI Studio — `gemini-3.1-flash-lite-image` (1490 tok), `gemini-3.1-flash-image`
с двумя рефами (1974 tok, оба персонажа держатся), `veo-3.1-lite-generate-preview` 4 с 720p с
первым кадром (~33 с), `lyria-3-clip-preview` (30 с mp3, ~300 tok); Vertex —
`gemini-3.1-flash-lite-image`, `veo-3.1-lite-generate-001` 4 с, `lyria-3-clip-preview`.

ComfyUI за тем же контрактом — `comfyImageProvider` из `@kerneldreams/comfy-client` (≥ 0.2,
внутренний): модель = шаблон (`*.json` API/UI, `*.png` со вшитым графом), схема = роли
шаблона (`prompt`, `negative`, `width`/`height`, `seed`, `steps`, `denoise`), рефы — в
ref-слоты через `upload`, пустые — `pruneEmptyLoaders`; прогресс — нода, шаги, превью
латента; `seed` −1/нет — случайный, реальный в `meta.seed`.

В runz проще `helpers.image` / `helpers.video` / `helpers.audio` (`runz.md`): провайдер и модель —
из цепочки, файл и провенанс на диске; хостам — `resolveImageProvider(ctx, name?, kind?)` /
`listImageProviders(ctx)`.

## `nrd/web` — storage

`memoryStorage()` → `IStorage`: `read` (**`ok(undefined)` = файла нет, штатно**),
`write`, `exists`, `list(prefix)`, `delete` — всё `AsyncResult`. На диске —
`fsStorage(root)` из `nrd/node`: относительный путь — от `root`, абсолютный
(`/a`, `S:/a`, `S:\a` — по форме строки, на любой ОС) — как есть, nrd ≥ 1.5.1.
До 1.5.1 `S:/a` на Unix и `/a` везде клеились к `root` → «не найден».

**`IFileSystem` и `KvStore`** (nr-contracts ≥ 1.4) — контракты хоста для
кода, который обязан жить и в Node, и в браузере/Worker'е. `IFileSystem extends
IStorage` + `stat` (`{type: 'file'|'dir', size, mtimeMs}` | `undefined`),
`readBytes`/`writeBytes`, `readdir` (`{name, type}[]` | `undefined`), `mkdir`
(с родителями), `rename`, `remove(path, {recursive})`, опционально `realpath`
(симлинки) и `append`. `KvStore`: `get`/`set(key, value, {ttlMs})`/`delete`/
`list(prefix)` — значение JSON, ключи через `/`. Всё `AsyncResult`, «нет такого»
— `ok(undefined)`. Реализации: `createNodeFileSystem()` (`nr-chat-store/node-fs`),
`createMemoryFileSystem()` (`nr-chat-store/fs`), хосты агента (Node, браузер: OPFS/IndexedDB,
память); у `nrd` — только `IStorage`.

## `nrd/node` — capabilities для `buildContext`

```ts
const caps = nodeCapabilities(baseDir)   // { storage, executor, http }
const ctx = await buildContext(cfg, { baseDir, ...caps, privilegedFunctions: builtinFunctions })
```

`nodeCapabilities(baseDir)` = `fsStorage(baseDir)` + `spawnExecutor` + `fetchHttp`;
передавай тот же `baseDir`, что и в `buildContext` — `$path` в source-блоках
трактуется относительно него. `builtinFunctions` — fs-функции для
`${}` (`loadMDD`, `loadMDZ`, `loadJSON`, `readFile`); они **привилегированные**:
кладутся в `privilegedFunctions` и при `trusted: false` не подключаются.

## `nrd/node` — исполнение и файлы

```ts
const r = await execShell('git rev-parse HEAD', { cwd, timeout: 5000 })
// AsyncResult<ExecResult, ExecError>; ExecResult = { stdout, stderr, code }
```

`ExecOptions`: `cwd`, `env` (merge поверх `process.env`), `timeout` (ms, дальше
SIGKILL), `shell` (`true` | путь | `false`), `input` (stdin). `runFile(path, args)` —
`node <path> args` **без оболочки**: честные аргументы, без шелл-экранирования.
Провал — `err(ExecError)`, `ExecError.result` несёт `ExecResult` и на провале.
`spawnExecutor` — готовый `Executor` для `execBlock` (см. `nrd.md`).

**Долгий прогон, который должен пережить свой процесс** (окно, вкладку, рестарт
бэкенда) — не `execShell`/`spawn` руками, а задача `@kerneldreams/runz-run/jobs`
(`start` → реестр `~/.runz/jobs/`, обёртка `detached` пишет лог сама, очередь с
лимитами `$jobs`): `runz.md` § «Задачи». Короткий синхронный прогон шаблона —
`runTemplate`/`runFile` того же пакета (отмена SIGTERM группе, `onLine`).

## `nrd/node` — discovery функций

`discoverFunctions(startDir, globalDir?)` собирает реестр `${fn()}`:
`builtinFunctions` → `~/.nrd/functions/` → вверх по дереву от `startDir` через каждый
`.nrd/functions/`; **ближе — сильнее**. Файл функции — `.ts`/`.js`/`.mjs`, **имя файла
= имя функции**, `export default` — сама функция `(args, ctx) => Value`; не функция
или сломанный модуль → warn в stderr и пропуск.

```ts
// .nrd/functions/upper.ts
export default (args: unknown[]) => String(args[0] ?? '').toUpperCase()
```

Весь этот реестр `buildRuntimeContext` кладёт в `privilegedFunctions` — значит при
`trusted: false` проектные `.nrd/functions/` не подключаются вместе с builtins.

**Что выбрать.** Функция нужна твоему коду — объявляй её в коде
(`funcContext({...})` или `opts.functions`): поведение не зависит от того, где лежит
файл. `.nrd/functions/` — для документов, которые пишешь не ты, и для функций,
общих на проект.

## `nrd/node` — сборка контекста файла

`buildRuntimeContext(filePath, opts)` — одна строка вместо ручной проводки: discovery
функций → `readTextWithIncludes(filePath, baseDir)` (раскрытие `$[[include]]`,
правила — `formats.md`) → `buildContext` с node-capabilities → готовый IContext; `params` подмешиваются отдельным слоем.
`RuntimeOptions` = `BuildContextOptions` + `functions`, `skipDiscovery`,
`globalFunctionsDir`; без файла — `buildFunctionContext`. Обычные блоки он, как и
`buildContext`, не отдаёт — только `## $source` (см. `nrd.md`). Ещё в `/node`:
`nodeFileIO`, `readTextSync` и загрузка шаблонов с диска (`template.md`).

Файл с инклюдами без контекста — `readTextWithIncludes(file, baseDir?, tag?, opts?)` → `string`
(nrd ≥ 1.1.0, sync; `baseDir` — от чего резолвятся инклюды самого файла, дефолт —
его папка; вложенные — всегда от папки включающего; nrd ≥ 1.7.0 — `opts.fallbackDirs`:
не найденный там инклюд ищется по этим папкам, так comfy находит профили в `workflows/`). Им же читает `loadProgram`
(`runz.md`). Цикл инклюдов — throws `IncludeCycleError`, не молчаливое обрезание.

## `nrd/node` — CAS-стор эмбедов

`sqliteEmbedStore(dir)` → `EmbedStore` + `close()` на `node:sqlite` (Node ≥ 22.5,
грузится лениво): файл на пространство `{dir}/{embedSpaceSlug(space)}.db`
(`embed/giga` → `embed__giga.db`), WAL, вектора f16. В meta файла — `space`, `NORM_V`,
`dim`: чужой файл, другая нормализация или размерность — ошибка, не подмена. `~`
раскрывается. Дефолтный каталог — `EMBED_DIR` = `~/.nr/embed`, **общий для всех
скриптов машины**: не чисти его руками — это оплаченные вектора.

В скрипте/документе runz проще `helpers.embed` (`runz.md`): он сам берёт провайдера
хоста, пространство `$embed_model` и стор в `$embed_dir ?? ~/.nr/embed`.
