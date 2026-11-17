/**
 * Подписанные адреса сырых файлов (v1.72): `GET /files/external/raw?path=…&exp=&sig=`
 * принимается без куки и прочей авторизации — html-страница в `srcdoc` (без `allow-same-origin`)
 * и кадры песочниц тянут картинки межсайтовым запросом, куку Cloudflare Access браузер туда не
 * кладёт. Владелец стенда (тот, кому можно `files.external`) берёт ключ `GET /files/external/sign`,
 * клиент подписывает адрес сам (`signRaw` из `@kerneldreams/chat-client`, синхронно).
 *
 * Ключ = HMAC(секрет стенда, `nr-files-raw/v1\n<exp>`) — срок вшит в ключ, клиент его не продлит.
 * Подпись = HMAC(ключ, `path\nhost\nthumb`) по значениям query как есть: другой путь, хост или эскиз —
 * другая подпись. Подпись даёт ровно то, что дал бы `raw` владельцу: дальше те же проверки
 * доступа хоста (`deny`, корни).
 */

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { ExternalSignKey } from '@kerneldreams/ui-protocol'

export interface FileSignOpts {
  /** Секрет стенда (из конфига / файла вне репы). Пустой — ошибка: без секрета подпись не включают. */
  secret: string
  /** Срок ключа и подписанных им адресов, с. Default 12 ч. */
  ttlSec?: number
  /**
   * Строгий режим «путь `raw` открыт мимо Cloudflare Access»: запрос `raw` без подписи пропускается,
   * только если его признал гейт пользователей / ключ стенда, либо это локальный процесс (loopback без
   * заголовков туннеля), либо `access` подтвердил JWT (`Cf-Access-Jwt-Assertion` / кука `CF_Authorization`).
   * Остальное — 401. Без гейта и без `strict` неподписанный `raw` — как раньше.
   */
  strict?: boolean
  /** Проверка JWT Cloudflare Access для строгого режима без гейта пользователей. */
  access?: { verify(jwt: string): Promise<unknown | null> }
  /** Часы (тесты). */
  now?: () => number
}

export type FileSignCheck = 'ok' | 'expired' | 'bad'

export interface FileSigner {
  readonly strict: boolean
  readonly access?: FileSignOpts['access']
  /** Ключ для клиента: действует до `exp` (секунды эпохи). */
  issue(): ExternalSignKey
  /** Проверка подписанного адреса (значения query как есть). */
  check(p: { path: string; host?: string | null; thumb?: string | null; exp?: string | null; sig?: string | null }): FileSignCheck
}

const DEFAULT_TTL_SEC = 12 * 3600

function hmac(key: string, msg: string): Buffer {
  return createHmac('sha256', key).update(msg).digest()
}

export function createFileSigner(opts: FileSignOpts): FileSigner {
  if (!opts.secret) throw new Error('createFileSigner: пустой секрет')
  const ttl = opts.ttlSec ?? DEFAULT_TTL_SEC
  const now = opts.now ?? (() => Date.now())
  const keyFor = (exp: number): string => hmac(opts.secret, `nr-files-raw/v1\n${exp}`).toString('base64url')
  // Ключ на час вперёд одинаковый: клиенты одного часа делят ключ, адреса не прыгают на каждом запросе.
  return {
    strict: opts.strict === true,
    ...(opts.access ? { access: opts.access } : {}),
    issue() {
      const exp = Math.ceil((now() / 1000 + ttl) / 3600) * 3600
      return { key: keyFor(exp), exp }
    },
    check(p) {
      if (!p.sig || !p.exp || !/^\d{1,12}$/.test(p.exp)) return 'bad'
      const exp = Number(p.exp)
      const given = Buffer.from(p.sig, 'base64url')
      const want = hmac(keyFor(exp), `${p.path}\n${p.host ?? ''}\n${p.thumb ?? ''}`)
      if (given.length !== want.length || !timingSafeEqual(given, want)) return 'bad'
      // Срок — после подписи: протухший, но настоящий адрес — громко «истёк», а не «не та подпись».
      if (now() / 1000 >= exp) return 'expired'
      return 'ok'
    },
  }
}
