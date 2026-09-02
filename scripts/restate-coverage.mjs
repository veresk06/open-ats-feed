#!/usr/bin/env node
// Restate the published coverage numbers from the company index the Actor actually
// ships, so the README, the results doc and the store listing cannot drift from it.
//
// This exists because they did drift. The README headline was 10,380 companies, of
// which the Lever third was extrapolated from a 1,000-token sample while Greenhouse
// and Ashby were counted — and the Actor meanwhile shipped an index built from the
// same sample. Every number below is now read back out of actor/data/companies.json,
// which is the file the product runs on. If it is not in the index, we do not claim it.
//
//   node scripts/build-company-index.mjs   # first — rebuild the index from measurements
//   node scripts/restate-coverage.mjs      # then — report what it actually contains

import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const index = JSON.parse(await readFile(resolve(ROOT, 'actor/data/companies.json'), 'utf8'))
const tokens = JSON.parse(await readFile(resolve(ROOT, 'data/tokens.json'), 'utf8'))

const fmt = (n) => n.toLocaleString('en-US')
const rows = []

for (const [name, p] of Object.entries(index.providers)) {
  const live = p.live.length
  const postings = p.live.reduce((a, [, j]) => a + j, 0)
  const harvested = (tokens[name] ?? []).length
  const unprobed = (p.unverified ?? []).length
  // Hit rate is against what we actually probed, not against what we harvested —
  // dividing by the harvest would silently count unprobed tokens as misses.
  const probed = harvested - unprobed
  rows.push({
    provider: name,
    harvested,
    probed,
    unprobed,
    live,
    postings,
    hitRate: probed ? live / probed : 0,
    empty: p.empty.length,
  })
}

const total = {
  live: rows.reduce((a, r) => a + r.live, 0),
  postings: rows.reduce((a, r) => a + r.postings, 0),
  unprobed: rows.reduce((a, r) => a + r.unprobed, 0),
}

console.log(`Index as_of ${index.as_of}\n`)
console.log('| Provider | Harvested | Probed | Live boards | Hit rate | Live postings |')
console.log('|---|---:|---:|---:|---:|---:|')
for (const r of rows) {
  console.log(
    `| ${r.provider} | ${fmt(r.harvested)} | ${fmt(r.probed)} | ${fmt(r.live)} | ` +
      `${(r.hitRate * 100).toFixed(1)}% | ${fmt(r.postings)} |`,
  )
}
console.log(`| **Total** | | | **${fmt(total.live)}** | | **${fmt(total.postings)}** |`)

console.log(
  `\nEvery figure above is counted, not projected. ${fmt(total.unprobed)} harvested tokens ` +
    'remain unprobed; they are shipped as an opt-in list and are never counted as live or dead.',
)
