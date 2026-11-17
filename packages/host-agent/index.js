/**
 * Хабовая половина nr-host-agent: исходник агента и загрузчик для `ssh <host> <node> -e <загрузчик>`.
 * Загрузчик читает первую строку входа (агент в base64), исполняет её и отдаёт остаток входа агенту.
 */

import { readFileSync } from 'node:fs'

export const AGENT_VERSION = '0.2.0'

/** Исходник агента (`agent.cjs`). */
export function agentSource() {
  return readFileSync(new URL('./agent.cjs', import.meta.url), 'utf8')
}

const LOADER =
  "let b='';const h=d=>{b+=d;const i=b.indexOf('\\n');if(i<0)return;process.stdin.off('data',h);globalThis.__nrRest=b.slice(i+1);eval(Buffer.from(b.slice(0,i),'base64').toString())};process.stdin.setEncoding('utf8');process.stdin.on('data',h)"

/**
 * Код для `node -e`: без кавычек и `$` внутри (base64 + обёртка), поэтому одинаково
 * переживает sh, cmd.exe и PowerShell в двойных кавычках.
 */
export function bootstrapCode() {
  return `eval(Buffer.from('${Buffer.from(LOADER).toString('base64')}','base64').toString())`
}

/** Первая строка входа процесса: агент в base64. */
export function agentLine() {
  return `${Buffer.from(agentSource()).toString('base64')}\n`
}
