# nrd — корень `@kerneldreams/nrd`

Портируемое ядро: ноль environment API (ни `node:`, ни fetch) — работает в Node,
браузере, Workers, GAS. Платформа — `platform.md`, шаблоны — `template.md`. Импорт
всегда из корня; `core`/`context`/`exec`/`infra` — слои внутри, не входы.

## Документ и IContext — три метода

```ts
const doc = parseDocument(text, { sigil: '$' })   // mdz; для mdd — { sigil: '@' }
doc.get(['name'])            // корневой атрибут
doc.get(['carly', 'age'])    // блок ## $person carly → его атрибут
doc.doc.root.children        // сырое дерево Block[]
```

`parse(text)` отдаёт голый `Document` без методов — **всегда `parseDocument`**: он и
есть IContext, а у IContext ровно три метода: `get(path)`, `func(name, args)`,
`cast(name)`. Фасадов не строй.

**`get` не раскрывает `${}`** — он только ходит по пути. `$greeting: ${upper(name)}`
приедет как InterpolatedValue (`asText` отдаст сырой текст плейсхолдера); значение
получаешь сам: `resolve(asText(v) ?? '', chain)` — см. ниже.

**Блок по ИМЕНИ всегда приходит коллекцией** — `IArray`, даже если блок один и даже
если у него есть id: `doc.get(['person'])` → IArray, звено — `.at(0)`. По id звено
приходит напрямую (`doc.get(['p1'])`), а сквозной путь работает и через коллекцию:
`doc.get(['person','name'])` → `'carly'` (прогнано).

**`cast` интерпретирует одно тело по-разному:** `text`, `lines`, `paragraphs`,
`prompts`, `records`, `attrs`, `keys`, `raw`, `messages`, `NRDocument`; неизвестный
каст → `undefined`, не ошибка.

### `asText` ≠ `toText`

`asText(v)` — **сужающий аксессор**: строка, если значение текстовое, иначе
`undefined` (для `?? fallback`). `toText(v)` — **полная коэрсия**: тело →
заголовочный хвост → json5-дамп. Прогон на `## $person carly` + `$age: 30`: `asText`
→ `""`, `toText` → `{age: 30}`; подмена утекает содержимым контейнера (в т.ч.
секретами блока провайдера) вместо честного «не текст».

## Резолв `${}` и цепочки

`resolve('Hi ${name}!', chainContext(objectContext({name:'Carly'}), funcContext(coreFunctions)))`
→ `'Hi Carly!'`; `\${name}` — opt-out, литерал. Звенья: `objectContext(rec)` —
JS-объект; `chainContext(a, b, …)` — цепочка, **первое сильнее**;
`funcContext(fns)` — функции (данных не даёт), хвостом;
`emptyContext`; `arrayValue(items)` — IArray. `coreFunctions` — чистая stdlib
(`if_else`, `not`, `eq`, `default`); truthy формата: `false`/`null`/`undefined`/`''`
— ложь. Своя функция — `FuncFn`, `(args, ctx) => Value`. `cartesian(axes, {order})` —
веер комбинаций по осям; `axes` — `Map<string, IArray>`, не объект. Оси из документа
(списки, таблицы, группы, достижимость) — `planBatches` из `nrd/batch` (`batch.md`).

### Резолв атрибута блока об его же соседей

`$greeting: ${upper(name)}` внутри `## $person` — частый случай, и одним `get` он не
делается. Канон — `resolveBlockValue`:

```ts
const block = doc.doc.root.children[0]
const fns = funcContext({ ...coreFunctions, upper: (a) => String(a[0] ?? '').toUpperCase() })
resolveBlockValue(block, 'greeting', { functions: fns })  // 'CARLY'
```

- `blockSelf(block)` — собственные атрибуты блока звеном (плюс база `$nr-extends`);
  `selfScope(self, opts)` — та же цепочка руками.
- `reader` — слой свободных переменных для голого `${name}`. По умолчанию это сам
  блок, так что пример выше работает без него; явный `reader` сильнее дефолта.
  `${self.name}` связан к блоку всегда.
- **`resolveValue(v, ctx)` по значению из `get` молча вернёт `''`** (прогнано):
  резолвится текст, `resolve(asText(v) ?? '', scope)`.

### Opt-out `\${` — сырой в контексте, свёрнутый на выходе

