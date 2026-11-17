# Спека 2 — Движок / API (nrd-core)

**Статус:** черновик 2 (сведён из двух параллельных черновиков; базой взят `nrd-core-next`, конкретика реализаций перенесена из `nrd-core2`). TS-специфичная спека движка. Реализует формат из Спеки 1 (`format-spec.md`).
**Опирается на:** `format-spec.md` (Спека 1), `core-2.0-architecture-map.md` (v3).
**Предшественник:** `nrd-core-v3.md` (draft, большая часть решений перенесена и закрыта).
**НЕ описывает:** грамматику формата (Спека 1), схему (Спека 3), реализации llm/storage/провайдеров.
**Пакет:** `@kerneldreams/nrd` (этот пакет — следующая версия nrd-core, не отдельный `nrd-core2`).
**Дата:** 01.06.2026

---

## 1. Принципы

1. **Core не знает что такое Value.** `Value = unknown`. Core видит его только через интерфейс (get/func/cast).
2. **Композиция — не дело core.** Core принимает один IContext. Цепочки, fallback, провайдеры — клиентский слой через ChainContext.
3. **Lazy бесплатно.** Любая реализация IContext решает откладывать работу до обращения. Core не материализует.
4. **Минимальный публичный API.** Три метода на IContext, четыре на IArray.
5. **Парсер и резолвер — разные слои.** Парсер (Спека 1, §7.2) распознаёт `${}`, резолвер разрешает. Контракт между ними — структура плейсхолдеров (§3.1). Парсер НЕ разворачивает эскейпы `\${`; это финальный проход резолвера (§3.1).

---

## 2. Value / IContext / IArray

### Value

```ts
type Value = unknown
```

Open-ended. Core не ограничивает тип. Взаимодействие — через cast.

### IContext

```ts
interface IContext {
  get(path: Segment[]): Value | undefined
  func(name: string, args: Value[]): Value | undefined
  cast<K extends keyof CastMap>(name: K): CastMap[K] | undefined
  cast<T>(name: string): T | undefined
}

type Segment = string | number
```

- **`get(path)`** — значение по пути сегментов. `${user.email}` → `get(['user', 'email'])`. Число = индекс массива, строка = ключ объекта.
- **`func(name, args)`** — вызов функции. Args — уже разрешённые Value. Нет функции → undefined.
- **`cast<T>(name)`** — view на себя как другой тип. Не умеет → undefined. Имя каста — string, открытый набор.

### IArray

```ts
interface IArray {
  length(): number
  at(i: number): Value | undefined
  iterate(): Iterable<Value>
  cast<K extends keyof CastMap>(name: K): CastMap[K] | undefined
  cast<T>(name: string): T | undefined
}
```

Не наследник IContext. Позиционный доступ + итерация vs именованный доступ + функции. `cast` типизирован тем же CastMap, что и у IContext.

### CastMap (type-safe касты)

```ts
interface CastMap {
  text: string
  raw: string
  lines: IArray
  prompts: IArray
  paragraphs: IArray
  records: IArray
  attrs: IArray
  keys: string[]
  tbl: IArray
  messages: IArray
  IContext: IContext
  IArray: IArray
  NRDocument: NRDocument
}
```

Расширяется через module augmentation:
```ts
declare module '@kerneldreams/nrd' {
  interface CastMap {
    imageRaw: Buffer
  }
}
```

Open set сохраняется (fallback `cast<T>(name: string)`).

### Стандартные cast names

