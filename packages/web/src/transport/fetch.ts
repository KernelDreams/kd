// fetchTransport — bare HTTP over globalThis.fetch (undici, Node 18+). Spec §1.1, §2.2.
// Stateless. body in/out as Uint8Array. Predictable errors → err, never throws.

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import type { Transport, WebRequest, WebResponse, MultipartBody } from '../types.js'

/**
 * Delivery limits. All optional — without them the transport behaves exactly
 * like bare fetch (no timeout, unbounded body, redirects followed).
 *
 * Errors are told apart by `error.name`: `TimeoutError` (timeoutMs elapsed),
 * `BodyTooLargeError` (maxBytes exceeded), `AbortError` (external signal).
 */
export interface FetchTransportOptions {
  /** Whole delivery (headers + body) budget in ms. */
  timeoutMs?: number
  /** Max response body bytes; the read is cancelled as soon as it is exceeded. */
  maxBytes?: number
  /**
   * `follow` (default) — fetch follows redirects itself. `manual` — a 3xx is
   * returned as is (with `location`), the caller decides whether to follow
   * (e.g. to re-validate every hop).
   */
  redirect?: 'follow' | 'manual'
  /** External cancellation. */
  signal?: AbortSignal
}

function isMultipart(b: unknown): b is MultipartBody {
  return typeof b === 'object' && b !== null && (b as { kind?: string }).kind === 'multipart'
}

/** Build a BodyInit for global fetch from a WebRequest body. */
function toFetchBody(body: WebRequest['body']): BodyInit | undefined {
  if (body === undefined) return undefined
  if (typeof body === 'string') return body
  if (isMultipart(body)) {
    const fd = new FormData()
    for (const [k, v] of Object.entries(body.fields)) fd.append(k, v)
    if (body.file) {
      const blob = new Blob([body.file.bytes as BlobPart], { type: body.file.mime })
      fd.append(body.file.field, blob, body.file.filename)
    }
    // Content-Type is set by fetch with the correct boundary — do not set it by hand.
    return fd
  }
  // Uint8Array — raw bytes as the body.
  return body as unknown as BodyInit
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    out[key] = value
  })
  return out
}

function namedError(name: string, message: string): Error {
  const e = new Error(message)
  e.name = name
  return e
}

/** Read the body, cancelling the stream once it grows past maxBytes. */
async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {})
    throw namedError('BodyTooLargeError', `response body ${declared} bytes exceeds maxBytes ${maxBytes}`)
  }
  if (!res.body) return new Uint8Array(0)

  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw namedError('BodyTooLargeError', `response body exceeds maxBytes ${maxBytes}`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function fetchTransport(opts: FetchTransportOptions = {}): Transport {
  return {
    async deliver(req: WebRequest): AsyncResult<WebResponse> {
      const timeout = opts.timeoutMs !== undefined ? AbortSignal.timeout(opts.timeoutMs) : undefined
      const signals = [timeout, opts.signal].filter((s): s is AbortSignal => s !== undefined)
      const signal = signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals)

      try {
        const body = toFetchBody(req.body)
        const init: RequestInit = {
          method: req.method,
          headers: req.headers,
          body: body as BodyInit | undefined,
        }
        if (opts.redirect) init.redirect = opts.redirect
        if (signal) init.signal = signal

        const res = await fetch(req.url, init)
        const buf =
          opts.maxBytes !== undefined ? await readLimited(res, opts.maxBytes) : new Uint8Array(await res.arrayBuffer())
        return ok({
          status: res.status,
          headers: headersToObject(res.headers),
          body: buf,
        })
      } catch (e) {
        // The timeout signal aborts with a DOMException that does not say which
        // signal fired — ask the signals themselves.
        if (timeout?.aborted) return err(namedError('TimeoutError', `timed out after ${opts.timeoutMs} ms`))
        if (opts.signal?.aborted) return err(namedError('AbortError', 'aborted'))
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },
  }
}
