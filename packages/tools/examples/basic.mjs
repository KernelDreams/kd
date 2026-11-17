// Набор тулов агента вне backend-nr: файлы + процессы + runz → массив ToolDef.
import { fsOf } from '@kerneldreams/chat-store/fs'
import { createNodeFileSystem } from '@kerneldreams/chat-store/node-fs'
import { createExecTools, createFsTools } from '../src/index.js'
import { createNodeExecHost, createRunzTools } from '../src/node/index.js'

const cwd = process.argv[2] ?? process.cwd()
const host = createNodeExecHost()
const fs = fsOf(createNodeFileSystem())
const tools = [...createFsTools({ cwd, fs, search: host }), ...createExecTools({ cwd, fs, processes: host.processes }), ...createRunzTools({ cwd })]
const ctx = { signal: AbortSignal.timeout(60_000), sessionId: 'demo', callId: 'c1', ask: async () => undefined, cwd }
const call = async (name, args) => tools.find((t) => t.name === name).execute(args, ctx)

console.log(tools.map((t) => t.name).join(' '))
console.log((await call('read', { path: 'package.json', limit: 3 })).text)
console.log((await call('exec', { command: 'echo ok' })).text)
console.log((await call('runz_list', {})).text.slice(0, 200))
host.processes.killAll()
