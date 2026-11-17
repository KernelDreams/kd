# $nr-extends: прозрачное наследование блока в лукапе (вариант C)

**Статус:** spec ready — closed. Решение принято 08.07 (диалог «Слоистые контексты», выбор C над A/B).
**Репо:** `S:\nrlib\nrd-core` (ядро) + `S:\Projects\runz` (инъекция загрузчика) + доки.
**Основание:** хвост C3 /. Ядро уже несёт механику (`blockSelf`/`selfScope`/`resolveBlockValue`/`ExtendsLoader`/кэш/цикл-гард — document.ts §291+), но она НЕ подключена к штатному лукапу: `doc.get(['preset','x','model'])` в базу НЕ проваливается. Фича мертва end-to-end.

## Цель (поведение)

Обычный лукап через `${block.key}` / `doc.get([block, key])` в блок с `$nr-extends` **прозрачно видит базу**: свои атрибуты > атрибуты базы (own-wins, база = дефолты). Наследование — свойство ФОРМАТА (живёт в лукапе, как last-wins §8), не вежливость потребителя. Это касается ЛЮБЫХ блочных данных: пресеты, описания эндпоинтов, ноды/шаблоны оркестратора, произвольные настройки — не только «пресетов».

Идентично по поведению отвергнутому варианту A, но **без порчи горячего пути `get`**: ветка живёт в `blockContext` (вызывается лениво, только на входе в блок), а не в `NRDocument.get`/`resolveName` (исполняется на каждом сегменте каждого пути).

## Архитектура (почему именно blockContext)

`blockContext(block, source)` (document.ts:97) — ЕДИНСТВЕННАЯ функция, разворачивающая Block в IContext. Все 6 её вызовов — внутри document.ts (resolveBlockName, collectionArray at/iterate, walk, NRDocument.resolveName). Значит `load` протягивается ЛОКАЛЬНО по document.ts, наружу публичных сигнатур НЕ течёт, кроме одной точки привязки — конструктор NRDocument.

`NRDocument.get`/`resolveName` и `blockContext.get` НЕ меняют свою логику пути — меняется только то, ЧТО `blockContext` возвращает для блока с `nr-extends`: вместо голого own-контекста — `chainContext(own, base)`.

## Работы

### 1. `blockContext` — ветка extends

Сигнатура: `blockContext(block, source, load?)`. Тело:
```
если у block есть атрибут nr-extends (extendsPath) И load передан:
    base = blockContext-подобный контекст из loadExtends(path, load).root  // база как блок
    вернуть чейнящий контекст: get(path) резолвит через chainContext(own, base)
иначе:
    текущее поведение (own-контекст)
```
Переиспользовать существующие `extendsPath`/`loadExtends` (document.ts:318/323) — не дублировать. own-контекст = текущая реализация blockContext; base-контекст строится из root загруженного NRDocument (его атрибуты + дочерние блоки как own-слой). own-wins: own первым в chainContext.

**Ключевой тест прозрачности** (которого нет — есть только resolveBlockValue-путь): загрузка через parseDocument с привязанным load, затем `doc.get(['preset','fast','model'])` возвращает значение из базы, если own не переопределил; own — если переопределил. НЕ через resolveBlockValue, а через штатный get.

### 2. Протяжка `load` по document.ts

- `NRDocument` конструктор: третий параметр `load?: ExtendsLoader`, хранить полем.
- `NRDocument.resolveName` → `blockContext(byId, this.source, this.load)`.
- `blockContext` внутренние вызовы (resolveBlockName, collectionArray, walk-переходы) — пробросить load дальше, чтобы вложенные блоки тоже наследовали. collectionArray/walk получают опциональный load-параметр.
- `parseDocument(text, opts?, load?)` — принять load, передать в NRDocument. Обратная совместимость: без load — текущее поведение (extends молча не активируется — НО см. §5, это должно быть видимо).

