/**
 * Тулы сервисов хаба nrchat: `$hub` машины — адрес хаба (`http://127.0.0.1:7800/api`), `$hub_services` —
 * какие сервисы (по умолчанию `archive`). Список — `POST {hub}/services/<сервис>/tools`, вызов —
 * `POST {hub}/services/<сервис>/tool {name, args, session}`: те же `archive_search`/`archive_read`…, что у агентов
 * nrchat, — коннектору claude.ai. Хаб лёг на старте — повтор раз в минуту, тулы машины работают без них.
 * `$hub_key` — bearer хаба, если он за ключом.
 */

import type { ToolDef, ToolResult } from '@kerneldreams/tools'

export interface HubOptions {
  url: string
  services: string[]
  key?: string
  fetch?: typeof fetch
}

type Def = { name: string; description: string; schema: Record<string, unknown> }

async function call(o: HubOptions, service: string, method: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await (o.fetch ?? fetch)(`${o.url.replace(/\/+$/, '')}/services/${encodeURIComponent(service)}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) },
    body: JSON.stringify({ args }),
    ...(signal ? { signal } : {}),
  })
  const j = (await res.json().catch(() => null)) as { ok?: boolean; result?: unknown; error?: { message?: string } } | null
  if (!res.ok || !j?.ok) throw new Error(`хаб ${service}.${method}: ${j?.error?.message ?? res.status}`)
  return j.result
}

/** Тулы сервисов хаба как `ToolDef` машины. */
export async function loadHubTools(o: HubOptions): Promise<ToolDef[]> {
  const out: ToolDef[] = []
  for (const service of o.services) {
    const defs = (await call(o, service, 'tools', {})) as Def[]
    for (const d of Array.isArray(defs) ? defs : [])
      out.push({
        name: d.name,
        description: d.description,
        schema: d.schema,
        executor: 'backend',
        source: 'service',
        async execute(args, ctx): Promise<ToolResult> {
          const r = (await call(o, service, 'tool', { name: d.name, args, session: { id: `mcp:${ctx.sessionId ?? ''}` } }, ctx.signal)) as Partial<ToolResult> | null
          return { text: typeof r?.text === 'string' ? r.text : JSON.stringify(r), ...(r?.isError ? { isError: true } : {}) }
        },
      })
  }
  return out
}

/** Подгрузить в живой список тулов машины; неудача — повтор через `retryMs`. */
export function attachHubTools(tools: ToolDef[], o: HubOptions, log: (m: string) => void, retryMs = 60_000): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const tryLoad = (): void => {
    loadHubTools(o)
      .then((ts) => {
        if (stopped) return
        for (const t of ts) if (!tools.some((x) => x.name === t.name)) tools.push(t)
        log(`хаб ${o.url}: тулы ${ts.map((t) => t.name).join(', ') || '—'}`)
      })
      .catch((e: unknown) => {
        if (stopped) return
        log(`хаб ${o.url}: ${(e as Error).message} — повтор через ${Math.round(retryMs / 1000)} с`)
        timer = setTimeout(tryLoad, retryMs)
        timer.unref?.()
      })
  }
  tryLoad()
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
