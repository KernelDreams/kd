/**
 * `exec` и `process` (tools-spec §2).
 *
 * `exec` — образец OpenClaw `bash-tools` (`yieldMs` → фон → `process`), вывод
 * — хвостом как у pi `bash` (2000 строк / 50 КБ). Команда ждётся `yieldMs`
 * (дефолт 10 с); не кончилась — уходит в фон, модель получает `processId` и
 * вывод на этот момент; дальше — `process poll|write|kill|list`.
 *
 * Политика по умолчанию — `ask` (обе). Превью апрува — команда и каталог.
 *
 * sudo: процесс получает `SUDO_ASKPASS` (хост, `askpass` старта) —
 * пароль спрашивается у пользователя окном чата (`ask` вида `text` с
 * `secret: true`) и идёт только процессу: не в вывод, не в данные тула, не в
 * контекст модели. Пока вопрос висит, команда не уходит в фон; ушла в фон —
 * вопрос не задаётся (спрашивать некому), `sudo` падает без пароля.
 *
 * Запрет-лист (`deny`): команды, которые `exec` не исполняет никогда,
 * при любой политике (`auto` батча, грант сессии). Правило — регэксп по тексту
 * команды; совпало — отказ результатом тула с причиной (модель видит), без
 * запуска процесса.
 */

import type { ToolDef, ToolPreview } from '../types.js'
import { displayPath, resolveIn, type FsRoot } from '../fs/paths.js'
import { truncateTail, formatSize } from '../fs/truncate.js'
import type { ProcessRegistry } from '../host.js'

export const DEFAULT_YIELD_MS = 10_000
const MAX_YIELD_MS = 600_000
const MAX_POLL_WAIT_MS = 30_000

export interface ExecToolsOptions extends FsRoot {
  processes: ProcessRegistry
  /** Запрет-лист: команда совпала с правилом — отказ без запуска. */
  deny?: ExecDenyRule[]
}

/** Правило запрет-листа: регэксп (строка — без флагов, регистр не важен) и причина для модели. */
export type ExecDenyRule = string | RegExp | { pattern: string | RegExp; reason?: string }

/** Правила → `{re, reason}`; кривой регэксп — ошибка сразу, а не тихий пропуск. */
export function compileExecDeny(rules: readonly ExecDenyRule[] | undefined): Array<{ re: RegExp; reason: string }> {
  return (rules ?? []).map((r) => {
    const pattern = typeof r === 'object' && !(r instanceof RegExp) ? r.pattern : r
    const re = pattern instanceof RegExp ? pattern : new RegExp(pattern, 'i')
    const reason = typeof r === 'object' && !(r instanceof RegExp) && r.reason ? r.reason : `matches deny rule /${re.source}/`
    return { re, reason }
  })
}

/** Первое правило, под которое попала команда; нет — `undefined`. */
export function execDenied(command: string, rules: ReadonlyArray<{ re: RegExp; reason: string }>): { rule: string; reason: string } | undefined {
  for (const { re, reason } of rules) if (re.test(command)) return { rule: re.source, reason }
  return undefined
}

function tail(text: string): string {
  const t = truncateTail(text)
  if (!t.truncated) return t.content
  return `[… ${t.totalLines - t.outputLines} earlier lines / ${formatSize(t.totalBytes)} total cut; showing the tail …]\n${t.content}`
}

function envOf(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v)) out[k] = String(val)
  return out
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