| Name | Returns | Когда реализовывать |
|---|---|---|
| `text` | `string` | значение подставляется в `${}` / нужен текст |
| `raw` | `string` | исходный сырой текст: документ → весь файл; блок → его исходный фрагмент (заголовок + атрибуты + тело) |
| `lines` | `IArray` | тело построчно, **все строки** без фильтрации |
| `prompts` | `IArray` | тело построчно, декоративные строки (`#`/`*`/`` ` ``/`//` в начале) игнорируются |
| `paragraphs` | `IArray` | текст, итерируемый по строфам |
| `records` | `IArray` | документ/блок → массив записей |
| `attrs` | `IArray` | атрибуты записи |
| `keys` | `string[]` | перечисление ключей верхнего уровня (enumeration: objectContext/chain/NRDocument). Для ${} НЕ используется — для wrapContext / Object.keys / итерации в шаблонах |
| `tbl` | `IArray` | тело как таблица (Спека 1, §5), декорация игнорируется |
| `messages` | `IArray` | тело как `%role`-лента nr-chat (§9) |
| `IContext` | `IContext` | cross-cast для walk (§4) |
| `IArray` | `IArray` | cross-cast для walk (§4) |
| `NRDocument` | `NRDocument` | identity-cast |

### Guards

```ts
function isScalar(v: unknown): v is string | number | boolean
function isContext(v: unknown): v is IContext    // duck: 'get' in v && typeof v.get === 'function'
function isArray(v: unknown): v is IArray        // duck: 'at' in v && typeof v.at === 'function'
function asText(v: unknown): string | undefined  // typeof → cast('text')
```

Ложноположительное (объект случайно имеет `get`) сужается тем, что `IContext.get` принимает `Segment[]`, не строку, + порядком проверки.

---

## 3. Резолвер

```ts
function resolve(text: string, ctx: IContext, opts?: ResolveOptions): string
```

Берёт текст с `${...}`, разрешает через ctx, возвращает результат. Для каждого `${expr}`: парсит форму → запрашивает через get/func → конвертирует Value в текст (§3.4) → подставляет.

### ResolveOptions

```ts
interface ResolveOptions {
  mode?: 'lenient' | 'strict'   // default: lenient
}
```

- **lenient:** не нашёл → литерал `${expr}` в выходе. Как v1.
- **strict:** не нашёл → throws. Для тестов и прода где литерал = баг.
- **Cycle detection — throws в обоих режимах.** Сломанные данные, не «не нашёл».

### 3.1 Контракт эскейпа `\${` (парсер ↔ резолвер)

`\${` — opt-out резолва (Спека 1, §2.5): «не разрешать этот плейсхолдер». Контракт между слоями:

- **Парсер НЕ разворачивает `\${`.** Значение, содержащее `\${`, хранится как InterpolatedValue с нетронутым `raw` (эскейпы НЕ свёрнуты) — даже когда «живых» плейсхолдеров ноль. Если бы парсер свернул `\${`→`${` сразу, значение стало бы обычной интерполяцией, и резолвер развернул бы его при первой же ссылке (рекурсия, §3.3) — opt-out молча сломался бы. Реализовано в `value.ts` (`hasOptOutEscape`).
- **Резолвер:** подставляет реальные плейсхолдеры → при ре-скане результата `\${` пропускает (не плейсхолдер) → финальный unescape `\${`→`${` **один раз, после того как вся рекурсия осела**.

Следствие: opt-out держится сквозь оба вида рекурсии (§3.3) и сквозь результат функции, а не только в исходном тексте.

**Значение, резолвнутое в контекст (добавлено 01.10.2026).** Атрибут, который сборка контекста резолвит заранее и кладёт обратно звеном (корневые атрибуты, атрибуты блоков, значения разобранного документа), — это ещё рекурсия, а не выход. Он резолвится с `keepOptOut: true` (`ResolveOptions`): живые плейсхолдеры подставлены, `\${` **не свёрнут**. Свёрнутое значение отдают только выходы: итог `resolve`/`resolveValue`, `get(path, ctx)`, хелперы-аксессоры (`helpers.attr`/`list`). `ctx.get` — сырой вид: `$u: a \${b} c` и `$u: "a \\${b} c"` одинаково дают `a \${b} c`, и `resolve('${u}', ctx)` = `a ${b} c` (не подставляет `b`). До plain-форма хранилась свёрнутой (`a ${b} c`) и оживала при следующей ссылке.

Ограничение грамматики: финальный проход сворачивает только `\${`, `\\` остаётся двумя символами. Поэтому «литеральный `\` + литеральный `${`» в NRD точно не выражается — данные с `\` прямо перед `${` (материализация шаблона в runz-run) несут лишний `\`.

### 3.2 Формы выражений

Парсер выражений — recursive descent (Спека 1, §7). Грамматика:

```
expr     = primary ('.' segment)*
primary  = path | call
path     = ident ('.' segment)*
call     = ident '(' args? ')'
segment  = ident | number
args     = arg (',' arg)*
arg      = string | number | bool | 'null' | expr
```

Аргументы: `"text"` / `'text'` → строковый литерал, `42` → число, `true/false` → bool, `null` → undefined, голый ident → путь, резолвится через `ctx.get`. Сегмент пути — `string | number` (оба: число → индекс массива, строка → ключ). Литеральная точка в имени сегмента — через `\.` (Спека 1, §7.1).

### 3.3 Рекурсия резолва

**Оба вида рекурсии включены по умолчанию:**

- **Вид 1 (по значениям):** `${a}` → значение содержит `${b}` → разворачивается дальше. Цепочки ссылок работают: `$x: ${y}`, `$y: ${z}`, `$z: hello` → `x` = `hello`.
- **Вид 2 (по результату функции):** `func()` вернула строку с `${...}` → резолвится. Composition через функции работает. (Меняет правило legacy-v3 «результат функции не резолвится» — код делал иначе и был прав.)

**Опт-аут — эскейп, не флаг.** Значение или результат функции, который должен остаться шаблоном, эскейпит свои `${` как `\${` (§3.1). Никаких режимов «не резолвить».

**Безопасность — НЕ дело резолвера.** Запрет рекурсии даёт ложную защиту (утечка одинакова через вид-1, вид-2 и через аргумент функции `${fetch(x, ${pwd})}`). Защита — на уровне контекста: секреты не в одном слое chain с недоверенным вводом + эскейп недоверенного ввода на границе.

**Cycle detection** ведёт set посещённых ключей текущей рекурсии. Повтор → throws `cyclic reference a -> b -> a`, в обоих режимах.

### 3.4 Подстановка Value в текст

1. `string` → as-is.
2. Value с `cast<string>('text')` → результат.
3. `IArray` → последний элемент `at(length-1)`, рекурсивно подставить (last-wins).
4. `IContext` → `cast('text')`. Не получилось → литерал / throw (по mode).
5. Иначе → литерал / throw.

---

## 4. Walk

Обход пути по сегментам. Сердце резолвера, тестируется отдельно — все ветки, все типы, оба режима.

```ts
function walk(val: Value, segments: Segment[], opts: ResolveOptions): Value | undefined {
  for (const seg of segments) {
    if (val === undefined || val === null) return undefined
    if (isScalar(val)) {
      if (opts.mode === 'strict') throw new Error(`cannot walk path: scalar at segment "${seg}"`)
      return undefined
    }
    if (isContext(val)) { val = val.get([seg]); continue }
    if (isArray(val)) {
      if (typeof seg === 'number') { val = val.at(seg); continue }
      const asCtx = val.cast<IContext>('IContext')        // имя на массив → cross-cast
      if (asCtx) { val = asCtx.get([seg]); continue }
      if (opts.mode === 'strict') throw new Error(`array does not support name segment "${seg}"`)
      return undefined
    }
    // unknown type → cross-cast в IContext / IArray по типу сегмента
    const c = (val as { cast?: (n: string) => unknown }).cast
    if (typeof c === 'function') {
      if (typeof seg === 'string') { const x = c.call(val, 'IContext') as IContext | undefined; if (x) { val = x.get([seg]); continue } }
      if (typeof seg === 'number') { const x = c.call(val, 'IArray')   as IArray   | undefined; if (x) { val = x.at(seg);  continue } }
    }
    if (opts.mode === 'strict') throw new Error(`unknown value type at segment "${seg}"`)
    return undefined
  }
  return val
}
```

Мягкая семантика (как JS path access) в lenient, видимые ошибки в strict. Cross-cast: массив + сегмент-имя → попытка `cast('IContext')`; контекст + сегмент-число → попытка `cast('IArray')`; не вышло → undefined / throw по mode.

---

## 5. ChainContext

```ts
class ChainContext implements IContext {
  constructor(private chain: IContext[]) {}
  get(path)  { for (const c of this.chain) { const v = c.get(path);  if (v !== undefined) return v } return undefined }
  func(n, a) { for (const c of this.chain) { const v = c.func(n, a); if (v !== undefined) return v } return undefined }
  cast(n)    { for (const c of this.chain) { const v = c.cast(n);    if (v !== undefined) return v } return undefined }
}
```

**First-hit** во всех трёх методах. Это parent-chain, реализованная снаружи движка как утилита.

**Serialization-касты (`text`/`raw`) — ChainContext возвращает undefined.** Причина: first-hit на `cast('text')` вернул бы текст первого звена, а нужен обычно текст документа. Кто хочет текст из цепочки — достаёт конкретное звено и кастует его: `chain.cast('NRDocument')?.cast('text')` (identity-cast first-hit найдёт документ → запрос текста у него). Подтверждено реальным кодом (потребители зовут `.cast('text')` на блоке/документе, не на chain).

Примеры chain (runtime собирает под себя):
- CLI: `[argvCtx, docCtx]`
- RP-бот: `[turnCtx, sessionCtx, characterCtx, docCtx]`
- Web: `[postCtx, sessionCtx, defaultsCtx, docCtx]`

---

## 6. NRDocument как IContext

`parse(text, opts): NRDocument`. Парсер из Спеки 1 (§1–§7) → NRDocument реализует IContext.

### Структура записи

Каждая запись: type (опц.), id (опц.), attributes (bag, повторы = массив), body (сырая строка, ключ `nr-body`), children (вложенные по уровням). Глобальный config документа — root-запись.

### Стандартные касты NRDocument

- `cast<NRDocument>('NRDocument')` → self
- `cast<string>('text')` → тело **как есть** (Спека 1, §6.2: декорация НЕ убирается; это НЕ join строф)
- `cast<string>('raw')` → исходный текст до парсинга
- `cast<IArray>('lines')` → тело построчно, все строки
- `cast<IArray>('prompts')` → тело построчно без декоративных строк
- `cast<IArray>('paragraphs')` → тело по строфам (markdown-aware split: внутри fenced code ``` пустые строки НЕ разделители)
- `cast<IArray>('records')` → все записи кроме root
- `cast<IArray>('attrs')` → атрибуты root
- `cast<IArray>('messages')` → тело как `%role`-лента nr-chat (§9)

Тело интерпретируется только по запросу каста — движок не парсит body как list/tbl/mdd, пока клиент не попросит (Спека 1, §6). `text` и `raw` различаются на всех уровнях и НЕ совпадают: `text` — только тело (как есть), `raw` — исходный сырой текст. Для документа `raw` — весь файл; для блока `raw` — его исходный фрагмент целиком (заголовок `## $name id`, атрибуты, тело), то есть тело (`text`) — лишь часть `raw`.

### Маршрутизация get

`get(['name'])`:
1. id записи в root-коллекции → IContext записи
2. имя type → IArray всех записей этого type
3. атрибут root → значение (string, или IArray если повторов несколько)
4. иначе undefined

`get(['type', 'id'])` → запись с type+id → IContext.
`get(['type', 'id', 'attr'])` → атрибут записи.

### Коллекции

Несколько блоков одного name — **всегда коллекция**, не ошибка. id опционален — адрес для инструментов, не свойство данных. Смешанно (часть с id, часть без) — валидно (Спека 1, §2.1).

### func

NRDocument.func() → undefined. Функции приходят через ChainContext (отдельный funcContext в chain, §8).

---

## 7. Fan-out (комбинаторика)

Портируемый слой НАД базовым резолвером. Базовый резолвер **схлопывает** (`resolve → string`, §3.4: IArray → последний), fan-out **разворачивает** (`${x}` по списку → N результатов).

```ts
function cartesian(
  collections: Map<string, IArray>,
  opts?: { order?: string[] }
): IContext[]
```

- **Вход:** именованные коллекции (из тела-cast, tbl, flow-литерала, результата `split()` — всё IArray).
- **Выход:** массив IContext, каждый = одна комбинация (по одному значению из каждой коллекции).
- **order:** какая коллекция «медленнее» (внешний цикл). Аргумент вызова; тулза берёт его из своих данных (`$order` у comfy). Движок про `order` не знает как про директиву — это tool-данные.

Тулза получает контексты и сама решает, что резолвить:
```ts
for (const combo of cartesian(collections, { order })) {
  const ctx = chainContext(combo, docCtx)
  const result = resolve(template, ctx)
  // ... делает своё (comfy workflow, SD batch, LLM prompt)
}
```

**Явный, без магии.** Авто-обнаружение достижимых списков (BFS по графу `${ref}`) — helper тулзы, не core.

---

## 8. Стандартные реализации

Core экспортирует:

```ts
// plain object → IContext
function objectContext(obj: Record<string, Value>): IContext

// цепочка → IContext
function chainContext(...ctxs: IContext[]): IContext

// пустой → IContext (singleton)
const emptyContext: IContext

// реестр функций → IContext (реализует только func)
function funcContext(fns: Record<string, FuncFn>): IContext
type FuncFn = (args: Value[], ctx: IContext) => Value | undefined

// массив → IArray
function arrayValue(items: Value[]): IArray
```

Без них каждый runtime пишет boilerplate. С ними — стандартизация поведения и DX.

### 8.1 Convenience API

```ts
// resolve с автооборачиванием Record → objectContext
function resolve(text: string, ctx: IContext | Record<string, Value>, opts?: ResolveOptions): string

// get с парсингом строкового пути и автооборачиванием контекста
function get(path: string | Segment[], ctx?: IContext | Record<string, Value>): Value | undefined
```

- `resolve`: `Record<string, Value>` автоматически оборачивается через `objectContext`.
- `get`: `path: string` парсится стандартным path-parser; `ctx: IContext` → `chainContext(ctx, doc)`; `ctx: Record` → `objectContext(ctx)` → chain.

80% потребителей с плоскими args не пишут `new ChainContext`.

---

## 9. Лента `%role` (nr-chat)

Собственного сплиттера у ядра нет: с 4.0.0 формат `%role` целиком
принадлежит `@kerneldreams/nrd/chat`, ядро только зовёт его `parse`.

Каждое сообщение — **IContext** над `ChatMessage`:
- `get(['role'])` — роль
- `get(['body'])` — тело сообщения (сырое, ` ```` `-зоны непрозрачны и остаются в теле)
- `get(['name'])` — имя из маркера, если есть
- `get(['meta', 'x'])` — JSON5-мета маркера (`%user {cache: true}`)

Два пути (один internal-код):
- `doc.cast<IArray>('messages')` — идиоматичный путь через cast; тот же каст есть у блока.
- `doc.split()` — метод на NRDocument, тот же разбор плоским списком.

Текст до первого маркера игнорируется; лента без маркеров даёт пустой массив.
Битая JSON5-мета маркера — `SyntaxError` наружу (fail loud).

**Ушло в 4.0.0:** `splitMessages`/`parseMessages`, типы `Message`/`ContentBlock`,
поля `content`/`blocks` у сообщения, атрибуты вида `%user $name: Bob` и
` ````%type `-блоки. Атрибуты сообщения теперь — JSON5-мета маркера.

---

## 10. Body-парсеры

### Стандартные касты тела

- `text` — тело как есть (Спека 1, §6.2: декорация НЕ убирается).
- `lines` — построчно, **все строки** без фильтрации (безопасно для любого контента — промпт, начинающийся с `*`/`#`, не теряется).
- `prompts` — построчно, декоративные строки (`#`, `*`, `` ` ``, `//` в начале) игнорируются. Конвенция генеративок/comfy.
- `paragraphs` — по пустым строкам (markdown-aware: внутри fenced code пустые строки не разделители).
- `tbl` — таблица (Спека 1, §5); декоративные строки игнорируются.
- `mdd` — вложенный mdd-документ.
- `messages` — `%role`-лента через nr-chat (§9).

`lines` vs `prompts`: исторически `lines` резал декорацию — это был footgun для контента. Разведено: `lines` честный (всё), `prompts` режет декорацию явно по запросу.

### Кастомные body-парсеры

`$nr-body-parser: <name>` / `$nr-default-body-parser: <name>` (Спека 1, §6.4).

Именованный парсер из реестра. Нативная реализация per-язык, **непортируемая**. Escape hatch для tool-специфики (comfy-list, etc.).

---

## 11. Портируемость

**Портируемое ядро** (TS → Python → C# → PHP):
- IContext / IArray / Value (как интерфейсы / duck-typing)
- Резолвер (resolve + walk), контракт эскейпа `\${` (§3.1)
- Коэрсия (Спека 1, §3)
- Парсер (Спека 1, §1–§7)
- Guards (isScalar/isContext/isArray/asText)
- ChainContext, objectContext, arrayValue, funcContext, emptyContext
- Fan-out (cartesian)
- Стандартные касты тела (lines/prompts/paragraphs/tbl/mdd)
- ResolveOptions, cycle detection, стандартные cast-имена (как конвенция строк)

**TS-only** (не портируется):
- CastMap + module augmentation (TS-специфика типизации; в Python касты типизируются иначе или динамически)
- NRDocument полная реализация (Python пишет свою)
- Кастомные body-парсеры (нативные per-язык)
- Splitter (нативный, если нужен)
- Convenience перегрузки (resolve/get)

Поведение не различается — рантайм-дискриминатор везде `name`-строка; различается только статическая типизация.

**Conformance:** поведение резолвера и walk тестируется языко-нейтральным корпусом (вход: текст + контекст-как-JSON → выход: результат). Любые два порта на одном входе дают одинаковый результат.

---

## 12. `nr-*` мета-атрибуты

Зарезервированный namespace (Спека 1, §2.2). Атрибуты с префиксом `nr-` — директивы движка / служебные ключи, не данные.

Определённые в этой спеке:
- `nr-body` — ключ тела в каноническом JSON (Спека 1, §10.2)
- `nr-parts` — ключ интерполированного значения в каноническом JSON (Спека 1, §10.2)
- `nr-body-parser` — именованный body-parser для блока (§10)
- `nr-default-body-parser` — body-parser по умолчанию для документа (§10)

Набор расширяется. Пользовательские ключи не должны начинаться с `nr-`.

---

## Что НЕ в этой спеке

- Грамматика формата (Спека 1)
- Схема / JSON Schema extensions (Спека 3)
- Стандартный реестр функций (each/join/first/last/loadFile/map/if) — runtime
- Runtime-специфика (CLI, web, runz) — клиентский слой
- Файловые ссылки (`$[[]]`, `@[[]]`) — синтаксис в Спеке 1 (§2.6); резолв (чтение файла, callback, рекурсия) — TODO в этой спеке
- Legacy-адаптер v1→v3 — отдельная забота при миграции
- Реализации провайдеров/storage — отдельные либы

---

## Открытые пункты

1. **Имя метода `cast` vs `as`** — оставлено `cast` (усвоено, не противоречит JS-семантике). `as` идиоматичнее для TS; если менять — глобальный rename, дёшево до реализации.
2. **Serialization-касты (R1):** `cast('text')` возвращает `string`, не Value. Гарантирует отсутствие цикла. Распространяется на `text`, `raw`. Зафиксировано конвенцией; формализация в CastMap опциональна.
3. **Cast идемпотентность (R2):** `cast(name)` дважды → то же значение. Соглашение, не enforced; реализация может кэшировать, lazy-инициализация (чтение файла/БД) — только при первом cast, без side effects кроме чтения внешних ресурсов.

**Закрыто при сведении:** convenience `get` (§8.1) — реализовать (сигнатура зафиксирована). Имя метода каста — `cast`. Семантика `text` у NRDocument — «как есть», не join строф (§6).
