// Chrome supervisor (spec §4.1–§4.6). ensureChrome / killChrome.
//
// Rules that are non-negotiable (§7.6):
//  - NEVER taskkill by process name. killChrome uses Browser.close on the port.
//  - killChrome is only ever called when didStart === true (we launched it).

import { spawn } from 'node:child_process'
import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import type { ChromeSpec, ChromeHandle } from '../types.js'
import {
  CDPClient,
  getTabs,
  newTab,
  browserWsUrl,
} from './cdp-client.js'

/** Standard Chrome install path on Windows; override via ChromeSpec.exe / _base.md. */
const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const LAUNCH_TIMEOUT = 15000
const POLL_INTERVAL = 250

function base(port: number): string {
  return 'http://localhost:' + port
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** Is a Chrome alive on this port (does /json/version answer)? */
async function isAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(base(port) + '/json/version')
    return res.ok
  } catch {
    return false
  }
}

/**
 * Build the launch command from ChromeSpec fields (§4.3). Not stored as a ready
 * string — assembled from named keys so the Chrome path/flags stay centralizable.
 */
export function buildChromeCommand(spec: ChromeSpec): { exe: string; args: string[] } {
  const exe = spec.exe ?? DEFAULT_CHROME
  const args = [
    '--remote-debugging-port=' + spec.port,
    '--user-data-dir=' + spec.userDataDir,
    ...(spec.flags ?? []),
  ]
  return { exe, args }
}

/** Launch Chrome detached — it outlives this call (a long-lived resource). */
function launch(spec: ChromeSpec): void {
  const { exe, args } = buildChromeCommand(spec)
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

/**
 * Guarantee a page tab on `origin` (§4.6). In-page fetch runs in a tab's context;
 * the tab must be on the site origin or the response body is CORS-clipped and
 * same-origin cookies won't be sent.
 */
export async function ensureOriginTab(port: number, origin: string): AsyncResult<void> {
  const r = await getTabs(port)
  if (!r.ok) return r
  const existing = r.value.find((t) => t.type === 'page' && t.url.startsWith(origin))
  if (existing) return ok(undefined)

  const created = await newTab(port, origin)
  if (!created.ok) return created

  // Wait for domcontentloaded on the new tab.
  if (!created.value.webSocketDebuggerUrl) {
    // No debugger URL yet — give the tab a moment and accept it (best effort).
    await sleep(POLL_INTERVAL)
    return ok(undefined)
  }
  try {
    const client = new CDPClient(created.value.webSocketDebuggerUrl)
    await client.connect()
    try {
      const deadline = Date.now() + LAUNCH_TIMEOUT
      while (Date.now() < deadline) {
        const res = await client.send<any>('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        })
        const state = res.result?.value
        if (state === 'interactive' || state === 'complete') return ok(undefined)
        await sleep(POLL_INTERVAL)
      }
      return err(new Error('origin tab did not reach domcontentloaded: ' + origin))
    } finally {
      client.close()
    }
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}

/**
 * Ensure a Chrome is available on the fixed port (§4.1):
 *  1. alive → connect to it, didStart:false (opened by hand / previous call)
 *  2. dead  → launch, poll /json/version until up, didStart:true
 *  3. if origin given → guarantee a tab on it (§4.6)
 */
export async function ensureChrome(spec: ChromeSpec): AsyncResult<ChromeHandle> {
  const alive = await isAlive(spec.port)
  let didStart = false

  if (!alive) {
    try {
      launch(spec)
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)))
    }
    const deadline = Date.now() + LAUNCH_TIMEOUT
    let up = false
    while (Date.now() < deadline) {
      if (await isAlive(spec.port)) {
        up = true
        break
      }
      await sleep(POLL_INTERVAL)
    }
    if (!up) return err(new Error('Chrome did not come up on port ' + spec.port))
    didStart = true
  }

  if (spec.origin) {
    const tab = await ensureOriginTab(spec.port, spec.origin)
    if (!tab.ok) return tab
  }

  return ok({ port: spec.port, didStart })
}

/**
 * Close the whole Chrome on this port via CDP Browser.close (§4.1). Clean, no pid
 * hunting. Caller MUST only invoke this when didStart === true (§4.5).
 */
export async function killChrome(port: number): AsyncResult<void> {
  const wsUrl = await browserWsUrl(port)
  if (!wsUrl.ok) return wsUrl
  try {
    const client = new CDPClient(wsUrl.value)
    await client.connect()
    try {
      await client.send('Browser.close')
    } catch {
      // Browser.close tears down the socket; a post-close error is expected.
    }
    client.close()
    return ok(undefined)
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
}
