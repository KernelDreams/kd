/**
 * Персоны (personas-spec §1–2, §4): правила, общие для писателя (pi-расширение),
 * читателя (backend-pi) и сборки.
 *
 * Реализация — в `@kerneldreams/chat-store/assembly`: общая
 * RP-сборка (`assembleRp`) живёт там, а пакет ниже протокола импортировать
 * протокол не может. Здесь — ре-экспорт под прежними именами и capability.
 */

import type { Capabilities, PersonaContext, PersonasCapability } from './types.js'

export {
  PERSONAS_CUSTOM_TYPE,
  PERSONA_INJECTION_SOURCE,
  charPersonas,
  expandPersonaNames,
  isPersona,
  isPersonasDoc,
  personaPrefixed,
  personasDocOf,
  personasSystemBlock,
  personasVoiced,
  stripPersonaPrefix,
  turnPersona,
  userPersona,
  validatePersonas,
} from '@kerneldreams/chat-store/assembly'

/**
 * Нормализованная capability персон. `undefined` — персон нет; `true` (форма
 * до v1.9) — `{}`: список есть, правки и мультиактёрности нет.
 */
export function personasCapability(caps: Pick<Capabilities, 'personas'>): PersonasCapability | undefined {
  const value = caps.personas
  if (value === undefined || value === false) return undefined
  if (value === true) return {}
  return value
}

/**
 * Что движок подаёт из персон в контекст (v1.50): нет `personas` — `none`; нет поля — `all`
 * (так вели себя все бэкенды до v1.50).
 */
export function personaContext(caps: Pick<Capabilities, 'personas'>): PersonaContext {
  const c = personasCapability(caps)
  if (!c) return 'none'
  return c.context ?? 'all'
}
