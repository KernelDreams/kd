# template — `@kerneldreams/nrd/template`

Ступень шаблонов, портируемая: движок и loader инъектируются, модуль грузится и в
браузере. Node-часть (загрузка с диска) живёт в `nrd/node`.

## Делимитеры — почему не стандартные

```
<{ tag }>      блок/управление      <{ for x in list }> … <{ endfor }>
<< var >>      подстановка          << user.name >>
<# comment #>  комментарий
```

Nunjucks с ntpl-делимитерами. **`{{...}}` в данных проходит СКВОЗЬ нетронутым** — это
и есть причина их смены: карточки и промпты полны `{{char}}`/`{{user}}`. `${}` — тоже
не его синтаксис: это резолв nrd, он отрабатывает раньше.

## Движки — async и optional peers

```ts
import { nunjucksEngine, handlebarsEngine } from '@kerneldreams/nrd/template'
import { objectContext } from '@kerneldreams/nrd'

const engine = await nunjucksEngine()          // ASYNC — движок грузится лениво
engine.render(body, objectContext({ name: 'Carly', list: ['a', 'b'] }))
```

`TemplateEngine` (тип экспортируется из `nrd/template`) — весь контракт:

```ts
interface TemplateEngine {
  readonly name: string
  render(template: string, context: IContext | object): string
}
```

**`nunjucks` и `handlebars` — optional peers, ставит их потребитель.** Пакет их не
тянет: импорт `nrd/template` обязан работать без установленного движка, а отсутствие
бьёт по **вызову** и текстом:

```
nrd/template: движок "nunjucks" не установлен. Это optional peer — добавьте его
в зависимости проекта: npm i nunjucks (…)
```

Оборачивай `await nunjucksEngine()` в try/catch и показывай сообщение как есть — оно
уже говорит, что делать; свой текст «ошибка рендера» эту информацию уничтожает.

`handlebarsEngine()` — фолбэк для старых шаблонов SillyTavern на `{{char}}`/`{{#each}}`.
**Внимание:** Handlebars интерпретирует `{{...}}` ВЕЗДЕ, включая значения контекста;
для данных с литеральными `{{}}` не годится. `createEnv(opts)` (тоже async) и
`render(env, template, ctx)` — низкий уровень, если нужен сам `nunjucks.Environment`.

## Мост IContext → шаблон

`render(templateText, ctx)` берёт **текст шаблона** (файл читаешь сам) и IContext
напрямую: внутри `wrapContext` — Proxy с `ownKeys` через `cast('keys')`, вложенность
раскрывается лениво; plain-объект идёт как есть.

**Грабля (прогнана): коллекция одноимённых блоков до шаблона не доезжает.** У mdd с
`## @person carly` и `## @person max` в коде `ctx.get(['person'])` — IArray длины 2,
а в шаблоне `<{ for p in person }>` даёт ноль итераций, `<< person | length >>` → 0:
`cast('keys')` перечисляет id блоков (`carly`, `max`), имени коллекции среди них нет.
Итерируй flow-список (`@members: @[Carly, Max]` — работает) или готовь массив в коде
и передавай plain-объектом.

## `<{ nrd }>` — конфиг внутри шаблона

Шаблон может нести свой mdz-блок между `<{ nrd }>` и `<{ endnrd }>`; `extractNrd(tpl)`
→ `{ nrdBlock, body }` вырезает его ДО рендера и допускает **один раз в корневом
шаблоне** (дошёл до компиляции — понятная ошибка guard-расширения).

## Хелперы

Встроенные фильтры: `section`, `json`, `yaml`, `trimEmpty`, `indent`, `unique`,
`groupBy`, `sortBy`, `pluck`, `join`, `first`, `last`. Свои — через `helpers`
(его берут и `createEnv`, и `nunjucksEngine`):
`createEnv({ helpers: [(env) => env.addFilter('slug', slugify)] })`.

## Загрузка с диска — это `nrd/node`

```ts
import { nodeLoader, findTemplate } from '@kerneldreams/nrd/node'
const engine = await nunjucksEngine({ loader: nodeLoader() })
const file = findTemplate('site/character')     // логическое имя → путь
```

`searchDirs(startDir)` — `.ntpl/templates` вверх по дереву плюс встроенные шаблоны
пакета; `findTemplate(name, dirs?)` берёт существующий путь напрямую, иначе ищет по
dirs с расширениями `''`/`.ntpl`/`.md` (first-hit wins, не нашёл — бросает). Loader
нужен только для `<{ include }>` / `<{ extends }>`. Шаблон по произвольному пути
(свой `.njk` в `meta.dataDir`) через `findTemplate` не ищут — читают файл
(`readTextSync` из `nrd/node` или `node:fs`) и отдают текст в `render`.

## Роутинг и sites

`resolveRoute(arg, sites)` → `{ template, params, site }` — выбор шаблона по URL
(матч по hostname плагина) или shorthand; `params` уезжают в контекст как
`${resource}`, `${path}`. Плагин — `SitePlugin`, встроенные — `builtinSites`,
дисковые — `discoverSites` (`nrd/node`); нет плагина под hostname — бросает.

Канон: `docs/specs/ntpl-spec.md` в репе `nrd`.
