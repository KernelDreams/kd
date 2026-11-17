# @kerneldreams/nrd/node

## main
execBlock(block: Block, opts: ExecBlockOptions): Promise<Result<IContext>>
> Исполнить один блок → IContext. Алгоритм (§7.4):
1. engine из `block.name`; не в `executor.supports` → `Result.err`.
2. chain([blockLocals, external]) — block-local перебивает external (§4).
3. снять fence, резолв `${}` (если не `$nr-raw`).
4. `executor.run(...)`.
5. ExecOutput → IContext: `value` напрямую, иначе `stdout` по `$nr-parse`.
6. code ≠ 0 → `Result.err` со stderr.
execBlocks(doc: NRDocument, opts: ExecBlockOptions): Promise<Result<Record<string, IContext>>>
> Исполнить все exec-блоки (`shell`/`ts`/`zx`) документа → Record<id, IContext>.
Ключ — `block.id`, иначе `<engine>-<index>`. Первая ошибка прерывает.
Executor { id, supports, run }
ExecInput { engine, code, env?, cwd?, timeout?, input? }
ExecOutput { stdout, value?, stderr, code }
Engine = 'shell' | 'ts' | 'zx'
ExecBlockOptions { executor, external?, baseDir? }

## spawn
spawnExecutor: Executor