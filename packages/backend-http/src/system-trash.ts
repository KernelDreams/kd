/**
 * Системная Корзина: удаление на своей машине — туда же, куда кладёт Finder / Проводник, а не в
 * `~/.nr-trash`. macOS — Finder через `osascript` (возвращает место в Корзине: по нему ⌘Z, в Finder работает «Вернуть»),
 * не вышло — `/usr/bin/trash` (macOS 15+) и поиск свежей записи в `~/.Trash`; Windows — Корзина через
 * `Microsoft.VisualBasic.FileIO` (места не отдаёт — ⌘Z говорит «верните из Корзины системой»). Другие ОС — `null`:
 * слой кладёт в `~/.nr-trash`, как раньше.
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

export type TrashRun = (cmd: string, args: string[]) => Promise<string>

const run: TrashRun = (cmd, args) =>
  new Promise((done, fail) => {
    execFile(cmd, args, { timeout: 20_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) fail(new Error(`${cmd}: ${String(stderr || err.message).trim()}`))
      else done(String(stdout))
    })
  })

/** Свежая запись Корзины macOS с именем файла (Finder добавляет к занятому « 2», «… 14.32.10»). */
async function findInMacTrash(home: string, name: string, since: number): Promise<string | undefined> {
  const dir = join(home, '.Trash')
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  let best: { path: string; t: number } | undefined
  for (const n of await readdir(dir).catch(() => [] as string[])) {
    if (n !== name && !(n.startsWith(stem) && n.endsWith(ext))) continue
    const p = join(dir, n)
    const st = await stat(p).catch(() => null)
    const t = st ? Math.max(st.ctimeMs, st.mtimeMs) : 0
    if (t >= since - 2000 && (!best || t > best.t)) best = { path: p, t }
  }
  return best?.path
}

/**
 * Файл (папку) — в системную Корзину. Возвращает `{ trashed }` (место в Корзине или `undefined`, если ОС его не
 * отдаёт); `null` — у ОС своей Корзины нет. Сбой — ошибка с причиной (слой решает, что дальше).
 */
export async function systemTrash(abs: string, o: { os: string; home: string; run?: TrashRun }): Promise<{ trashed?: string } | null> {
  const exec = o.run ?? run
  if (o.os === 'darwin') {
    const since = Date.now()
    const script = 'on run argv\ntell application "Finder" to set t to (delete (POSIX file (item 1 of argv) as alias))\nreturn POSIX path of (t as alias)\nend run'
    try {
      const out = (await exec('osascript', ['-e', script, abs])).trim()
      return out ? { trashed: out.replace(/\/$/, '') } : {}
    } catch (finderErr) {
      if (!existsSync('/usr/bin/trash') && !o.run) throw finderErr
      await exec('/usr/bin/trash', [abs])
      const p = await findInMacTrash(o.home, basename(abs), since)
      return p ? { trashed: p } : {}
    }
  }
  if (o.os === 'win32') {
    const ps = `$p = $args[0]; Add-Type -AssemblyName Microsoft.VisualBasic; if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') } else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }`
    await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `& { ${ps} }`, abs])
    return {}
  }
  return null
}