`ctx.get` отдаёт значение **сырым**: `$u: a \${b} c` → `a \${b} c` (nrd ≥ 1.5).
Эскейп сворачивают выходы — `resolve`/`resolveValue`/`get(path, ctx)`/
`helpers.attr`: `resolve('${u}', doc)` → `a ${b} c`, `b` не подставлен (прогнано).
Свой слой, который кладёт резолвленный текст **обратно в контекст**, резолвит с
`{ keepOptOut: true }` — иначе следующий проход подставит `${b}`; финальный текст
сворачивает `unescapeOptOut(s)`. Ведущий BOM в тексте не из кодека — `stripBom`.

## `buildContext` — mdz-конфиг → готовый IContext

`buildContext(text, opts)`. `opts`: `baseDir`, capabilities `storage`/`executor`/`http`
(из `nrd/node`), `functions` (всегда) и `privilegedFunctions` (fs/exec, только при
trusted), слои хоста `params`/`strongChain`/`weakChain`, `trusted` (default `true`),
`strictUntrusted`, `mode`. Порядок: parse → params → `$required` → `## $source` по
`$nr-type` → `## $transform` → chain; плагины `inline`, `env`, `file`, `json`,
`exec`, `script`. Каскад резолва деклараций — `params > strongChain (CLI) > атрибуты
документа > weakChain (конфиги) > env`.

**Главная грабля (прогнана): в результат входят ТОЛЬКО `## $source`-блоки.** Для
конфига `$app: demo` + `## $source data` (`$nr-type: file`, `$path: data.mdd`)
`ctx.get(['app'])` → `undefined` (корневой атрибут — слой резолва, не данные), зато
`ctx.get(['data','title'])` и плоское `ctx.get(['title'])` дают значение из файла.
Блок другого имени (`## $person`) источником не является и не попадёт в контекст
вовсе — такой документ читают `parseDocument`. Нужны корневые атрибуты — подложи
документ слоем: `chainContext(ctx, parseDocument(cfg))`.

**Trust-гейт.** При `trusted: false` (прогнано) source-блоки `exec`/`script`/`file`/
`env` пропускаются с warn (`strictUntrusted` — падают), `privilegedFunctions` не
подключаются, env вне цепочки — чужой документ только так. Без mdz-текста та же
сборка — `chainSources`, по дереву — `buildContextFromRoot`.

## `execBlock` — исполнение блока

`execBlock(block, { executor: spawnExecutor, baseDir })` → `Result<IContext>`. Блок
`## $shell` с `$who: world` и телом ```` ```echo hi ${who}``` ```` даёт
`asText(r.value.get(['content'])) === 'hi world\n'` (прогнано; `spawnExecutor` — из
`nrd/node`).

- Движок — из **имени блока**: `shell` | `ts` | `zx`, не из `$nr-type` (то другой
  словарь). **Fence обязателен**: три бэктика отделяют декларацию от тела.
- Атрибуты блока — block-local контекст резолва тела, бьют external; служебные
  (`$nr-parse`, `$cwd`, `$env.X`, `$timeout`, `$nr-raw`, `$nr-mode`, `$shell-bin`)
  туда не попадают, а `$nr-raw: true` вовсе отключает резолв тела.
- Результат: нативный `value` → как есть, иначе stdout по `$nr-parse`
  (`text` → `{content}`, `json`, `mdd`, `mdz`); `code ≠ 0` → `err` со stderr. Все
  блоки сразу — `execBlocks`.

## Result и прочее из корня

`ok`/`err`/`isOk`/`isErr` + `Result`/`AsyncResult` — **в корне, не в `/web`**: старый
`import { isOk } from '@kerneldreams/nrd/web'` падает на «does not provide an export
named». Оттуда же `generateId`, `resolveIncludes`, `serialize`, `parseTable`,
`toJson`/`fromJson`/`JSON_FORM_VERSION` (документ ⇄ JSON одной строкой, nrd ≥ 1.2;
`toJson` берёт и `NRDocument`, и `Document` — nrd ≥ 1.5.1; `formats.md`), `Json5ParseError`/`FlowParseError`. `nrd/format` — фасад кодека
(те же `parse`/`serialize`/`toJson` + `IncludeCycleError`) для кода, которому нужен
только текст ↔ структура.
