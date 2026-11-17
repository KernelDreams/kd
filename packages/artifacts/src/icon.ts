/**
 * `$icon` артефакта (comfy-gen-spec §5a):
 *   - без `/` и расширения — имя иконки lucide (`wand-sparkles`), рисует фронт;
 *   - `./x.svg` — SVG как есть: с `currentColor` — моно (перекрашивается под тему), иначе цветной;
 *   - `./x.png` / `./x.webp` — картинка как есть.
 * Файл отдаётся списку data-URL (до {@link ICON_MAX_BYTES}) — иконка видна и у неоткрытого артефакта.
 * Нет поля / файла / имени не знаем — фронт рисует `AppWindow`.
 */

import { readFileSync, statSync } from 'node:fs'
import { extname, relative, resolve, sep } from 'node:path'
import { LUCIDE_NAMES } from './lucide-names.js'

export const ICON_MAX_BYTES = 256 * 1024

const MIME: Record<string, string> = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }

export type ArtifactIcon = { kind: 'lucide'; name: string } | { kind: 'image'; url: string; mono: boolean }

type Parsed = { kind: 'lucide'; name: string } | { kind: 'file'; path: string; ext: string } | { kind: 'invalid'; reason: string }

export function parseIcon(value: string): Parsed {
  const v = value.trim()
  if (!v.includes('/') && !/\.[a-z0-9]+$/i.test(v)) return { kind: 'lucide', name: v.toLowerCase() }
  const ext = extname(v).toLowerCase()
  if (!MIME[ext]) return { kind: 'invalid', reason: `$icon: "${v}" — картинка только .svg, .png или .webp` }
  return { kind: 'file', path: v, ext }
}

function fileOf(dir: string, path: string): string | null {
  const abs = resolve(dir, path)
  const rel = relative(resolve(dir), abs)
  return rel && !rel.startsWith('..') && !rel.startsWith(sep) ? abs : null
}

/** Ошибка `$icon` для finalize; `null` — в порядке. */
export function checkIcon(dir: string, value: string | null): string | null {
  if (value === null) return null
  const p = parseIcon(value)
  if (p.kind === 'invalid') return p.reason
  if (p.kind === 'lucide') return LUCIDE_NAMES.has(p.name) ? null : `$icon: иконки lucide "${p.name}" нет (имена — https://lucide.dev/icons, kebab-case) или укажи файл ./icon.svg`
  const abs = fileOf(dir, p.path)
  if (!abs) return `$icon: ${p.path} — вне папки артефакта`
  let size: number
  try {
    size = statSync(abs).size
  } catch {
    return `$icon: файла ${p.path} нет в папке артефакта`
  }
  if (size > ICON_MAX_BYTES) return `$icon: ${p.path} больше ${ICON_MAX_BYTES >> 10} КБ — уменьши (256×256 хватает)`
  return null
}

/** Иконка для списка/вкладки; любая проблема — `null` (фронт рисует дефолт). */
export function resolveIcon(dir: string, value: string | null): ArtifactIcon | null {
  if (value === null || checkIcon(dir, value) !== null) return null
  const p = parseIcon(value)
  if (p.kind === 'lucide') return { kind: 'lucide', name: p.name }
  if (p.kind !== 'file') return null
  try {
    const bytes = readFileSync(fileOf(dir, p.path)!)
    const mono = p.ext === '.svg' && /currentColor/i.test(bytes.toString('utf8'))
    return { kind: 'image', url: `data:${MIME[p.ext]};base64,${bytes.toString('base64')}`, mono }
  } catch {
    return null
  }
}
