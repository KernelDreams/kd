# @kerneldreams/runz-run

A runner for runz templates, for host applications: it puts values into a run document, runs `runz` in a separate process (with cancel and timeout) and returns the results as outputs. Sub-entries add jobs (long runs outside the window, with a queue and limits) and a machine pool (a center plus workers with leases).

```sh
npm i @kerneldreams/runz-run
```

```ts
import { runTemplate } from '@kerneldreams/runz-run'

const r = await runTemplate({
  template: './fix-core.mdz',        // a runz template
  values: { source: 'https://example.com/a.png', tags: ['a', 'b'] },
  runz: ['runz'],                    // runz command: binary + argument prefix
  timeoutMs: 10 * 60_000,
})
if (r.ok) for (const o of r.outputs) console.log(o)   // text | image | file
```

The `runz` command must be available on the machine. Exports: `.` (runner), `./jobs`, `./pool`; the `runz-run` bin is the job wrapper.

Two kinds of front ends sit on top of one template contract: one where a model supplies the values through a tool, and one where a human enters them in a form.

- **Materialization** — `materialize(text, values)`: a block of root attributes with the values is inserted before the first `## ` line (last-wins overrides the template defaults). A string becomes a quoted NRD scalar (`\\`, `\"`, `\n`, `\r`, `\t`), and `${` is opted out as `\${`: a value is data, not a template (the NRD resolver is recursive over values, so without escaping, `${seed}` or `${readFile(...)}` inside the text would be executed). A `\` directly before `${` is doubled (otherwise the placeholder would come alive); the price is an extra `\` in the result.
- **Lists** (0.3.0) — `values: Record<string, TemplateValue | TemplateValue[]>`: an array is emitted as a flow literal `$[...]`; string elements use the same quoted scalar (commas, brackets, quotes and `${` are inside the quotes and opted out), numbers and flags go as is, an empty array is `$[]`. A list cannot be passed from the CLI (`--k='$[x, y]'` arrives as a string), only as a document, hence the materialization.
- **How a template reads a value** — through the resolver: `${key}` in the template text, and in a handler `resolveValue('${key}', ctx)` from `@kerneldreams/nrd`; then `"a ${b} c"` arrives exactly as that string. A raw `asText(ctx.get([key]))` sees the `\${` escape. Verified against real runz in `test/runz-live.test.ts` (skipped when runz is not on PATH).
- **Running** — `runTemplate({ template, values, runz, signal, timeoutMs, onLine? })`: the run file is written next to the template (relative `$[[...]]` and paths behave as in the original), `runz <file> --runz-json` runs in a separate process, and the file is deleted afterwards. `onLine` (0.3.0) works as in `runFile`. Cancellation is SIGTERM (comfy gets `/interrupt` on its server), then SIGKILL after 5 s.
- **Running a file as is** (0.2.0) — `runFile({ file, args, runz, signal, timeoutMs, onLine })`: `runz <file> <args...> --runz-json` with no materialization and no copy of the file. `onLine(stream, line)` delivers stdout/stderr lines as they are printed (the last stdout line, the JSON result, is not passed to `onLine`; it is parsed by `parseResult`. Only a line that looks like a JSON object is held until the next line; an ordinary line is delivered immediately, since 0.3.0). Cancellation and timeout work as in `runTemplate`. Cancellation (0.2.1) kills the whole runz process group, so children of a `$shell` block (a `sleep` holding stdout) are not orphaned and `close` does not wait for them.
- **Cleanup on exit** (0.2.2) — an exit hook kills live runz processes and removes only its own run files; a `runFile` document is never touched, even in a process that earlier ran `runTemplate` (regression test in a separate process in `test/run.test.ts`).
- **Result** — `RunResult { ok, outputs: ScriptArtifact[], output, exitCode, ms, aborted, timedOut, stderr }`; `outputs` is `ScriptResult.outputs` (`text` | `image` | `file`). `ok` means exit code 0 and JSON on stdout; empty `outputs` is not a failure — that is up to the consumer.

`runFile` (0.4.0) also takes `killGraceMs` (the pause between SIGTERM and SIGKILL), `onSpawn(pid)`, and `timeoutMs: 0` for no timeout.

## Jobs — `@kerneldreams/runz-run/jobs` (0.4.0)

A long runz run in a separate process that survives the window, the tab, the front end and a backend restart, with a queue and concurrency limits. The registry is files in `~/.runz/jobs/<id>/` (`RUNZ_JOBS_DIR` selects another directory): any process (a host, a CLI, an artifact) sees the same state.

```ts
import { start, list, get, attach, cancel, restart, scheduler } from '@kerneldreams/runz-run/jobs'

const job = await start({ target: 'fix-core.mdz', values: { source: url, out: 'result' } })   // queued → running if a slot is free
for await (const f of attach(job.id)) console.log(f.kind, f.text)                          // tail of log.ndjson + live frames until the end
await cancel(job.id)                                                                      // SIGTERM to the group, SIGKILL after 10 s
await restart(job.id)                                                                     // a new job: same target/values/cwd/keys + a copy of inputs/
```

- **Registry.** `job.mdz` follows the rule "files are read by a human": the header holds short attributes (`$status`, `$target`, `$keys`, `$out`, `$pid`, times, `$exit`), run values go in a `## $values` block (`valueBlock`), and the result and error go in `## $output` / `## $error` bodies. `log.ndjson` holds frames `{ts, kind: queued|start|line|end|lost|cancel|resume, stream?, text?, status?...}`. `inputs/` holds the job inputs. The id sorts by time (`20261008-143012345-a1b2`). Every edit of `job.mdz` is under the lock `<jobs>/.lock`, and writes are atomic (tmp + rename).
- **Statuses:** `queued` → `running` → `done` | `failed` | `cancelled`; `lost` means the wrapper process is gone and there is no end in the registry (kill -9, machine crash). `list`/`get` show `lost` immediately; a scheduler pass records it.
- **Wrapper.** A job is launched as `node <jobs/scheduler.js> job-wrap <id>` (`detached`, its own process group, stdio detached); the wrapper itself runs `runFile` and writes `log.ndjson` and the end into `job.mdz`, so the parent may die right after enqueueing. The document with values is materialized next to the recipe (`.<name>.job-<id>.mdz`, deleted afterwards); an app receives the values as flags. A value `inputs/<name>` resolves to the absolute path of the input. The wrapper is the scheduler module itself: in a bundle (a sidecar vendoring the package as a single file) there is no `cli.js` next to it. The package bin `runz-run job-wrap <id>` does the same.
- **Scheduler.** `tick()` is one pass under `.lock`: `running` with a dead pid becomes `lost` (or `cancelled` if cancellation was requested), `resume_lost` puts `lost` back in the queue, and `queued` jobs start in order of enqueueing while the common slot and the slots of **all** the job's keys are free. A pass is made on enqueue, on the end of every job (by the wrapper) and on cancel, so the queue advances even without a resident process. `scheduler()` is the resident loop (one per machine via `<jobs>/.scheduler`; if the holder dies, the next one takes the lock; one loop per process).
- **Limits** — `$jobs: {max: 6, limits: {gpu: 3, api: 4, mac: 1}, resume_lost: true}` in `~/.runz/config.md` (`NR_RUNZ_CONFIG`), re-read on every pass. A job's keys: `keys` in `start` → the recipe's `$job_keys: $[gpu]` (including includes `$[[base.mdz]]` and profiles: a form field `$models: preset models/*.mdz`, a job value `models: opus` — the profile's `$job_keys`) → the recipe name. A key without a limit is bounded only by `max`. A recipe's `$job_timeout: 90m` is a timeout (none by default).
- **Inputs** — `start({files: [{name, path | bytes | text, link?}]})`: a path is copied into `inputs/` (the source may be deleted; `link: true` makes a symlink), bytes and text are written there. In `values` there are stable references `inputs/<name>`. A job's runz gets `RUNZ_JOB_DIR`, the job directory: the recipe sees `inputs/` even without values.
- **Title** by default: `title` → `values.name` → the name of the `out` folder → the tail of `source` → the recipe name. `out` (a value or the recipe's `$out`, relative to `cwd`) is the run folder.
- **Cancel** — `cancel`: `queued` becomes `cancelled` at once; for `running`, `$cancel` is written to the registry and SIGTERM goes to the wrapper's group, which stops the runz group (SIGKILL after 10 s) and writes `cancelled`; `cancel` waits up to 3 s for the end and makes a pass (a wrapper killed before its handlers are installed will not). If it does not answer within 15 s, a scheduler pass finishes it off.

Tests: `npm test` builds first (the wrapper is the built one), then runs vitest: registry round-trip of `job.mdz`, per-key and global `max` limits, `lost` on a dead pid and resume, log after the parent's death (the parent is a separate process), `attach` from the middle, failure, inputs after the sources are deleted, and `restart`.

## Machine pool — `@kerneldreams/runz-run/pool` (0.6.0)

Jobs run on any machine of the pool. The **center** (`Center`) is the same `~/.runz/jobs` registry plus dispatch; a **worker** (`Worker`) on each machine comes for a job itself (long-poll) with a heartbeat every 10 s. The center never connects out.

```ts
import { Center, servePool, Worker, loadWorkerConfig, httpPoolClient } from '@kerneldreams/runz-run/pool'

const center = new Center({ dir: jobsDir(), prodHost: 'host-a' }).start()
await servePool(center, { keys: { 'host-a': '...', 'host-b': '...' }, port: 7860 })   // expose on a private network only

const cfg = loadWorkerConfig()                                         // ~/.runz/worker.md
await new Worker({ config: cfg, client: httpPoolClient(cfg.pool, cfg.key) }).run()
```

- **Submitting:** `start({..., pool: true | on: 'host-b' | shards: 16, needs})`; `$jobs: {pool: true}` in `~/.runz/config.md` sends all of the machine's jobs to the pool (the machine's own scheduler neither starts pool jobs nor buries them by pid). Recipe: `$needs: {cpu: 8, mem: "16G", os: "darwin", labels: ["cargo"], host: "host-a"}` (an object is JSON5, sizes are strings), `$retries: 2`, `$shards: 32`, `$merge: merge.mdz`.
- **Packages:** code is the files of the document's repo (`git ls-files -co`, edits as they are, `$dirty`) or the document's directory; inputs are `inputs/`. The name is the sha256 of the manifest (path, mode, file sha), transfer is `tar.gz`; the center's store is `~/.runz/jobs/.pool/pkg/<sha>.tgz`, the worker's cache is `~/.runz/pool/cache/<sha>/` with LRU by `$budget.disk`.
- **On the machine:** `~/.runz/pool/work/<id>-<attempt>/{code,inputs,out}`; the `out` of values is this folder, and after the end it travels to the center as an archive and is unpacked into the job's `$out` (or `<job>/out`). Environment: `RUNZ_JOB_DIR`, `RUNZ_SHARD`, `RUNZ_SHARDS`, `RUNZ_POOL_WORKER`. The log is frames with a `worker` field in the same `log.ndjson`.
- **Lease:** 60 s, extended by the heartbeat; when it expires the job goes back to `queued`, the attempt count grows by 1 and the machine is added to `$tried`; with no attempts left the job is `lost`. An end and a log are accepted only from the current lease. A job returned by the guard does not spend an attempt. After a center restart, `recover()` gives running jobs a fresh lease. If the center is down, the end waits in `~/.runz/pool/outbox/`.
- **Guard:** `$guard: {mem_free: "4G", disk_free: "20G", load: 0.8}` against real measurements (on macOS free memory is `vm_stat`: free + inactive + speculative + purgeable). When tripped the machine takes nothing; when memory drops below half the threshold, the newest job is stopped and returned to the queue.
- **Shards:** a parent in `running` with no machine plus N children; when all are done, the `$merge` job runs with `inputs/shard-<i>/` holding the shards' outputs, and the parent's result is the merge result. If a shard fails, the parent is `failed`.
- **HTTP:** `/v1/heartbeat`, `/v1/claim?wait=`, `/v1/log`, `/v1/finish` (the body is `tar.gz`, the report is in the `x-pool-report` header), `/v1/return`, `/v1/pkg/<sha>`, `/v1/workers`, `/v1/pause`; the machine key is a `Bearer` token.

`~/.runz/worker.md`:

```
$name: host-b
$pool: https://pool.example.com
$key: ...
$budget: {cpu: 6, mem: "12G", disk: "40G", jobs: 2}
$hours: "always"            // "22:00-08:00", "idle" (HIDIdleTime >= 5 min)
$guard: {mem_free: "4G", disk_free: "20G", load: 0.8}
$labels: $[cargo, xcode]
```

## Development

```sh
npm run build   # dist
npm test
```
