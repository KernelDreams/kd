// Role mapping: `%role` (session) → API role. Ported from chat2 assembly/roles.ts.

export type ApiRole = 'system' | 'user' | 'assistant'

/** Map a session role to an LLM API role. Unknown roles → system. */
export function mapRole(role: string): ApiRole {
  switch (role) {
    case 'system':
      return 'system'
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'tool_result':
      return 'user'
    case 'narrator':
      return 'system'
    default:
      return 'system'
  }
}
