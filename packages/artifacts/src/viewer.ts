/**
 * Capability `viewer`: гость просит оболочку показать картинки её
 * смотрелкой — поверх всего окна nrchat/exz, а не лайтбоксом внутри iframe.
 * Хост только проверяет право и нормализует список; открывает фронт (Plugin API
 * `ui.viewImages`), как буфер обмена.
 *
 *   __host.viewer.open(images, index?)   images: (url | {url, name?})[]
 *
 * URL — http(s) (`comfy.view`, `fileUrl`, статика артефакта) или `data:image/…`;
 * относительные адреса prelude гостя уже раскрыл от страницы.
 */

export interface ViewerImage {
  url: string
  name?: string
}

export interface ViewerRequest {
  images: ViewerImage[]
  index: number
}

/** Предел списка: смотрелке хватит, провод не распухнет. */
export const VIEWER_MAX_IMAGES = 500

const URL_RE = /^(?:https?:\/\/|data:image\/)/i

/** Аргументы `viewer.open` → запрос оболочке; throw — ошибка гостю. */
export function viewerRequest(args: readonly unknown[]): ViewerRequest {
  const raw = Array.isArray(args[0]) ? args[0] : args[0] == null ? [] : [args[0]]
  const images: ViewerImage[] = []
  for (const item of raw.slice(0, VIEWER_MAX_IMAGES)) {
    const url = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { url?: unknown }).url : null
    if (typeof url !== 'string' || !URL_RE.test(url.trim())) {
      throw new Error(`viewer.open: картинка — URL http(s) или data:image (comfy.view, fileUrl), а не ${JSON.stringify(item)?.slice(0, 80)}`)
    }
    const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined
    images.push({ url: url.trim(), ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}) })
  }
  if (images.length === 0) throw new Error('viewer.open: нет картинок')
  const i = typeof args[1] === 'number' && Number.isFinite(args[1]) ? Math.trunc(args[1]) : 0
  return { images, index: Math.min(Math.max(i, 0), images.length - 1) }
}
