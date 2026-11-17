/**
 * @kerneldreams/runz-runtime/web — HTTP-сервис поверх runtime
 *
 * Тот же runtime, тот же реестр скриптов, вызов через API.
 *
 *   POST /run      { script, args }  → запуск скрипта
 *   GET  /scripts                    → список скриптов
 *
 * Bearer auth: с ключом доступен извне, без ключа — только localhost.
 */

import * as http from 'node:http'
import { execute, listScripts, findProjectDir, isServiceResult } from '../index.ts'
import type { Value } from '@kerneldreams/nrd'

export interface ServeOptions {
  /** Listen port. */
  port: number
  /** Bearer API key. Without it the server binds to localhost only. */
  key?: string
  /** Bind host. Defaults: `0.0.0.0` with a key, `127.0.0.1` without. */
  host?: string
  /** Working directory for script resolution. Default `process.cwd()`. */
  cwd?: string
}

export interface ServeHandle {
  server: http.Server
  port: number
  url: string
  close(): Promise<void>
}

interface RunBody {
  script?: string
  args?: Record<string, Value>
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', c => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJSON(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body)
}

/** Start the HTTP service. Resolves once the server is listening. */
export function serve(opts: ServeOptions): Promise<ServeHandle> {
  const cwd = opts.cwd ?? process.cwd()
  const host = opts.host ?? (opts.key ? '0.0.0.0' : '127.0.0.1')

  const authorized = (req: http.IncomingMessage): boolean => {
    if (!opts.key) return true
    const header = req.headers['authorization']
    return header === `Bearer ${opts.key}`
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch(err => {
      sendJSON(res, 500, { error: err instanceof Error ? err.message : String(err) })
    })
  })

  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/'

    if (!authorized(req)) {
      sendJSON(res, 401, { error: 'unauthorized' })
      return
    }

    if (req.method === 'GET' && url === '/scripts') {
      const scripts = listScripts({ cwd, projectDir: findProjectDir(cwd), paths: [] })
      sendJSON(res, 200, { scripts })
      return
    }

    if (req.method === 'POST' && url === '/run') {
      const raw = await readBody(req)
      let body: RunBody
      try {
        body = raw ? (JSON.parse(raw) as RunBody) : {}
      } catch {
        sendJSON(res, 400, { error: 'invalid JSON body' })
        return
      }
      if (!body.script) {
        sendJSON(res, 400, { error: 'missing "script"' })
        return
      }
      try {
        const { result } = await execute({
          script: body.script,
          args: body.args ?? {},
          cwd,
        })
        if (isServiceResult(result)) {
          sendJSON(res, 200, { pid: result.pid, url: result.url, log: result.log })
        } else {
          sendJSON(res, 200, { output: result.output ?? '', exitCode: result.exitCode ?? 0 })
        }
      } catch (err) {
        sendJSON(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
      return
    }

    sendJSON(res, 404, { error: 'not found' })
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, host, () => {
      server.removeListener('error', reject)
      resolve({
        server,
        port: opts.port,
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${opts.port}`,
        close: () => new Promise<void>(r => server.close(() => r())),
      })
    })
  })
}
