// Devtools — observation/introspection (spec §5). Neighbour of delivery: same
// live Chrome, same CDP client, different consumer (human + recon feeding the
// contract layer's golden-sample). Returns objects, NOT TOON (§7.11).

import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import type { Devtools, DevtoolsCaptured, CdpCookie, TabInfo, Body } from '../types.js'
import { connectTab, tabInfos } from '../chrome/cdp-client.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export function devtools(): Devtools {
  return {
    async listen(opts): AsyncResult<DevtoolsCaptured[]> {
      const r = await connectTab(opts.port, opts.tab)
      if (!r.ok) return r
      const { client } = r.value
      try {
        await client.send('Network.enable')
        const captured = new Map<string, DevtoolsCaptured>()
        const order: string[] = []
        const filter = opts.filter?.toLowerCase()

        client.on('Network.requestWillBeSent', (p: any) => {
          const url: string = p.request.url
          if (filter && !url.toLowerCase().includes(filter)) return
          captured.set(p.requestId, {
            method: p.request.method,
            url,
            requestHeaders: p.request.headers ?? {},
            requestBody: p.request.postData,
          })
          order.push(p.requestId)
        })
        client.on('Network.responseReceived', (p: any) => {
          const cap = captured.get(p.requestId)
          if (!cap) return
          cap.status = p.response.status
          cap.responseHeaders = p.response.headers ?? {}
        })

        await sleep(Math.max(0, opts.seconds) * 1000)

        // Pull response bodies (Network.getResponseBody) for what we captured.
        for (const id of order) {
          const cap = captured.get(id)
          if (!cap) continue
          try {
            const b = await client.send<any>('Network.getResponseBody', { requestId: id })
            cap.responseBody = b.base64Encoded
              ? Buffer.from(b.body, 'base64').toString('utf-8')
              : b.body
          } catch {
            // Body not retained/available — leave undefined.
          }
        }

        try {
          await client.send('Network.disable')
        } catch {
          /* ignore */
        }
        const result = order
          .map((id) => captured.get(id))
          .filter((c): c is DevtoolsCaptured => c !== undefined)
        return ok(result)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      } finally {
        client.close()
      }
    },

    async cookies(opts): AsyncResult<CdpCookie[]> {
      const r = await connectTab(opts.port)
      if (!r.ok) return r
      const { client } = r.value
      try {
        const params = opts.domain ? { urls: ['https://' + opts.domain] } : {}
        const res = await client.send<{ cookies: CdpCookie[] }>('Network.getCookies', params)
        return ok(res.cookies)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      } finally {
        client.close()
      }
    },

    async eval<T = unknown>(opts: { port: number; tab?: string; expression: string }): AsyncResult<T> {
      const r = await connectTab(opts.port, opts.tab)
      if (!r.ok) return r
      const { client } = r.value
      try {
        const res = await client.send<any>('Runtime.evaluate', {
          expression: opts.expression,
          returnByValue: true,
          awaitPromise: true,
        })
        if (res.exceptionDetails) {
          const text =
            res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'eval exception'
          return err(new Error(text))
        }
        return ok(res.result?.value as T)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      } finally {
        client.close()
      }
    },

    async tabs(opts): AsyncResult<TabInfo[]> {
      return tabInfos(opts.port)
    },

    async html(opts): AsyncResult<string> {
      const r = await connectTab(opts.port, opts.tab)
      if (!r.ok) return r
      const { client } = r.value
      try {
        const res = await client.send<any>('Runtime.evaluate', {
          expression: 'document.documentElement.outerHTML',
          returnByValue: true,
        })
        let html: string = res.result?.value ?? ''
        const max = opts.maxLength
        if (max !== undefined && html.length > max) {
          html = html.slice(0, max) + '\n<!-- truncated -->'
        }
        return ok(html)
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      } finally {
        client.close()
      }
    },

    async screenshot(opts): AsyncResult<Body> {
      const r = await connectTab(opts.port, opts.tab)
      if (!r.ok) return r
      const { client } = r.value
      try {
        let clip: Record<string, number> | undefined
        if (opts.selector) {
          const rectRes = await client.send<any>('Runtime.evaluate', {
            expression:
              'JSON.stringify(document.querySelector(' +
              JSON.stringify(opts.selector) +
              ')?.getBoundingClientRect())',
            returnByValue: true,
          })
          const rect = rectRes.result?.value ? JSON.parse(rectRes.result.value) : null
          if (!rect) return err(new Error('element not found: ' + opts.selector))
          clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
        }
        const shot = await client.send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          ...(clip ? { clip } : {}),
        })
        return ok(new Uint8Array(Buffer.from(shot.data, 'base64')))
      } catch (e) {
        return err(e instanceof Error ? e : new Error(String(e)))
      } finally {
        client.close()
      }
    },
  }
}
