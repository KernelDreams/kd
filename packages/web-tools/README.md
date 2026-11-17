# @kerneldreams/web-tools

Web search and page reading for agents: `web_search` and `web_fetch` on top of the `@kerneldreams/web` transport, as plain functions and as ready-made tools (`createWebTools`, entry `./tools`). Stateless, no cache.

```sh
npm i @kerneldreams/web-tools
```

```ts
import { createWebTools } from '@kerneldreams/web-tools/tools'

const tools = createWebTools()                       // [web_search, web_fetch, ...]
const search = tools.find((t) => t.name === 'web_search')!
const r = await search.execute({ query: 'node 22 AbortSignal.any', limit: 3 })
console.log(r.text)                                  // numbered list for the model; r.details has the structure
```

Each tool is `{ name, description, parameters (JSON Schema), execute(args, { signal }) → { text, details, isError? } }`. The functions `webSearch` and `webFetch` are exported from the package root (`@kerneldreams/web-tools`).

## Tools

| | parameters | result |
|---|---|---|
| **`web_search`** | `query`, `limit?` (default 5, max 10), `lang?` | `[{ title, url, snippet }]` |
| **`web_fetch`** | `url`, `maxChars?` (default 20 000, max 100 000) | `{ url, title?, text, truncated, product?, via? }` |
| `browser_open` / `browser_look` / `browser_click` / `browser_fill` / `browser_extract` | see "Browser" | page view, product card |

The `content` of a tool_result is text for the model (a numbered list, or a page with a `URL:`/`Title:` header and a truncation note); the full structure is in `details`. Errors are returned **as text in the tool_result**, not thrown: `web_fetch failed [bad_request]: ...`; the error code is duplicated in `details.error.code`.

Tool descriptions are in English and hint at the scenario: search, pick a url, fetch.

## Search

A router: providers in the order of `NR_WEB_SEARCH` (comma-separated); if unset, `searxng,brave,ddg` among the configured ones. The first one to return a non-empty result wins; an anti-bot response (`blocked`: DDG 202/403, captcha), 429 (`rate_limited`), a provider timeout (12 s) and network errors switch to the next provider. A provider that failed **cools down** for the process (captcha 15 min, 429 5 min, timeout 3 min) and later calls skip it, so a model retry does not hit the captcha again; if all have cooled down, all are tried. The model sees a first line such as `[search via searxng; ddg: blocked]`, and `details` is `{hits, provider, attempts}`. If all failed, the error carries a reason for each.

Measured on 12 queries (brushes, nozzles, Polish shops): DDG alone gave 3 of 12 (HTTP 202 after the third query); the router with SearXNG gave 12 of 12, median 1.4 s.

| provider | setup | notes |
|---|---|---|
| `ddg` | none | DuckDuckGo html results. The request is a **POST form**: on a cookie-less GET DDG serves an anti-bot captcha. A captcha yields a `blocked` error, not an empty list. Fragile to markup changes; the parser is pinned by a fixture |
| `brave` | `BRAVE_API_KEY` | Brave Search API |
| `searxng` | `SEARXNG_URL` | your own instance, `/search?format=json` (the JSON format must be enabled in its settings.yml, otherwise 403 becomes `config`) |

A new provider is a file in `src/search/` implementing `SearchProvider` (`unconfigured(env)` + `search(query, opts) → Result<SearchHit[]>`) plus a line in `PROVIDERS`.

## Reading a page

- Transport is `fetchTransport` from `@kerneldreams/web`: a 20 s timeout for the whole chain, body up to 5 MB, up to 5 redirects followed **manually**, so every hop passes the SSRF guard again.
- `text/html` and xhtml become text: `script/style/nav/footer/aside` (and `template/svg/iframe/form`) are cut out, `<article>`/`<main>` is taken if present; headings become `#`, list items `- `, `<pre>` is kept as is. `<noscript>` stays, since for an SPA stub it is the only text. Not readability, but enough for a model.
- `application/json`, `+json` and `text/*` are returned as is. Anything else is `unsupported_content_type`. The encoding comes from the header `charset` or `<meta charset>`.
- Truncation by `maxChars` sets `truncated: true` and adds a note to the text.
- Non-2xx responses give an honest code: 403/202 are `blocked`, 429 is `rate_limited`, the rest `http_error` (with `status` in the error). An anti-bot stub served with 200 (Cloudflare "Just a moment", DataDome, Amazon Robot Check) is also `blocked`.
- **Browser fallback on anti-bot**: on `blocked`, `rate_limited`, 401/503, with `NR_WEB_BROWSER_CDP` set, the page is opened in a temporary tab of a browser profile (cookies and logins live there), the html goes through the same path, and the text carries a `[via browser]` note. If the stub persists even in the browser, the result is `blocked` with a hint to pass it by hand in the profile window. The SSRF guard is the same. Measured on 10 addresses (6 of which had failed in a session): without the browser 4 of 10, with it 8 of 10 (Allegro, RTV Euro AGD, Media Expert passed; manualslib and manuals.plus hit a Cloudflare captcha even in the browser).
- **Product card** (`product`): JSON-LD `Product` or `og:`/`product:` meta gives model, brand, EAN, SKU, MPN, price, currency, availability, seller, delivery, url and `checkedAt`; it is also appended to the text as a `Product: ...` line.