export function execTool(opts: ExecToolsOptions): ToolDef {
  const { processes } = opts
  const deny = compileExecDeny(opts.deny)
  const workdirOf = (args: Record<string, unknown>): Promise<string> => {
    const w = typeof args.workdir === 'string' && args.workdir.trim() ? args.workdir : '.'
    return resolveIn(opts, w)
  }
  return {
    name: 'exec',
    description:
      `Execute a shell command (${processes.shell ?? 'sh -c'}) in the workspace. ` +
      (processes.shell?.startsWith('cmd') ? 'Windows cmd syntax: chain with & or &&, not ;. ' : '') +
      'Returns combined stdout/stderr (tail: last 2000 lines or 50KB) and the exit code. ' +
      `If the command is still running after yieldMs (default ${DEFAULT_YIELD_MS} ms) it continues in the background and you get a processId: ` +
      'use the process tool (poll to read new output, write to send stdin, kill to stop). Use background: true for servers and watchers. ' +
      'Prefer the read/ls/find/grep/edit tools for files.',
    schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command.' },
        workdir: { type: 'string', description: 'Working directory (relative to the workspace; default: workspace root).' },
        env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment variables (literal values).' },
        yieldMs: { type: 'number', description: `Milliseconds to wait before moving the command to the background; default ${DEFAULT_YIELD_MS}.` },
        background: { type: 'boolean', description: 'Start in the background right away (servers, watchers).' },
        timeoutSeconds: { type: 'number', description: 'Kill the process after this many seconds; 0 or omitted — no limit.' },
      },
      required: ['command'],
    },
    executor: 'backend',
    policy: 'ask',
    async preview(args): Promise<ToolPreview> {
      return { kind: 'command', command: String(args.command ?? ''), cwd: await workdirOf(args) }
    },
    async execute(args, ctx) {
      const command = String(args.command ?? '').trim()
      if (!command) throw new Error('command is empty')
      const denied = execDenied(command, deny)
      if (denied) {
        return {
          text: `Refused: this command is on the deny list and is never executed here (${denied.reason}). Do not retry it or work around it; do the task without it or report that it is needed.`,
          isError: true,
          data: { command, denied: true, rule: denied.rule, reason: denied.reason },
        }
      }
      const cwd = await workdirOf(args)
      const env = envOf(args.env)
      const timeoutS = num(args.timeoutSeconds)
      const background = args.background === true
      const yieldMs = background ? 0 : Math.min(MAX_YIELD_MS, Math.max(0, num(args.yieldMs) ?? DEFAULT_YIELD_MS))
      let inFlight = true
      let asking = 0
      const askpass = async (prompt: string): Promise<string | undefined> => {
        if (!inFlight) return undefined
        asking++
        try {
          const answer = await ctx.ask('text', { question: prompt.trim() || 'Password:', secret: true, purpose: 'sudo', command })
          return typeof answer === 'string' && answer !== '' ? answer : undefined
        } finally {
          asking--
        }
      }
      const p = processes.start({
        sessionId: ctx.sessionId,
        askpass,
        command,
        cwd,
        // Id сессии: `runz projektor` из exec — постановщик задачи; явный env главнее.
        env: { ...(ctx.sessionId ? { NR_SESSION: ctx.sessionId } : {}), ...(env ?? {}) },
        ...(timeoutS && timeoutS > 0 ? { timeoutMs: timeoutS * 1000 } : {}),
        signal: ctx.signal,
      })
      let finished = yieldMs > 0 ? await processes.wait(p.id, yieldMs, ctx.signal) : false
      while (!finished && yieldMs > 0 && asking > 0 && !ctx.signal.aborted) finished = await processes.wait(p.id, 1000, ctx.signal)
      inFlight = false
      if (ctx.signal.aborted) {
        processes.kill(p.id)
        throw new Error('aborted')
      }
      const where = displayPath(opts, cwd)
      if (finished) {
        const out = processes.output(p.id).text
        const info = processes.get(p.id)!
        processes.remove(p.id)
        const status = info.status === 'killed' ? `killed${info.signal ? ` (${info.signal})` : ''}` : `exit code ${info.exitCode ?? '?'}`
        const body = out.trim() ? tail(out.replace(/\s+$/, '')) : '(no output)'
        return {
          text: `${body}\n\n[${status}]`,
          data: { command, cwd: where, exitCode: info.exitCode ?? null, status: info.status },
          ...(info.status === 'exited' && info.exitCode === 0 ? {} : { isError: true }),
        }
      }
      // В фон.
      processes.markBackground(p.id)
      const sofar = processes.output(p.id).text
      return {
        text:
          `Command is running in the background: processId ${p.id}${p.pid ? ` (pid ${p.pid})` : ''}, cwd ${where}.\n` +
          (sofar.trim() ? `Output so far:\n${tail(sofar.replace(/\s+$/, ''))}\n` : 'No output yet.\n') +
          `Use process with action "poll" and processId "${p.id}" to read new output (waitMs to wait), action "kill" to stop it.`,
        data: { command, cwd: where, processId: p.id, pid: p.pid, background: true },
      }
    },
  }
}

