// Trace — рендер decision log (§7).
//
// dry показывает ЧТО получилось, trace — ПОЧЕМУ. Логируются решения, которые
// движок и так принимает: matched → scored → included/dropped/replaced.
// `--json` отдаёт то же машиночитаемо (задел под ui-protocol).

import type { ContextPackage, Decision } from './types.js'

function score(n: number): string {
  return n === Infinity ? '∞' : String(n)
}

function line(d: Decision): string {
  switch (d.kind) {
    case 'matched': {
      const keys = d.keys?.length ? ` [${d.keys.join(', ')}]` : ''
      const by = d.triggeredBy ? ` ← ${d.triggeredBy}` : ''
      return `  matched   ${d.entry}  (${d.injector})${keys}${by}`
    }
    case 'scored': {
      const boost = d.boost ? ` +${d.boost}` : ''
      return `  scored    ${d.item}  ${d.source}: ${score(d.base)}${boost} → ${score(d.final)}`
    }
    case 'included':
      return `  included  ${d.item}  ${d.tokens} tok  (осталось ${d.budgetLeft})`
    case 'dropped':
      return `  dropped   ${d.item}  ${d.reason}${d.detail ? `: ${d.detail}` : ''}`
    case 'replaced':
      return `  replaced  ${d.item}  → ${d.by}`
  }
}

/** Человекочитаемый trace. */
export function renderTrace(pkg: ContextPackage): string {
  const m = pkg.meta
  const out: string[] = []
  out.push('=== context trace ===')
  out.push(
    `budget: ${m.totalTokens} / ${m.budget} tok · history ${m.historyFull} full, ` +
      `${m.historySummarized} summarized, ${m.historyDropped} dropped · ` +
      `injections ${m.injectionsIncluded}/${m.injectionsMatched} matched, ${m.injectionsDropped} dropped`,
  )
  out.push('')
  for (const d of m.decisions) out.push(line(d))
  return out.join('\n')
}

/** Машиночитаемый trace. Infinity не переживает JSON — пишем строкой. */
export function traceJSON(pkg: ContextPackage): string {
  return JSON.stringify(
    { meta: pkg.meta, injections: pkg.injections },
    (_k, v) => (v === Infinity ? 'Infinity' : v),
    2,
  )
}
