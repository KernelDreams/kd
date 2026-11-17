// Один бинарь (board-edge-spec §3): `bun build --compile` под darwin-arm64 и linux-x64 → bin/nr-mcp-<os>-<arch>;
// win32-x64 → bin/nr-mcp-win32-x64.exe без окна консоли (сервис — задача планировщика).
// bun — devDependency пакета; рантайм чужой платформы bun берёт сам (нужна сеть при первой сборке).
// darwin: подпись постоянным сертификатом `nr-studio-codesign` из ~/Library/Keychains/nr-codesign.keychain-db
// (пароль — ~/.config/nr-codesign/keychain-pass): права macOS (Accessibility, Screen Recording) держатся на сертификате,
// а не на хэше бинаря, и переживают обновления. Нет связки — подпись bun по умолчанию (права слетают при обновлении).
// `node scripts/build-bin.mjs [darwin-arm64,linux-x64]`
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const targets = (process.argv[2] ?? 'darwin-arm64,linux-x64').split(',').filter(Boolean)
const bun = join(root, 'node_modules', '.bin', 'bun')
mkdirSync(join(root, 'bin'), { recursive: true })

function sign(file) {
  const kc = join(homedir(), 'Library', 'Keychains', 'nr-codesign.keychain-db')
  const pass = join(homedir(), '.config', 'nr-codesign', 'keychain-pass')
  if (process.platform !== 'darwin' || !existsSync(kc) || !existsSync(pass)) return console.log(`  ${file}: без постоянной подписи (нет ${kc})`)
  const u = spawnSync('security', ['unlock-keychain', '-p', readFileSync(pass, 'utf8').trim(), kc], { encoding: 'utf8' })
  const c = u.status === 0 && spawnSync('codesign', ['-f', '-s', 'nr-studio-codesign', '--keychain', kc, '-i', 'studio.nr-mcp', file], { encoding: 'utf8' })
  if (!c || c.status !== 0) {
    console.error(`  ${file}: подпись — ${(c ? c.stderr : u.stderr).trim()}`)
    process.exit(1)
  }
}
for (const t of targets) {
  const win = t.startsWith('win32-')
  const out = join(root, 'bin', `nr-mcp-${t}${win ? '.exe' : ''}`)
  const target = win ? t.replace('win32-', 'windows-') : t
  const extra = win ? ['--windows-hide-console'] : []
  const r = spawnSync(bun, ['build', join(root, 'src', 'cli.ts'), '--compile', '--minify', `--target=bun-${target}`, ...extra, '--outfile', out], { stdio: 'inherit', cwd: root })
  if (r.status !== 0) process.exit(r.status ?? 1)
  if (t.startsWith('darwin-')) sign(out)
  console.log(`✓ ${out}`)
}
