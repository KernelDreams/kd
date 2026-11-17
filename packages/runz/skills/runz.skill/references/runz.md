# runz — запуск скриптов и appz

runz запускает `.ts` и NRD-документы (`.md`/`.mdz`/`.mdd`/`.mds`) **без
package.json, без node_modules, без билда**: Node 24+ гоняет TypeScript нативно,
окружение даёт runz.

```
runz ./my-script.ts --key=value hello   # прямой путь
runz greet --name=Carly                 # имя из реестра
runz task.mdz                           # документ; что исполнять — объявлено в нём
runz feed.txt --as=mds                  # нестандартное расширение
```

## Контракт скрипта

```ts
import { asText, type IContext } from '@kerneldreams/nrd'
import type { ScriptMeta, ScriptResult } from '@kerneldreams/runz-runtime'

export default async function (ctx: IContext, meta: ScriptMeta): Promise<ScriptResult> {
  return { output: `Hello, ${asText(ctx.get(['name'])) ?? 'World'}!` }
}
```

Фасадов поверх IContext не строй. **`ScriptMeta`/`ScriptResult`/`ServiceResult` —
из `@kerneldreams/runz-runtime`, не из `@kerneldreams/nrd`** (импорт из nrd даёт `TS2305`).
`ScriptResult` = `{ output?, append?, exitCode?, outputs? }` (`append` дописывается в
исходный файл); `ServiceResult` = `{ pid, url?, log? }` — runz печатает handle и
выходит, сервис живёт своим процессом.

**`outputs: ScriptArtifact[]`** — что скрипт произвёл, для машинного потребителя
(форма, сервис `runz-run`, nrchat): `{type:'text', text}` | `{type:'image', path,
meta?}` | `{type:'file', path}`; тип — из `@kerneldreams/runz-runtime`. CLI поле не печатает,
`output` остаётся человеческой сводкой. Отдаёт его **`--runz-json`**: stdout — одна
строка `JSON.stringify(ScriptResult)`, и на ошибке тоже (`{"output":"runz: …",
"exitCode":1}`, exit 1) — вызывающий парсит stdout, не stderr (прогнано). Картинку
генерации кладёшь в `meta.dataDir` и отдаёшь путём в `outputs`, не байтами в `output`.

### Аргументы — из `ctx`, не из `process.argv`

`--key=value` попадают в chain: `ctx.get(['key'])`. **Позиционные — под ключом `_`**,
несколько → IArray (не JS-массив — см. `nrd.md`). Префикс `--runz-*` (`debug`, `dry`, `json`,
`config=X`, `chain=X`, `list`, `help`, `runtime=X`) и `--untrusted` — за рантаймом.

**Окружение — не источник голых ключей**: `${env.VAR}` / `ctx.get(['env','VAR'])` —
да, `${VAR}` — нет. Иначе служебный ключ env (`_`, `HOME`) молча подменяет
отсутствующее значение.

### `meta` — то, чего нет в данных

`ScriptMeta`: `file` (путь исходника, `null` у virtual-run), `doc` (`NRDocument` или
`null` для `.ts`), `program` (документ как программа), `projectDir` (корень с
`.runz/`), `dataDir`, `debug`/`dry`, опциональный `chain: { strong, weak }` — слои
сильнее и слабее атрибутов документа.

**`meta.dataDir` — единственное легальное место для файлов состояния.** Не
хардкодить и не писать рядом с исходником: default — `{projectDir}/.runz/data/{name}/`,
глобально `~/.runz/data/{name}/`, переопределяется `$dataDir`; каталог создаётся не
сам — `mkdir` перед записью. **Поля `args` у `meta` НЕТ**: цель — `ctx.get(['_'])`
или `meta.file`.

## Chain — откуда берутся значения

Приоритет (первый выигрывает): **CLI → документ → `<script>.config.md` рядом со
скриптом → проектный `.runz/config.md` → глобальный `~/.runz/config.md` → окружение**
(последнее — только под `env.`). `--runz-config=path` — между документом и конфигом
скрипта.

`~/.runz/config.md` — обычный mdz: корневые ключи (`$paths`, `$default_provider`)
видны как `ctx.get(['paths'])`; провайдеры — блоками `## $provider <имя>`
(`$type`/`$base_url`/`$api_key`/`$model`), читаются по id блока:
`ctx.get(['<имя>','base_url'])`. **`$default_provider` хранит id такого блока.**
Ведущий `~` в путях раскрывается в домашнюю директорию.

## Реестр — как runz находит скрипт по имени

