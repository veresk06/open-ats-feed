#!/usr/bin/env node
// Actor telemetry — the only view we have of people who are not us.
//
// WHY THIS EXISTS. A run of a public Actor started by somebody else is created under *their*
// account. The owner cannot enumerate it, cannot read its input, cannot read its log and cannot
// see why it failed. `GET /v2/acts/{id}/runs` returns our runs and only ours. So the entire
// demand tripwire — 10 external users, 3 repeat runs, 1 paid purchase — has to be read off four
// coarse counters on the Actor object, and nothing was recording them.
//
// Cycle 30 found an external run by accident, while reading the stats for an unrelated reason,
// and could not date it because there was no earlier reading to compare against. That is the
// whole point of this script: the counters are not a log, they are a level. Sampling them every
// cycle turns them into a log.
//
// WHAT THE COUNTERS ACTUALLY MEAN, established by control experiment rather than by reading the
// docs. A throwaway private Actor was created and run exactly once with the owner's own token:
//
//   totalRuns            1 against 1 visible run   -> counts owner runs, real time, no off-by-one
//   totalUsers           1                         -> counts the owner
//   totalUsers30Days     0                          -> does NOT count the owner
//   publicActorRunStats30Days   null                -> absent while the Actor is private
//
// Two consequences, and they are the reason this script reports what it reports:
//
//   gap = totalRuns - (runs we can see)  is the number of runs by somebody else. On the control
//        it was 0. Any value above 0 is a stranger, and it updates in real time.
//   totalUsers30Days excludes the owner, so it is a direct count of external users in 30 days.
//
// `publicActorRunStats30Days` is the only field whose refresh behaviour is NOT established. It
// did not move when an owner run was added, which is consistent with either "excludes owner runs"
// or "lags by a day". It is recorded because its SUCCEEDED/FAILED split is the only signal we
// have about whether a stranger's run worked, and flagged as unverified wherever it is used.
//
//   node scripts/actor-telemetry.mjs            append a reading, print the diff
//   node scripts/actor-telemetry.mjs --quiet    append only, print nothing unless something moved

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'data/actor-telemetry.csv')
const ACTOR = process.env.ACTOR_ID ?? 'bMtkiY7lzUpCjEn1V'
const PUBLIC_PATH = process.env.ACTOR_PATH ?? 'sharp_malachite~open-ats-jobs-feed'
const QUIET = process.argv.includes('--quiet')

const COLUMNS = [
  'read_at',
  'total_runs',
  'owner_visible_runs',
  'external_runs',
  'total_users',
  'external_users_30d',
  'pub30_total',
  'pub30_succeeded',
  'pub30_failed',
  'review_count',
  'review_rating',
  'bookmarks',
]

async function getJson(url, token) {
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined)
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.json()
}

const token = process.env.APIFY_TOKEN
if (!token) {
  console.error('APIFY_TOKEN is not set. Read it from .env; never paste the value anywhere.')
  process.exit(1)
}

// The public endpoint is deliberately used unauthenticated for the stats block: it is the same
// object a prospective buyer sees, so if it ever disagrees with the authenticated view we want to
// be reading the buyer's copy rather than ours.
const [pub, runs] = await Promise.all([
  getJson(`https://api.apify.com/v2/acts/${PUBLIC_PATH}`),
  getJson(`https://api.apify.com/v2/acts/${ACTOR}/runs?limit=1`, token),
])

const s = pub.data.stats
const p = s.publicActorRunStats30Days ?? {}
// `.data.total` is the count of runs the owner can enumerate, independent of the page size.
const ownerVisible = runs.data.total
const row = {
  read_at: new Date().toISOString(),
  total_runs: s.totalRuns ?? 0,
  owner_visible_runs: ownerVisible,
  external_runs: (s.totalRuns ?? 0) - ownerVisible,
  total_users: s.totalUsers ?? 0,
  external_users_30d: s.totalUsers30Days ?? 0,
  pub30_total: p.TOTAL ?? 0,
  pub30_succeeded: p.SUCCEEDED ?? 0,
  pub30_failed: p.FAILED ?? 0,
  review_count: s.actorReviewCount ?? 0,
  review_rating: s.actorReviewRating ?? 0,
  bookmarks: s.bookmarkCount ?? 0,
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
  // First reading. Not an error — the file is created below.
}

const header = existing ? '' : `${COLUMNS.join(',')}\n`
await writeFile(OUT, `${existing}${header}${COLUMNS.map((c) => row[c]).join(',')}\n`)

// Only these four are worth waking someone for. Reviews and bookmarks are recorded but a change
// in them is visible in the store anyway; a stranger's run is not visible anywhere else.
const WATCHED = [
  ['external_runs', 'a run by somebody who is not us'],
  ['external_users_30d', 'an external user in the last 30 days'],
  ['pub30_failed', "a failed run on the public counter (refresh behaviour unverified)"],
  ['review_count', 'a store review'],
]

const moved = previous
  ? WATCHED.filter(([k]) => Number(row[k]) !== Number(previous[k])).map(
      ([k, what]) => `${k}: ${previous[k]} -> ${row[k]}  (${what})`,
    )
  : []

if (!QUIET || moved.length) {
  console.log(`open-ats-jobs-feed @ ${row.read_at}`)
  console.log(
    `  runs ${row.total_runs} total, ${row.owner_visible_runs} ours, ` +
      `${row.external_runs} not ours | users ${row.total_users} total, ` +
      `${row.external_users_30d} external in 30d | reviews ${row.review_count}`,
  )
  if (!previous) console.log('  first reading — nothing to compare against yet')
  else if (!moved.length) console.log('  no change on any watched counter')
  else for (const m of moved) console.log(`  CHANGED  ${m}`)
}

// Exit 10 when a watched counter moved, so a caller can act on it without parsing stdout.
process.exit(moved.length ? 10 : 0)