### 3. Инъекция загрузчика в runz

`parseDocFile` (runtime/loader.ts:40) уже строит fs-callback для includes (baseDir = dirname файла). Добавить симметричный `load` для extends тем же паттерном и передать в `parseDocument`:
```
const load: ExtendsLoader = (target) => {
  const p = path.isAbsolute(target) ? target : path.join(baseDir, target)
  return fs.readFileSync(p, 'utf8')  // fail loud — loadExtends оборачивает ошибку
}
return parseDocument(text, undefined, load)
```
Путь относительно документа-владельца — как в §11.3 канона.

### 4. Untrusted

Untrusted = загрузчик НЕ передан. `loadExtends` уже кидает «загрузчик не передан» (document.ts:327). Для untrusted это правильный fail loud: чужой документ с `$nr-extends: C:/secret` не читает файл. Проверить тестом: untrusted-цепочка + документ с nr-extends → ошибка, не молчание, не утечка.

### 5. Прозрачность неявности — ОБЯЗАТЕЛЬНАЯ часть, не после

Наследование невидимо в тексте блока (видишь 3 атрибута, движок подмешал 10 из базы) — это опасный класс. Условие таски, не пожелание:

- **format-spec §11.3** — дописать: «Прозрачность лукапа: штатная адресация `${block.key}` / `get([block,key])` видит унаследованные значения (own > база). Наследование активно, когда документ загружен с ExtendsLoader; без загрузчика `$nr-extends` не резолвится и обращение к унаследованному ключу — ошибка (fail loud), не молчаливый undefined.»
- **formats-guide.md §7** (skills/nr-system/sources) — в раздел про extends: пометка «прозрачно — обычная адресация видит унаследованное; если блок наследует, его реальные значения = свои + база, ищи `$nr-extends`». В чеклист ошибок — строку про невидимое наследование.
- **Диагностика:** `$nr-extends` остаётся ВИДИМЫМ атрибутом (`cast('attrs')`/`keys` его не прячут — уже так по nr-* правилу §2.2). Достаточно для dry/debug: видно, что блок наследует и откуда.

### 6. resolveBlockValue не удалять

Explicit-API (`resolveBlockValue`, `blockSelf`, `selfScope`) остаётся — self-scope с reader-цепочкой для свободных переменных (C1) нужен там, где значение резолвится об внешнюю цепочку. §1 (прозрачный лукап) и explicit-API сосуществуют: лукап даёт наследование значений, resolveBlockValue — полный self-scope с параметрами читателя.

## Критерии приёмки

- Новый тест прозрачности через `doc.get([...])` (не resolveBlockValue) зелёный: own-wins, база=дефолт, вложенный блок наследует.
- Untrusted-тест: nr-extends без загрузчика → fail loud.
- Все существующие тесты nrd-core (355) + self-extends conformance зелёные, ни один не изменён кроме явного расширения.
- runz: `parseDocFile` c extends-документом работает end-to-end; smoke — документ с `## $preset` + `$nr-extends` читается, `${preset.x.key}` резолвит базу. runz-тесты (37) зелёные.
- format-spec §11.3 и formats-guide §7 обновлены (§5 таски).
- tsc чистый в обоих репо.

## Запреты

- `NRDocument.get`/`resolveName`/`blockContext.get` — логику ПУТИ не менять, только возвращаемый для extends-блока контекст.
- `load` в публичные сигнатуры сверх parseDocument+NRDocument-конструктора не протаскивать.
- Legacy S:\libs не трогать. resolveBlockValue/blockSelf не удалять.
- Кэш: extendsCache УДАЛЁН (14.07 — кэш в ядре противоречит IO-free; кэширование — зона ExtendsLoader'а, рантайм мемоизирует свой loader сам). `loadExtends` парсит всегда; в границах одного вызова базу грузить один раз и пробрасывать (образец — resolveBlockValue после). Цикл-гард — есть, переиспользовать.
