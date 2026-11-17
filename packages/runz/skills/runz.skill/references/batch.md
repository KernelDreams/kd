# nrd/batch — комбинаторика документа

`@kerneldreams/nrd/batch` (nrd ≥ 1.7.0, portable — ноль IO, как корень). Документ →
группы батчей → комбинации. Потребители: appz `comfy` (эталон), `imagen`. Спека —
`../../specs/batch-spec.md`. Свой парсер списков, BFS по `${}` и перемножение осей в
appz не писать — это здесь.

## Вызов

```ts
import { parseDocument } from '@kerneldreams/nrd'
import { readTextWithIncludes } from '@kerneldreams/nrd/node'
import { planBatches } from '@kerneldreams/nrd/batch'

const doc = parseDocument(readTextWithIncludes(file, undefined, '[app]', { fallbackDirs: [profilesDir] }))
const groups = planBatches(doc, {
  params: (layer) => fieldTexts(layer.texts),   // корни достижимости; нет — оси все списки
  strong: meta.chain?.strong,                   // CLI: схлопывает оси
  batches: ['cats'],                            // --batch=…; неизвестное имя — BatchError
  warn: (m) => process.stderr.write(m + '\n'),
})
for (const g of groups) for (const c of g.combos) resolve(raw, chainContext(c.ctx, strong, g.attrs, weak))
```

Инклюды хост раскрывает сам до вызова (в т.ч. внутри `## $batch`: инклюд в блоке даёт
атрибуты блока, last-wins).

## Что возвращает

`BatchGroup[]`, по порядку файла; документ без `## $batch` — одна группа, `id` undefined.

| Поле | Что |
|---|---|
| `id` | id группы (`## $batch cats` → `cats`) |
| `texts` | `Map` атрибут → сырой текст (`${}` цел), группа поверх корня, last-wins; точечные ключи тоже |
| `values` | IContext: атрибуты как разобраны (список — IArray, число — число), группа поверх корня |
| `attrs` | IContext переменных: бесточечные атрибуты + фенс-тела, группа поверх корня |
| `axes` | имена осей в порядке документа (корневые, затем свои) |
| `combos` | `{ ctx, labels, points, index }` |

`Combo.ctx` — слой точки: ось → точка (`cast('text')` = значение, `get(['label'])`),
колонки таблиц — простыми именами. Ставь его ПЕРВЫМ в цепочке резолва. `labels` — ось →
метка (`// label`, колонка `label`, иначе значение); `points` — точка как есть (метка
только явная — для имён файлов); `index` — с 1.

## Оси

- Блок со списком в теле — ось: `value // label`, комментарии `//` `#` `*` `` ` `` `---`
  `$//`, диапазон `a..b/step`. Тело в ```-фенсе — одно значение (попадает в `attrs`).
- Ось-таблица: тело tbl (первая строка с `|`, у всех строк то же число ячеек; иначе —
  список + `warn`). Строка = точка, колонки — переменные; типы `n:number`,
  `tags:list(;)` (список — IArray, в `${}` склеивается `, `); пустая ячейка — `''`.
- Достижимость (`params` задан): ось — список, на который ссылаются корни через `${}`
  транзитивно (бесточечные атрибуты, тела блоков). Лексер — `scanPlaceholders`, не
  regex: `${a.b}`, `${fn(x)}`, вложенные. Таблица — ось, если достижима хоть одна
  колонка; недостижимая колонка — `warn`. Колонка с именем другой оси — `BatchError`.
- `$order: a, b` (CLI `--order` сильнее) — первая самая медленная. Одноимённые блоки —
  последний.
- CLI с именем оси: точка по метке, затем по значению → ось из одной точки; список без
  совпадения уходит (значение берётся из сильного слоя), таблица — `BatchError` со
  списком меток. Колонка, заданная в CLI, в слой точки не кладётся (CLI сильнее).

## Группы

`## $batch <id>` — атрибуты блока — слой поверх корня; оси — `###`-дети; корневые оси
общие, одноимённая ось группы перекрывает. Каскад хоста: CLI > группа > корень >
профиль корня > конфиги — профиль, подключённый ВНУТРИ группы, часть слоя группы и
перекрывает корень (переменную задавай в группе после инклюда). `## $batch` без id —
`BatchError`.

Хост обязан ставить слой группы (`values`) **выше** своей цепочки запуска, не ниже: в цепочке
есть конфиг с блоками `## $provider`, и `$provider` группы иначе затенён (imagen до).
Так в одном документе группы идут на разные провайдеры — `$provider`/`$model` в группе
(imagen: `## $batch nano` на nanogpt, `## $batch qwen` на comfyui). Id группы не называй
именем корневого атрибута цепочки (`comfy`, `server`): id-lookup затенит атрибут.

## Ещё экспорты

`parseAxisBody(text, warn?, name?)` → `{kind: 'fenced'|'list'|'table', …}`,
`parseList`, `parseRange`, `extractFencedBlock`, `referencedNames(text)`, `BatchError`,
`BATCH_BLOCK`.
