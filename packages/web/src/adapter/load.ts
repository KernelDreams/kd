// loadAdapter — find profile, parse mdz, resolve $[[include]], build transport + auth,
// wrap with one-shot 401/403 re-auth (spec §2.3, §3, §3.4).

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type AsyncResult, ok, err } from '@kerneldreams/nrd'
import { parse, resolveIncludesAsync } from '@kerneldreams/nrd'
import type {
  Adapter,
  WebRequest,
  WebResponse,
  AuthResult,
  AuthHelpers,
  CdpHandle,
} from '../types.js'
import { fetchTransport } from '../transport/fetch.js'
import { cdpTransport } from '../transport/cdp.js'
import { cdpConnect } from '../chrome/cdp-client.js'
import { readProfileFields, extractAuthScript } from './profile.js'
import { compileAuthScript } from './auth-script.js'
import type { Transport } from '../types.js'

// ---------- Profile lookup (§3.3) ----------

interface FoundProfile {
  path: string
  dir: string
  text: string
}

async function tryReadFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return undefined
  }
}

/**
 * Resolve `name` to a profile file across `roots` (§3.3).
 *  - `name` with `/` → direct `<root>/<name>.mdz`.
 *  - short name → search `<root>/<subdir>/<name>.mdz`.
 *  - only `.mdz`; `_`-prefixed files are never profiles (base fragments).
 *  - ambiguous short name (two domains) → err, ask for the full name.
 */
async function findProfile(name: string, roots: string[]): AsyncResult<FoundProfile> {
  const hasSlash = name.includes('/')
  const rel = name.endsWith('.mdz') ? name : name + '.mdz'
  const baseName = (hasSlash ? name.slice(name.lastIndexOf('/') + 1) : name)
  if (baseName.startsWith('_')) {
    return err(new Error('profile "' + name + '": names starting with "_" are not profiles'))
  }

  if (hasSlash) {
    for (const root of roots) {
      const path = join(root, rel)
      const text = await tryReadFile(path)
      if (text !== undefined) {
        return ok({ path, dir: join(path, '..'), text })
      }
    }
    return err(new Error('profile "' + name + '" not found in roots: ' + roots.join(', ')))
  }

  // short name — scan each root's immediate subdirectories.
  const matches: FoundProfile[] = []
  for (const root of roots) {
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const dirent of entries) {
      if (!dirent.isDirectory()) continue
      const path = join(root, dirent.name, baseName + '.mdz')
      const text = await tryReadFile(path)
      if (text !== undefined) {
        matches.push({ path, dir: join(root, dirent.name), text })
      }
    }
  }

  if (matches.length === 0) {
    return err(new Error('profile "' + name + '" not found in roots: ' + roots.join(', ')))
  }
  if (matches.length > 1) {
    const where = matches.map((m) => m.path).join(', ')
    return err(
      new Error('profile "' + name + '" is ambiguous (' + where + '); use a full name like "<domain>/' + name + '"'),
    )
  }
  return ok(matches[0])
}

/** Include reader: `$[[_base.md]]` relative to profile dir, then roots. */
function makeIncludeReader(
  profileDir: string,
  roots: string[],
): (p: string) => Promise<string | undefined> {
  return async (p: string) => {
    const candidates = [join(profileDir, p), ...roots.map((r) => join(r, p))]
    for (const cand of candidates) {
      const text = await tryReadFile(cand)
      if (text !== undefined) return text
    }
    return undefined
  }
}

// ---------- Adapter assembly ----------

export async function loadAdapter(profileName: string, roots: string[]): AsyncResult<Adapter> {
  const found = await findProfile(profileName, roots)
  if (!found.ok) return found

  // 2. resolve $[[include]] (base config), then parse.
  let resolved: string
  try {
    resolved = await resolveIncludesAsync(found.value.text, makeIncludeReader(found.value.dir, roots))
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  }
  const doc = parse(resolved, { sigil: '$' })
  const fields = readProfileFields(doc)

  if (!fields.transport) {
    return err(new Error('profile "' + profileName + '": missing $transport'))
  }
  const domain = fields.domain ?? ''
  const transportName = fields.transport
  const authScriptCode = extractAuthScript(doc)

  // 3. build transport by $transport.
  let transport: Transport
  if (transportName === 'fetch') {
    transport = fetchTransport()
  } else if (transportName === 'cdp') {
    if (fields.port === undefined) {
      return err(new Error('profile "' + profileName + '": cdp transport requires $port'))
    }
    if (!fields.origin) {
      return err(new Error('profile "' + profileName + '": cdp transport requires $origin (§4.6)'))
    }
    transport = cdpTransport({
      port: fields.port,
      origin: fields.origin,
      userDataDir: fields.userDataDir,
      exe: fields.exe,
      flags: fields.chromeFlags,
      credentials: fields.credentials,
    })
  } else {
    return err(
      new Error('profile "' + profileName + '": unknown $transport "' + transportName + '" (v1: fetch | cdp)'),
    )
  }

  // 4. auth. Static headers for fetch; script overlay if `## $auth` present.
  function computeStaticHeaders(): Record<string, string> {
    const headers: Record<string, string> = {}
    if (transportName === 'fetch' && fields.authHeader && fields.token) {
      const scheme = fields.authScheme ? fields.authScheme + ' ' : ''
      headers[fields.authHeader] = scheme + fields.token
    }
    return headers
  }

  let cachedAuth: AuthResult | null = null
  let compiled: import('../types.js').AuthScript | null = null

  async function ensureAuth(): AsyncResult<AuthResult> {
    if (cachedAuth) return ok(cachedAuth)
    const staticHeaders = computeStaticHeaders()

    if (!authScriptCode) {
      cachedAuth = { headers: staticHeaders }
      return ok(cachedAuth)
    }

    if (!compiled) {
      const c = await compileAuthScript(authScriptCode)
      if (!c.ok) return c
      compiled = c.value
    }

    // cdp handle for the script (cdp transport only; null for fetch — §3.4).
    let cdp: CdpHandle | null = null
    if (transportName === 'cdp' && fields.port !== undefined && fields.origin) {
      const h = await cdpConnect(fields.port, fields.origin)
      if (!h.ok) return h
      cdp = h.value
    }
    const helpers: AuthHelpers = {
      fetch: (r) => fetchTransport().deliver(r),
      log: () => {},
    }
    try {
      const result = await compiled(cdp, helpers)
      cachedAuth = { headers: { ...staticHeaders, ...(result?.headers ?? {}) } }
      return ok(cachedAuth)
    } catch (e) {
      return err(e instanceof Error ? e : new Error(String(e)))
    } finally {
      cdp?.close()
    }
  }

  async function applyAuth(req: WebRequest): AsyncResult<WebRequest> {
    const a = await ensureAuth()
    if (!a.ok) return a
    return ok({ ...req, headers: { ...(req.headers ?? {}), ...(a.value.headers ?? {}) } })
  }

  const adapter: Adapter = {
    domain,
    transport: transportName,
    async deliver(req: WebRequest): AsyncResult<WebResponse> {
      const applied = await applyAuth(req)
      if (!applied.ok) return applied
      let res = await transport.deliver(applied.value)
      if (!res.ok) return res

      // Re-auth exactly once on 401/403 — only when there's a script to re-run (§3.4).
      if ((res.value.status === 401 || res.value.status === 403) && authScriptCode) {
        cachedAuth = null // invalidate
        const reapplied = await applyAuth(req)
        if (!reapplied.ok) return reapplied
        res = await transport.deliver(reapplied.value)
      }
      return res
    },
  }

  return ok(adapter)
}
