/**
 * Агент как модуль своего процесса (установленный агент — nr-mcp): та же `agent.cjs`, что
 * уходит по ssh, только сессия — по вызову, а не на stdin. Импорт статический: попадает в бинарь bun.
 */
import agent from './agent.cjs'

export const createAgent = agent.createAgent
export const AGENT_VERSION = agent.VERSION
