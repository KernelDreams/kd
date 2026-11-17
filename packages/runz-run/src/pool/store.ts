/**
 * Хранилище пакетов центра: `<jobs>/.pool/pkg/<sha>.tgz` (рядом с реестром —
 * центр и постановщик на одном хосте). Ссылка пакета в задаче — `роль:sha`
 * (`code:…`, `inputs:…`): воркеру роль говорит, куда распаковать.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Pack } from './pack.js'

export type PkgRole = 'code' | 'inputs'

export const poolDir = (jobs: string): string => join(jobs, '.pool')
export const pkgFile = (jobs: string, sha: string): string => join(poolDir(jobs), 'pkg', `${sha}.tgz`)

const SHA_RE = /^[0-9a-f]{64}$/
export const isSha = (s: string): boolean => SHA_RE.test(s)

/** Положить пакет (уже есть — не переписывать). Возвращает ссылку `роль:sha`. */
export function putPkg(jobs: string, role: PkgRole, p: Pick<Pack, 'sha' | 'bytes'>): string {
  const file = pkgFile(jobs, p.sha)
  if (!existsSync(file)) {
    mkdirSync(join(poolDir(jobs), 'pkg'), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, p.bytes)
    renameSync(tmp, file)
  }
  return `${role}:${p.sha}`
}

export function readPkg(jobs: string, sha: string): Buffer | null {
  if (!isSha(sha)) return null
  try {
    return readFileSync(pkgFile(jobs, sha))
  } catch {
    return null
  }
}

/** `code:<sha>` → `{role, sha}`; голый sha — код. */
export function splitRef(ref: string): { role: PkgRole; sha: string } {
  const i = ref.indexOf(':')
  if (i < 0) return { role: 'code', sha: ref }
  return { role: ref.slice(0, i) as PkgRole, sha: ref.slice(i + 1) }
}

export const shaOf = (ref: string): string => splitRef(ref).sha
