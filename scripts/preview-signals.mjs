// Run the signal classifier over real boards, locally, without the platform.
//
//   node scripts/preview-signals.mjs [boardsPerProvider=25] [greenhouse,ashby]
//
// This exists because the classifier can pass every unit test and still be
// worthless on live data: if a vendor does not actually publish per-posting dates
// at scale, every company scores `undated` and there is no product. Check the
// distribution against real boards before shipping a build, not after.

import { readFile } from 'node:fs/promises'

import { PROVIDERS } from '../actor/src/normalize.js'
import { companySignal } from '../actor/src/signals.js'

const limit = Number(process.argv[2] ?? 25)
const providers = (process.argv[3] ?? 'greenhouse,ashby').split(',')

const index = JSON.parse(await readFile(new URL('../actor/data/companies.json', import.meta.url), 'utf8'))
const now = Date.now()
const fetched_at = new Date(now).toISOString()

const breakdown = {}
const rows = []
let dated = 0
let seen = 0

for (const provider of providers) {
  const spec = PROVIDERS[provider]
  const tokens = index.providers[provider].live.slice(0, limit).map(([t]) => t)
  for (const token of tokens) {
    const res = await fetch(spec.url(token), { headers: { 'user-agent': 'open-ats-feed (+https://github.com/veresk06/open-ats-feed)' } })
    if (!res.ok) continue
    const list = spec.list(await res.json())
    if (!list?.length) continue
    const mapped = list.map((j) => spec.map(j, token)).filter((r) => r.title && r.job_id)
    for (const r of mapped) {
      seen++
      if (r.posted_at) dated++
      delete r.description
    }
    const s = companySignal(mapped, { provider, token, company_url: mapped[0].company_url, index_as_of: index.as_of, fetched_at, now })
    if (!s) continue
    breakdown[s.signal] = (breakdown[s.signal] ?? 0) + 1
    rows.push(s)
    if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs))
  }
}

console.log(`companies: ${rows.length}   postings: ${seen}   with a publication date: ${dated} (${((dated / seen) * 100).toFixed(1)}%)`)
console.log('signal breakdown:', breakdown)
console.log('\nfastest ramps:')
for (const s of rows.filter((r) => r.signal === 'ramping').sort((a, b) => (b.ramp_ratio ?? 99) - (a.ramp_ratio ?? 99)).slice(0, 8)) {
  console.log(
    `  ${s.company.padEnd(24)} open ${String(s.open_postings).padStart(4)}  30d ${String(s.opened_30d).padStart(3)}  ` +
      `ramp ${s.ramp_ratio ?? 'n/a'}  tech ${s.tech_signals.slice(0, 4).map((t) => t.name).join('/') || '—'}`,
  )
}
console.log('\nnewly opened functions:')
for (const s of rows.filter((r) => r.new_functions.length).slice(0, 10)) {
  console.log(`  ${s.company.padEnd(24)} ${s.new_functions.map((f) => `${f.name} (${f.count})`).join(', ')}`)
}