export function processTool(opts: ExecToolsOptions): ToolDef {
  const { processes } = opts
  return {
    name: 'process',
    description:
      'Manage background processes started by exec in this session. Actions: list — all processes; poll — new output since the last poll and status ' +
      `(waitMs: wait up to that long for new output or exit, max ${MAX_POLL_WAIT_MS}); write — send input to stdin; kill — stop the process (and its children).`,
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'poll', 'write', 'kill'], description: 'list | poll | write | kill' },
        processId: { type: 'string', description: 'Process id from exec (p1, p2…); required except for list.' },
        input: { type: 'string', description: 'For write: text to send to stdin (add \\n for Enter).' },
        waitMs: { type: 'number', description: 'For poll: wait up to this many ms for new output or exit.' },
      },
      required: ['action'],
    },
    executor: 'backend',
    policy: 'ask',
    preview(args): ToolPreview {
      const id = String(args.processId ?? '')
      const p = id ? processes.get(id) : undefined
      const what = p ? `${p.command}` : id || '(all)'
      return { kind: 'command', command: `process ${String(args.action ?? '')} ${id}${args.input !== undefined ? ` ← ${JSON.stringify(args.input)}` : ''}\n${what}`, cwd: p?.cwd ?? opts.cwd }
    },
    async execute(args, ctx) {
      const action = String(args.action ?? '')
      if (action === 'list') {
        const all = processes.list(ctx.sessionId).filter((p) => p.background)
        if (all.length === 0) return 'No background processes.'
        return all
          .map((p) => `${p.id}  ${p.status}${p.status !== 'running' ? ` (exit ${p.exitCode ?? p.signal ?? '?'})` : ''}  pid ${p.pid ?? '?'}  ${Math.round(((p.endedAt ?? Date.now()) - p.startedAt) / 1000)}s  ${p.command}`)
          .join('\n')
      }
      const id = String(args.processId ?? '')
      const p = id ? processes.get(id) : undefined
      if (!p || p.sessionId !== ctx.sessionId) throw new Error(`no process ${id || '(processId missing)'} in this session; use action "list"`)
      if (action === 'poll') {
        const waitMs = Math.min(MAX_POLL_WAIT_MS, Math.max(0, num(args.waitMs) ?? 0))
        if (waitMs > 0) await processes.waitOutput(id, waitMs, ctx.signal)
        const { text, skipped } = processes.read(id)
        const now = processes.get(id)!
        const status = now.status === 'running' ? 'running' : now.status === 'killed' ? `killed${now.signal ? ` (${now.signal})` : ''}` : `exited with code ${now.exitCode ?? '?'}`
        const body = text ? tail(text.replace(/\s+$/, '')) : '(no new output)'
        return { text: `${skipped ? `[${skipped} chars of older output dropped]\n` : ''}${body}\n\n[process ${id}: ${status}]`, data: { processId: id, status: now.status, exitCode: now.exitCode ?? null } }
      }
      if (action === 'write') {
        const input = String(args.input ?? '')
        if (!processes.write(id, input)) throw new Error(`process ${id} is not running or has no stdin`)
        return `Wrote ${input.length} chars to ${id}.`
      }
      if (action === 'kill') {
        if (p.status !== 'running') return { text: `Process ${id} already ${p.status} (exit ${p.exitCode ?? p.signal ?? '?'}).`, data: { processId: id, status: p.status } }
        processes.kill(id)
        await processes.wait(id, 3000, ctx.signal)
        const now = processes.get(id)!
        return { text: `Process ${id} ${now.status === 'running' ? 'is being killed' : now.status}.`, data: { processId: id, status: now.status } }
      }
      throw new Error(`unknown action "${action}": use list | poll | write | kill`)
    },
  }
}

export function createExecTools(opts: ExecToolsOptions): ToolDef[] {
  return [execTool(opts), processTool(opts)]
}
