# nr-web — спецификация

**Статус:** черновик 3 (ревью 2 учтён: §2.3/§2.4 переставлены, url не фильтруется по origin, helpers.fetch = голый fetch, challenge в границах). Закрытая спека под реализацию.
**Пакет:** `@kerneldreams/web` (`S:\nrlib\nr-web`). Приватная либа — публикуется только в приватный Gitea-registry, НЕ в public.
**Назначение:** доставка HTTP-запросов к произвольным (в т.ч. недокументированным) веб-API + управление живыми Chrome для доставки и девтулз-интроспекции. Нижний слой веб-инфраструктуры: несёт байты, не осмысляет их.
**Опирается на:** `@kerneldreams/nrd` (Result, HttpResponse-типы, парсинг профилей-mdz, IContext, `$[[include]]`, cast). До 08.09 это были `@kerneldreams/nrd/web` и `@kerneldreams/nrd`.
**НЕ описывает:** формат протокола API (golden-sample/схема/официальный SDK — слой контракта поверх), домен (боты/CCv3/блоги/реддит — клиент ещё выше), парсинг тел ответа (JSON/XML/HTML — потребитель).

---

## 0. Ментальная модель (читать первой)

Три оси работы с чужим API — **ортогональны**, комбинируются свободно. nr-web занимает **только нижнюю**.

| Ось | Отвечает на | Где живёт |
|---|---|---|
| **Транспорт** (nr-web) | *как физически долетает запрос* — TLS, сессия, фингерпринт | эта спека |
| Контракт | *что посылать и что значит ответ* — официальный SDK / JSON-схема / golden-sample TOON | слой поверх nr-web |
| Домен | *что это значит в моём мире* — бот(CCv3)/пост/коммент/глава | клиент, ещё выше |

**nr-web несёт сырые байты и ничего не осмысляет.** Вход — запрос, выход — байты ответа (текст — частный случай; бывают картинки, музыка, видео). Что за формат в теле (JSON, XML, HTML, бинарь), как его парсить — **не дело nr-web**. Парсинг, TOON-представление, маппинг полей, схемы — всё этажами выше.

**Две сущности внутри nr-web, оба доменно- и контракт-нейтральны:**

1. **Универсальный интерфейс доставки** — `deliver(request) → response`, где тело — байты. Одна форма для всего.
2. **Именованные адаптеры доставки** — описывают *способ доставки* (транспорт) к конкретному эндпоинту/семейству, попутно решая авторизацию. Внутри адаптера сидит выбор «как» (голый fetch / живой Chrome), но снаружи адаптер выглядит одинаково — тот же `deliver`. Адаптер = mdz-профиль (конфиг + опционально скрипт).

**Девтулз — сосед доставки в той же либе, не её часть.** Доставка *исполняет* (пошли запрос). Девтулз *наблюдает/интроспектирует* (что этот Chrome делает, какие куки, что улетело в сеть). Оба стоят на общих кирпичах (управление Chrome + CDP-клиент), но это два разных публичных API с разными потребителями: доставка → адаптеры; девтулз → человек и разведка (питает golden-sample контракт-слоя). Пуповина одна (тот же CDP к тому же авторизованному Chrome) — потому один пакет; направление разное — потому два API, не один класс.

**Гранулярность адаптера — эндпоинт/семейство, не сайт.** Один сайт может дать несколько адаптеров: `craveu-api` (JSON, cdp+JWT) и `craveu-upload` (multipart в S3, cdp+presigned) — физически разные доставки при одном сайте. Резать по «как доставляется», не по «чей домен».

---

## 1. Транспорты

Транспорт — реализация «как физически долетает запрос». Выбор транспорта — **свойство адаптера** (поле `$transport` в mdz-профиле), не переключатель в коде потребителя. Потребитель берёт именованный адаптер — тот сам знает свой транспорт.

### 1.1 `fetch` — голый HTTP

`globalThis.fetch` (undici, Node 18+). Для сайтов с токеном или без защиты. Дефолт, самый лёгкий. Класс площадок вроде REST-API ботов: `Authorization: Bearer`, обычный REST — этого достаточно, Chrome не нужен.

### 1.2 `cdp` — доставка через живой Chrome

`fetch`, выполняемый **внутри живого Chrome** через CDP (`Runtime.evaluate` с `awaitPromise`), в контексте вкладки на origin площадки (§4.6). Для сайтов, где голый fetch палится или нужна настоящая браузерная сессия: Cloudflare/DataDome (JA3/JA4-фингерпринт), chunked-cookie auth (Supabase JWT), проверка порядка заголовков. crushon-класс.

