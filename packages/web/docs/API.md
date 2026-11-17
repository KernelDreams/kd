# @kerneldreams/web

## main
Body = Uint8Array
MultipartBody { kind, fields, file? }
WebRequest { method, url, headers?, body? }
WebResponse { status, headers, body }
Transport { deliver }
Adapter { deliver, domain, transport }
CdpTransportOptions { port, origin, userDataDir?, exe?, flags?, credentials?, autoClose? }
CdpCredentials = 'omit' | 'include'
ChromeSpec { port, userDataDir, origin?, exe?, flags? }
ChromeHandle { port, didStart }
CdpCookie { name, value, domain, path?, expires?, size?, httpOnly?, secure?, session?, sameSite? }
CdpHandle { eval, cookies, close }
TabInfo { index, title, url, id? }
AuthResult { headers? }
AuthHelpers { fetch, log }
AuthScript = ( cdp: CdpHandle | null, helpers: AuthHelpers, ) => Promise<AuthResult>
DevtoolsCaptured { method, url, requestHeaders, requestBody?, status?, responseHeaders?, responseBody? }
Devtools { listen, cookies, eval, tabs, html, screenshot }
asText(res: WebResponse): string
> Decode the response body as utf-8 text.
asJson<T = unknown>(res: WebResponse): Result<T>
> Decode as text, then JSON.parse. Invalid JSON → err (predictable error via Result).
FetchTransportOptions { timeoutMs?, maxBytes?, redirect?, signal? }
> Delivery limits. Errors are told apart by `error.name`: `TimeoutError`, `BodyTooLargeError`, `AbortError`.
fetchTransport(opts?: FetchTransportOptions): Transport
cdpTransport(opts: CdpTransportOptions): Transport
buildFetchExpression(req: WebRequest, opts?: { credentials?: CdpCredentials | undefined; }): string
> Build the in-page fetch expression from a WebRequest (spec §4.4). Pure and
deterministic — unit-tested directly (CDP mocked). Returns an async IIFE whose
value is `{ status, headers, bodyBase64 }`.
ensureChrome(spec: ChromeSpec): AsyncResult<ChromeHandle>
> Ensure a Chrome is available on the fixed port (§4.1):
 1. alive → connect to it, didStart:false (opened by hand / previous call)
 2. dead  → launch, poll /json/version until up, didStart:true
 3. if origin given → guarantee a tab on it (§4.6)
killChrome(port: number): AsyncResult<void>
> Close the whole Chrome on this port via CDP Browser.close (§4.1). Clean, no pid
hunting. Caller MUST only invoke this when didStart === true (§4.5).
buildChromeCommand(spec: ChromeSpec): { exe: string; args: string[]; }
> Build the launch command from ChromeSpec fields (§4.3). Not stored as a ready
string — assembled from named keys so the Chrome path/flags stay centralizable.
ensureOriginTab(port: number, origin: string): AsyncResult<void>
> Guarantee a page tab on `origin` (§4.6). In-page fetch runs in a tab's context;
the tab must be on the site origin or the response body is CORS-clipped and
same-origin cookies won't be sent.
CDPClient { connect, send, on, close }
> Low-level CDP connection. Methods reject on error; boundary functions wrap in Result.
cdpConnect(port: number, tabRef?: string | undefined): AsyncResult<CdpHandle>
> Connect and return a CdpHandle for the tab (§4.4).
connectTab(port: number, ref?: string | undefined): AsyncResult<{ client: CDPClient; tab: RawTab; }>
> Connect a CDPClient to a resolved tab.
getTabs(port: number): AsyncResult<RawTab[]>
> GET /json/list → all targets.
tabInfos(port: number): AsyncResult<TabInfo[]>
> Page-type tabs as consumer-facing TabInfo.
newTab(port: number, url: string): AsyncResult<RawTab>
> Create a new tab navigated to url (PUT /json/new?<url>).
browserWsUrl(port: number): AsyncResult<string>
> Browser-level WebSocket endpoint from /json/version (for Browser.close).
loadAdapter(profileName: string, roots: string[]): AsyncResult<Adapter>
readProfileFields(doc: Document): ProfileFields
extractAuthScript(doc: Document): string | undefined
> Body of the `## $auth` block, if present (the inline auth script, §3.4).
ProfileFields { domain?, transport?, authHeader?, authScheme?, token?, userDataDir?, port?, origin?, chromeFlags?, exe?, credentials? }
compileAuthScript(rawBody: string): Promise<Result<AuthScript>>
> Compile the `## $auth` block body into a callable AuthScript. Writes the code
to a temp `.mjs` and dynamic-imports its default export.
stripFences(text: string): string
> Strip a leading/trailing ``` fence (bodies often arrive fenced as ```ts).
devtools(): Devtools