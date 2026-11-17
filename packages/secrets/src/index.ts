/**
 * Маска секретов в тексте — одна на все потоки, которые выносят текст наружу:
 * пакет репорта nrchat (консоль, логи стенда, сессия), раскопки архива
 * чатов (эпизоды → память), autocommit. Zero-dep, без Node и DOM.
 *
 * Три слоя, по порядку:
 * 1. **Известные значения** (`values`): секреты из конфига стенда (`~/.runz/config.md`) —
 *    ловятся точным совпадением, какой бы формы ни были (ключи гейта, свои токены).
 * 2. **Формы ключей** провайдеров: `sk-ant-…`, `sk-or-v1-…`, `sk-proj-…`, `sk-…`, Z.ai
 *    (`<32 hex>.<16>`), Google `AIza…`, GitHub `ghp_`/`github_pat_`, npm `npm_`, AWS `AKIA…`,
 *    Slack `xox?-`, Projektor `pk_…`/`fbk_…`, Telegram-бот `<id>:AA…`, JWT, приватные ключи PEM.
 * 3. **Контекст**: `Authorization: Bearer …` / `Basic …`, `Bearer …`, параметры адреса
 *    `?key=`/`&token=`/`api_key=`…, поля `"apiKey": "…"`, `$key: …`, `X-Api-Key: …`.
 *
 * Замена — `«…»` с хвостом из 4 первых символов (`sk-a…[secret]`): в репорте видно, что
 * ключ был и какой формы, значение — нет. Ложное срабатывание (длинный hex-хэш) дешевле
 * утечки.
 */

export interface MaskOptions {
  /** Точные значения, которые маскируются всегда (секреты конфига). Короче 8 символов — пропуск. */
  values?: Iterable<string>
}

export interface Mask {
  (text: string): string
}

const MARK = '[secret]'

/** Хвост для подсказки: первые 4 символа, если значение длиннее 12, иначе ничего. */
function hide(value: string): string {
  return value.length > 12 ? `${value.slice(0, 4)}…${MARK}` : MARK
}

/** Формы ключей — значение целиком. Порядок: специфичные раньше общих. */
const SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-or-v1-[A-Za-z0-9]{8,}/g,
  /\bsk-proj-[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // Z.ai (GLM): 32 hex, точка, 16 букв-цифр.
  /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[0-9A-Za-z-]{10,}/g,
  // Projektor: pk_<hex…> (MCP), fbk_<hex…> (источник фидбэка).
  /\b(?:pk|fbk)_[A-Za-z0-9]{16,}/g,
  // Telegram: токен бота <id>:<35>.
  /\b\d{6,12}:AA[A-Za-z0-9_-]{30,}/g,
  // JWT: три base64url-куска, первые два — JSON.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Голый длинный hex (ключи узлов, admin-токены): 48+ без разрывов.
  /\b[0-9a-f]{48,}\b/g,
]

/** Имя поля/параметра, у которого значение — секрет. */
const NAME = String.raw`(?:api[_-]?key|apikey|access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|client[_-]?secret|password|passwd|token|key|x-api-key|x-goog-api-key|cf-access-client-secret|authorization)`

/** Значение по контексту: группа 1 — то, что остаётся, группа 2 — секрет. */
const CONTEXT: RegExp[] = [
  // Authorization: Bearer xxx / Basic xxx (заголовок, JSON, curl -H).
  /(\bauthorization["']?\s*[:=]\s*["']?(?:bearer|basic|token)\s+)([A-Za-z0-9._~+/=-]{6,})/gi,
  /(\b(?:bearer|basic)\s+)([A-Za-z0-9._~+/=-]{12,})/gi,
  // ?key=… &token=… api_key=… в адресе или строке запроса.
  new RegExp(String.raw`([?&;](?:[a-z_-]*${NAME})=)([^&#\s"'<>]{4,})`, 'gi'),
  // "apiKey": "…" / 'token': '…' (JSON, JS-объекты).
  new RegExp(String.raw`(["']?[a-z_-]*${NAME}["']\s*:\s*["'])([^"'\s]{6,})`, 'gi'),
  // $key: …, api_key = …, TOKEN=… (mdz, env, shell).
  new RegExp(String.raw`((?:^|[\s$])\$?[a-z_-]*${NAME}\s*[:=]\s*["']?)([^\s"',;]{8,})`, 'gim'),
  // X-Api-Key: … (заголовок без кавычек).
  new RegExp(String.raw`(\b${NAME}\s*:\s*)([A-Za-z0-9._~+/=-]{12,})`, 'gi'),
]

const FIELD = new RegExp(String.raw`^[a-z_-]*${NAME}$`, 'i')

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Маска с известными значениями (секреты конфига). Без значений — только формы и контекст. */
export function createMask(opts: MaskOptions = {}): Mask {
  const values = [...new Set([...(opts.values ?? [])].map((v) => v.trim()).filter((v) => v.length >= 8))]
    // Длинные раньше: значение-префикс не съедает хвост длинного.
    .sort((a, b) => b.length - a.length)
  const known = values.length > 0 ? new RegExp(values.map(escape).join('|'), 'g') : null
  return (text: string): string => {
    if (!text) return text
    let out = known ? text.replace(known, (v) => hide(v)) : text
    for (const re of SHAPES) out = out.replace(re, (v) => hide(v))
    for (const re of CONTEXT) {
      out = out.replace(re, (all: string, keep: string, value: string) => (value.includes(MARK) ? all : keep + hide(value)))
    }
    return out
  }
}

/** Маска без известных значений. */
export const maskSecrets: Mask = createMask()

/**
 * Значения секретов из текста конфига (mdz/md/env): поля, имя которых похоже на
 * ключ (`$api_key: …`, `TOKEN=…`), значение ≥ 8 символов, не ссылка `$…`/`${…}`.
 * Для {@link createMask} `values`: конфиг стенда читает вызывающий.
 */
export function secretValues(config: string): string[] {
  const re = new RegExp(String.raw`^\s*\$?[a-z_-]*${NAME}[a-z_-]*\s*[:=]\s*["']?([^\s"']+)`, 'gim')
  const out: string[] = []
  for (const m of config.matchAll(re)) {
    const v = m[1] ?? ''
    if (v.length >= 8 && !v.startsWith('$') && !/^(true|false|null|undefined)$/i.test(v)) out.push(v)
  }
  return out
}

/** Маска для JSON-значения: строки внутри маскируются, форма сохраняется. */
export function maskDeep<T>(value: T, mask: Mask = maskSecrets): T {
  if (typeof value === 'string') return mask(value) as T
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, mask)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      // Поле с именем-секретом — целиком, даже короткое.
      out[k] = typeof v === 'string' && FIELD.test(k) && v.length >= 6 ? hide(v) : maskDeep(v, mask)
    }
    return out as T
  }
  return value
}