Ключевое: это **настоящий Chrome**, не имитация. TLS-рукопожатие, HTTP/2-отпечаток, cookie-контекст — браузерные по построению, потому что это и есть браузер. Уровни защиты «сервер палит не-браузер по фингерпринту» (3A) и «данные рождаются в браузере» (3B) закрываются даром — имитировать нечего.

### 1.3 Расширяемость

Контракт транспорта (§2.1) допускает будущие реализации (напр. `impersonate` — curl-impersonate для Cloudflare без нужды в живой сессии) без изменения интерфейса. `$transport` — открытая строка (§2.3), не закрытый union, ровно ради этого. В v1 реализуются **только `fetch` и `cdp`** — они покрывают известные потребности (bots требует fetch, crushon требует cdp). Прочее — по факту встречи, контракт готов.

---

## 2. Интерфейс доставки

### 2.1 Типы

```ts
/** Тело — байты. Текст декодируется потребителем при нужде. */
type Body = Uint8Array

interface WebRequest {
  method: string                          // GET/POST/PUT/...
  url: string
  headers?: Record<string, string>
  body?: Body | string | MultipartBody    // string → utf-8 bytes; MultipartBody → §4.4
}

interface WebResponse {
  status: number
  headers: Record<string, string>         // для cdp — урезаны, см. §2.4
  body: Body                              // СЫРЬЁ. Не парсится, формат неизвестен.
}

/** Multipart-запрос: части собираются в FormData на стороне транспорта (§4.4). */
interface MultipartBody {
  kind: 'multipart'
  fields: Record<string, string>          // текстовые поля формы (порядок сохраняется)
  file?: { field: string; bytes: Body; filename: string; mime: string }
}
```

**`body: Uint8Array`, не строка.** Ответ может быть картинкой/видео/аудио/бинарём. Текст — частный случай: потребитель декодирует `new TextDecoder().decode(res.body)` когда знает, что там текст. nr-web формат не предполагает.

Удобные декодеры-хелперы (не часть контракта транспорта, а сахар потребителю):
```ts
function asText(res: WebResponse): string          // TextDecoder utf-8
function asJson<T>(res: WebResponse): Result<T>     // asText → JSON.parse, невалидный JSON → err
```
`asJson` возвращает `Result` (предсказуемая ошибка через Result, как в nr-infra HttpResponse.json).

### 2.2 Транспорт как интерфейс

```ts
interface Transport {
  deliver(req: WebRequest): AsyncResult<WebResponse>
}
```

`AsyncResult` из nr-infra. Предсказуемые ошибки доставки (сеть, таймаут, Chrome недоступен, CDP-ошибка) → `err`, не throws. Единая модель с nr-infra.

Реализации:
```ts
function fetchTransport(): Transport
function cdpTransport(opts: CdpTransportOptions): Transport
```

`fetchTransport` — stateless, обёртка undici, `body` в/из Uint8Array.
`cdpTransport` — держит связь с живым Chrome (§4), доставляет через `Runtime.evaluate(fetch)` на вкладке origin. Опции — §4.

### 2.3 Адаптер доставки

Адаптер — это **mdz-профиль (§3) + собранный из него `Transport`**. Публичный вход потребителя:

```ts
function loadAdapter(profileName: string, roots: string[]): AsyncResult<Adapter>

interface Adapter {
  /** Доставить запрос через транспорт и auth этого адаптера. Прозрачно ре-аутит один раз при 401/403 (§3.4). */
  deliver(req: WebRequest): AsyncResult<WebResponse>
  readonly domain: string
  readonly transport: string              // 'fetch' | 'cdp' | будущее; открытая строка (§1.3)
}
```

`loadAdapter`:
1. Ищет `<profileName>.mdz` по набору корней `roots` (§3.3).
2. Парсит через nrd-core, резолвит `$[[include]]` (базовый конфиг площадки).
3. По `$transport` собирает нужный `Transport`.
4. Готовит auth: для `fetch` — заголовки из полей профиля; для `cdp` — привязку к Chrome-профилю (§4). Если есть `## $auth`-скрипт (§3.4) — вынимает и держит для применения.
5. `Adapter.deliver` = навесить auth на запрос → `transport.deliver` → при 401/403 ре-аут+повтор один раз (§3.4).

**Потребитель НЕ выбирает транспорт и НЕ знает про auth.** Он строит `WebRequest` (метод, url, тело) и зовёт `adapter.deliver`. Токены, cookie, TLS — внутренность адаптера.

### 2.4 Ограничение заголовков ответа для cdp

