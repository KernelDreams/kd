// Inline `## $auth` script — playground pattern (spec §3.4, §7.8).
// Block body → JS/ESM → temp file → dynamic import → default export.
//
// The script body must be valid ESM (the spec examples are plain JS arrow
// functions). We write it as `.mjs` and import it natively — no TS transform.

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Result, ok, err } from '@kerneldreams/nrd'
import type { AuthScript } from '../types.js'

/** Strip a leading/trailing ``` fence (bodies often arrive fenced as ```ts). */
export function stripFences(text: string): string {
  const lines = text.split('\n')
  if (lines[0]?.match(/^```\w*\s*$/)) lines.shift()
  if (lines[lines.length - 1]?.match(/^```\s*$/)) lines.pop()
  return lines.join('\n')
}

/**
 * Compile the `## $auth` block body into a callable AuthScript. Writes the code
 * to a temp `.mjs` and dynamic-imports its default export.
 */
export async function compileAuthScript(rawBody: string): Promise<Result<AuthScript>> {
  const code = stripFences(rawBody.trim())
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'nrweb-auth-'))
    const file = join(dir, 'auth.mjs')
    await writeFile(file, code, 'utf-8')
    const mod = await import('file:///' + file.replace(/\\/g, '/'))
    if (typeof mod.default !== 'function') {
      return err(new Error('## $auth: script does not export a default function'))
    }
    return ok(mod.default as AuthScript)
  } catch (e) {
    return err(e instanceof Error ? e : new Error(String(e)))
  } finally {
    if (dir) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* temp cleanup best-effort */
      }
    }
  }
}
