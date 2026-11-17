export declare const AGENT_VERSION: string
/** Исходник агента (`agent.cjs`). */
export declare function agentSource(): string
/** Код для `node -e` (без кавычек и `$`: переживает sh, cmd.exe и PowerShell). */
export declare function bootstrapCode(): string
/** Первая строка входа процесса: агент в base64 с `\n`. */
export declare function agentLine(): string

/** Что агент сообщает при старте. */
export interface AgentHello {
  event: 'hello'
  version: string
  os: string
  arch: string
  node: string
  home: string
  /** Реальный путь дома (`/var` → `/private/var`): правила закрытого — на оба. */
  realHome: string
  caps: { thumb: 'sips' | 'ffmpeg' | 'magick' | null; video: boolean; rg: boolean; tar: boolean; git: boolean; watch: boolean }
}

/** Правило закрытого пути для `init`: префикс либо регэксп по пути без ведущего `/`. */
export type AgentDenyRule = { prefix: string } | { re: string }

/** Ответ агента на запрос. */
export type AgentReply = { id?: number; ok: true; result: unknown } | { id?: number; ok: false; error: string; code?: string }

/** Наблюдатель каталога (`fs.watch` или поток слежения). */
export interface AgentWatcher {
  close(): void
}

export interface CreateAgentOptions {
  /** Ответы и события наружу; default — строкой JSON в stdout. */
  emit?: (msg: Record<string, unknown>) => void
  /** Корни машины (POSIX-пути провода, `~` раскрывается): вне них — `forbidden`. Нет — весь диск (как по ssh). */
  roots?: string[]
  /** Своё слежение (поток); default — `fs.watch` в этом потоке. */
  watchDir?: (nativePath: string, recursive: boolean, onName: (name: string) => void, onError: () => void) => AgentWatcher
}

/** Сессия агента в своём процессе (установленный агент, nr-mcp): то же, что по ssh, без stdin. */
export interface AgentSession {
  hello: AgentHello & { roots?: string[] }
  call(req: { id?: number; op: string; args?: Record<string, unknown> }): Promise<AgentReply>
  handle(line: string): Promise<void>
  /** Снять слежение сессии. */
  close(): void
}