Для `fetch`-транспорта `WebResponse.headers` полные. Для `cdp`-транспорта — **урезаны браузером**: in-page fetch отдаёт только заголовки, доступные через `Response.headers`. `Set-Cookie` **не читается никогда** (браузер его прячет от JS). Cross-origin-заголовки — только expose-listed. Контракт-слой поверх cdp НЕ должен рассчитывать на `Set-Cookie` в ответе — если нужны куки, брать их через девтулз `cookies()` (§5) или из auth-скрипта. Это ограничение природы cdp (fetch внутри браузера), не баг.

---

## 3. Профиль — mdz-адаптер

Адаптер описывается **mdz-документом** (формат nrd-core, sigil `$`). Профиль несёт: домен, транспорт, поля авторизации, опционально inline-скрипт auth. Профиль — данные (+иногда скрипт), не код.

### 3.1 Расположение и наследование

Профили — вне либы, в `S:\profiles\<domain>\<name>.mdz`. Либа про конкретный путь не знает — принимает **набор корней** (§3.3) и ищет.

**Наследование через `$[[include]]`.** Базовый конфиг площадки — отдельный файл, профили инклудят его и дописывают своё:

```
# S:\profiles\bots\_base.md  — базовый конфиг площадки (без секретов)
$domain: bots
$transport: fetch
$base: https://api.bots.example/...
$auth-header: Authorization
$auth-scheme: Bearer
```

```
# S:\profiles\bots\julian.mdz  — конкретный аккаунт
$[[_base.md]]
$token: sk-...
```

Десять аккаунтов площадки = десять трёхстрочных профилей над одним `_base.md`. Меняется API площадки → правится `_base.md` один раз → все профили получают через инклуд. Механика инклуда — из nrd-core (`$[[path]]`, резолвится инъектируемым загрузчиком, format-spec §2.6), **не реализуется здесь заново**.

**База — `.md`, профили — `.mdz`. Намеренно:** база не является профилем (это фрагмент для инклуда), потому не должна находиться поиском профилей. Расширение `.md` + правило «поиск игнорирует `_*`» (§3.3) — двойная защита: `_base.md` не подхватится как аккаунт ни по имени, ни по расширению.

### 3.2 Поля профиля по транспорту

**Общие:**
- `$domain` — имя площадки (строка). Обязательно.
- `$transport` — `fetch` | `cdp` | будущее. Обязательно.

**Для `$transport: fetch` (auth = навешивание заголовков):**
- `$auth-header` — имя заголовка (напр. `Authorization`).
- `$auth-scheme` — префикс значения (напр. `Bearer`), опционально.
- `$token` — секрет. Лежит в профиле ИЛИ в соседнем `.env` (если профиль пушится в репу и секрет нельзя в гит — профиль ссылается на env через `${sys...}` или `$[[.env]]`, выбор per-профиль).
- Собранный заголовок: `<auth-header>: <auth-scheme> <token>`.

**Для `$transport: cdp` (auth = живой залогиненный Chrome):**
- `$user-data-dir` — папка Chrome с залогиненной сессией (напр. `D:\ChromeDev\craveu-julian`). Существующая залогиненная папка переиспользуется напрямую — указал путь, Chrome поднимется на ней.
- `$port` — **фиксированный** порт remote-debugging (напр. `9333`). Фиксирован, не динамический (§4.2 — почему).
- `$origin` — **origin площадки** (напр. `https://craveu.ai`). **Обязательно для cdp.** In-page fetch исполняется в контексте вкладки; вкладка обязана быть на origin площадки, иначе cross-origin — тело ответа не читается (CORS), same-origin cookie не поедут. supervisor гарантирует вкладку на этом origin (§4.6). Обычно в `_base.md` площадки, не в каждом аккаунте.
- `$chrome-flags` — доп. флаги запуска (напр. `--allow-file-access-from-files --disable-web-security`), опционально. Список/строка флагов.
- `$cdp-credentials` — `omit` | `include` (дефолт по площадке). Режим credentials для in-page fetch (craveu хотел omit, crushon include — потому поле). Опционально.
- Путь к `chrome.exe` — общий, из `_base.md` или sys-цепочки (`${sys.chrome.exe}`), не дублируется в каждом профиле.

Профиль НЕ хранит готовую строку команды запуска — только поля, из которых команда собирается (§4.3). Плоские именованные ключи, не слитная строка (дух nrd-core: подменить путь к Chrome централизованно, переиспользовать флаги).

### 3.3 Поиск профиля

`loadAdapter(name, roots)`: набор корней `roots` приходит от потребителя (обычно из sys-цепочки runz: `${sys.profiles.roots}`, лежит в `~/.runz/config.md` или аналоге). Либа перебирает корни, ищет профиль. Не хардкод пути в либе. Прецедент — `fileIncludeResolver` в nr-infra (принимает roots, ищет).

