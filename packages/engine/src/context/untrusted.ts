// Untrusted-резолв чужого контента (решение №1).
//
// Untrusted = отсутствие ambient authority. Текст карточки, лорбука, любых
// injector-данных, пришедших извне, резолвится ТОЛЬКО об ContextPackage-скоуп:
//
//   - без env-слоя           → `${GITEA_TOKEN}` не резолвится ни во что
//   - без fs-функций         → `${loadMDD("/etc/passwd")}` не существует
//   - без executor'а         → кода не запустить
//   - только coreFunctions   → чистая stdlib (if_else/not/eq/default), ноль IO
//
// Не запрет кода — выбор цепочки. Одна функция, весь класс дыр закрыт по
// построению: `${sys.gitea.token}` в лоре чужого бота уходит в промпт литералом.

import { chainContext, coreFunctions, funcContext, objectContext, resolve } from '@kerneldreams/nrd'
import type { IContext, Value } from '@kerneldreams/nrd'

/** Скоуп, об который резолвится чужой контент. Ничего сверх переданных данных. */
export function untrustedScope(scope: Record<string, Value> = {}): IContext {
  return chainContext(objectContext(scope), funcContext(coreFunctions))
}

/**
 * Резолвить чужой текст об untrusted-цепочку. Нерезолвимое остаётся литералом
 * (lenient) — чужой бот не отличит «нет доступа» от «нет значения».
 */
export function resolveUntrusted(text: string, scope: IContext): string {
  if (!text.includes('${')) return text
  return resolve(text, scope)
}
