/**
 * Фейковый runz для юнитов: поведение выбирается «именем скрипта» (argv[2]).
 * Запускается как `node fake-runz.mjs <script> …` — без прав на исполнение и
 * без настоящего runz.
 */

import { spawn } from 'node:child_process'

const [script, ...args] = process.argv.slice(2)

function writeChunks(stream, text) {
  // Кусками, чтобы буфер обрезки увидел много чанков, а не один.
  for (let i = 0; i < text.length; i += 8192) stream.write(text.slice(i, i + 8192))
}

switch (script) {
  case '--runz-list':
    // --runz-describe: имя<TAB>что это; без описания — одно имя
    process.stdout.write(args.includes('--runz-describe') ? 'alpha\tпервый скрипт\nbeta\nbots\tплощадка ботов\n' : 'alpha\nbeta\nbots\n')
    break
  case 'echo':
    process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), probe: process.env.PI_EXT_RUNZ_PROBE ?? null, session: process.env.NR_SESSION ?? null }))
    break
  case 'split':
    process.stdout.write('OUT\n')
    process.stderr.write('ERR\n')
    process.exitCode = 3
    break
  case 'big': {
    const n = Number(args[0])
    writeChunks(process.stdout, `${'a'.repeat(n - 5)}TAIL!`)
    break
  }
  case 'stderr-big': {
    const n = Number(args[0])
    writeChunks(process.stderr, `${'e'.repeat(n - 5)}TAIL!`)
    break
  }
  case 'stdin': {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (data += c))
    process.stdin.on('end', () => process.stdout.write(`got:${data}`))
    break
  }
  case 'sleep': {
    // Внук — проверка, что таймаут убивает группу, а не только runz.
    const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
    process.stdout.write(`grandchild:${grandchild.pid}\n`)
    setInterval(() => {}, 1000)
    break
  }
  default:
    process.stderr.write(`runz: script not found: ${script}\n`)
    process.exitCode = 1
}