Резолюция имени:
- `name` содержит `/` (`bots/julian`) — прямой путь `<root>/bots/julian.mdz`.
- короткое имя (`julian`) — поиск `<root>/*/julian.mdz` по всем поддиректориям.
- **Поиск игнорирует файлы, начинающиеся с `_`** (`_base.md` и подобные — не профили, фрагменты для инклуда) и файлы не с расширением `.mdz`. Двойная защита базы (§3.1).
- Неоднозначность (два `julian.mdz` в разных доменах при коротком имени) — ошибка `err`, требуй полное имя.

### 3.4 Inline-скрипт авторизации (опционально)

Для нетривиального auth (распаковать chunked-cookie в токен, дёрнуть refresh) профиль несёт TS-скрипт **в теле блока** `## $auth`. Механика — **как в playground** (`S:\appz\playground`, обработчик `$action`): тело блока → TS-код → запись во temp → dynamic import → вызов `default` с инъекцией контекста.

```
## $auth
```ts
export default async (cdp, helpers) => {
  // cdp: доступ к живому Chrome этого профиля (eval, cookies) — для cdp-транспорта.
  //      Для fetch-транспорта cdp === null (refresh делать через helpers.fetch).
  // вернуть { headers: {...} } — навесится на запросы адаптера
  const token = await cdp.eval(`(() => {
    const c = Object.fromEntries(document.cookie.split(';').map(s => {
      const [k, ...v] = s.trim().split('='); return [k, v.join('=')]
    }))
    const combined = ((c['sb-supabase-auth-token.0']||'') + (c['sb-supabase-auth-token.1']||'')).replace(/^base64-/, '')
    return JSON.parse(atob(combined)).access_token
  })()`)
  return { headers: { authorization: 'Bearer ' + token } }
}
```
```

Контракт скрипта:
```ts
type AuthScript = (
  cdp: CdpHandle | null,                 // §4.4 — eval/cookies живого Chrome для cdp; null для fetch-транспорта
  helpers: AuthHelpers
) => Promise<AuthResult>

interface AuthResult {
  headers?: Record<string, string>       // навесить на каждый запрос адаптера
  // (расширяемо: cookie-манипуляции и т.п. — по потребности)
}

interface AuthHelpers {
  fetch(req: WebRequest): AsyncResult<WebResponse>   // ГОЛЫЙ fetchTransport (refresh-запросы), независимо от транспорта профиля; браузерный fetch скрипт делает сам через cdp.eval
  log(msg: string): void
}
```

**Жизненный цикл auth и retry — ровно один повтор.** Скрипт вызывается лениво — при первом `deliver`. Результат (заголовки) кешируется и навешивается на последующие запросы. При ответе **401/403** от площадки `deliver`:
1. Сбрасывает кеш auth, перевыполняет `## $auth` (свежий токен).
2. Повторяет исходный запрос **ровно один раз** с новым auth.
3. Если повтор снова 401/403 — отдаёт этот ответ потребителю как есть (НЕ зацикливается). Мёртвый/неполучаемый токен виден потребителю, а не вешает систему.

Профиль без `## $auth` (простой fetch с `$token`) — retry-логика не применяется (нечего перевыполнять), 401/403 отдаётся сразу.

Скрипт — **не хардкод в либе**, а данные профиля. Либа предоставляет только механику вынимания и инъекции (playground-паттерн), сам скрипт живёт в mdz рядом с конфигом.

---

## 4. Управление живыми Chrome (кирпич + cdp-транспорт)

Общий фундамент для cdp-транспорта (доставка) и девтулза (§5). Один CDP-клиент, одна модель supervisor.

### 4.1 Supervisor: `ensureChrome`

```ts
interface ChromeSpec {
  port: number                           // фиксированный, из профиля
  userDataDir: string
  origin?: string                        // для cdp-доставки: гарантировать вкладку на этом origin (§4.6)
  exe?: string                           // путь к chrome.exe; дефолт из конфига
  flags?: string[]
}

interface ChromeHandle {
  port: number
  didStart: boolean                      // true = supervisor поднял; false = уже был жив
}

function ensureChrome(spec: ChromeSpec): AsyncResult<ChromeHandle>
function killChrome(port: number): AsyncResult<void>
```

`ensureChrome`:
1. `fetch(http://localhost:<port>/json/version)` — жив ли Chrome на этом порту?
2. **Жив** → подключиться к существующему. `didStart: false`. (Случай «открыл руками» или «прошлый вызов оставил».)
3. **Мёртв** → собрать команду (§4.3), запустить, дождаться подъёма (поллинг `/json/version` до успеха или таймаута). `didStart: true`.
4. Если задан `origin` → гарантировать вкладку на нём (§4.6).

