#!/usr/bin/env node
// Store presence — is our record in the Apify Store index, and is it served to strangers?
//
// WHY THIS EXISTS. For thirty cycles the company assumed its distribution channel was Store
// search: publish a public Actor, strangers find it, the tripwire moves. The tripwire never
// moved. Cycle 31 measured the assumption instead of holding it and found we were unreachable
// by search.
//
// CYCLE 32 CORRECTION — Cycle 31's CONCLUSION WAS WRONG, and the way it was wrong matters.
// It reported "deterministic exclusion from the Store index". The truth is narrower and points
// somewhere completely different:
//
//     WE ARE IN THE INDEX. OUR RECORD IS WITHHELD FROM UNAUTHENTICATED CALLERS.
//
// Every probe in the old version called /v2/store with no Authorization header. Add the token
// and our Actor comes back. Measured, same query, token the only variable:
//
//     search=open-ats-jobs-feed        auth -> 1 item   anon -> 0 items (count:1, body withheld)
//     search=ats-jobs                  auth -> 78       anon -> 78
//     search=multi-ats-jobs-feed       auth -> 3        anon -> 3
//     search=career-site-job-listing-api  auth -> 42    anon -> 42
//
// So it is not a general property of anonymous access — competitors are served identically both
// ways. The discriminating control: take the newest Actors in the Store and check each one
// anonymously. 7 of 7 were served. Ours is the only record withheld.
//
// WHY THE OLD CONCLUSION SURVIVED ITS OWN CONTROLS. Cycle 31's controls were honest and they
// passed: 8 of 8 known-listed actors did return by exact name, anonymously. That verified the
// METHOD without verifying that the method measured the intended QUANTITY. Every probe was
// anonymous, so the experiment could only ever see the anonymous surface. A control proves the
// instrument works; it does not prove you pointed it at the right thing.
//
// WHAT THIS RULES OUT, so nobody re-runs them: anything fixable in the Actor's own card.
// Icon, categories, description, keywords, deprecation, indexing lag — all were investigated for
// three cycles and none of them can produce an auth/anon asymmetry on one record. The remaining
// live hypothesis is a moderation or creator-verification gate on the account, which is
// consistent with KYC never having been completed.
//
//   node scripts/store-presence.mjs           append a reading, print it
//   node scripts/store-presence.mjs --quiet    print only when presence changes
//
// Exit 10 when presence CHANGES in either direction — becoming visible to strangers is the thing
// we are waiting for; losing authenticated presence would matter too.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { staleListingFields } from './lib/listing.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'data/store-presence.csv')
const USERNAME = process.env.ACTOR_USERNAME ?? 'sharp_malachite'
const NAME = process.env.ACTOR_NAME ?? 'open-ats-jobs-feed'
const QUIET = process.argv.includes('--quiet')
const TOKEN = process.env.APIFY_TOKEN

if (!TOKEN) {
  console.error('APIFY_TOKEN is not set. Read it from .env; never paste the value anywhere.')
  console.error('Without it the auth/anon comparison — the whole point of this script — cannot run.')
  process.exit(1)
}

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

// Actors confirmed listed at the time of writing. They are the method control: if these stop
// returning anonymously, the endpoint or the method broke, and a null result for us means
// nothing that day.
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
  // Added in Cycle 32. Blank on older rows, which were anonymous-only readings.
  'indexed_auth',
  'anon_withheld',
  'newest_run',
  'newest_anon_served',
  // Added in Cycle 43. Which listing fields disagree with the shipped roster, ';'-joined.
  'listing_stale',
]

