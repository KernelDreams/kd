#!/usr/bin/env node
// kd — вход. Подсказки (`kd __complete …`) — лёгкой точкой без рантайма (бюджет 50 мс, kd-cli-spec §6).
const argv = process.argv.slice(2)
if (argv[0] === '__complete') {
  const { runComplete } = await import('../dist/complete-fast.js')
  await runComplete(argv.slice(1))
} else {
  const { main, processIo } = await import('../dist/node/cli.js')
  const code = await main(argv, processIo())
  // stdout в пайп асинхронный: дождаться слива, потом выйти (долгоживущие сокеты не держат процесс).
  await new Promise((r) => process.stdout.write('', r))
  try {
    const { getGlobalDispatcher } = await import('undici')
    await getGlobalDispatcher().close()
  } catch {}
  process.exit(code)
}