`killChrome(port)` — через CDP `Browser.close` (чисто, без поиска pid; `/json/version` pid не даёт). Закрывает **весь** Chrome по этому порту, потому вызывается **только когда `didStart === true`** (мы подняли — мы закрываем; §4.5). Никогда для `didStart: false` (не supervisor открыл).

**НИКОГДА не использовать `taskkill /F /IM chrome.exe` или подобное массовое убийство по имени.** Только `Browser.close` на конкретный порт.

### 4.2 Почему порт фиксированный

Порт фиксирован в профиле (`$port`), НЕ выделяется динамически. Причина: **переиспользование уже живущего Chrome.** Пользователь часто держит Chrome открытым руками (`chrome.exe --remote-debugging-port=9333 --user-data-dir=...`). Фиксированный порт = адрес, по которому supervisor находит этот живой Chrome и подключается к нему вместо подъёма дубля. Динамический порт делает уже открытый Chrome ненаходимым.

Следствие: Chrome — **разделяемый ресурс** между пользователем-руками и supervisor. `didStart: false` при уже живущем Chrome → самоуборка (§4.5) его не трогает (не supervisor открыл — не supervisor закрывает).

Цена: уникальность портов — забота пользователя (раздаёт в профилях, `craveu-julian: 9333`, `craveu-alter: 9334`...). Диапазон широкий (9300–9400 — сотня), коллизий нет. Это те же данные, что `$user-data-dir` — раз проставил в профиль, забыл.

### 4.3 Сборка команды запуска

Из полей `ChromeSpec`:
```
<exe> --remote-debugging-port=<port> --user-data-dir="<userDataDir>" <...flags>
```
Не хранится готовой строкой — собирается из полей. Запуск detached (Chrome живёт после завершения вызова, это долгоживущий ресурс). `exe` дефолт — стандартный путь Chrome, переопределяется через `ChromeSpec.exe` (из `_base.md`/sys).

### 4.4 CDP-клиент, `CdpHandle`, формат cdp-доставки

Минимальный CDP-клиент над WebSocket (Node 22+ встроенный `WebSocket`) — по образцу `S:\mcp\laptop-v2\commands\chrome.js` (класс `CDPClient`), извлечённый в переиспользуемый код либы. Находит вкладку (`/json/list`, фильтр по url/title/индексу), коннектится по `webSocketDebuggerUrl`, шлёт команды с request-id, ловит ответы и события, таймаут на команду.

```ts
interface CdpHandle {
  /** Runtime.evaluate с awaitPromise+returnByValue. Основа cdp-доставки и auth-скриптов. */
  eval<T = unknown>(expression: string): AsyncResult<T>
  /** Network.getCookies для домена. */
  cookies(domain?: string): AsyncResult<CdpCookie[]>
  close(): void
}

function cdpConnect(port: number, tabRef?: string): AsyncResult<CdpHandle>
```

`cdpTransport` строится поверх: `ensureChrome(spec с origin)` → вкладка на origin гарантирована (§4.6) → `cdpConnect(port, origin)` (tabRef = вкладка площадки) → `deliver` выполняет `eval` с fetch-выражением внутри страницы.

**Формат cdp-доставки — запрос выполняется как `fetch(url, init)` внутри страницы через `eval`.** Все три направления тел:

- **Текстовый/JSON запрос** (`body: string`): подставляется в init как строка.
- **Бинарный запрос** (`body: Uint8Array`): base64 → в eval → `Uint8Array`/`Blob` в странице → в fetch init. (Uint8Array не сериализуется в eval напрямую — только через base64-мост.)
- **Multipart** (`body: MultipartBody`): `FormData` собирается **в странице**, не на стороне либы. Причина: boundary в `Content-Type` генерит браузер, ручная сборка multipart на стороне либы даст рассогласование boundary. Либа передаёт в eval: `fields` (текстовые), `file` (base64+filename+mime) → в странице `new FormData()`, `append` полей, `append` файла как `Blob`, `fetch(url, {method, body: fd})`. **Content-Type не ставить руками** — браузер поставит с правильным boundary. (Образец — `pagePostMultipart` из легаси post-craveu.)
- **Ответ** (любой): тело читается в странице. Текст — напрямую. Бинарь (картинка) — через base64 в eval, декодируется на стороне либы в `Body`.

`credentials` — из `$cdp-credentials` профиля (omit/include), дефолт по площадке.

Заголовки ответа для cdp — урезаны (§2.4): только то, что видит `Response.headers`, без `Set-Cookie`.

### 4.5 Самоуборка

Адаптер/потребитель может запросить закрытие Chrome после работы: если `didStart === true` И запрошена самоуборка → `killChrome` (`Browser.close`) в конце. Если `didStart === false` (Chrome был жив до вызова) — не трогать. Это опция потребителя (флаг), не автоматика либы по умолчанию — по умолчанию Chrome остаётся жить (дешевле для следующего вызова).

