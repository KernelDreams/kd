#!/usr/bin/env node
/**
 * runz — CLI entry point
 *
 * Parses argv, composes the chain, resolves and runs a script, prints the
 * result. Reserved flags use the `--runz-*` prefix. Built-in subcommands:
 * `runz add <pkg>`, `runz test [target]`.
 */

import {
  parseArgv,
  execute,
  listScripts,
  findScript,
  describeScript,
  findProjectDir,
  globalRunzDir,
  loadConfigFile,
  isServiceResult,
  nearestEnvDir,
  userEnvDir,
  parsePathList,
  resolvePath,
  runTests,
} from '@kerneldreams/runz-runtime'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Рантайм живёт в репе kd: корень CLI (встроенные scripts/, его node_modules для резолва скриптов)
// он узнаёт отсюда — функции рантайма читают RUNZ_HOME при вызове; дочерние процессы его наследуют.
process.env.RUNZ_HOME ||= path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const HELP = `runz — runtime для TypeScript-скриптов и NRD-документов

Usage:
  runz <script> [--key=value ...]
  runz ./path/to/script.ts [--key=value ...]
  runz <document.md|.mdz> [--key=value ...]
  runz --type=<handler> [--key=value ...]
  runz add <package> [--global] [--env=<path>]
  runz test [target] [--filter=<substr>]

Reserved flags:
  --runz-debug        debug info в stderr, дамп chain
  --runz-dry          резолв без исполнения
  --runz-json         stdout = ScriptResult одной JSON-строкой (output, exitCode, outputs)
  --runz-config=X     явный конфиг (добавляется в chain)
  --runz-chain=X      загрузить chain из JSON-файла
  --runz-help         эта справка
  <script> --help|-h  справка скрипта: его шапка и объявленные флаги, скрипт не исполняется
  --runz-list         список доступных скриптов (+ --runz-describe: имя<TAB>что это)
  --runz-runtime=X    среда исполнения (node | electron)
  --untrusted         недоверенный документ: без sys/env/fs (см. docs/scopes.md)

Positional arguments after the script name are passed as $_ in the chain.
Single value → string, multiple → array.

Известные флаги скрипт объявляет сам: .ts — export const flags = ['dry', …] или
{ dry: 'описание' }, документ — $flags. Объявил — неизвестный флаг командной строки
отказ до запуска; не объявил — флаги не проверяются.

runz test — node --test с resolve-хуком runz: тесты appz (без package.json)
резолвят @kerneldreams/* штатно. Цель — путь или имя из $paths; по умолчанию cwd.
`

// npm package name: scoped or unscoped, optional @version suffix.
// Examples: lodash, lodash@4, @kerneldreams/nrd, @types/node@^24
const PKG_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-zA-Z0-9._^~><=*+\-]+)?$/

function runAdd(positionals: string[], args: Record<string, unknown>): number {
  const pkg = positionals[0]
  if (!pkg) {
    process.stderr.write('runz add: missing <package>\n')
    process.stderr.write('usage: runz add <package> [--global] [--env=<path>]\n')
    return 1
  }
  if (!PKG_RE.test(pkg)) {
    process.stderr.write(`runz add: invalid package name "${pkg}"\n`)
    return 1
  }

  let envDir: string
  if (args.global === true) {
    envDir = userEnvDir()
  } else if (typeof args.env === 'string' && args.env.length > 0) {
    envDir = resolvePath(args.env, process.cwd())
  } else {
    envDir = nearestEnvDir(process.cwd())
  }

  if (!fs.existsSync(envDir)) fs.mkdirSync(envDir, { recursive: true })

  const pkgFile = path.join(envDir, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(
      pkgFile,
      JSON.stringify({ name: 'runz-env', private: true, dependencies: {} }, null, 2) + '\n',
      'utf-8',
    )
  }

  // Node 24 on Windows rejects spawnSync for *.cmd / *.bat unless shell:true
  // (CVE-2024-27980 fallout). PKG_RE already restricted pkg to a safe charset.
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  process.stderr.write(`[runz add] ${pkg} → ${envDir}\n`)
  const r = spawnSync(
    npmCmd,
    ['install', '--prefix', envDir, pkg],
    { stdio: 'inherit', shell: process.platform === 'win32' },
  )
  return r.status ?? 0
}