Порядок: cwd (`./name.ts`, `.md`/`.mdz`/`.mdd`/`.mds`, `name/index.ts`) → проектный
`.runz/scripts/` (вверх от cwd) → `$paths` → встроенные → `~/.runz/scripts/`; первое
совпадение побеждает, локальный скрипт осознанно перекрывает встроенный. Аргумент с
`/`, `~`, абсолютный или с расширением — прямой путь без поиска.

**Документ вместо скрипта.** `$type` (или `--type=`) — имя `.ts`-скрипта в реестре:
runz зовёт его, кладя документ в `meta.doc` и `meta.program`. Так `runz task.mdz`
при `$type: code` уходит на appz `code`. Без `$type` документ исполняет себя сам —
ниже.

Хендлер документа зовётся `(ctx, meta, helpers)`: третьим аргументом — те же
`helpers`, что у in-file `## $handler` (llm/embed/image/attr/list/render/run, провайдер
и цепочка — те, что видит хендлер; `run(id)` грузит `fn` документа). Тип —
`DocumentHandlerFn` / `ProgramHelpers` из `@kerneldreams/runz-runtime`. Свою сборку через
`buildHelpers` + `resolveProvider` не делай (это низкоуровневый экспорт для хостов).
Виртуальный `--type` без документа — `helpers` нет.

**Зависимости.** Bare-импорт (в скрипте и в теле `fn` документа): `@kerneldreams/*` —
сначала из дистрибутива runz, дальше node_modules от файла-импортёра вверх (как голой
нодой: свой `node_modules/@acme/x` у скрипта вне runz находится), затем окружения
`.runz/node_modules` (от файла вверх, от cwd вверх → `~/.runz/`), затем node_modules
runz; `runz add <pkg>` ставит в окружение. Не нашлось — ошибка перечисляет реально
просмотренные `node_modules`. appz без `package.json` берут всё из дистрибутива runz.

**`@kerneldreams/runz-runtime` в хосте** (сайдкар приложения, сервисы плагинов): пакет ядра kd, `npm i
@kerneldreams/runz-runtime`; его зависимости — пакеты `@kerneldreams/*` той же версии. В рабочей области kd пакеты
ссылаются друг на друга версией; публикация — `scripts/publish.mjs` репы kd, не `npm publish` по пакету.

## Документ как программа

Без `$type` документ исполняется рантаймом runz — один механизм на четыре формата;
что запускать, объявляет файл: `## $handler <id>` (`%handler` в mds) — ts-тело
внутри документа; `$run: <id>` в корне или `--run=` — именованный `fn`; ни того ни
другого — **блокнот**.

Блокнот исполняет в порядке файла `## $step <id>` (то же даёт `$nr-auto: true` на
любом `fn`) и `## $shell`/`## $zx` через executor. Результат шага ложится в цепочку
под id блока — следующий видит его как `${one.output}`. Декларации
`source`/`template`/`data` готовы до первого шага. Документ, в котором нечего
исполнять, — ошибка, не тихий ноль.

Тело `fn` — модуль (capability `CodeLoader`, не `new Function`): импорты в нём
резолвятся как у файла рядом с документом. `export default` зовётся
`(ctx, meta, helpers)`; `export const fn` регистрируется для `${name(args)}`.

`helpers` (nrd ≥ 1.3): `attr(key)` — скаляр из цепочки строкой; ключа нет →
`undefined`, значение не скаляр (`$[…]`, объект) → **ошибка** с подсказкой, не тихий
`undefined`. `list(key)` — `$[a, b]` → `['a','b']`, скаляр → `[x]`, `$[]` → `[]`,
ключа нет → `undefined`. `render(id, data)` → messages (IArray в `data` на любой
глубине — ошибка с путём `data.a.b`: передавай `list()`/массив, nrd ≥ 1.5), `llm(messages, opts)`, `read`/`readTbl`/`write`/`exists`/`listDir`
(путь — только строка), `baseDir`, `log`, `run(fnId)`. Объект — через `ctx.get([key])`.
Недоверенный документ (`--untrusted` / `$nr-trusted: false`) тело не исполняет.

**Мета шагов для схемы пайплайна** (nrchat, вкладка «Схема» окна файла,
`nrchat.dev/specs/pipeline-graph-spec.md`): атрибуты блока `## $action <id>` перед
блоком кода. runz их не читает — `--run=<шаг>` и `helpers.run('<шаг>')` находят шаг как
прежде (тест в `runz/test/documents/documents.test.ts`).