**Демон-уборщик (гашение по простою всех Chrome) — НЕ в этой спеке.** Отдельная задача, отдельный процесс, знает про поднятые Chrome как данные, независим. Самоуборка per-vyzov достаточна для v1 (каждый поднявший убирает за собой). Демон — потом, отдельным Linear-таском.

### 4.6 Гарантия вкладки на origin

**Критично для cdp-доставки.** In-page fetch исполняется в контексте вкладки, а значит origin этой вкладки. Fetch к `https://craveu.ai/...` из вкладки на `about:blank`/newtab — cross-origin: тело ответа режется CORS, same-origin cookie не отправляются. Потому cdp-доставка **обязана** исполняться на вкладке origin площадки.

`ensureChrome` при заданном `origin`:
1. Ищет среди вкладок (`/json/list`) вкладку, чей url начинается с `origin`.
2. **Есть** → используется она (пользователь/прошлый вызов уже на площадке).
3. **Нет** → создаёт вкладку (`/json/new?<origin>` или CDP `Target.createTarget`) и/или навигирует на `origin`, ждёт `domcontentloaded`. (Образец — `page.goto(ORIGIN, {waitUntil:'domcontentloaded'})` из легаси-скриптов.)
4. `cdpConnect` для доставки коннектится именно к этой вкладке (tabRef = origin-вкладка).

Без `origin` в spec (девтулз-сценарии, где вкладку задаёт потребитель явно) — шаг пропускается, вкладка берётся по tabRef потребителя.

**Url запроса НЕ валидируется против origin вкладки.** Cross-origin запросы с origin-вкладки легитимны: `craveu-upload` — fetch с вкладки craveu.ai на S3 presigned, работает, потому что S3 отдаёт CORS-заголовки (легаси `pagePostMultipart` подтверждает). Вкладка на origin нужна ради same-origin cookie и браузерного контекста, не как фильтр url. Никаких проверок вида `req.url.startsWith(origin)` в deliver.

---

## 5. Девтулз — наблюдение и интроспекция

Сосед доставки. Те же живые Chrome (§4), тот же CDP-клиент, но **другой потребитель**: человек (отладка) и разведка (ловля трафика для golden-sample контракт-слоя). Отдельный публичный API, не смешан с доставкой.

```ts
interface DevtoolsCaptured {
  method: string
  url: string
  requestHeaders: Record<string, string>
  requestBody?: string
  status?: number
  responseHeaders?: Record<string, string>
  responseBody?: string                  // тело ответа (Network.getResponseBody)
}

interface Devtools {
  /** Слушать сеть вкладки N секунд. Ловит запрос И ответ (с телами). Питает golden-sample. */
  listen(opts: { port: number; tab?: string; filter?: string; seconds: number }): AsyncResult<DevtoolsCaptured[]>
  /** Прочитать куки. */
  cookies(opts: { port: number; domain?: string }): AsyncResult<CdpCookie[]>
  /** Выполнить JS в странице (отладка/разведка). */
  eval<T = unknown>(opts: { port: number; tab?: string; expression: string }): AsyncResult<T>
  /** Список вкладок. */
  tabs(opts: { port: number }): AsyncResult<TabInfo[]>
  /** Полный HTML страницы. */
  html(opts: { port: number; tab?: string; maxLength?: number }): AsyncResult<string>
  /** Скриншот вкладки/элемента (PNG bytes). */
  screenshot(opts: { port: number; tab?: string; selector?: string }): AsyncResult<Body>
}

function devtools(): Devtools
```

**`listen` возвращает объекты, НЕ TOON.** TOON — представление верхнего слоя (инструмент golden-sample/чтения). Превратить `DevtoolsCaptured[]` в TOON-капчуру — одна строка `encode(obj)` у потребителя (скрабера). nr-web форматов представления не знает — отдаёт структуру, потребитель решает: TOON для глаз, JSON на диск, дифф с прошлой капчурой. Это граница с контракт-слоем: транспорт **ловит** сырьё, контракт-слой его **осмысляет**.

Реализация — расширение того, что уже есть в `chrome.js`: `actionNetwork` ловит `Network.requestWillBeSent` — добавить `Network.responseReceived` + `Network.getResponseBody` (сейчас тела ответов не ловятся). Остальные (`cookies`/`eval`/`tabs`/`html`/`screenshot`) — прямой перенос из `chrome.js`.

