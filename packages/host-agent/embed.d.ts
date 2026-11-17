import type { AgentSession, CreateAgentOptions } from './index.js'
export type { AgentSession, CreateAgentOptions, AgentReply, AgentWatcher } from './index.js'
/** Сессия агента в своём процессе. */
export declare function createAgent(opts?: CreateAgentOptions): AgentSession
export declare const AGENT_VERSION: string
