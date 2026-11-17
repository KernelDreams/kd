#!/usr/bin/env node
/**
 * `runz-run job-wrap <id>` — обёртка задачи (jobs-spec §2). Её запускает
 * планировщик отдельным процессом (модулем `jobs/scheduler.js`); руками звать не нужно.
 */

import { wrapperMain } from './jobs/scheduler.js'

const [cmd, id] = process.argv.slice(2)
if (cmd === 'job-wrap' && id) wrapperMain(id)
else {
  process.stderr.write('usage: runz-run job-wrap <id>\n')
  process.exit(2)
}