**MCP `chrome.js` (`S:\mcp\laptop-v2\commands\chrome.js`) становится тонкой обёрткой над `devtools()`.** Сейчас держит свой `CDPClient` — после реализации берёт из nr-web. Дедупликация: один CDP-клиент в либе, и доставка (cdp-транспорт), и девтулз (MCP-инструмент) на нём. Замена chrome.js на обёртку — отдельная задача после того, как либа готова (не часть этой спеки, но следствие).

---

## 6. Структура пакета

```
src/
  types.ts          — Body, WebRequest, WebResponse, MultipartBody, Transport, Adapter, CdpHandle, ...
  decode.ts         — asText, asJson (Result)
  transport/
    fetch.ts        — fetchTransport
    cdp.ts          — cdpTransport (поверх chrome.ts + cdp-client.ts): сборка fetch-выражения из WebRequest (text/binary/multipart), чтение ответа
  chrome/
    supervisor.ts   — ensureChrome, killChrome (Browser.close), сборка команды, живость-чек, гарантия origin-вкладки (§4.6)
    cdp-client.ts   — CDPClient (WebSocket), cdpConnect, CdpHandle
  adapter/
    load.ts         — loadAdapter: поиск профиля, парсинг mdz, сборка транспорта+auth, retry-обёртка (§3.4)
    auth-script.ts  — вынимание и исполнение ## $auth (playground-паттерн), кеш+инвалидация
    profile.ts      — чтение полей профиля по транспорту
  devtools/
    devtools.ts     — listen/cookies/eval/tabs/html/screenshot
  index.ts          — re-exports
test/
  fetch.test.ts     — fetchTransport: deliver, Uint8Array in/out, ошибки → Result
  decode.test.ts    — asText/asJson
  cdp.test.ts       — сборка fetch-выражения из WebRequest (text/binary/multipart) — юнит на генерацию выражения (CDP замокан)
  supervisor.test.ts— ensureChrome: жив→подключись(didStart false), мёртв→подними(didStart true); origin-вкладка; killChrome только при didStart
  adapter.test.ts   — loadAdapter: поиск по roots (игнор _* и не-.mdz), $[[include]] наследование, сборка fetch-auth заголовка
  auth-script.test.ts — вынимание ## $auth, исполнение, cdp=null для fetch, кеш, retry ровно один раз при 401/403
  devtools.test.ts  — listen ловит req+resp (мок CDP); объекты не TOON
docs/specs/
  nr-web-spec.md    — этот файл
CLAUDE.md
package.json / tsconfig.json / vitest.config.ts
```

---

## 7. Ключевые контракты (для CLAUDE.md)

1. **Всё IO через Result** (nr-infra-модель). Доставка, Chrome-операции, парсинг профиля — `err()` на предсказуемых ошибках, не throws.
2. **Тело ответа — `Uint8Array`, сырьё.** Ноль парсинга, ноль знания форматов. Текст/JSON — через `asText`/`asJson` у потребителя.
3. **Выбор транспорта — в профиле (`$transport`), не в коде.** Потребитель зовёт именованный адаптер, транспорт внутри. `transport` — открытая строка, не union.
4. **Порт Chrome — фиксированный, из профиля.** Для переиспользования уже живущих Chrome. `ensureChrome`: жив→подключись, мёртв→подними. `didStart` для самоуборки.
5. **cdp-доставка исполняется на вкладке origin площадки (§4.6).** Иначе CORS режет тело и cookie. `$origin` обязателен для cdp; supervisor гарантирует вкладку. Url запроса при этом НЕ валидируется против origin — cross-origin с origin-вкладки легитимен (S3 presigned), CORS решает площадка.
6. **Никакого массового убийства Chrome** (`taskkill /IM chrome.exe` запрещён). Только `killChrome(port)` через `Browser.close`, только при `didStart: true`.
7. **Наследование профилей — через nrd-core `$[[include]]`**, не своя реализация. База — `.md`, профили — `.mdz`. Поиск игнорирует `_*` и не-`.mdz`.
8. **Inline-auth-скрипт — playground-паттерн** (тело mdz → TS → import → default). `cdp` = CdpHandle для cdp, null для fetch. Retry при 401/403 — ровно один раз, потом отдать ответ (не зациклиться).
9. **Multipart/бинарь в cdp — FormData собирается в странице**, не в либе (boundary — браузера). Content-Type не ставить руками.
10. **cdp-заголовки ответа урезаны** (§2.4): нет `Set-Cookie`, cross-origin только expose-listed. Контракт-слой не рассчитывает на Set-Cookie из cdp.
11. **Девтулз `listen` отдаёт объекты, не TOON.** Представление — верхний слой.
12. **Девтулз — сосед доставки, не её часть.** Общие кирпичи (Chrome+CDP), разные API, разные потребители.
13. **nr-web не знает про: домен (боты/CCv3), контракт (схемы/golden-sample), форматы тел (JSON/XML/HTML).** Всё это — слои поверх. CDP — именно `localhost:port` (локальный Chrome); правило «никогда localhost» касается внешних сервисов, не локального Chrome.

