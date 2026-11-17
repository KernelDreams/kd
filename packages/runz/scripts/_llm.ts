/**
 * Shared helper for the built-in LLM scripts.
 *
 * Builds an LLMClient from the runz config chain — `~/.runz/config.md` (global)
 * and `{projectDir}/.runz/config.md` (project). Provider blocks are declared
 * as `## $provider <name>` sections.
 *
 * Not a runnable script — the `_` prefix keeps it out of the registry listing.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadLLMConfig, createClient } from '@kerneldreams/runz-runtime/llm'
import type { LLMClient } from '@kerneldreams/runz-runtime/llm'
import type { ScriptMeta } from '@kerneldreams/runz-runtime'

export function buildLLMClient(meta: ScriptMeta): LLMClient {
  const texts: string[] = []

  const globalConfig = path.join(os.homedir(), '.runz', 'config.md')
  if (fs.existsSync(globalConfig)) {
    texts.push(fs.readFileSync(globalConfig, 'utf8'))
  }
  if (meta.projectDir) {
    const projectConfig = path.join(meta.projectDir, '.runz', 'config.md')
    if (fs.existsSync(projectConfig)) {
      texts.push(fs.readFileSync(projectConfig, 'utf8'))
    }
  }

  const config = loadLLMConfig(texts, process.env as Record<string, string>)
  return createClient(config)
}
