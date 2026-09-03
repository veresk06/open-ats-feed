#!/usr/bin/env node
// Duplication audit — is a repeated title a repeated *job*?
//
// Cycle 24 found that 40.29% of the 121,050 titles in the role census are exact duplicates of
// another title on the *same board*. `lever/boxlunch` carries 3,653 postings across 76 distinct
// titles; `greenhouse/blueskytelepsych` carries 945 across 5. That number is easy to compute and
// easy to misread, and misreading it in the flattering direction would be the whole point of
// this script's existence.
//
// The claim "40% of the feed is duplicated" is NOT supported by title text alone. A retailer
// posting "Sales Associate" seventy-six times is filling seventy-six real openings in
// seventy-six stores; the store is in the `location` field, not in the title. So a repeated
// title is evidence of nothing until the location is read alongside it.
//
// This script reads title AND location live from the vendors' public APIs and splits every
// repeated title into two populations:
//
//   distinct_location  — same title, different place. Real multi-site hiring. A legitimate row.
//   same_location      — same title, same place. A genuine duplicate: the buyer pays twice for
//                        one opening. This is the only part of the 40% that is a defect.
//
// It also measures the opposite error, which the `other` bucket surfaced first. Some boards put
// the location *inside* the title — "Sports Data Collector (American Football) - Ames, Iowa,
// USA" appears 470 times on `geniussportssn` with a different city each time. Those look like
// 470 distinct titles to any title-only method and are one role. Title-only counting therefore
// overstates duplication on one kind of board and understates it on the other, and neither
// error is visible without the location field.
//
//   node scripts/duplication.mjs                    audit the 40 worst boards by title-repeat
//   node scripts/duplication.mjs --boards=80        wider audit
//   node scripts/duplication.mjs --board=lever/boxlunch --explain
//
// Writes data/duplication.json. Costs $0.00 on Apify — local node against the vendors' public
// APIs, same as snapshot-history.mjs and role-census.mjs.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = resolve(ROOT, 'data/role-census-titles.json')
const OUT = resolve(ROOT, 'data/duplication.json')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const BOARDS_N = Number(arg('boards', 40))
const ONE_BOARD = arg('board', null)
const EXPLAIN = process.argv.includes('--explain')

// Title text as the census normalises it: case-folded, punctuation collapsed to single spaces.
// Two postings whose titles differ only by trailing whitespace or an en-dash are the same title.
export const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// Locations are written by humans in free text and no two boards agree on a format. We are not
// trying to resolve them to places — only to decide whether two strings denote the same place.
// So: fold case, drop punctuation, drop the noise words that appear on one copy and not the
// other, and sort the remaining tokens. "Chicago, IL" and "IL - Chicago" become the same key;
// "Chicago, IL" and "Aurora, IL" do not.
const LOC_NOISE = new Set([
  'remote', 'hybrid', 'onsite', 'on', 'site', 'usa', 'us', 'united', 'states', 'america',
  'or', 'and', 'the', 'of', 'in', 'at', 'area', 'greater', 'metro', 'region', 'multiple',
  'locations', 'location', 'various', 'flexible', 'anywhere', 'office', 'based',
])
export const normLoc = (s) => {
  const toks = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ')
    .filter((w) => w && !LOC_NOISE.has(w))
  if (!toks.length) return '' // empty means "unstated", which is not the same as "same place"
  return [...new Set(toks)].sort().join(' ')
}