| Ключ | Значение | Смысл |
|---|---|---|
| `$nr-needs` | список id шагов `$[a, b]` или одна строка `a` | шаг берёт результат этих шагов: связь `a → шаг` |
| `$nr-node` | `false` | шаг не нода (управляющий: `help`, `run`) |
| `$nr-title` | строка | подпись ноды; нет — `$nr-title` секции `## $form <id>`; нет — id |

Нужда на несуществующий шаг — без ноды-призрака, предупреждение у ноды; цикл
допустим. Правит связи вкладка точечно (`nr-md` `setAttr`/`removeAttr`), только в
файле, где лежат блоки шагов; тонкий рецепт `$[[base]]` — связи в базе.

`helpers.embed(texts, {model?, onProgress?})` → `Float32Array[]` (nrd ≥ 1.4) —
эмбеды с CAS-кешем: пространство — `opts.model ?? $embed_model` (алиас шлюза,
`embed/giga`; нет ни того ни другого — ошибка), провайдер — тот же, что у `llm`
(`$provider ?? $default_provider`; у провайдера нет `embed` — ошибка с его именем),
стор — sqlite в `$embed_dir ?? ~/.nr/embed`, один на процесс. Повторный текст в том
же пространстве сеть не трогает; механика и грабли (f16, нормализация) —
`platform.md`. Прогнано: `$provider: lgate` + `helpers.embed(['кот','собака','кот'])`
→ 3 вектора dim 1536.

`helpers.image(prompt, {model?, refs?, params?, out?, onProgress?})` → `{files, meta}` (nrd ≥ 1.8,
runz/240) — картинка(и) через провайдер хоста. Провайдер — `$image_provider ??
$provider ?? $default_provider` → блок `## $provider <имя>` (`resolveImageProvider` runtime):
`$type: bfl` → `bflImageProvider`, `nanogpt` → `nanogptImageProvider`, `google` →
`googleMediaProvider` (ключ AI Studio; блок `## $provider gemini` — `## $provider google` занят LLM
`$type: openai`), `vertex` → `vertexMediaProvider` (`$project`, `$location`, `$media_location`, токен
`gcloud auth application-default print-access-token`, путь — `$gcloud`; `gcloudToken` runtime) (`platform.md`),
`gate` → `gateMediaProvider` (llm-gate,: `$base_url` гейта и его ключ `$api_key`; модель —
алиас гейта `$output: image|video|audio` или `провайдер/модель`; задача на гейте, прогресс опросом),
`comfy` → `comfyImageProvider` (comfy-client: сервер — `$server` блока ?? `$server` ?? `$comfy`
цепочки, только строкой; шаблоны — `$templates` блока ?? `$comfy_templates` ??
`~/Studio/appz/comfy/workflows`, строка или список), `mock` → PNG 1×1 без сети (`params.n` —
сколько), другой тип — ошибка с именем типа. Модель — `opts.model ?? $image_model ?? $model`, нет —
ошибка. `refs` — пути от `baseDir` (`~` раскрывается) → байты по порядку. `out` — файл от
`baseDir`, расширение по MIME; N картинок — `name.png`, `name-2.png`…; без `out` —
`{dataDir}/image/{дата}/{время}-{n}.{ext}`. Рядом с каждым файлом — `<файл>.json`
(prompt, model, provider, params, refs, meta — провенанс). `onProgress` — события провайдера
как есть (у comfy — нода, шаги, превью); без него — строка в stderr на смену stage/status.
Ошибка провайдера всплывает `throw` с её `name` (`ModerationError`…). Провайдер резолвится
лениво — документ без картинок его не трогает. Батч с осями — appz `imagen`.

`helpers.video(prompt, {model?, frame?, lastFrame?, refs?, params?, out?, onProgress?})` и
`helpers.audio(prompt, {model?, refs?, params?, out?, onProgress?})` → `{files, meta}` (nrd ≥ 1.11,
media-gen-spec §5) — то же, что `image`, для моделей вида `video` / `audio`: модель — `opts.model ??
$video_model` / `$audio_model` (`$model` не подхватывается — это LLM), провайдер — `$video_provider` /
`$audio_provider`, затем как у картинок (`HelpersOptions.media(kind)` хоста; нет — `image`).
`frame`/`lastFrame` — первый и последний кадр (пути, как `refs`; вместе с `refs` — ошибка); без
кадров — text-to-video. Вид модели сверяется со схемой провайдера **до** генерации: картинка в
`helpers.video` — ошибка «вида image; бери helpers.image». Файлы — `.mp4` / `.mp3` по MIME, без
`out` — `{dataDir}/video|audio/{дата}/…`; провенанс с `kind`. Прогнано (10.10): `$video_provider:
gemini` + `veo-3.1-lite-generate-preview`, `frame: fox.jpg`, 4 с → mp4 + `.json`; `helpers.audio` на
`lyria-3-clip-preview` → mp3, `meta.text`.

