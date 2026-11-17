/**
 * Промпт сообщения (prompt-recipe-spec §1, §3): правила рецепта, общие для
 * бэкендов и расширений.
 *
 * Хэширования здесь нет намеренно: пакет zero-dep и живёт в браузере, а
 * sha256 синхронно есть только в node. Здесь — имя записи, длины хэшей и
 * проверка формы: то, в чём писатель (pi-расширение) и читатель (backend-pi)
 * обязаны совпасть.
 */

import type { PromptRecipe } from './types.js'

/** customType записи рецепта в сессии pi (§3). Служебная — в ленте её нет. */
export const PROMPT_RECIPE_CUSTOM_TYPE = 'nr-prompt-recipe'

/** Длина хэша текста куска (system, инъекция): sha256 hex [:16] (§1). */
export const PROMPT_HASH_LENGTH = 16

/** Длина хэша сообщения в `messageHashes`: sha hex [:8] (§4). */
export const PROMPT_MESSAGE_HASH_LENGTH = 8

/**
 * Форма рецепта: обязательные поля на месте и нужных типов. Необязательные
 * проверяются, только если есть, — рецепт из файла сессии мог написать и
 * старый, и новый писатель.
 */
export function isPromptRecipe(v: unknown): v is PromptRecipe {
  if (!isRecord(v)) return false
  if (typeof v.at !== 'string' || typeof v.systemHash !== 'string') return false
  if (!isStringArray(v.messageIds)) return false
  if (!Array.isArray(v.injections) || !v.injections.every(isInjection)) return false
  if (v.model !== undefined && typeof v.model !== 'string') return false
  if (v.messageHashes !== undefined && !isStringArray(v.messageHashes)) return false
  if (v.tokens !== undefined && !isRecord(v.tokens)) return false
  if (v.personaId !== undefined && typeof v.personaId !== 'string') return false
  if (v.systemBlocks !== undefined && !(Array.isArray(v.systemBlocks) && v.systemBlocks.every((b) => isRecord(b) && typeof b.source === 'string' && typeof b.hash === 'string'))) return false
  return true
}

function isInjection(v: unknown): boolean {
  return (
    isRecord(v) &&
    (v.role === 'system' || v.role === 'user' || v.role === 'assistant') &&
    typeof v.hash === 'string' &&
    (v.source === undefined || typeof v.source === 'string') &&
    (v.reason === undefined || typeof v.reason === 'string')
  )
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
