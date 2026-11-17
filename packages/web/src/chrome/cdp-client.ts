// Minimal CDP client over WebSocket (Node 22+ built-in). Spec §4.4.
// Extracted from S:\mcp\laptop-v2\commands\chrome.js (class CDPClient) into
// reusable, Result-wrapped library code. Both cdp delivery and devtools stand on it.

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import type { CdpHandle, CdpCookie, TabInfo } from '../types.js'

const DEFAULT_CMD_TIMEOUT = 15000

/** Raw /json/list entry. */
export interface RawTab {
  id?: string
  title: string
  url: string
  type?: string
  webSocketDebuggerUrl?: string
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** Low-level CDP connection. Methods reject on error; boundary functions wrap in Result. */
export class CDPClient {
  private ws: WebSocket | null = null
  private id = 0
  private pending = new Map<number, Pending>()
  private listeners = new Map<string, Array<(params: any) => void>>()

  constructor(
    private readonly wsUrl: string,
    private readonly cmdTimeout = DEFAULT_CMD_TIMEOUT,
  ) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl)
      this.ws = ws
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', () => reject(new Error('CDP connect failed: ' + this.wsUrl)))
      ws.addEventListener('message', (event: any) => {
        const data = typeof event.data === 'string' ? event.data : String(event.data)
        let msg: any
        try {
          msg = JSON.parse(data)
        } catch {
          return
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new Error(msg.error.message ?? 'CDP error'))
          else p.resolve(msg.result)
        }
        if (msg.method) {
          const fns = this.listeners.get(msg.method)
          if (fns) for (const fn of fns) fn(msg.params)
        }
      })
    })
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error('CDP not connected'))
        return
      }
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP timeout: ' + method))
        }
      }, this.cmdTimeout)
    })
  }

  on(method: string, fn: (params: any) => void): void {
    const fns = this.listeners.get(method) ?? []
    fns.push(fn)
    this.listeners.set(method, fns)
  }

  close(): void {
    if (this.ws) {
      try {
        this.ws.close()
      } catch {
        /* already closed */
      }
      this.ws = null
    }
  }
}

// ---------- HTTP endpoints of the DevTools remote debugging server ----------

function base(port: number): string {
  // Local Chrome only. The "never localhost" rule is about external services (§7.13).
  return 'http://localhost:' + port
}

/** GET /json/list → all targets. */
export async function getTabs(port: number): AsyncResult<RawTab[]> {
  try {
    const res = await fetch(base(port) + '/json/list')
    const tabs = (await res.json()) as RawTab[]
    return ok(tabs)
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}

/** Page-type tabs as consumer-facing TabInfo. */
export async function tabInfos(port: number): AsyncResult<TabInfo[]> {
  const r = await getTabs(port)
  if (!r.ok) return r
  const pages = r.value.filter((t) => t.type === 'page')
  return ok(
    pages.map((t, i) => ({ index: i, title: t.title, url: t.url, id: t.id })),
  )
}

/** Resolve a raw page tab by ref (index, url/title substring, or first). */
export function pickTab(tabs: RawTab[], ref?: string): RawTab | undefined {
  const pages = tabs.filter((t) => t.type === 'page')
  if (pages.length === 0) return undefined
  if (!ref) return pages[0]
  if (/^\d+$/.test(ref)) {
    const idx = parseInt(ref, 10)
    if (idx < pages.length) return pages[idx]
  }
  const low = ref.toLowerCase()
  return (
    pages.find(
      (t) => t.url.toLowerCase().includes(low) || t.title.toLowerCase().includes(low),
    ) ?? pages[0]
  )
}

/** Connect a CDPClient to a resolved tab. */
export async function connectTab(
  port: number,
  ref?: string,
): AsyncResult<{ client: CDPClient; tab: RawTab }> {
  const r = await getTabs(port)
  if (!r.ok) return r
  const tab = pickTab(r.value, ref)
  if (!tab) return err(new Error('No page tabs found on port ' + port))
  if (!tab.webSocketDebuggerUrl) {
    return err(new Error('Tab "' + tab.title + '" has no debugger URL'))
  }
  try {
    const client = new CDPClient(tab.webSocketDebuggerUrl)
    await client.connect()
    return ok({ client, tab })
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}

/** Create a new tab navigated to url (PUT /json/new?<url>). */
export async function newTab(port: number, url: string): AsyncResult<RawTab> {
  try {
    const res = await fetch(base(port) + '/json/new?' + url, { method: 'PUT' })
    if (!res.ok) {
      // Older Chrome only accepts GET for /json/new.
      const res2 = await fetch(base(port) + '/json/new?' + url)
      if (!res2.ok) return err(new Error('newTab failed: HTTP ' + res.status))
      return ok((await res2.json()) as RawTab)
    }
    return ok((await res.json()) as RawTab)
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}

/** Browser-level WebSocket endpoint from /json/version (for Browser.close). */
export async function browserWsUrl(port: number): AsyncResult<string> {
  try {
    const res = await fetch(base(port) + '/json/version')
    const data = (await res.json()) as { webSocketDebuggerUrl?: string }
    if (!data.webSocketDebuggerUrl) return err(new Error('No browser debugger URL on port ' + port))
    return ok(data.webSocketDebuggerUrl)
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}

// ---------- CdpHandle (§4.4) ----------

/** Build a CdpHandle over a connected client. */
export function handleOver(client: CDPClient): CdpHandle {
  return {
    async eval<T = unknown>(expression: string): AsyncResult<T> {
      try {
        const res = await client.send<any>('Runtime.evaluate', {
          expression,
          returnByValue: true,
          awaitPromise: true,
        })
        if (res.exceptionDetails) {
          const text =
            res.exceptionDetails.exception?.description ??
            res.exceptionDetails.text ??
            'eval exception'
          return err(new Error(text))
        }
        return ok(res.result?.value as T)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },
    async cookies(domain?: string): AsyncResult<CdpCookie[]> {
      try {
        const params = domain ? { urls: ['https://' + domain] } : {}
        const res = await client.send<{ cookies: CdpCookie[] }>('Network.getCookies', params)
        return ok(res.cookies)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      }
    },
    close() {
      client.close()
    },
  }
}

/** Connect and return a CdpHandle for the tab (§4.4). */
export async function cdpConnect(port: number, tabRef?: string): AsyncResult<CdpHandle> {
  const r = await connectTab(port, tabRef)
  if (!r.ok) return r
  return ok(handleOver(r.value.client))
}
