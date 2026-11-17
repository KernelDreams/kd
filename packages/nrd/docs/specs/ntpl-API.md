# @kerneldreams/nrd/template

## main
extractNrd(template: string): ExtractResult
> Разделить шаблон на NRD-конфиг и тело.

- блок есть → `{ nrdBlock: <текст>, body: <шаблон без блока> }`
- блока нет → `{ nrdBlock: null, body: <шаблон как есть> }`

Текст блока возвращается с обрезанными краевыми переводами строк; ведущая
пустая строка, оставшаяся после удаления блока из тела, тоже убирается.
ExtractResult { nrdBlock, body }
createEnv(opts?: CreateEnvOptions): Environment
> Создать Nunjucks Environment с ntpl-делимитерами и встроенными фильтрами.
Loader инъектируется (portable); helpers добавляются поверх встроенных.
render(env: Environment, template: string, ctx: object | IContext): string
> Отрендерить тело шаблона поверх контекста.

IContext оборачивается `wrapContext` (Proxy с честным `ownKeys` через
`cast('keys')`) — Nunjucks копирует ключи через `Object.keys`, вложенность
раскрывается лениво. Plain-object передаётся как есть — для chat2/custom путей,
где данные уже в JS-форме.
nunjucksEngine(opts?: CreateEnvOptions | undefined): TemplateEngine
> Обёртка Nunjucks-движка под общий контракт `TemplateEngine`. `createEnv` и
`render` остаются экспортированными для обратной совместимости.
CreateEnvOptions { loader?, helpers? }
HelperRegistrar = (env: nunjucks.Environment) => void
TemplateEngine { name, render }
handlebarsEngine(): TemplateEngine
> Handlebars-движок (`TemplateEngine`). `noEscape: true` — ntpl рендерит не HTML,
экранирование не нужно (как `autoescape: false` у Nunjucks).

⚠️ ВНИМАНИЕ: Handlebars интерпретирует `{{...}}` ВЕЗДЕ, включая ЗНАЧЕНИЯ
контекста. В отличие от `nunjucksEngine` (делимитеры `<< >>` пропускают
`{{user}}`/`{{char}}` в данных нетронутыми), `handlebarsEngine` съест
Handlebars-синтаксис в данных. Это приемлемо для фолбэка старых SillyTavern-шаблонов
(там `{{char}}` — макрос, который и должен резолвиться), но НЕ для данных с
литеральными `{{}}` — они будут интерпретированы, а не выведены как есть.
resolveRoute(arg: string, sites?: SitePlugin[]): RouteResult | null
> Сопоставить позиционный аргумент с site-плагином → шаблон + params.

Режимы:
 - URL (`http(s)://…`) — матч по hostname; нет плагина → ошибка.
 - shorthand — первый `matchShorthand(arg)`.
 - иначе → `null` (значит: трактовать arg как прямое имя шаблона).

Файловый режим (arg — путь к существующему .ntpl) сюда не входит: это fs-логика
Node-слоя, который проверяет файл до вызова resolveRoute.
SitePlugin { name?, hostname?, parseUrl?, matchShorthand?, defaultTemplates?, accounts?, defaultAccount?, templatesDir? }
ParsedUrl { resource, path, account? }
RouteResult { template, params, site? }
registerSite(site: SitePlugin): () => void
> Зарегистрировать site-плагин (площадки — снаружи ядра); повтор с тем же `name` заменяет; возвращает отмену. `templatesDir` сайта попадает в `searchDirs`.
registeredSites(): SitePlugin[]
> Зарегистрированные site-плагины в порядке регистрации.
loadBuiltinHelpers(env: Environment): void
> Зарегистрировать все встроенные фильтры на env.
builtinHelpers: HelperRegistrar[]
section(content: unknown, header: unknown): string
> Извлечь тело markdown-секции `## Header` до следующего заголовка того же/высшего уровня.
json(value: unknown): string
> JSON.stringify с отступом 2.
yaml(value: unknown, indentLevel?: number): string
> Минималистичный YAML-подобный вывод (scalar / array / object, рекурсивно).
trimEmpty(text: unknown): string
> Схлопнуть 2+ подряд пустых строк в одну и обрезать края.
indent(text: unknown, n?: unknown): string
> Добавить отступ из n пробелов к каждой непустой строке.
registerCore: HelperRegistrar
unique(arr: unknown, key?: string | undefined): unknown[]
> Уникальные элементы (порядок первого вхождения). С `key` — дедуп по полю.
groupBy(arr: unknown, key: string): Record<string, unknown[]>
> Группировка массива объектов по значению поля → `{ groupKey: [...] }`.
sortBy(arr: unknown, key: string): unknown[]
> Сортировка массива объектов по полю (стабильная, по возрастанию).
pluck(arr: unknown, key: string): unknown[]
> Извлечь поле через массив объектов (как `| map(attribute="x")`).
join(arr: unknown, sep?: unknown): string
> Join массива (дефолтный разделитель ", ").
first(value: unknown): unknown
> Первый элемент массива/строки.
last(value: unknown): unknown
> Последний элемент массива/строки.
registerCollection: HelperRegistrar

## node
upwardDirs(startDir: string): string[]
> Директории от startDir вверх до stop-маркера (.git/.obsidian/.server) или корня.
searchDirs(startDir?: string): string[]
> Директории поиска шаблонов: `.ntpl/templates/` вверх от startDir + встроенные.
First-wins — локальный перекрывает встроенный (spec §6).
findTemplate(name: string, dirs?: string[]): string
> Найти файл шаблона по логическому имени (`example/page`) или пути.

Порядок: существующий файл-путь напрямую → поиск по dirs с расширениями
`''`/`.ntpl`/`.md`. First-hit wins. Бросает, если не найден.
nodeLoader(dirs?: string[]): FileSystemLoader
> Nunjucks-loader для `<{ include }>`/`<{ extends }>` — FileSystemLoader поверх
`.ntpl/templates/` upward + встроенных. Инъектируется в `createEnv({ loader })`.
discoverSites(startDir?: string): Promise<SitePlugin[]>
> Собрать site-плагины: локальные (`.ntpl/sites/`, ближе к startDir — раньше) +
зарегистрированные `registerSite`. Порядок = приоритет матчинга в resolveRoute (first-wins).
nodeCapabilities(baseDir?: string | undefined): { storage: IStorage; executor: Executor; http: HttpClient; }
> Готовый Node-комплект capabilities: fs + spawn + fetch одной строкой.

`storage` — `fsStorage(baseDir)`: `$path` в source трактуется относительно
baseDir. Передавайте тот же baseDir, что и в buildContext.