## Browser

The `browser_*` tools (`createWebTools({ browser: true })`, opt-in: they are visible to an agent only if it names them, e.g. `tools: "all, browser_*"`) work in the agent's persistent tab of the same browser over CDP (`src/browser.ts`, `src/tools-browser.ts`); the tab id is kept in a temporary file and survives a process restart.

- `browser_open {url, find?}` — navigate and get a page view; `browser_look {find?, offset?, maxChars?}` — a view of the current page: headings, text and controls with refs `[r12]` (the `data-nr-ref` attribute); the site header, menu and footer come last, the cap is 6000 characters, and `find="word|other"` returns matches with their neighbours. A full accessibility snapshot would not do: an Amazon search page is 380 thousand characters.
- `browser_click {ref, confirmed?}` — a real mouse click (CDP `Input`), followed by a short view. A button that looks like a payment or final order ("Kupuję i płacę", "Kup teraz", "Złóż zamówienie", "Place your order"...; `PAY_RE`) without `confirmed: true` gives a `needs_confirmation` error that demands a summary and the human's "yes".
- `browser_fill {ref, value, submit?}` — typing (`Input.insertText`) or choosing in a list; a non-field gives `not_a_field`; a password, BLIK, card or one-time code gives `human_only`, and the values of such fields are hidden in the view.
- `browser_extract {what: product|text}` — a product card (JSON-LD + Amazon DOM: ASIN, price, seller, delivery, EAN and model from the details) or the page text.

Store logins and captchas are passed by a human in the profile window (`NR_WEB_BROWSER_WINDOW` is the link shown in hints); the model sees only the tool output.

**SSRF guard** (`bad_request`): schemes other than http(s), credentials in the url, `localhost`/`*.localhost`, loopback, private and reserved IPv4/IPv6 ranges (including IPv4-mapped and numeric forms such as `http://2130706433/`), and names that **resolve** to such addresses. `NR_WEB_FETCH_ALLOW_HOSTS` (comma-separated hostnames) lifts the guard for specific hosts, for smoke tests and local debugging. Known gap: DNS rebinding between the check and the request is not closed.

## Configuration

Tools: `createWebTools({ http?, env?, lookup? })` (entry `./tools`) gives descriptions and JSON Schema for the model and `execute(params, {signal})` → `{text, details, isError?}`; functions: `webSearch`, `webFetch`.

| env | |
|---|---|
| `NR_WEB_SEARCH` | comma-separated search providers, default `ddg` |
| `BRAVE_API_KEY` | Brave key |
| `SEARXNG_URL` | SearXNG address |
| `NR_WEB_FETCH_ALLOW_HOSTS` | hosts exempt from the SSRF guard (debugging) |
| `NR_WEB_BROWSER_CDP` | CDP port of the profile browser; without it there is no browser |
| `NR_WEB_BROWSER_WINDOW` | the profile window for a human, shown in "human needed" hints |
| `NR_WEB_PROVIDER_TIMEOUT_MS` | timeout of one search provider, default 12 000 |

The environment is read on every call, so a key can be added without a restart. By default (`createWebTools()` without `env`) the settings come from the `## $web` block of `~/.runz/config.md` (`$provider`, `$searxng_url`, `$brave_api_key`, `$browser_cdp`, `$browser_window`, `$allow_hosts`; the file is re-read by mtime), and variables set in the process take precedence (`src/machine.ts`).

## Tests

```
npm test           # unit tests
npm run test:live  # one network test against real DuckDuckGo
```

Unit tests cover: the DDG parser on a saved result page (`test/fixtures/ddg-results.html`; it contains ads, which must be filtered out), html to text on three fixtures (article, docs, SPA stub), the SSRF filter, redirects through the guard, truncation, provider order and fallback, the router with cooldown and provider timeout, fetch through the browser (a fake `browserGet`), the product card, the page view and the safety stops (`test/shop.test.ts`).

The live test is tagged and skipped by default: its failure is a signal that DDG changed its markup and the fixture needs refreshing.