---

## 8. Зависимости

- `@kerneldreams/nrd` — Result/AsyncResult, ok/err, HttpResponse-типы; парсинг mdz-профилей, IContext/cast, `$[[include]]`-резолв (через инъектируемый `fileIncludeResolver` оттуда же).
- Рантайм: `globalThis.fetch` + `globalThis.WebSocket` (Node 22+). Ноль тяжёлых внешних зависимостей (никакого playwright — только CDP по WebSocket к системному Chrome).

---

## 9. Границы / что НЕ делаем

- **Парсинг тел** (JSON/XML/HTML/бинарь) — потребитель. Либа несёт байты.
- **Контракт-слой** (официальный SDK / JSON-схема / golden-sample TOON, карта адресации, слоты, дифф капчур) — поверх nr-web, отдельная спека.
- **Домен** (боты/CCv3/extensions.nrs, блоги, реддит-деревья, mdd-компиляция) — клиент, ещё выше.
- **TOON** — представление верхнего слоя; в nr-web нет ни encode, ни decode TOON.
- **Демон-уборщик Chrome по простою** — отдельный процесс/таск, не здесь. Самоуборка per-vyzov — есть.
- **Замена MCP chrome.js на обёртку** — следствие, отдельная задача после готовности либы.
- **impersonate-транспорт** — контракт готов (`transport` — строка), реализация по факту встречи (v1: только fetch+cdp).
- **Кеширование ответов, rate limiting, балансировка** — слой выше.
- **Логин с нуля** (OAuth, капча, 2FA) — не автоматизируем. Auth = переиспользование живой сессии (токен в профиле / залогиненная user-data-dir). Логин — руками один раз, вне либы.
- **Cloudflare challenge** — не решаем, как и логин. Залогиненная user-data-dir предполагает живую сессию с clearance; challenge на свежей вкладке → 403/challenge-страница потребителю, чинится руками (открыть Chrome, пройти).

---

## 10. Приёмка (наблюдаемое поведение)

1. `fetchTransport().deliver` на реальный публичный GET → `WebResponse` с `status`, `body: Uint8Array`; `asText`/`asJson` разбирают.
2. `loadAdapter('bots/julian', roots)` с профилем, инклудящим `_base.md` → `Adapter` с `transport: 'fetch'`, `deliver` навешивает `Authorization: Bearer <token>` из профиля. Поиск не подхватывает `_base.md`.
3. `ensureChrome` на порт с уже живым Chrome → `didStart: false`, подключение; на мёртвый порт → поднимает Chrome, `didStart: true`, `/json/version` отвечает.
4. `ensureChrome` с `origin`, где вкладки на площадке нет → создаёт/навигирует вкладку на origin, `domcontentloaded`.
5. `cdpTransport` доставляет запрос через живой Chrome на origin-вкладке, возвращает тело in-page fetch как `Body`. Multipart-upload → FormData в странице, boundary браузера, файл доезжает.
6. Inline `## $auth`-скрипт craveu (распаковка chunked-cookie) → возвращает `{headers}`, навешивается; при 401 — перевыполняется и повтор ровно один раз; второй 401 → отдан потребителю без петли.
7. `devtools().listen` на вкладку ловит req **и** resp с телами, возвращает `DevtoolsCaptured[]` (объекты, не строка TOON).
8. `killChrome` закрывает Chrome через `Browser.close`; не вызывается при `didStart: false`.
9. Ошибки (сеть, мёртвый Chrome, битый профиль, невалидный JSON в `asJson`, cross-origin без origin-вкладки) → `err(Error)` с текстом, не throws.
10. Ноль внешних рантайм-зависимостей в package.json (только `@kerneldreams/*` workspace + Node built-ins).

---

## Открытые пункты

1. **Резолюция короткого имени профиля** при коллизии доменов (§3.3) — ошибка с требованием полного имени. Достаточно ли, или нужен приоритет доменов — по факту использования.
2. **`$cdp-credentials` дефолт** (§3.2) — omit или include по умолчанию, если поле не задано. Определить по факту площадок (craveu omit, crushon include — оба задают явно, дефолт для новых).
3. **Бинарные тела через CDP** (§4.4) — base64-мост в eval для больших файлов (upload картинок). Проверить, не пухнет ли eval на многомегабайтных телах; при проблеме — `Network`-домен / `Fetch.fulfillRequest` вместо in-page fetch для бинарей. Касается обоих направлений (запрос-upload и ответ-download).
