// nr-web — public types (spec §2, §4, §5).
//
// nr-web carries raw bytes. Body is always Uint8Array; no format is ever
// parsed or assumed here.

import type { AsyncResult } from '@kerneldreams/nrd'

// ---------- Delivery interface (§2.1) ----------

/** Response/request body — raw bytes. Text is a special case decoded by the consumer. */
export type Body = Uint8Array

/** A multipart request. Parts are assembled into FormData on the transport side (§4.4). */
export interface MultipartBody {
  kind: 'multipart'
  /** Text form fields, insertion order preserved. */
  fields: Record<string, string>
  /** Optional single file part. */
  file?: { field: string; bytes: Body; filename: string; mime: string }
}

export interface WebRequest {
  method: string
  url: string
  headers?: Record<string, string>
  /** string → utf-8 bytes; MultipartBody → assembled as FormData (§4.4). */
  body?: Body | string | MultipartBody
}

export interface WebResponse {
  status: number
  /** For cdp transport these are trimmed by the browser (§2.4) — no Set-Cookie. */
  headers: Record<string, string>
  /** Raw bytes. Not parsed; format unknown. */
  body: Body
}

/** A transport: the physical "how a request travels" (§2.2). */
export interface Transport {
  deliver(req: WebRequest): AsyncResult<WebResponse>
}

// ---------- Adapter (§2.3) ----------

export interface Adapter {
  /**
   * Deliver a request through this adapter's transport and auth.
   * Transparently re-authenticates exactly once on 401/403 (§3.4).
   */
  deliver(req: WebRequest): AsyncResult<WebResponse>
  readonly domain: string
  /** 'fetch' | 'cdp' | future — open string (§1.3), not a closed union. */
  readonly transport: string
}

// ---------- cdp transport options (§4) ----------

export type CdpCredentials = 'omit' | 'include'

export interface CdpTransportOptions {
  /** Fixed remote-debugging port from the profile (§4.2). */
  port: number
  /** Origin of the site — the in-page fetch runs on a tab at this origin (§4.6). */
  origin: string
  /** Chrome user-data-dir with the logged-in session. */
  userDataDir?: string
  /** Path to chrome.exe; default is the standard install path. */
  exe?: string
  /** Extra launch flags. */
  flags?: string[]
  /** credentials mode for the in-page fetch (default per site). */
  credentials?: CdpCredentials
  /**
   * Close Chrome after delivery IF this call started it (didStart). Default false —
   * Chrome stays alive, cheaper for the next call (§4.5).
   */
  autoClose?: boolean
}

// ---------- Chrome supervisor (§4.1) ----------

export interface ChromeSpec {
  /** Fixed port, from the profile. */
  port: number
  userDataDir: string
  /** For cdp delivery: guarantee a tab on this origin (§4.6). */
  origin?: string
  /** Path to chrome.exe; default from config. */
  exe?: string
  flags?: string[]
}

export interface ChromeHandle {
  port: number
  /** true = supervisor launched it; false = it was already alive. */
  didStart: boolean
}

// ---------- CDP client (§4.4) ----------

export interface CdpCookie {
  name: string
  value: string
  domain: string
  path?: string
  expires?: number
  size?: number
  httpOnly?: boolean
  secure?: boolean
  session?: boolean
  sameSite?: string
}

export interface CdpHandle {
  /** Runtime.evaluate with awaitPromise + returnByValue. Basis of cdp delivery and auth scripts. */
  eval<T = unknown>(expression: string): AsyncResult<T>
  /** Network.getCookies for a domain. */
  cookies(domain?: string): AsyncResult<CdpCookie[]>
  close(): void
}

export interface TabInfo {
  index: number
  title: string
  url: string
  /** Raw target id (for tab selection). */
  id?: string
}

// ---------- Auth script (§3.4) ----------

export interface AuthResult {
  /** Headers to hang on every request of this adapter. */
  headers?: Record<string, string>
}

export interface AuthHelpers {
  /** Bare fetchTransport (refresh requests), regardless of the profile transport. */
  fetch(req: WebRequest): AsyncResult<WebResponse>
  log(msg: string): void
}

/**
 * Inline `## $auth` script contract. `cdp` is a CdpHandle for cdp transport,
 * null for fetch transport (do refresh via helpers.fetch).
 */
export type AuthScript = (
  cdp: CdpHandle | null,
  helpers: AuthHelpers,
) => Promise<AuthResult>

// ---------- Devtools (§5) ----------

export interface DevtoolsCaptured {
  method: string
  url: string
  requestHeaders: Record<string, string>
  requestBody?: string
  status?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
}

export interface Devtools {
  /** Listen to a tab's network for N seconds. Captures request AND response (with bodies). */
  listen(opts: {
    port: number
    tab?: string
    filter?: string
    seconds: number
  }): AsyncResult<DevtoolsCaptured[]>
  /** Read cookies. */
  cookies(opts: { port: number; domain?: string }): AsyncResult<CdpCookie[]>
  /** Evaluate JS in the page. */
  eval<T = unknown>(opts: { port: number; tab?: string; expression: string }): AsyncResult<T>
  /** List tabs. */
  tabs(opts: { port: number }): AsyncResult<TabInfo[]>
  /** Full page HTML. */
  html(opts: { port: number; tab?: string; maxLength?: number }): AsyncResult<string>
  /** Screenshot of tab/element (PNG bytes). */
  screenshot(opts: { port: number; tab?: string; selector?: string }): AsyncResult<Body>
}