const store = async (params, { auth = false } = {}) => {
  const res = await fetch(`https://api.apify.com/v2/store?${params}`, {
    headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
  })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} on /v2/store?${params}`)
  const { data } = await res.json()
  return (data.items ?? []).map((i) => `${i.username}/${i.name}`)
}

const SELF = `${USERNAME}/${NAME}`

// 1. Free-text searches, ANONYMOUS. This is the surface a stranger and a crawler actually see,
//    so it stays the definition of `listed` and the series remains comparable across cycles.
let searchesHit = 0
for (const q of QUERIES) {
  const items = await store(`limit=100&search=${encodeURIComponent(q)}`)
  if (items.includes(SELF)) searchesHit += 1
}

// 2. Category browse, paged, anonymous.
let catRun = 0
let catHit = 0
for (const c of ['JOBS', 'LEAD_GENERATION', 'AGENTS']) {
  for (const offset of [0, 100, 200]) {
    const items = await store(`limit=100&offset=${offset}&category=${c}`)
    catRun += 1
    if (items.includes(SELF)) catHit += 1
  }
}

// 3. Method control: known-listed actors, anonymous. Without these a zero above is
//    uninterpretable — it could mean the endpoint is broken rather than that we are hidden.
let controlsFound = 0
for (const [u, n] of CONTROLS) {
  const items = await store(`limit=100&search=${encodeURIComponent(n)}`)
  if (items.includes(`${u}/${n}`)) controlsFound += 1
}

// 4. THE MEASUREMENT CYCLE 31 MISSED: the same exact-name query, with the token.
//    Authenticated presence means the record exists in the index; the gap between this and
//    step 1 is the whole finding.
const authItems = await store(`limit=100&search=${encodeURIComponent(NAME)}`, { auth: true })
const indexedAuth = authItems.includes(SELF)
const anonItems = await store(`limit=100&search=${encodeURIComponent(NAME)}`)
const anonWithheld = indexedAuth && !anonItems.includes(SELF)

// 5. Discriminating control: is withholding just what happens to new Actors? Take the newest
//    records in the Store and check each is served anonymously. If they are and we are not,
//    the gate is on us specifically rather than on recency.
const newest = await store('limit=12&sortBy=newest', { auth: true })
let newestServed = 0
for (const ref of newest) {
  const n = ref.slice(ref.indexOf('/') + 1)
  const items = await store(`limit=100&search=${encodeURIComponent(n)}`)
  if (items.includes(ref)) newestServed += 1
}

// 6. Does the listing still describe the product we ship? `apify push` uploads source and
//    builds an image; it does NOT write title/description/seoTitle/seoDescription from
//    .actor/actor.json onto the Actor record. Those four are set at creation or by hand, and
//    then never move. Ours said "10,197 verified company boards on Greenhouse, Ashby and Lever"
//    for roughly thirty-five cycles while the Actor shipped six providers and 18,164 boards —
//    understating the product by 44% on the one surface a buyer reads first. Nobody noticed,
//    because a successful build looks exactly the same either way.
//    So the roster is the source of truth and the listing is checked against it, every cycle.
//    Details and the API's undocumented length caps: docs/devops/apify-listing-metadata.md
const rosterLive = JSON.parse(await readFile(resolve(ROOT, 'actor/data/companies.json'), 'utf8'))
  .totals.live
const rosterText = rosterLive.toLocaleString('en-US')
const actorRecord = await fetch(
  `https://api.apify.com/v2/acts/${USERNAME}~${NAME}?token=${TOKEN}`,
).then((r) => (r.ok ? r.json() : null))
const SHIPPED = ['Greenhouse', 'Ashby', 'Lever', 'Breezy', 'Recruitee', 'Teamtailor']
const listingStale = actorRecord
  ? staleListingFields(actorRecord.data, { rosterText, providers: SHIPPED })
  : null

const row = {
  read_at: new Date().toISOString(),
  searches_run: QUERIES.length,
  searches_hit: searchesHit,
  category_pages_run: catRun,
  category_pages_hit: catHit,
  controls_run: CONTROLS.length,
  controls_found: controlsFound,
  listed: searchesHit + catHit > 0 ? 'yes' : 'no',
  store_page_http: (await fetch(`https://apify.com/${USERNAME}/${NAME}`, { redirect: 'follow' })).status,
  indexed_auth: indexedAuth ? 'yes' : 'no',
  anon_withheld: anonWithheld ? 'yes' : 'no',
  newest_run: newest.length,
  newest_anon_served: newestServed,
  listing_stale: listingStale === null ? 'unread' : listingStale.join(';'),
}

