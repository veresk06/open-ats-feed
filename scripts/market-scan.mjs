#!/usr/bin/env node
// Run the company-signal classifier across the whole measured roster, locally.
//
//   node scripts/market-scan.mjs [deadlineSeconds=600]
//
// Why this exists: `preview-signals.mjs` runs the classifier over a handful of
// boards to check it is not producing nonsense. This runs it over all of them and
// keeps the result, because the aggregate is the thing worth publishing — "who
// started hiring this month, across 10,197 companies" is a number nobody else has,
// and it is computable from posting dates in a single pass with no accumulated
// history.
//
// Costs $0. This never touches the Apify platform; it calls the same public vendor
// APIs the Actor calls, from here.
//
// The deadline is not a nicety. Lever publishes `Crawl-delay: 1` and we honour it,
// so Lever alone would take 26 minutes for its 1,538 boards while Greenhouse and
// Ashby finish in single digits. Rather than either breaking the crawl delay or
// letting the run overshoot, providers run concurrently against a shared wall clock
// and the output records exactly how far each one got. A partial sweep that says
// how partial it is beats a complete one that never lands.

import { readFile, writeFile } from 'node:fs/promises'

import { PROVIDERS } from '../actor/src/normalize.js'
import { companySignal } from '../actor/src/signals.js'

const DEADLINE_S = Number(process.argv[2] ?? 600)
const startedAt = Date.now()
const deadline = startedAt + DEADLINE_S * 1000
const now = Date.now()
const fetched_at = new Date(now).toISOString()

const index = JSON.parse(await readFile(new URL('../actor/data/companies.json', import.meta.url), 'utf8'))

const UA = 'open-ats-feed (+https://github.com/veresk06/open-ats-feed)'

async function fetchBoard(provider, token) {
  const spec = PROVIDERS[provider]
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(spec.url(token), {
        signal: AbortSignal.timeout(25_000),
        headers: { 'user-agent': UA, accept: 'application/json' },
      })
      if (res.status === 404 || res.status === 410) return { rows: [], gone: true }
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1200 * 2 ** attempt))
        continue
      }
      if (!res.ok) return { rows: [], gone: true }
      const list = spec.list(await res.json())
      if (!list) return { rows: [], gone: true }
      return { rows: list.map((j) => spec.map(j, token)).filter((r) => r.title && r.job_id) }
    } catch {
      if (attempt === 2) return { rows: [], failed: true }
      await new Promise((r) => setTimeout(r, 900 * 2 ** attempt))
    }
  }
  return { rows: [], failed: true }
}

const signals = []
const perProvider = {}

async function sweep(provider) {
  const spec = PROVIDERS[provider]
  const tokens = index.providers[provider].live.map(([t]) => t)
  const stat = { candidates: tokens.length, scanned: 0, gone: 0, failed: 0, postings: 0, complete: false }
  perProvider[provider] = stat

  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(spec.concurrency, tokens.length) }, async () => {
      for (;;) {
        if (Date.now() > deadline) return
        const i = next++
        if (i >= tokens.length) return
        const token = tokens[i]
        const at = Date.now()
        const { rows, gone, failed } = await fetchBoard(provider, token)
        stat.scanned++
        if (failed) stat.failed++
        else if (gone || !rows.length) stat.gone++
        else {
          stat.postings += rows.length
          const rec = companySignal(rows, {
            provider,
            token,
            company_url: rows[0].company_url,
            index_as_of: index.as_of,
            fetched_at,
            now,
          })
          if (rec) signals.push(rec)
        }
        const wait = spec.delayMs - (Date.now() - at)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      }
    }),
  )
  stat.complete = next >= tokens.length
}

await Promise.all(Object.keys(PROVIDERS).map(sweep))

// ---- aggregates -----------------------------------------------------------

const breakdown = { ramping: 0, new_board: 0, steady: 0, quiet: 0, undated: 0 }
for (const s of signals) breakdown[s.signal] = (breakdown[s.signal] ?? 0) + 1

const marketTech = new Map()
for (const s of signals) {
  for (const t of s.tech_signals) marketTech.set(t.name, (marketTech.get(t.name) ?? 0) + t.count)
}

const byOpened30 = (a, b) => b.opened_30d - a.opened_30d || a.company.localeCompare(b.company)
const slim = (s) => ({
  source: s.source,
  company: s.company,
  company_url: s.company_url,
  signal: s.signal,
  open_postings: s.open_postings,
  opened_7d: s.opened_7d,
  opened_30d: s.opened_30d,
  opened_90d: s.opened_90d,
  baseline_30d: s.baseline_30d,
  ramp_ratio: s.ramp_ratio,
  new_functions: s.new_functions,
  top_departments: s.top_departments.slice(0, 3),
  tech_signals: s.tech_signals.slice(0, 6),
  executive_openings_90d: s.executive_openings_90d,
  remote_postings: s.remote_postings,
  newest_posting_at: s.newest_posting_at,
})

const out = {
  fetched_at,
  index_as_of: index.as_of,
  elapsed_s: Math.round((Date.now() - startedAt) / 1000),
  deadline_s: DEADLINE_S,
  per_provider: perProvider,
  scanned: Object.values(perProvider).reduce((n, p) => n + p.scanned, 0),
  boards_with_postings: signals.length,
  postings_seen: Object.values(perProvider).reduce((n, p) => n + p.postings, 0),
  breakdown,
  // "Ramping" is the classifier's own verdict; ranking inside it is by absolute
  // new roles, not by ratio. A two-person company going from 1 to 3 postings has a
  // ratio of 3 and is noise; the ratio is shown so a reader can see both.
  ramping: signals.filter((s) => s.signal === 'ramping').sort(byOpened30).map(slim),
  new_boards: signals.filter((s) => s.signal === 'new_board').sort(byOpened30).map(slim),
  new_functions: signals
    .filter((s) => s.new_functions.length)
    .sort((a, b) => b.new_functions[0].count - a.new_functions[0].count || a.company.localeCompare(b.company))
    .map(slim),
  market_tech: [...marketTech.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, postings]) => ({ name, postings })),
}

await writeFile(new URL('../data/market-scan.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`)

const csv = [
  'provider,company,company_url,signal,open_postings,opened_7d,opened_30d,opened_90d,baseline_30d,ramp_ratio,executive_openings_90d,remote_postings,newest_posting_at',
  ...signals
    .sort(byOpened30)
    .map((s) =>
      [
        s.source,
        s.company,
        s.company_url,
        s.signal,
        s.open_postings,
        s.opened_7d,
        s.opened_30d,
        s.opened_90d,
        s.baseline_30d,
        s.ramp_ratio ?? '',
        s.executive_openings_90d,
        s.remote_postings,
        s.newest_posting_at ?? '',
      ].join(','),
    ),
].join('\n')
await writeFile(new URL('../data/market-scan.csv', import.meta.url), `${csv}\n`)

console.log(
  JSON.stringify(
    {
      elapsed_s: out.elapsed_s,
      scanned: out.scanned,
      postings_seen: out.postings_seen,
      breakdown,
      per_provider: perProvider,
      ramping: out.ramping.length,
      new_boards: out.new_boards.length,
      top_tech: out.market_tech.slice(0, 8),
    },
    null,
    1,
  ),
)