async function main(): Promise<void> {
  const parsed = parseArgv(process.argv.slice(2))

  // `runz -h`, `runz --help` без скрипта — справка runz; со скриптом — справка скрипта (execute)
  const bare = parsed.script === '-h' || (parsed.script === null && (parsed.args.help === true || parsed.args.h === true) && parsed.args.type === undefined)
  if (parsed.runz.help || bare) {
    process.stdout.write(HELP)
    return
  }

  if (parsed.runz.list) {
    const cwd = process.cwd()
    const projectDir = findProjectDir(cwd)
    const globalConfig = loadConfigFile(path.join(globalRunzDir(), 'config.md'))
    const projectConfig = projectDir
      ? loadConfigFile(path.join(projectDir, '.runz', 'config.md'))
      : null
    const paths = parsePathList(
      projectConfig?.get(['paths']) ?? globalConfig?.get(['paths']),
      cwd,
    )
    const opts = { cwd, projectDir, paths }
    const names = listScripts(opts)
    const lines = parsed.runz.describe
      ? names.map((n) => {
          const f = findScript(n, opts)
          return `${n}\t${f ? describeScript(f.file) : ''}`
        })
      : names
    process.stdout.write(lines.join('\n') + (lines.length ? '\n' : ''))
    return
  }

  // Built-in subcommand: `runz add <pkg>`
  if (parsed.script === 'add') {
    const code = runAdd(parsed.positionals, parsed.args as Record<string, unknown>)
    process.exit(code)
  }

  // Built-in subcommand: `runz test [target]`
  if (parsed.script === 'test') {
    const cwd = process.cwd()
    const projectDir = findProjectDir(cwd)
    const globalConfig = loadConfigFile(path.join(globalRunzDir(), 'config.md'))
    const projectConfig = projectDir
      ? loadConfigFile(path.join(projectDir, '.runz', 'config.md'))
      : null
    const paths = parsePathList(
      projectConfig?.get(['paths']) ?? globalConfig?.get(['paths']),
      cwd,
    )
    const filter = typeof parsed.args.filter === 'string' ? parsed.args.filter : undefined
    const { exitCode } = runTests({
      target: parsed.positionals[0],
      cwd,
      projectDir,
      paths,
      filter,
    })
    process.exit(exitCode)
  }

  // Inject positional arguments into chain as `$_`
  if (parsed.positionals.length) {
    parsed.args._ = parsed.positionals.length === 1
      ? parsed.positionals[0]
      : parsed.positionals
  }

  const { result } = await execute({
    script: parsed.script,
    args: parsed.args,
    debug: parsed.runz.debug,
    dry: parsed.runz.dry,
    runtime: parsed.runz.runtime,
    configPath: parsed.runz.config,
    chainFile: parsed.runz.chain,
    untrusted: parsed.runz.untrusted,
  })

  if (isServiceResult(result)) {
    process.stdout.write(
      `[runz] service started — pid ${result.pid}` +
      (result.url ? ` — ${result.url}` : '') +
      (result.log ? ` — log: ${result.log}` : '') +
      '\n',
    )
    // ServiceResult: keep the process alive — the service owns the event loop.
    return
  }

  if (parsed.runz.json) {
    // Машинный вызов: ровно одна строка JSON в stdout, всё человеческое — в stderr.
    process.stdout.write(JSON.stringify(result) + '\n')
  } else if (result.output !== undefined) {
    process.stdout.write(result.output.endsWith('\n') ? result.output : result.output + '\n')
  }
  await flushAndExit(result.exitCode ?? 0)
}

// Close undici's global keep-alive pool before a forced process.exit.
// Without this, lingering keep-alive sockets trip a libuv UV_HANDLE_CLOSING
// assertion on Windows when the process exits while a socket is still closing.
async function flushAndExit(code: number): Promise<never> {
  // stdout в пайп — асинхронный: process.exit до слива буфера режет вывод на
  // 64 КБ (`runz x.mdz --out=json | jq`). Пустая запись с колбэком ждёт drain.
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()))
  try {
    const { getGlobalDispatcher } = await import('undici')
    await getGlobalDispatcher().close()
  } catch {
    // undici unavailable or already closed — exit anyway.
  }
  process.exit(code)
}

main().catch(async (err: unknown) => {
  const raw = err instanceof Error ? err.message : String(err)
  // Ошибки рантайма часто уже несут префикс (`runz: script not found…`) — не дублировать.
  const message = raw.startsWith('runz: ') ? raw : `runz: ${raw}`
  process.stderr.write(`${message}\n`)
  // --runz-json обещает JSON и на ошибке: вызывающий парсит stdout, не stderr.
  if (process.argv.includes('--runz-json')) {
    process.stdout.write(JSON.stringify({ output: message, exitCode: 1 }) + '\n')
  }
  await flushAndExit(1)
})
