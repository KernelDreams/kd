#!/usr/bin/env node
/**
 * nr-mcp [serve] [--log=…]  сервер по ~/.config/nr-mcp/config.md (NR_MCP_CONFIG — другой путь); `--log` — строки
 *                           сервера дописываются в файл (Windows: у бинаря нет консоли, задача планировщика вывод не хранит)
 * nr-mcp init [--name=…] [--roots=a,b] [--port=…] [--listen=…]
 *                           конфиг со свежим токеном, если его нет (токен в вывод не пишется)
 * nr-mcp token              токен конфига — в stdout (для secrets клиента; в логи не класть)
 * nr-mcp connector          секрет пути коннектора claude.ai (`$connector`) — в stdout; нет — код 1
 * nr-mcp version
 */

import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { format } from 'node:util'
import { configPath, configTemplate, parseConfig } from './config.js'
import { startServer } from './server.js'
import { VERSION } from './version.js'

const argv = process.argv.slice(2)
const cmd = argv.find((a) => !a.startsWith('--')) ?? 'serve'
const opt = (k: string): string | undefined => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3)

const logFile = opt('log')
if (logFile) {
  mkdirSync(dirname(logFile), { recursive: true })
  const out = createWriteStream(logFile, { flags: 'a' })
  const line = (...a: unknown[]): void => void out.write(`${new Date().toISOString()} ${format(...a)}\n`)
  console.error = line
  console.log = line
}

function readConfig() {
  const file = configPath()
  if (!existsSync(file)) throw new Error(`нет конфига ${file} — \`nr-mcp init\``)
  return parseConfig(readFileSync(file, 'utf8'))
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'version':
      console.log(VERSION)
      return
    case 'init': {
      const file = configPath()
      if (existsSync(file)) {
        console.log(`конфиг уже есть: ${file}`)
        return
      }
      mkdirSync(dirname(file), { recursive: true })
      const roots = opt('roots')?.split(',').map((x) => x.trim()).filter(Boolean)
      writeFileSync(file, configTemplate({ name: opt('name') ?? hostname().split('.')[0]!, token: randomBytes(32).toString('base64url'), ...(roots?.length ? { roots } : {}), ...(opt('port') ? { port: Number(opt('port')) } : {}), ...(opt('listen') ? { listen: opt('listen') } : {}) }), { mode: 0o600 })
      console.log(`конфиг: ${file}`)
      return
    }
    case 'token':
      process.stdout.write(readConfig().token)
      return
    case 'connector': {
      const c = readConfig().connector
      if (!c) throw new Error('в конфиге нет $connector')
      process.stdout.write(c)
      return
    }
    case 'serve': {
      const srv = await startServer(readConfig())
      // Ошибка вне тула (сокет, поток слежения) — строка в лог, процесс жив.
      process.on('uncaughtException', (err) => console.error(`[nr-mcp] uncaught: ${err instanceof Error ? err.stack : String(err)}`))
      process.on('unhandledRejection', (err) => console.error(`[nr-mcp] unhandled: ${err instanceof Error ? err.message : String(err)}`))
      const stop = (): void => void srv.close().finally(() => process.exit(0))
      process.on('SIGTERM', stop)
      process.on('SIGINT', stop)
      return
    }
    default:
      console.error('nr-mcp [serve|init|token|connector|version]')
      process.exitCode = 2
  }
}

main().catch((err) => {
  console.error(`[nr-mcp] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