Блок comfy в `~/.runz/config.md` — `## $provider comfyui` (`$type: comfy`), **не** `comfy`: блок
с id `comfy` по правилу id-lookup (nrd §8) затеняет корневой `$comfy`, который читают capability
`comfy` nrchat и appz. По той же причине группа/блок документа `## $… comfy` прячет `$comfy` от
`resolveImageProvider` — ошибка это называет.

Хостам (артефакт image-gen — Media Gen, сервис nrchat): `resolveImageProvider(ctx, name, kind?)` — явное имя,
`listImageProviders(ctx)` → имена блоков `## $provider` с `$type` bfl / nanogpt / comfy / google / vertex (по
цепочке хоста; `$provider` документа строкой затеняет блоки). Прогнано (07.10):
`$image_provider: nanogpt` + `flux-3/text-to-image` 1k → jpg, `meta.cost 0.05 usd`; `flux-3/edit`
с рефом; `$image_provider: comfyui` + `qwen21-edit` с рефом → ноды/25 шагов/25 превью в
`onProgress`, `meta.seed`. Раньше: `$image_provider: bfl` + `flux-2-pro` → jpg, 3 кредита.

`helpers.agent(opts?)` (runz) → агент в процессе (слот расширения `agent`): полный цикл
(тулы, картинки, `apply_patch`, компакция, рецепт), а не один вызов, как `llm`.
`agent.session({file|id, title?})` — сессия `.mds` pi/2 в `$out` (иначе папка документа);
её открывает стенд nr (`$sessions_dir`). У сессии: `run({text, images?, parent?, target?})`
→ `{lastText(), lastId, messages, recipe, usage}`, `swipe()` (вариант сиблингом),
`tag(id, {step, pass})` (мета узла — идемпотентность шагов), `branch(id)`,
`append(node)`, `history()` (дерево с `meta`), `meta(patch?)`. Провайдер и ключ — как у
`llm` (`$provider`, `~/.runz/config.md`; `mock` — заглушка); модель — `opts.model` →
`$agent_model` → `$model`. Профиль — `opts.profileDoc` → блок `## $agent` (атрибуты
профиля nr, тело — system) → `$agent: <имя|путь .mdz>`. Батч без человека:
`tool_approval` — `$tool_policy` профиля (`auto`), иначе `askDefaults`/`$agent_ask` по
имени тула, иначе отказ с причиной в ленте; `ask_user` — ответ из `$agent_ask` или ошибка
тула. Ранов разом — не больше `$threads` (default 4); агент закрывается по концу
`$action`. Тулы шага — `opts.tools` (`ToolDef`). Агента в открытом ядре нет — это слот расширения
`agent` (`runz-runtime` extensions): файл `agent.mjs` в `~/.runz/extensions/` (или в папке из
`$extensions_dir` / `KD_EXTENSIONS`), который отдаёт `createAgent` (и, если умеет, `cardCodec`); хост в
процессе — `registerExtension('agent', модуль)`; `RUNZ_BACKEND_NR=<путь к собранному пакету>` — то же
путём. Нет — ошибка `helpers.agent: агент … не установлен — нет расширения «agent»`. Картинку модель
видит, только если гейт отдаёт ей `input: image`. Пример — `fix-agent.mdz` пайплайна bot-fix.

`helpers.step(id, {part?, out?, icon?, title?})` → `end({out?, error?})` — шаг следа прогона
`run.trace.jsonl` внутри одного тела (части — персонаж, сид, плечо); с функцией третьим аргументом — шаг вокруг
неё. След пишется сам: шаги блокнота и `helpers.run(id)` — `step.*`, `helpers.llm` / `helpers.agent` — `llm`; файл —
`<$out>/run.trace.jsonl` или `.runz/runs/<время>/` у документа. Подробно — README `@kerneldreams/runz-runtime` § «След прогона».

Команды: `--cmd=debug`, `--cmd=tpl --template=<id>`, `--cmd=tpl_inspect`.

## Задачи — долгий прогон вне окна (`runz job`, `@kerneldreams/runz-run/jobs`)

Рецепт, который идёт минуты–час (bot-fix, генерация уровней, ферма), запускай
**задачей**, а не ребёнком своего процесса: задача — отдельный процесс (своя группа,
`detached`), переживает окно exz, вкладку, рестарт стенда; лог пишет сама. Реестр —
`~/.runz/jobs/<id>/` (`job.mdz` читается глазами, `log.ndjson`, `inputs/`); его же
видят панель «Задачи» nrchat (`?panel=jobs`, `exz --resident jobs`), формы и
артефакты (`__host.job`, `$uses: job`). `__host.run` — для коротких.

