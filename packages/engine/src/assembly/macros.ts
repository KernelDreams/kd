// Macro substitution: {{user}}, {{char}}, {{time}}, {{date}}, {{model}}, {{random}}.
// Ported from chat2 assembly/macros.ts; vars now sourced from an IContext.

import { asText } from '@kerneldreams/nrd'
import type { IContext } from '@kerneldreams/nrd'

export interface MacroVars {
  user: string
  char: string
  time?: string
  date?: string
  model?: string
}

export interface MacroDefaults {
  user?: string
  char?: string
  model?: string
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** Build macro vars from a context (card / persona) with config fallbacks. */
export function macroVars(ctx: IContext, defaults: MacroDefaults = {}): MacroVars {
  const get = (k: string): string | undefined => asText(ctx.get([k]))
  const now = new Date()
  return {
    user: get('user') ?? defaults.user ?? 'User',
    char: get('char') ?? defaults.char ?? 'Assistant',
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    model: defaults.model ?? get('model'),
  }
}

/** Replace `{{macro}}` tokens. Cheap string replace, not a template engine. */
export function resolveMacros(text: string, vars: MacroVars): string {
  if (!text.includes('{{')) return text
  return text
    .replaceAll('{{user}}', vars.user)
    .replaceAll('{{char}}', vars.char)
    .replaceAll('{{time}}', vars.time ?? '')
    .replaceAll('{{date}}', vars.date ?? '')
    .replaceAll('{{model}}', vars.model ?? '')
    .replace(/\{\{random\}\}/g, () => String(Math.floor(Math.random() * 100) + 1))
}
