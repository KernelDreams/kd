# nr-web — Claude Context

`@kerneldreams/web` — нижний слой веб-инфраструктуры. Доставка HTTP-запросов к произвольным (в т.ч. недокументированным) веб-API + управление живыми Chrome для доставки и девтулз-интроспекции.

**Несёт сырые байты, ничего не осмысляет.** Формат тела (JSON/XML/HTML/бинарь), парсинг, схемы, TOON — этажами выше.

Спека: `docs/specs/nr-web-spec.md` (черновик 3, закрытая). Читать перед любой правкой.

## Ключевые контракты (§7 спеки) — нарушение = брак

1. **Всё IO через Result** (модель nr-infra). Доставка, Chrome-операции, парсинг профиля — `err()` на предсказуемых ошибках, никогда throws.
2. **Тело — `Uint8Array`, сырьё.** Ноль парсинга, ноль знания форматов. Текст/JSON — через `asText`/`asJson` у потребителя.
3. **Выбор транспорта — в профиле (`$transport`), не в коде.** Потребитель зовёт именованный адаптер. `transport` — открытая строка, не union (§1.3).
4. **Порт Chrome — фиксированный, из профиля.** Для переиспользования уже живущих Chrome. `ensureChrome`: жив→подключись (`didStart:false`), мёртв→подними (`didStart:true`).
5. **cdp-доставка исполняется на вкладке origin площадки.** Иначе CORS режет тело и cookie. `$origin` обязателен для cdp; supervisor гарантирует вкладку. **Url запроса НЕ валидируется против origin** — cross-origin с origin-вкладки легитимен (S3 presigned).
6. **Никакого массового убийства Chrome.** `taskkill /IM chrome.exe` запрещён. Только `killChrome(port)` через CDP `Browser.close`, только при `didStart: true`.
7. **Наследование профилей — через nrd-core `$[[include]]`**, не своя реализация. База — `.md`, профили — `.mdz`. Поиск игнорирует `_*` и не-`.mdz`.
8. **Inline-auth-скрипт — playground-паттерн** (тело mdz → ESM → import → `default`). `cdp` = CdpHandle для cdp, `null` для fetch. Retry при 401/403 — **ровно один раз**, потом отдать ответ (не зациклиться). Профиль без `## $auth` — retry не применяется.
9. **Multipart/бинарь в cdp — FormData собирается в странице**, не в либе (boundary — браузера). **Content-Type не ставить руками.**
10. **cdp-заголовки ответа урезаны** (§2.4): нет `Set-Cookie`, cross-origin только expose-listed. Контракт-слой не рассчитывает на `Set-Cookie` из cdp.
11. **Девтулз `listen` отдаёт объекты, не TOON.** Представление — верхний слой.
12. **Девтулз — сосед доставки, не её часть.** Общие кирпичи (Chrome+CDP), разные API, разные потребители.
13. **nr-web не знает про домен / контракт / форматы тел.** CDP — именно `localhost:port` (локальный Chrome); правило «никогда localhost» касается внешних сервисов, не локального Chrome.

## Зависимости

- `@kerneldreams/nrd` — Result/AsyncResult, ok/err; парсинг mdz, `$[[include]]`-резолв.
  (бывшие `@kerneldreams/nrd/web` + `@kerneldreams/nrd`, слиты 08.09 — см. nrd/docs/MIGRATION.md)
- Рантайм: `globalThis.fetch` + `globalThis.WebSocket` (Node 22+). **Ноль внешних рантайм-зависимостей** (никакого playwright — только CDP по WebSocket к системному Chrome).

## Структура

```
src/
  types.ts          — Body, WebRequest, WebResponse, MultipartBody, Transport, Adapter, CdpHandle, ...
  decode.ts         — asText, asJson (Result)
  transport/
    fetch.ts        — fetchTransport
    cdp.ts          — cdpTransport + buildFetchExpression (text/binary/multipart)
  chrome/
    supervisor.ts   — ensureChrome, killChrome (Browser.close), buildChromeCommand, гарантия origin-вкладки
    cdp-client.ts   — CDPClient (WebSocket), cdpConnect, connectTab, CdpHandle
  adapter/
    load.ts         — loadAdapter: поиск профиля, парсинг mdz, транспорт+auth, retry-обёртка
    auth-script.ts  — compileAuthScript (## $auth, playground-паттерн)
    profile.ts      — readProfileFields, extractAuthScript
  devtools/
    devtools.ts     — listen/cookies/eval/tabs/html/screenshot
  index.ts          — re-exports
test/               — fetch, decode, cdp, supervisor, adapter, auth-script, devtools
```

## ПЕРЕД ЗАВЕРШЕНИЕМ

```bash
cd S:\nrlib\nr-web
npx tsc --noEmit    # typecheck — должен быть чистым
npx vitest run      # тесты — зелёные
```

## Профили (вне либы)

Профили-адаптеры живут в `S:\profiles\<domain>\<name>.mdz`. Либа знает не путь, а **набор корней** (`roots`), приходящий от потребителя (обычно sys-цепочка runz). База площадки — `_base.md`, инклудится через `$[[_base.md]]`.

```
# _base.md (fetch)              # julian.mdz
$domain: bots                   $[[_base.md]]
$transport: fetch               $token: sk-...
$auth-header: Authorization
$auth-scheme: Bearer
```

## Границы (что НЕ здесь)

Парсинг тел, контракт-слой (golden-sample/схемы/TOON), домен (боты/CCv3), демон-уборщик Chrome по простою, замена MCP `chrome.js` на обёртку, impersonate-транспорт, логин с нуля / Cloudflare challenge — всё вне этой либы.
