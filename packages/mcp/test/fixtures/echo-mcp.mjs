// Мини-сервер MCP по stdio для теста детей nr-mcp: тул echo, тул shot (картинка).
import { createInterface } from 'node:readline'
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') out({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } })
  else if (m.method === 'tools/list') out({ id: m.id, result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }, { name: 'shot', inputSchema: { type: 'object' } }] } })
  else if (m.method === 'tools/call' && m.params.name === 'echo') out({ id: m.id, result: { content: [{ type: 'text', text: `echo ${m.params.arguments.x}` }] } })
  else if (m.method === 'tools/call') out({ id: m.id, result: { content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }], isError: false } })
})
