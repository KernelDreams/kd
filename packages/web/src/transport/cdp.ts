// cdpTransport — deliver a request as fetch() executed INSIDE a live Chrome (spec §1.2, §4.4).
//
// The request runs as fetch(url, init) in a tab on the site origin (§4.6). Three
// body directions: text/json (string), binary (base64 bridge), multipart
// (FormData assembled IN THE PAGE — boundary is the browser's, §4.4).

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import type {
  Transport,
  WebRequest,
  WebResponse,
  MultipartBody,
  CdpCredentials,
} from '../types.js'
import { ensureChrome, killChrome } from '../chrome/supervisor.js'
import { cdpConnect } from '../chrome/cdp-client.js'
import type { CdpTransportOptions } from '../types.js'

function isMultipart(b: unknown): b is MultipartBody {
  return typeof b === 'object' && b !== null && (b as { kind?: string }).kind === 'multipart'
}

function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

/** In-page expression that rebuilds bytes from base64. */
function bytesFromB64(base64: string): string {
  return `Uint8Array.from(atob(${JSON.stringify(base64)}), c => c.charCodeAt(0))`
}

/** Strip any content-type header (multipart boundary is the browser's — §4.4). */
function withoutContentType(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === 'content-type') continue
    out[k] = v
  }
  return out
}

/**
 * Build the in-page fetch expression from a WebRequest (spec §4.4). Pure and
 * deterministic — unit-tested directly (CDP mocked). Returns an async IIFE whose
 * value is `{ status, headers, bodyBase64 }`.
 */
export function buildFetchExpression(
  req: WebRequest,
  opts: { credentials?: CdpCredentials } = {},
): string {
  const body = req.body
  const multipart = isMultipart(body)
  const headers = multipart ? withoutContentType(req.headers ?? {}) : (req.headers ?? {})

  const lines: string[] = []
  lines.push('(async () => {')
  lines.push(`  const init = { method: ${JSON.stringify(req.method)}, headers: ${JSON.stringify(headers)} };`)
  if (opts.credentials) {
    lines.push(`  init.credentials = ${JSON.stringify(opts.credentials)};`)
  }

  if (typeof body === 'string') {
    lines.push(`  init.body = ${JSON.stringify(body)};`)
  } else if (body instanceof Uint8Array) {
    lines.push(`  init.body = ${bytesFromB64(b64(body))};`)
  } else if (multipart) {
    lines.push('  const __fd = new FormData();')
    for (const [k, v] of Object.entries(body.fields)) {
      lines.push(`  __fd.append(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
    }
    if (body.file) {
      const f = body.file
      lines.push(
        `  __fd.append(${JSON.stringify(f.field)}, new Blob([${bytesFromB64(b64(f.bytes))}], { type: ${JSON.stringify(f.mime)} }), ${JSON.stringify(f.filename)});`,
      )
    }
    // Content-Type intentionally NOT set — the browser adds it with the boundary.
    lines.push('  init.body = __fd;')
  }

  lines.push(`  const res = await fetch(${JSON.stringify(req.url)}, init);`)
  lines.push('  const buf = new Uint8Array(await res.arrayBuffer());')
  lines.push("  let bin = '';")
  lines.push('  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);')
  lines.push('  const headers = {};')
  lines.push('  res.headers.forEach((v, k) => { headers[k] = v; });')
  lines.push('  return { status: res.status, headers, bodyBase64: btoa(bin) };')
  lines.push('})()')
  return lines.join('\n')
}

interface PageFetchResult {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

export function cdpTransport(opts: CdpTransportOptions): Transport {
  return {
    async deliver(req: WebRequest): AsyncResult<WebResponse> {
      const chrome = await ensureChrome({
        port: opts.port,
        userDataDir: opts.userDataDir ?? '',
        origin: opts.origin,
        exe: opts.exe,
        flags: opts.flags,
      })
      if (!chrome.ok) return chrome

      const handleR = await cdpConnect(opts.port, opts.origin)
      if (!handleR.ok) return handleR
      const handle = handleR.value

      try {
        const expr = buildFetchExpression(req, { credentials: opts.credentials })
        const evalR = await handle.eval<PageFetchResult>(expr)
        if (!evalR.ok) return evalR
        const page = evalR.value
        if (!page || typeof page.status !== 'number') {
          return err(new Error('cdp delivery: unexpected in-page result'))
        }
        const bodyBytes = new Uint8Array(Buffer.from(page.bodyBase64 ?? '', 'base64'))
        return ok({ status: page.status, headers: page.headers ?? {}, body: bodyBytes })
      } finally {
        handle.close()
        if (opts.autoClose && chrome.value.didStart) {
          await killChrome(opts.port)
        }
      }
    },
  }
}
