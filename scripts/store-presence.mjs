#!/usr/bin/env node
// Store presence — are we actually in the Apify Store index, or only reachable by direct link?
//
// WHY THIS EXISTS. For thirty cycles the company assumed its distribution channel was Store
// search: publish a public Actor, strangers find it, the tripwire moves. The tripwire never
// moved. Cycle 31 measured the assumption instead of holding it, and the assumption is false —
// the Actor is public, its page returns 200, and it is absent from every Store listing.
//
// THE MEASUREMENT IS NOT "search for ourselves and see nothing". That test is worthless on its
// own, because the store endpoint is lossy: ask for 100 items against 64,916 matches and it
// returns 74. Absence from one lossy response is not evidence of anything. Two controls make it
// evidence:
//
//   CONTROL 1 — is the loss random or deterministic?
//     The same query five times returned byte-identical sets (74/74 intersection). So the
//     endpoint applies a FILTER, not a sample. Being missing once means being missing always,
//     and repeated draws are not independent coin flips — they are the same verdict re-read.
//
//   CONTROL 2 — does exact-name search work for actors that ARE listed?
//     Eight known-listed actors were searched by their exact name. 8 of 8 came back. So the
//     method finds an actor when the actor is there, which is the only thing that licenses
//     reading a null result as absence.
//
// Against those controls: ours returns `total:1, count:0` for its own exact name, and appeared
// in 0 of 20 searches, 0 of 5 category pages, and 0 of the newest-sorted window that brackets
// its own creation time. That is a deterministic exclusion, not a sampling miss.
//
// WHAT WAS RULED OUT, so nobody re-runs these:
//   indexing lag  — actors created 0.7h ago are already listed; ours is 8h old and is not
//   missing icon  — 150 of 409 sampled listed actors have no pictureUrl either
//   bad category  — AGENTS is real, 13 listed actors carry it
//   random drop   — the filter is deterministic (control 1)
//   deprecation   — isDeprecated:false, notice:"NONE", page is index,follow and returns 200
// The cause is not visible through the public API. It needs Apify Console or Apify support.
//
// `total` is reported but NOT trusted as a presence signal: the nonsense query
// "qwertyuiopasdfgh" also returns total:1, so a total of 1 with zero items is not by itself
// proof that the 1 is us. The load-bearing evidence is the control pair above.
//
//   node scripts/store-presence.mjs           append a reading, print it
//   node scripts/store-presence.mjs --quiet    print only when presence changes
//
// Exit 10 when presence CHANGES in either direction — appearing is the thing we are waiting for,
// disappearing after having appeared is worth waking someone for too.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'data/store-presence.csv')
const USERNAME = process.env.ACTOR_USERNAME ?? 'sharp_malachite'
const NAME = process.env.ACTOR_NAME ?? 'open-ats-jobs-feed'
const QUIET = process.argv.includes('--quiet')

// Searches a real buyer might plausibly type. Kept fixed so readings stay comparable over time;
// adding a query later changes the denominator and breaks the series.
const QUERIES = [
  'ats',
  'greenhouse',
  'ashby',
  'lever',
  'job postings',
  'jobs api',
  'hiring signals',
  'ats jobs',
  'greenhouse jobs',
  'job board',
  NAME,
  USERNAME,
]

// Actors confirmed listed at the time of writing. They are the control: if these stop returning,
// the endpoint or the method broke, and a null result for us means nothing that day.
const CONTROLS = [
  ['themineworks', 'ats-jobs'],
  ['jobo.world', 'ats-jobs-api'],
  ['k1ra', 'ats-jobs-scraper'],
  ['vnx0', 'ashby-jobs-scraper'],
  ['skootle', 'greenhouse-jobs'],
  ['glitchbound', 'ats-jobs-search'],
]

const COLUMNS = [
  'read_at',
  'searches_run',
  'searches_hit',
  'category_pages_run',
  'category_pages_hit',
  'controls_run',
  'controls_found',
  'listed',
  'store_page_http',
]

const store = async (params) => {
  const res = await fetch(`https://api.apify.com/v2/store?${params}`)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on /v2/store?${params}`)
  const { data } = await res.json()
  return (data.items ?? []).map((i) => `${i.username}/${i.name}`)
}

const SELF = `${USERNAME}/${NAME}`

// 1. Free-text searches.
let searchesHit = 0
for (const q of QUERIES) {
  const items = await store(`limit=100&search=${encodeURIComponent(q)}`)
  if (items.includes(SELF)) searchesHit += 1
}

// 2. Category browse, paged. Our three categories, first few pages of each.
let catRun = 0
let catHit = 0
for (const c of ['JOBS', 'LEAD_GENERATION', 'AGENTS']) {
  for (const offset of [0, 100, 200]) {
    const items = await store(`limit=100&offset=${offset}&category=${c}`)
    catRun += 1
    if (items.includes(SELF)) catHit += 1
  }
}

// 3. Controls. Without these a zero above is uninterpretable.
let controlsFound = 0
for (const [u, n] of CONTROLS) {
  const items = await store(`limit=100&search=${encodeURIComponent(n)}`)
  if (items.includes(`${u}/${n}`)) controlsFound += 1
}

// 4. The public page itself, to separate "not in the index" from "not on the platform".
const pageRes = await fetch(`https://apify.com/${USERNAME}/${NAME}`, { redirect: 'follow' })

const row = {
  read_at: new Date().toISOString(),
  searches_run: QUERIES.length,
  searches_hit: searchesHit,
  category_pages_run: catRun,
  category_pages_hit: catHit,
  controls_run: CONTROLS.length,
  controls_found: controlsFound,
  listed: searchesHit + catHit > 0 ? 'yes' : 'no',
  store_page_http: pageRes.status,
}

let previous = null
let existing = ''
try {
  existing = await readFile(OUT, 'utf8')
  const lines = existing.trim().split('\n')
  if (lines.length > 1) {
    const cells = lines[lines.length - 1].split(',')
    previous = Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]]))
  }
} catch {
  // First reading. The file is created below.
}

const header = existing ? '' : `${COLUMNS.join(',')}\n`
await writeFile(OUT, `${existing}${header}${COLUMNS.map((c) => row[c]).join(',')}\n`)

const controlsOk = controlsFound === CONTROLS.length
const changed = previous !== null && previous.listed !== row.listed

if (!QUIET || changed || !controlsOk) {
  console.log(`store presence @ ${row.read_at}`)
  console.log(
    `  ${SELF}: listed=${row.listed} | ` +
      `search ${searchesHit}/${QUERIES.length} | category ${catHit}/${catRun} | ` +
      `page HTTP ${row.store_page_http}`,
  )
  console.log(`  controls ${controlsFound}/${CONTROLS.length} found`)
  if (!controlsOk) {
    console.log('  CONTROLS FAILED — the method or the endpoint is broken today.')
    console.log('  A null result for us is NOT evidence of absence in this reading.')
  } else if (row.listed === 'no') {
    console.log('  Controls pass and we are absent: deterministic exclusion from the Store index.')
    console.log('  The page is reachable by direct link; it is not reachable by search.')
  }
  if (changed) console.log(`  CHANGED  listed: ${previous.listed} -> ${row.listed}`)
}

process.exit(changed ? 10 : 0)