// Read the previous reading. The file predates the Cycle 32 columns, so map by the header that
// is actually in the file rather than assuming today's column set.
let previous = null
let existing = ''
let existingHeader = null
try {
  existing = await readFile(OUT, 'utf8')
  const lines = existing.trim().split('\n')
  existingHeader = lines[0].split(',')
  if (lines.length > 1) {
    const cells = lines[lines.length - 1].split(',')
    previous = Object.fromEntries(existingHeader.map((c, i) => [c, cells[i]]))
  }
} catch {
  // First reading. The file is created below.
}

// Migrate the series rather than starting a new one: pad historical rows to the new width.
if (existingHeader && existingHeader.length !== COLUMNS.length) {
  const lines = existing.trim().split('\n')
  const padded = lines
    .slice(1)
    .map((l) => l + ','.repeat(COLUMNS.length - existingHeader.length))
  existing = `${COLUMNS.join(',')}\n${padded.join('\n')}\n`
} else if (!existing) {
  existing = `${COLUMNS.join(',')}\n`
}
await writeFile(OUT, `${existing}${COLUMNS.map((c) => row[c]).join(',')}\n`)

const controlsOk = controlsFound === CONTROLS.length
const newestOk = newest.length > 0 && newestServed === newest.length
const changed =
  previous !== null &&
  (previous.listed !== row.listed ||
    (previous.indexed_auth !== undefined &&
      previous.indexed_auth !== '' &&
      previous.indexed_auth !== row.indexed_auth))

if (!QUIET || changed || !controlsOk) {
  console.log(`store presence @ ${row.read_at}`)
  console.log(
    `  ${SELF}: anon listed=${row.listed} | authenticated indexed=${row.indexed_auth} | ` +
      `search ${searchesHit}/${QUERIES.length} | category ${catHit}/${catRun} | ` +
      `page HTTP ${row.store_page_http}`,
  )
  console.log(`  controls ${controlsFound}/${CONTROLS.length} found | newest served anonymously ${newestServed}/${newest.length}`)
  if (listingStale === null) {
    console.log('  listing: could not read the Actor record — metadata NOT checked this reading.')
  } else if (listingStale.length) {
    console.log(`  LISTING STALE: ${listingStale.join(', ')} disagree with the shipped roster`)
    console.log(`  of ${rosterText} boards across ${SHIPPED.length} providers. \`apify push\` does not`)
    console.log('  write these; PUT /v2/acts/{id}. See docs/devops/apify-listing-metadata.md')
  } else {
    console.log(`  listing agrees with the roster: ${rosterText} boards, ${SHIPPED.length} providers`)
  }
  if (!controlsOk) {
    console.log('  CONTROLS FAILED — the method or the endpoint is broken today.')
    console.log('  A null result for us is NOT evidence of absence in this reading.')
  } else if (anonWithheld && newestOk) {
    console.log('  WITHHELD: the record is in the index and is not served to anonymous callers,')
    console.log(`  while ${newestServed}/${newest.length} of the newest Actors are. The gate is on us, not on recency.`)
  } else if (row.listed === 'no' && row.indexed_auth === 'no') {
    console.log('  Absent under both auth and anon: genuinely not in the index.')
  } else if (row.listed === 'yes') {
    console.log('  VISIBLE TO STRANGERS. This is the state we have been waiting for.')
  }
  if (changed) {
    console.log(`  CHANGED  anon listed: ${previous.listed} -> ${row.listed}` +
      (previous.indexed_auth ? `, indexed_auth: ${previous.indexed_auth} -> ${row.indexed_auth}` : ''))
  }
}

// Exit 10 on a changed presence — or on a listing that no longer describes what ships. The
// second one is not a curiosity: it is the defect that sat unnoticed for thirty-five cycles.
process.exit(changed || (listingStale && listingStale.length) ? 10 : 0)
