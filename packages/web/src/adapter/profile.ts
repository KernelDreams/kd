// Profile field reading (spec §3.2). A profile is data: flat named keys per
// transport, plus an optional `## $auth` script block.

import { isJson5Object } from '@kerneldreams/nrd'
import type { Document, Block, AttributeValue } from '@kerneldreams/nrd'

/** Last-wins scalar text of an attribute value (InterpolatedValue → its raw text). */
function attrText(v: AttributeValue | undefined): string | undefined {
  if (v === undefined) return undefined
  if (Array.isArray(v)) return undefined
  if (v === null) return undefined
  // JSON5-объект — не текст профиля; гард обязан стоять до 'raw' in v
  // (Json5Object — plain-объект, ключ raw в нём — пользовательские данные).
  if (isJson5Object(v)) return undefined
  if (typeof v === 'object' && 'raw' in v) return (v as { raw: string }).raw
  return String(v)
}

/** Read a root attribute by name (last-wins, §2.4). */
function readAttr(root: Block, name: string): string | undefined {
  let result: string | undefined
  for (const a of root.attrs) {
    if (a.key.join('.') === name) result = attrText(a.value)
  }
  return result
}

/** Read an attribute as a flag list (flow-list or whitespace-split string). */
function readFlags(root: Block, name: string): string[] | undefined {
  let val: AttributeValue | undefined
  for (const a of root.attrs) {
    if (a.key.join('.') === name) val = a.value
  }
  if (val === undefined) return undefined
  if (Array.isArray(val)) {
    return val.map((e) => attrText(e as AttributeValue) ?? '').filter(Boolean)
  }
  const text = attrText(val)
  if (!text) return undefined
  return text.split(/\s+/).filter(Boolean)
}

export interface ProfileFields {
  domain?: string
  transport?: string
  // fetch
  authHeader?: string
  authScheme?: string
  token?: string
  // cdp
  userDataDir?: string
  port?: number
  origin?: string
  chromeFlags?: string[]
  exe?: string
  credentials?: 'omit' | 'include'
}

export function readProfileFields(doc: Document): ProfileFields {
  const root = doc.root
  const portRaw = readAttr(root, 'port')
  const port = portRaw !== undefined ? Number(portRaw) : undefined
  const credRaw = readAttr(root, 'cdp-credentials')
  const credentials = credRaw === 'omit' || credRaw === 'include' ? credRaw : undefined

  return {
    domain: readAttr(root, 'domain'),
    transport: readAttr(root, 'transport'),
    authHeader: readAttr(root, 'auth-header'),
    authScheme: readAttr(root, 'auth-scheme'),
    token: readAttr(root, 'token'),
    userDataDir: readAttr(root, 'user-data-dir'),
    port: Number.isFinite(port) ? port : undefined,
    origin: readAttr(root, 'origin'),
    chromeFlags: readFlags(root, 'chrome-flags'),
    exe: readAttr(root, 'chrome-exe'),
    credentials,
  }
}

/** Body of the `## $auth` block, if present (the inline auth script, §3.4). */
export function extractAuthScript(doc: Document): string | undefined {
  const authBlock = doc.root.children.find((c: Block) => c.name === 'auth')
  if (!authBlock) return undefined
  const body = authBlock.body
  if (body === undefined) return undefined
  const text = typeof body === 'string' ? body : body.raw
  return text.trim() ? text : undefined
}
