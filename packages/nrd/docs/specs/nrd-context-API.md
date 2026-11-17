# @kerneldreams/nrd

## main
buildContext(config: string, opts?: BuildContextOptions): Promise<IContext>
> Собрать IContext из mdz-конфига (§5.1).

1. parseDocument(sigil '$')
2. каскад params: opts.params > strongChain (CLI) > корневые атрибуты > weakChain (конфиги) > env
3. проверить `$required`
4. собрать SourceContext (baseDir, params, log + capabilities)
5. `## $source` → plugin по `$nr-type` → resolve → IContext (namespaced)
6. `## $transform` → plugin → transform(...)
7. chain(...) по `$chain` или порядку блоков
chainSources(specs: SourceSpec[], opts?: BuildContextOptions): Promise<IContext>
> Собрать chain без mdz-конфига: плагины и attrs передаются кодом. Code-плагин —
«богатый in-process» путь (возвращает живой IContext напрямую).
wrapContext(ctx: IContext): object
> Рекурсивный Proxy: IContext → обычный JS-объект (для шаблонизаторов).
Logger { debug, info, warn, error }
HttpClient { get, post }
SourceContext { baseDir, params, log, storage?, executor?, http?, chain? }
SourcePlugin { name, resolve }
TransformPlugin { name, transform }
noopLogger: Logger
builtinSources: Record<string, SourcePlugin>
ParseMode = 'text' | 'json' | 'mdd' | 'mdz'
parseRaw(raw: string, mode: ParseMode, chain?: IContext): IContext
> Распарсить сырую строку по режиму:
- text → `objectContext({ content })`
- json → `JSON.parse` → objectContext (массив/скаляр оборачивается в `{ value }`)
- mdd  → parseDocument(sigil '@')
- mdz  → parseDocument(sigil '$')

`chain` — внешняя цепочка резолва для `${}` внутри разобранного документа
(mdd/mdz): значения резолвятся лениво об `chain(документ, внешняя цепочка)`.
Не передана → документ резолвится только об себя.
parseMode(v: unknown): ParseMode
> Нормализовать значение `$nr-parse` к известному режиму (дефолт text; неизвестное имя — ошибка).
funcServiceContext(baseDir?: string): IContext
> Служебный контекст для `funcContext` — то, что `FuncFn` не выводит из аргументов (baseDir под ключом `FUNC_BASE_DIR`).
FUNC_BASE_DIR = '$baseDir'
BuildContextOptions { params?, baseDir?, storage?, executor?, http?, log?, plugins?, transforms?, functions?, trusted?, strictUntrusted?, strongChain?, weakChain?, paramsChain? }
> `strongChain` — слой сильнее атрибутов документа (CLI); `weakChain` — слабее
(конфиги, env). `paramsChain` — deprecated-алиас `strongChain`.
SourceSpec { name, plugin, attrs }

## builtins
inlineSource: SourcePlugin
envSource: SourcePlugin
fileSource: SourcePlugin
jsonSource: SourcePlugin
execSource: SourcePlugin
scriptSource: SourcePlugin

## node
nodeCapabilities(baseDir?: string): { storage: IStorage; executor: Executor; http: HttpClient; }
> Готовый Node-комплект capabilities: fs + spawn + fetch одной строкой.

`storage` — `fsStorage(baseDir)`: `$path` в source трактуется относительно
baseDir. Передавайте тот же baseDir, что и в buildContext.
fetchHttp: HttpClient