// The inverse error: the location is inside the title. Detected structurally, not by a city
// dictionary — a dictionary would be a permanent maintenance burden and would silently miss
// every place it had not heard of. Instead: split the title on its last separator and ask
// whether the stem repeats across the board with many different tails. One role fanned out over
// 470 cities has one stem and 470 tails; "Engineer II" and "Engineer III" have 2.
//
// The threshold is deliberately stated rather than tuned: a stem needs >= MIN_FANOUT distinct
// tails before we call it fan-out, so a role posted at two sites is not accused of anything.
// NOTE: this takes the RAW title, not a normalised one. `normTitle` collapses punctuation to
// spaces, which destroys exactly the separators this splits on — feeding it a normalised title
// silently returns null for everything and reports 0% fan-out on a corpus that has plenty.
const MIN_FANOUT = 5
const SPLITTERS = /\s+[-–—|(]\s*|\s*,\s*/
export const titleStem = (raw) => {
  const parts = String(raw || '').split(SPLITTERS).map((p) => normTitle(p)).filter(Boolean)
  return parts.length > 1 ? parts[0] : null
}

const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    rows: (j) => (Array.isArray(j?.jobs) ? j.jobs.map((x) => ({ title: x?.title, loc: x?.location?.name })) : null),
    delayMs: 0,
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    rows: (j) => (Array.isArray(j?.jobs) ? j.jobs.map((x) => ({ title: x?.title, loc: x?.location })) : null),
    delayMs: 0,
  },
  lever: {
    // api.lever.co/robots.txt asks for Crawl-delay: 1. Honoured here as everywhere else.
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    rows: (j) => (Array.isArray(j) ? j.map((x) => ({ title: x?.text, loc: x?.categories?.location })) : null),
    delayMs: 1000,
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const fetchBoard = async (provider, token) => {
  const p = PROVIDERS[provider]
  if (!p) return null
  try {
    const res = await fetch(p.url(token), {
      headers: { 'user-agent': 'open-ats-feed/duplication-audit (+https://github.com/veresk06/open-ats-feed)' },
      signal: AbortSignal.timeout(25000),
    })
    if (!res.ok) return null
    return p.rows(await res.json())
  } catch {
    return null
  }
}

// The whole finding, per board. Every count here is derived from rows that carry both a title
// and a location, so `unstated_location` is reported separately rather than being quietly
// folded into either bucket — a posting with no location cannot testify either way.
export const analyseBoard = (rows) => {
  const groups = new Map()
  let unstated = 0
  for (const r of rows) {
    const t = normTitle(r.title)
    if (!t) continue
    const l = normLoc(r.loc)
    if (!l) unstated++
    if (!groups.has(t)) groups.set(t, [])
    groups.get(t).push(l)
  }

  let postings = 0
  let repeatedExtra = 0      // copies beyond the first, for any repeated title
  let sameLocExtra = 0       // ...of which share a stated location with an earlier copy
  let distinctLocExtra = 0   // ...of which are at a different stated location
  let unstatedExtra = 0      // ...of which cannot testify
  const offenders = []

  for (const [title, locs] of groups) {
    postings += locs.length
    if (locs.length < 2) continue
    const extra = locs.length - 1
    repeatedExtra += extra
    const seen = new Map()
    let same = 0; let distinct = 0; let blank = 0
    for (const l of locs) {
      if (!l) { blank++; continue }
      if (seen.has(l)) same++
      else { seen.set(l, 1); distinct++ }
    }
    // The first copy of the title is the original, not an extra. Charge it to whichever bucket
    // its own location put it in, so the three buckets sum to `extra` exactly.
    // Exactly one copy is the original and it must be deducted exactly once across all three
    // buckets, or the parts sum to more than the whole. Deduct it from `distinct` when there is
    // a stated location to deduct it from, otherwise from `blank`.
    const distinctExtra = distinct > 0 ? distinct - 1 : 0
    const blankExtra = distinct > 0 ? blank : Math.max(0, blank - 1)
    sameLocExtra += same
    distinctLocExtra += distinctExtra
    unstatedExtra += blankExtra
    if (same > 0) offenders.push({ title, postings: locs.length, same_location_extra: same })
  }

  // Inverse error: location inside the title. Walks the raw rows, not `groups`, because the
  // stem has to be cut from the raw title before normalisation eats the separators.
  const stems = new Map()
  for (const r of rows) {
    const title = normTitle(r.title)
    if (!title) continue
    const stem = titleStem(r.title)
    if (!stem || stem === title) continue
    if (!stems.has(stem)) stems.set(stem, { tails: new Set(), postings: 0 })
    const e = stems.get(stem)
    e.tails.add(title)
    e.postings++
  }
  const fanout = [...stems.entries()]
    .filter(([, e]) => e.tails.size >= MIN_FANOUT)
    .map(([stem, e]) => ({ stem, variants: e.tails.size, postings: e.postings }))
    .sort((a, b) => b.postings - a.postings)

  return {
    postings,
    distinct_titles: groups.size,
    unstated_location: unstated,
    repeated_extra: repeatedExtra,
    same_location_extra: sameLocExtra,
    distinct_location_extra: distinctLocExtra,
    unstated_location_extra: unstatedExtra,
    fanout_stems: fanout.length,
    fanout_postings: fanout.reduce((a, b) => a + b.postings, 0),
    fanout_top: fanout.slice(0, 5),
    offenders: offenders.sort((a, b) => b.same_location_extra - a.same_location_extra).slice(0, 5),
  }
}

// Fan-out needs no network and no location field — it is a property of the title text alone —
// so it is measured over the whole cache rather than over the audited stratum. It has to be:
// ranking boards by title-repeat, which is how the live audit picks its targets, structurally
// cannot find a fan-out board. A board that writes the city into every title has *no* repeated
// titles at all, so it sorts to the bottom of exactly the list that was built to catch it.
export const fanoutOverCache = (cached) => {
  let postings = 0
  let fanoutPostings = 0
  const boards = []
  for (const b of cached) {
    postings += b.titles.length
    const stems = new Map()
    for (const t of b.titles) {
      const title = normTitle(t)
      const stem = titleStem(t)
      if (!stem || stem === title) continue
      if (!stems.has(stem)) stems.set(stem, { tails: new Set(), postings: 0 })
      const e = stems.get(stem)
      e.tails.add(title)
      e.postings++
    }
    const hits = [...stems.entries()]
      .filter(([, e]) => e.tails.size >= MIN_FANOUT)
      .map(([stem, e]) => ({ stem, variants: e.tails.size, postings: e.postings }))
      .sort((a, b) => b.postings - a.postings)
    if (!hits.length) continue
    const n = hits.reduce((a, x) => a + x.postings, 0)
    fanoutPostings += n
    boards.push({
      board: `${b.p}/${b.t}`,
      postings: b.titles.length,
      fanout_postings: n,
      fanout_share_pct: +(100 * n / b.titles.length).toFixed(1),
      top: hits.slice(0, 3),
    })
  }
  boards.sort((a, b) => b.fanout_postings - a.fanout_postings)
  return { postings, fanout_postings: fanoutPostings, fanout_rate_pct: +(100 * fanoutPostings / postings).toFixed(2), boards }
}

const main = async () => {
  const cached = JSON.parse(await readFile(CACHE, 'utf8'))

  // Rank by title-repeat measured from the cache, then audit the top N live. Ranking on the
  // cache costs nothing and picks exactly the boards where the claim would be loudest — which
  // is also, deliberately, where it is most likely to be wrong.
  let candidates = cached.map((b) => {
    const f = new Set(b.titles.map(normTitle))
    return { provider: b.p, token: b.t, postings: b.titles.length, distinct: f.size, extra: b.titles.length - f.size }
  }).filter((c) => c.extra > 0).sort((a, b) => b.extra - a.extra)

  if (ONE_BOARD) {
    const [p, t] = ONE_BOARD.split('/')
    candidates = [{ provider: p, token: t, postings: 0, distinct: 0, extra: 0 }]
  }
  const targets = candidates.slice(0, ONE_BOARD ? 1 : BOARDS_N)

  const results = []
  for (const c of targets) {
    const rows = await fetchBoard(c.provider, c.token)
    if (PROVIDERS[c.provider]?.delayMs) await sleep(PROVIDERS[c.provider].delayMs)
    if (!rows || !rows.length) {
      results.push({ board: `${c.provider}/${c.token}`, error: 'unreachable_or_empty' })
      process.stderr.write(`  ! ${c.provider}/${c.token} unreachable\n`)
      continue
    }
    const a = analyseBoard(rows)
    results.push({ board: `${c.provider}/${c.token}`, ...a })
    process.stderr.write(
      `  ${`${c.provider}/${c.token}`.padEnd(38)} n=${String(a.postings).padStart(5)} ` +
      `rep=${String(a.repeated_extra).padStart(5)} same-loc=${String(a.same_location_extra).padStart(5)} ` +
      `diff-loc=${String(a.distinct_location_extra).padStart(5)} fanout=${String(a.fanout_postings).padStart(5)}\n`,
    )
    if (EXPLAIN) {
      for (const o of a.offenders) process.stderr.write(`      dup: ${o.title} x${o.postings} (${o.same_location_extra} same place)\n`)
      for (const f of a.fanout_top) process.stderr.write(`      fanout: "${f.stem}" x${f.variants} variants, ${f.postings} postings\n`)
    }
  }

  const ok = results.filter((r) => !r.error)
  const sum = (k) => ok.reduce((a, b) => a + (b[k] || 0), 0)
  const totals = {
    boards_audited: ok.length,
    boards_unreachable: results.length - ok.length,
    postings: sum('postings'),
    distinct_titles: sum('distinct_titles'),
    unstated_location: sum('unstated_location'),
    repeated_extra: sum('repeated_extra'),
    same_location_extra: sum('same_location_extra'),
    distinct_location_extra: sum('distinct_location_extra'),
    unstated_location_extra: sum('unstated_location_extra'),
    fanout_postings: sum('fanout_postings'),
  }
  totals.repeat_rate_pct = totals.postings ? +(100 * totals.repeated_extra / totals.postings).toFixed(2) : 0
  totals.true_duplicate_rate_pct = totals.postings ? +(100 * totals.same_location_extra / totals.postings).toFixed(2) : 0
  totals.multi_site_rate_pct = totals.postings ? +(100 * totals.distinct_location_extra / totals.postings).toFixed(2) : 0
  totals.fanout_rate_pct = totals.postings ? +(100 * totals.fanout_postings / totals.postings).toFixed(2) : 0

  const fan = fanoutOverCache(cached)

  const payload = {
    generated_at: new Date().toISOString(),
    fanout_corpus: {
      note: 'Measured over all 500 cached boards, not the audited stratum — fan-out needs no '
        + 'location field, and the title-repeat ranking that picks the audit targets cannot '
        + 'find a fan-out board by construction.',
      ...fan,
      boards: fan.boards.slice(0, 25),
    },
    method: 'Live title+location read from vendor public APIs for the boards with the highest '
      + 'title-repeat in data/role-census-titles.json. A repeated title is split by whether the '
      + 'copies share a stated location. Boards audited are the worst offenders by title-repeat, '
      + 'NOT a random sample — these totals describe that stratum and are not a corpus estimate.',
    min_fanout_variants: MIN_FANOUT,
    totals,
    boards: results,
  }
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`)

  console.log('')
  console.log(`audited ${totals.boards_audited} boards, ${totals.postings} postings`)
  console.log(`  repeated title (any)      ${totals.repeated_extra}  ${totals.repeat_rate_pct}%`)
  console.log(`  ...same stated location   ${totals.same_location_extra}  ${totals.true_duplicate_rate_pct}%   <- the defect`)
  console.log(`  ...different location     ${totals.distinct_location_extra}  ${totals.multi_site_rate_pct}%   <- real multi-site hiring`)
  console.log(`  ...location unstated      ${totals.unstated_location_extra}`)
  console.log('')
  console.log(`fan-out over all ${cached.length} cached boards (${fan.postings} postings):`)
  console.log(`  location-in-title fanout  ${fan.fanout_postings}  ${fan.fanout_rate_pct}%  on ${fan.boards.length} boards`)
  for (const b of fan.boards.slice(0, 10)) {
    console.log(`    ${b.board.padEnd(38)} ${String(b.fanout_postings).padStart(5)}/${String(b.postings).padEnd(5)} ${String(b.fanout_share_pct).padStart(5)}%  "${b.top[0].stem}" x${b.top[0].variants}`)
  }
  console.log(`wrote ${OUT}`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
