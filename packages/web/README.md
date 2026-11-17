# @kerneldreams/web

Web transport layer: delivers HTTP requests to arbitrary web APIs, including undocumented ones, and drives live Chrome instances for delivery and devtools-style introspection. It carries raw bytes and understands nothing: bodies are `Uint8Array`, and parsing JSON, HTML or anything else is up to the caller.

```
npm i @kerneldreams/web
```

Node >= 24. No runtime dependencies besides `@kerneldreams/nrd` (for `Result`); no browser automation library — Chrome is driven over the DevTools protocol through `WebSocket`.

All I/O returns `Result` (`{ ok: true, value }` or `{ ok: false, error }`); predictable failures never throw.

## Quick start

```ts
import { fetchTransport, asJson } from '@kerneldreams/web'

const transport = fetchTransport({ timeoutMs: 10_000, maxBytes: 1_000_000 })
const res = await transport.deliver({ method: 'GET', url: 'https://example.com/api/items' })
if (!res.ok) throw res.error

console.log(res.value.status)
const json = asJson(res.value)           // Result: decode the raw bytes yourself
```

## Transports

A `Transport` has one method, `deliver(req: WebRequest): AsyncResult<WebResponse>`.

- **`fetchTransport(options?)`** — plain HTTP over the global `fetch`. Options: `timeoutMs`, `maxBytes` (the read is cancelled once exceeded), `redirect` (`'follow'` or `'manual'`, to re-validate every hop yourself), `signal`. Errors are told apart by `error.name`: `TimeoutError`, `BodyTooLargeError`, `AbortError`.
- **`cdpTransport(options)`** — the request is executed by `fetch` inside a page of a live Chrome, on a tab at the given `origin`, so the site's cookies and CORS rules apply. Options: `port`, `origin`, `userDataDir`, `exe`, `flags`, `credentials`, `autoClose`. Response headers are trimmed by the browser (no `Set-Cookie`). Multipart bodies (`MultipartBody`) are assembled as `FormData` inside the page; do not set `Content-Type` yourself.

Request bodies may be `Uint8Array`, a string (UTF-8) or a `MultipartBody`.

## Adapters (profiles)

`loadAdapter(profileName, roots)` finds an `.mdz` profile in the given root directories, resolves its `$[[include]]` base, picks the transport from the profile (`$transport`: `fetch` or `cdp`, an open string) and returns an `Adapter` with `deliver()`, `domain` and `transport`. Files whose names start with `_` are base fragments, not profiles.

A profile may carry an inline `## $auth` script. It receives `(cdp, helpers)` and returns headers to attach to every request; on a 401 or 403 the adapter re-authenticates exactly once and retries, then returns whatever came back.

```
$domain: example
$transport: fetch
```

```ts
import { loadAdapter } from '@kerneldreams/web'

const adapter = await loadAdapter('example', ['/path/to/profiles'])
if (adapter.ok) {
  const res = await adapter.value.deliver({ method: 'GET', url: 'https://example.com/me' })
}
```

## Chrome supervisor and CDP client

- `ensureChrome({ port, userDataDir, origin?, exe?, flags? })` — connects to a Chrome already listening on `port` (`didStart: false`) or launches one (`didStart: true`). With `origin` it also guarantees a tab on that origin.
- `killChrome(port)` — closes that Chrome through `Browser.close`. There is no process-wide kill; only use it when you started the instance.
- `buildChromeCommand`, `ensureOriginTab`, and the CDP client: `CDPClient`, `cdpConnect`, `connectTab`, `getTabs`, `tabInfos`, `newTab`, `browserWsUrl`.
- `CdpHandle`: `eval(expression)` (awaits promises, returns by value), `cookies(domain?)`, `close()`.

## Devtools

`devtools()` returns an object with `listen` (capture a tab's network, requests and responses with bodies, for N seconds), `cookies`, `eval`, `tabs`, `html`, and `screenshot` (PNG bytes, whole tab or a selector). Each takes the Chrome `port`. It returns plain objects; presentation is up to the caller.

## Exports

Types: `Body`, `MultipartBody`, `WebRequest`, `WebResponse`, `Transport`, `Adapter`, `CdpTransportOptions`, `CdpCredentials`, `ChromeSpec`, `ChromeHandle`, `CdpCookie`, `CdpHandle`, `TabInfo`, `AuthResult`, `AuthHelpers`, `AuthScript`, `DevtoolsCaptured`, `Devtools`, `FetchTransportOptions`, `ProfileFields`. Helpers: `asText`, `asJson`, `buildFetchExpression`, `readProfileFields`, `extractAuthScript`, `compileAuthScript`, `stripFences`.

## License

MIT
