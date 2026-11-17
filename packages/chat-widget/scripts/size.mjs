// Размер бандла: сырой и gzip (цель ≤60 КБ gzip).
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const buf = readFileSync(new URL('../dist/nr-chat.js', import.meta.url))
const gz = gzipSync(buf, { level: 9 }).length
console.log(`dist/nr-chat.js: ${(buf.length / 1024).toFixed(1)} КБ, gzip ${(gz / 1024).toFixed(1)} КБ`)
if (gz > 60 * 1024) {
  console.error('больше 60 КБ gzip')
  process.exit(1)
}