```bash
runz job start fix-core.mdz --source=https://example.com/… --out=elena     # задача; --now — мимо очереди
runz job start fix-core.mdz --source=@sources.txt --out=farm/{slug}     # пачка: задача на строку файла
runz job ls [--all] · runz job log <id> [-f] · runz job cancel <id> · runz job restart <id>
```

- **Лимиты** — `$jobs: {max: 6, limits: {gemini: 3, glm: 4, mac: 1}, resume_lost: true}` в
  `~/.runz/config.md`. Задача занимает общий слот и слот **каждого** своего ключа. Ключи —
  `--keys` → атрибут рецепта **`$job_keys: $[gemini]`** (с инклюдами) → имя рецепта. Ставь
  `$job_keys` по моделям шагов — иначе лимит по провайдеру не работает. `$job_timeout: 90m` —
  таймаут задачи (по умолчанию нет).
- **Рецепт задачи идемпотентен**: `restart` ставит новую задачу с теми же значениями и
  `inputs/` — рецепт продолжает с места по состоянию папки прогона. `lost` (обёртку убили
  kill -9 / машина) при `resume_lost` встаёт в очередь сам.
- **Папка прогона** — значение `out` (или `$out` рецепта) от `cwd` задачи: её панель
  показывает выходами (bot.md, check.md, картинки).
- Из кода — `start/list/get/attach/cancel/restart` из `@kerneldreams/runz-run/jobs`, планировщик —
  `scheduler()` (стенд держит его сам); подробности — README `kd/packages/runz-run`.

## appz — приложение на runz

appz = папка, которую запускают как `runz {name}`; лежит в каталоге из `$paths`.
Раскладка: `index.ts` (entry), `lib/` (чистая логика), `test/` (node:test),
`README.md`. **`package.json` не создавать** (исключение — appz, генерящий TS-код и
требующий `tsc --noEmit`); `docs/specs/` в appz не заводить — рабочая документация
не живёт в код-репе.

**Тесты обязательны**, гонять — `runz test [цель]`; правило и док-стандарт README —
в `conventions.md`.

### appz `pi` — `--serve`

`runz env.mdz` с `$type: pi` запускает pi-окружение; корневые атрибуты слепо уходят
флагами в pi, **кроме служебных** (`type`, `setup`, `bin`, `serve`, `port`, `cwd`,
`user`, `idle`, `base_path`, `services`, `nrchat`, `attachment_max`, `comfy`).
`--serve` (или `$serve: true`) поднимает вместо TUI бэкенд nr-ui-protocol для nrchat;
для него:

- `$services: artifacts, forms` — сервисы плагинов nrchat в процессе бэкенда: id →
  `<nrchat>/plugins/<id>/service.ts`, элемент с `/` — путь от папки mdz. Нет файла —
  ошибка старта. Грузятся при старте (прогрев): `jobs` держит резидентный
  планировщик задач машины. Каталог nrchat — `$nrchat`, иначе env `NRCHAT_DIR`, иначе
  `~/Studio/Projects/nrchat`.
- `$comfy: http://host:8188` — адрес ComfyUI для сервисов (видят его в `ctx`).
- `$attachment_max: 25MB` — лимит одного вложения (`KB`/`MB`/`GB` десятичные или число
  байт; дефолт бэкенда 2 МБ), бэкенд заявляет его в `/capabilities`.
- `$port` (дефолт 7800, `0` — свободный), `$idle` (`30s`/`15m`/`1h`), `$base_path`.
- `$auth_key` — ключ доступа к стенду: HTTP требует `Authorization: Bearer` (или
  `?auth=`), включая SSE, ACP ws — тоже; строка — ключ, `{keyRef: блок.атрибут}` — из
  `~/.runz/config.md`. Служебный, во флаги pi не уходит.

## Каркас файловой тулзы

`buildRuntimeContext(meta.file!, { params })` (см. `platform.md`) → IContext →
рендер/вызов → `{ output }`. Ошибку — в stderr и `{ exitCode: 1 }`, не
`process.exit`. Печатал сам в stdout (стрим) — возвращай `{}`. **Одиночный скрипт —
не appz:** каркас, README и `test/` требуются от appz в реестре, не от
`./one-off.ts`.

Типчек не обязателен (Node стрипает типы); нужен — `tsconfig.json` (`nodenext`,
`strict`, `allowImportingTsExtensions`), `typeRoots` и `paths` на дистрибутив runz.
