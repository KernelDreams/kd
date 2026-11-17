/**
 * @kerneldreams/runz-runtime — CLI argument parser
 *
 * Splits `--runz-*` reserved flags from script data arguments.
 */

import type { Value } from '@kerneldreams/nrd'

export interface RunzFlags {
  debug: boolean
  dry: boolean
  help: boolean
  list: boolean
  /** `--runz-describe` при `--runz-list`: `имя<TAB>одна строка`. */
  describe: boolean
  /** `--runz-json`: stdout = JSON.stringify(ScriptResult), одна строка. */
  json: boolean
  /** `--untrusted`: document не видит sys/env/fs (см. buildScopes). */
  untrusted: boolean
  config?: string
  chain?: string
  runtime: string
}

export interface ParsedArgs {
  /** Reserved `--runz-*` flags. */
  runz: RunzFlags
  /** Positional script name / path (null if none given). */
  script: string | null
  /** Extra positional arguments after script (used by subcommands like `runz add <pkg>`). */
  positionals: string[]
  /** Script data arguments — everything that isn't `--runz-*`. */
  args: Record<string, Value>
}

/** Coerce a CLI string value: numbers and booleans become typed; rest stays string. */
export function coerceValue(s: string): Value {
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  if (/^-?\d+\.\d+$/.test(s)) return Number(s)
  return s
}

/** Set a possibly-dotted key into a nested object. */
function setKey(target: Record<string, Value>, key: string, value: Value): void {
  const parts = key.split('.')
  let cur = target
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {}
    cur = cur[p] as Record<string, Value>
  }
  cur[parts[parts.length - 1]] = value
}

export function parseArgv(argv: string[]): ParsedArgs {
  const runz: RunzFlags = {
    debug: false,
    dry: false,
    help: false,
    list: false,
    describe: false,
    json: false,
    untrusted: false,
    runtime: 'node',
  }
  const args: Record<string, Value> = {}
  const positionals: string[] = []
  let script: string | null = null

  for (const token of argv) {
    if (!token.startsWith('--')) {
      if (script === null) script = token
      else positionals.push(token)
      continue
    }

    const body = token.slice(2)
    const eq = body.indexOf('=')
    const key = eq >= 0 ? body.slice(0, eq) : body
    const rawValue = eq >= 0 ? body.slice(eq + 1) : undefined

    // `--untrusted` — зарезервированный флаг (без `runz-`-префикса, как в спеке).
    if (key === 'untrusted' || key === 'runz-untrusted') {
      runz.untrusted = true
      continue
    }

    if (key.startsWith('runz-')) {
      const flag = key.slice('runz-'.length)
      switch (flag) {
        case 'debug': runz.debug = true; break
        case 'dry': runz.dry = true; break
        case 'help': runz.help = true; break
        case 'list': runz.list = true; break
        case 'describe': runz.describe = true; break
        case 'json': runz.json = true; break
        case 'config': runz.config = rawValue; break
        case 'chain': runz.chain = rawValue; break
        case 'runtime': runz.runtime = rawValue ?? 'node'; break
        default: break
      }
      continue
    }

    setKey(args, key, rawValue === undefined ? true : coerceValue(rawValue))
  }

  return { runz, script, positionals, args }
}
