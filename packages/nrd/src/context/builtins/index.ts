// Реестр встроенных source-плагинов (§4.4).

import type { SourcePlugin } from '../types.js'
import { inlineSource } from './inline.js'
import { envSource } from './env.js'
import { fileSource } from './file.js'
import { jsonSource } from './json.js'
import { execSource, scriptSource } from './exec.js'

export const builtinSources: Record<string, SourcePlugin> = {
  inline: inlineSource,
  env: envSource,
  file: fileSource,
  json: jsonSource,
  exec: execSource,
  script: scriptSource,
}

export { inlineSource, envSource, fileSource, jsonSource, execSource, scriptSource }
