// Приближённый счётчик токенов (§11).
//
// Кириллица ~3 символа/токен, латиница ~4. Занижаем бюджет — запас на ошибку.
// Pluggable ITokenCounter — когда заболит (v1 открытый №3, закрыт).

const CYRILLIC = /[Ѐ-ӿ]/g

export function estimateTokens(text: string): number {
  if (!text) return 0
  const cyr = text.match(CYRILLIC)?.length ?? 0
  const divisor = cyr / text.length > 0.3 ? 3 : 4
  return Math.ceil(text.length / divisor)
}
