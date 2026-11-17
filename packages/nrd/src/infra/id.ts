/**
 * Генерация читаемых уникальных идентификаторов в формате CVCVCV
 * (согласная-гласная). НЕ криптографический.
 *
 * Дефолт 6 символов → ~300K вариантов. Парадокс дней рождения: коллизия
 * вероятна при ~550 одновременных id. Для больших множеств увеличить length.
 */
const CONSONANTS = 'bcdfghjklmnpqrstvwxyz'
const VOWELS = 'aeiou'

/**
 * Сгенерировать id длиной `length` (дефолт 6). Чётные позиции — согласные,
 * нечётные — гласные.
 */
export function generateId(length = 6): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    const set = i % 2 === 0 ? CONSONANTS : VOWELS
    out += set[Math.floor(Math.random() * set.length)]
  }
  return out
}
