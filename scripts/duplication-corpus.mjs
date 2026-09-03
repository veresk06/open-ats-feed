#!/usr/bin/env node
// Corpus-wide same-location duplicate rate — the number the `dedupe` option was missing.
//
// Cycle 27 shipped `dedupe`: within one board, collapse postings that share a title AND a stated
// location, keep the first, record `duplicates_merged` on it. The only rate we could publish
// alongside it was **8.87%**, measured by `scripts/duplication.mjs` over the 40 boards with the
// highest title-repeat in the census cache. That stratum was chosen *because* it repeats titles.
// Quoting it as a corpus rate would have been the single most flattering misreading available, so
// the README and the input schema both say, in as many words, that it is not one.
//
// This script produces the corpus number instead. Two differences from `duplication.mjs`, and
// they are the whole point:
//
//   1. The boards are drawn from the FULL roster (docs/data/all.csv, 10,197 live boards), by size,
//      not by how much they repeat themselves. A board that repeats nothing is as likely to be
//      read as a board that repeats everything.
//   2. The result is weighted back to the corpus by the roster's own posting counts, so it
//      estimates "what fraction of the 291,507 open postings are same-location duplicates",
//      not "what fraction of the postings we happened to read".
//
// The rule itself is NOT restated here. `analyseBoard` is imported from `scripts/duplication.mjs`,
// which is the same rule the Actor ships, so the published rate cannot drift from the option it
// describes. (The Actor's own copy is a third implementation — the image is standalone and cannot
// import from `scripts/` — and `actor/test/dedupe.test.js` asserts the two agree on live rows.)
//
// Design: census the head, sample the tail.
//
//   postings/board   boards  postings   share    treatment
//   500+                 47    62,234   21.3%    census — read every one
//   100-499             451    85,449   29.3%    census — read every one
//   30-99             1,385    72,161   24.8%    sample
//   10-29             2,971    49,407   16.9%    sample
//   3-9               3,572    19,652    6.7%    sample
//   1-2               1,771     2,604    0.9%    sample
//
// The two censused strata are 498 boards and carry 50.6% of all postings. Reading them in full is
// cheaper than arguing about them, and it means half the answer has no sampling error at all —
// only non-response, which is counted and reported rather than assumed away.
//
// Sampling inside the four tail strata is a deterministic every-kth walk over a stable sort, the
// same choice `role-census.mjs` made and for the same reason: the run must be reproducible from
// the public roster by someone who is not us. `Math.random` would make the number unauditable.
//
//   node scripts/duplication-corpus.mjs                 default plan (~1,300 boards, ~6 min)
//   node scripts/duplication-corpus.mjs --plan          print the sample plan, fetch nothing
//   node scripts/duplication-corpus.mjs --scale=0.25    quarter-size run, for a smoke test
//
// Writes data/duplication-corpus.json and docs/data/duplication-corpus.csv.
// Costs $0.00 on Apify — local node against the vendors' public APIs.

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyseBoard } from './duplication.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ROSTER = resolve(ROOT, 'docs/data/all.csv')
const OUT = resolve(ROOT, 'data/duplication-corpus.json')
const CSV_OUT = resolve(ROOT, 'docs/data/duplication-corpus.csv')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const PLAN_ONLY = process.argv.includes('--plan')
const SCALE = Number(arg('scale', 1))
const BOOTSTRAP_N = Number(arg('bootstrap', 2000))

// Strata are cut on posting count, which is the only board attribute the roster carries and the
// only one that predicts duplication a priori: a two-posting board can contribute at most one
// duplicate, a 5,000-posting retail board can contribute thousands. `census: true` means read the
// stratum entire — it is small enough in boards to be worth removing its sampling error outright.
export const STRATA = [
  { key: '500+', min: 500, max: Infinity, census: true, target: 0 },
  { key: '100-499', min: 100, max: 499, census: true, target: 0 },
  { key: '30-99', min: 30, max: 99, census: false, target: 260 },
  { key: '10-29', min: 10, max: 29, census: false, target: 240 },
  { key: '3-9', min: 3, max: 9, census: false, target: 200 },
  { key: '1-2', min: 1, max: 2, census: false, target: 120 },
]

export const parseRoster = (text) => text.trim().split('\n').slice(1).map((line) => {
  const [provider, token, postings] = line.split(',')
  return { provider, token, postings: Number(postings) }
}).filter((r) => r.provider && r.token && Number.isFinite(r.postings) && r.postings > 0)

// Stable order first, then every kth. Sorting by postings descending puts the walk across the
// whole size range of the stratum rather than clustering at one end; ties break on the board's
// own name so the order does not depend on how the roster file happened to be written.
export const stratumOrder = (rows) => [...rows].sort(
  (a, b) => b.postings - a.postings || `${a.provider}/${a.token}`.localeCompare(`${b.provider}/${b.token}`),
)

export const pickSample = (rows, target) => {
  const ordered = stratumOrder(rows)
  if (target <= 0 || target >= ordered.length) return ordered
  const step = ordered.length / target
  const out = []
  for (let i = 0; i < target; i++) out.push(ordered[Math.floor(i * step)])
  return out
}

export const buildPlan = (roster, scale = 1) => {
  const total = roster.reduce((a, b) => a + b.postings, 0)
  return STRATA.map((s) => {
    const rows = roster.filter((r) => r.postings >= s.min && r.postings <= s.max)
    const postings = rows.reduce((a, b) => a + b.postings, 0)
    const target = s.census ? 0 : Math.max(1, Math.round(s.target * scale))
    const sample = pickSample(rows, target)
    return {
      key: s.key,
      census: s.census,
      boards_in_stratum: rows.length,
      postings_in_stratum: postings,
      weight: total ? postings / total : 0,
      sample,
    }
  })
}

const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    rows: (j) => (Array.isArray(j?.jobs) ? j.jobs.map((x) => ({ title: x?.title, loc: x?.location?.name })) : null),
    concurrency: 12,
    delayMs: 0,
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    rows: (j) => (Array.isArray(j?.jobs) ? j.jobs.map((x) => ({ title: x?.title, loc: x?.location })) : null),
    concurrency: 12,
    delayMs: 0,
  },
  lever: {
    // api.lever.co/robots.txt asks for Crawl-delay: 1. Honoured here as everywhere else.
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    rows: (j) => (Array.isArray(j) ? j.map((x) => ({ title: x?.text, loc: x?.categories?.location })) : null),
    concurrency: 1,
    delayMs: 1000,
  },
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// One retry, for the reason Cycle 18 measured: a single-shot probe silently drops good boards on
// a transient timeout, and here a dropped board is not just a missing row — it is non-response in
// a stratum whose weight is fixed, so it moves the estimate.
const fetchBoard = async (provider, token) => {
  const cfg = PROVIDERS[provider]
  if (!cfg) return { ok: false, reason: 'unknown_provider' }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(cfg.url(token), {
        headers: { 'user-agent': 'open-ats-feed/duplication-corpus (+https://github.com/veresk06/open-ats-feed)' },
        signal: AbortSignal.timeout(20000),
      })
      if (!res.ok) return { ok: false, reason: `http_${res.status}` }
      const rows = cfg.rows(await res.json())
      if (rows === null) return { ok: false, reason: 'shape' }
      return { ok: true, rows }
    } catch (err) {
      if (attempt === 1) return { ok: false, reason: err.name === 'TimeoutError' ? 'timeout' : 'error' }
      await sleep(500)
    }
  }
  return { ok: false, reason: 'error' }
}

const runPool = async (jobs, onResult) => {
  const byProvider = new Map()
  for (const j of jobs) {
    if (!byProvider.has(j.provider)) byProvider.set(j.provider, [])
    byProvider.get(j.provider).push(j)
  }
  await Promise.all([...byProvider.entries()].map(async ([provider, list]) => {
    const cfg = PROVIDERS[provider]
    if (!cfg) return
    let i = 0
    const worker = async () => {
      while (i < list.length) {
        const job = list[i++]
        const res = await fetchBoard(provider, job.token)
        onResult(job, res)
        if (cfg.delayMs) await sleep(cfg.delayMs)
      }
    }
    await Promise.all(Array.from({ length: cfg.concurrency }, worker))
  }))
}

// Within a stratum the estimate is a ratio: duplicates found over postings read. Not the mean of
// per-board rates — a board's rate carries no information about how many postings it is a rate
// OF, and the question asked is about postings, not about boards.
export const stratumRate = (boards) => {
  const postings = boards.reduce((a, b) => a + b.postings, 0)
  const dup = boards.reduce((a, b) => a + b.same_location_extra, 0)
  return postings ? dup / postings : 0
}

// Deterministic RNG, so the interval is reproducible from the same board results. A bootstrap
// seeded by Math.random gives a different confidence interval on every run, which is a strange
// property for a published number to have.
export const lcg = (seed) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

// Resample boards with replacement inside each SAMPLED stratum only. A censused stratum has no
// sampling error by construction — every board in it was read — so resampling it would invent
// uncertainty that does not exist. Its non-response is reported separately instead.
export const bootstrap = (strata, iterations = 2000, seed = 20260903) => {
  const rnd = lcg(seed)
  const draws = []
  for (let it = 0; it < iterations; it++) {
    let acc = 0
    let w = 0
    for (const s of strata) {
      if (!s.boards.length) continue
      let sample = s.boards
      if (!s.census) {
        sample = []
        for (let i = 0; i < s.boards.length; i++) sample.push(s.boards[Math.floor(rnd() * s.boards.length)])
      }
      acc += s.weight * stratumRate(sample)
      w += s.weight
    }
    draws.push(w ? acc / w : 0)
  }
  draws.sort((a, b) => a - b)
  const at = (q) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(q * draws.length)))]
  return { lo: at(0.025), hi: at(0.975), median: at(0.5), iterations }
}

// Weighted combination across strata. `weight` is the stratum's share of the roster's 291,507
// postings; strata that returned nothing are dropped and the remaining weights renormalised, with
// the dropped weight reported so the reader can see how much of the corpus the number covers.
export const combine = (strata) => {
  let acc = 0
  let covered = 0
  for (const s of strata) {
    if (!s.boards.length) continue
    acc += s.weight * stratumRate(s.boards)
    covered += s.weight
  }
  return { rate: covered ? acc / covered : 0, weight_covered: covered }
}

const pct = (x) => +(100 * x).toFixed(2)

const main = async () => {
  const roster = parseRoster(await readFile(ROSTER, 'utf8'))
  const plan = buildPlan(roster, SCALE)
  const rosterPostings = roster.reduce((a, b) => a + b.postings, 0)

  console.log(`roster: ${roster.length} boards, ${rosterPostings} postings`)
  for (const s of plan) {
    console.log(
      `  ${s.key.padEnd(8)} boards=${String(s.boards_in_stratum).padStart(5)} `
      + `postings=${String(s.postings_in_stratum).padStart(7)} w=${String(pct(s.weight)).padStart(5)}%  `
      + `${s.census ? 'CENSUS' : 'sample'} ${s.sample.length}`,
    )
  }
  const totalFetch = plan.reduce((a, b) => a + b.sample.length, 0)
  console.log(`  -> ${totalFetch} boards to read\n`)
  if (PLAN_ONLY) return

  const jobs = plan.flatMap((s) => s.sample.map((b) => ({ ...b, stratum: s.key })))
  const byBoard = new Map()
  let done = 0
  await runPool(jobs, (job, res) => {
    done++
    const key = `${job.provider}/${job.token}`
    if (!res.ok || !res.rows.length) {
      byBoard.set(key, { ...job, error: res.ok ? 'empty' : res.reason })
      return
    }
    const a = analyseBoard(res.rows)
    byBoard.set(key, { ...job, ...a })
    if (done % 100 === 0) process.stderr.write(`  read ${done}/${totalFetch}\n`)
  })

  const strata = plan.map((s) => {
    const all = s.sample.map((b) => byBoard.get(`${b.provider}/${b.token}`)).filter(Boolean)
    const boards = all.filter((b) => !b.error && b.postings > 0)
    const failed = all.filter((b) => b.error)
    const live = boards.reduce((a, b) => a + b.postings, 0)
    const dup = boards.reduce((a, b) => a + b.same_location_extra, 0)
    const rep = boards.reduce((a, b) => a + b.repeated_extra, 0)
    const diff = boards.reduce((a, b) => a + b.distinct_location_extra, 0)
    const blank = boards.reduce((a, b) => a + b.unstated_location_extra, 0)
    return {
      key: s.key,
      census: s.census,
      weight: s.weight,
      boards_in_stratum: s.boards_in_stratum,
      postings_in_stratum: s.postings_in_stratum,
      boards_targeted: s.sample.length,
      boards_read: boards.length,
      boards_failed: failed.length,
      // A board that is gone since the harvest is a different fact from a board that timed out,
      // and both are different from a board that answered with an empty list. Counted apart.
      failure_reasons: failed.reduce((m, b) => ({ ...m, [b.error]: (m[b.error] || 0) + 1 }), {}),
      live_postings: live,
      repeated_extra: rep,
      same_location_extra: dup,
      distinct_location_extra: diff,
      unstated_location_extra: blank,
      boards_with_any_duplicate: boards.filter((b) => b.same_location_extra > 0).length,
      rate_pct: pct(stratumRate(boards)),
      repeat_rate_pct: live ? pct(rep / live) : 0,
      boards,
    }
  })

  const { rate, weight_covered } = combine(strata)
  const ci = bootstrap(strata, BOOTSTRAP_N)

  // How concentrated is the defect? If half the duplicates come from twenty boards, a buyer who
  // does not pull those boards sees a rate near zero, and the corpus mean is the wrong number for
  // them. That is a real property of the answer, not a footnote, so it is measured.
  const allBoards = strata.flatMap((s) => s.boards.map((b) => ({ ...b, stratum: s.key })))
  const dupBoards = allBoards.filter((b) => b.same_location_extra > 0)
    .sort((a, b) => b.same_location_extra - a.same_location_extra)
  const dupTotal = dupBoards.reduce((a, b) => a + b.same_location_extra, 0)
  const shareFromTop = (n) => (dupTotal
    ? pct(dupBoards.slice(0, n).reduce((a, b) => a + b.same_location_extra, 0) / dupTotal) : 0)

  const readBoards = allBoards.length
  const readPostings = allBoards.reduce((a, b) => a + b.postings, 0)

  const payload = {
    generated_at: new Date().toISOString(),
    question: 'What share of open postings in the corpus are same-title-same-stated-location '
      + 'duplicates within their own board — i.e. what would the shipped `dedupe` option remove?',
    method: 'Boards drawn from the full roster (docs/data/all.csv) stratified by open posting '
      + 'count, NOT by how much they repeat titles. The two largest strata are censused; the four '
      + 'smaller are sampled by a deterministic every-kth walk over a stable sort, so the run is '
      + 'reproducible from the public roster. Each board is read live from its vendor public API '
      + 'and passed through analyseBoard() imported from scripts/duplication.mjs — the same rule '
      + 'the Actor ships as `dedupe`, not a restatement of it. Per stratum the estimate is a ratio '
      + '(duplicates found / postings read), and strata are combined by their share of the '
      + "roster's postings. The interval is a board-level bootstrap over the sampled strata only; "
      + 'censused strata contribute no sampling error by construction.',
    contrast_with_stratum_rate: 'scripts/duplication.mjs reports 8.87% over the 40 boards with the '
      + 'highest title-repeat in the census cache. Those boards were selected for the property '
      + 'being measured, so that figure describes a worst-offender stratum and was never a corpus '
      + 'rate. This file is the corpus rate.',
    roster: { boards: roster.length, postings: rosterPostings },
    read: { boards_targeted: totalFetch, boards_read: readBoards, live_postings: readPostings },
    corpus_rate_pct: pct(rate),
    corpus_rate_ci95_pct: [pct(ci.lo), pct(ci.hi)],
    bootstrap_iterations: ci.iterations,
    weight_covered_pct: pct(weight_covered),
    estimated_duplicate_postings: Math.round(rate * rosterPostings),
    concentration: {
      note: 'Of the duplicates found across every board read, what share comes from the worst N '
        + 'boards. A concentrated defect means the corpus mean overstates what a typical buyer '
        + 'sees and understates what an unlucky one sees.',
      boards_read: readBoards,
      boards_with_any_duplicate: dupBoards.length,
      boards_with_any_duplicate_pct: readBoards ? pct(dupBoards.length / readBoards) : 0,
      duplicates_found: dupTotal,
      share_from_top_1_pct: shareFromTop(1),
      share_from_top_10_pct: shareFromTop(10),
      share_from_top_25_pct: shareFromTop(25),
      worst: dupBoards.slice(0, 15).map((b) => ({
        board: `${b.provider}/${b.token}`,
        stratum: b.stratum,
        postings: b.postings,
        same_location_extra: b.same_location_extra,
        rate_pct: pct(b.same_location_extra / b.postings),
      })),
    },
    strata: strata.map(({ boards, ...s }) => s),
  }
  await writeFile(OUT, `${JSON.stringify(payload, null, 2)}\n`)

  const csv = ['stratum,census,boards_in_stratum,postings_in_stratum,weight_pct,boards_read,boards_failed,live_postings,repeated_extra,same_location_extra,distinct_location_extra,rate_pct']
  for (const s of strata) {
    csv.push([
      s.key, s.census, s.boards_in_stratum, s.postings_in_stratum, pct(s.weight), s.boards_read,
      s.boards_failed, s.live_postings, s.repeated_extra, s.same_location_extra,
      s.distinct_location_extra, s.rate_pct,
    ].join(','))
  }
  csv.push(['corpus', '', roster.length, rosterPostings, 100, readBoards, '', readPostings, '', '', '', pct(rate)].join(','))
  await writeFile(CSV_OUT, `${csv.join('\n')}\n`)

  console.log('')
  for (const s of strata) {
    console.log(
      `  ${s.key.padEnd(8)} ${s.census ? 'CENSUS' : 'sample'} read=${String(s.boards_read).padStart(4)}/${String(s.boards_targeted).padEnd(4)} `
      + `postings=${String(s.live_postings).padStart(6)} dup=${String(s.same_location_extra).padStart(5)} `
      + `rate=${String(s.rate_pct).padStart(6)}%  (repeat ${s.repeat_rate_pct}%)`,
    )
  }
  console.log('')
  console.log(`corpus same-location duplicate rate  ${pct(rate)}%  95% CI [${pct(ci.lo)}%, ${pct(ci.hi)}%]`)
  console.log(`  covers ${pct(weight_covered)}% of the roster's postings by weight`)
  console.log(`  implies ~${Math.round(rate * rosterPostings)} duplicate postings of ${rosterPostings}`)
  console.log(`  worst-offender stratum, for contrast: 8.87% (duplication.mjs, 40 selected boards)`)
  console.log('')
  console.log(`concentration: ${payload.concentration.boards_with_any_duplicate} of ${readBoards} boards read carry any duplicate (${payload.concentration.boards_with_any_duplicate_pct}%)`)
  console.log(`  top 1 board  = ${payload.concentration.share_from_top_1_pct}% of all duplicates found`)
  console.log(`  top 10 boards= ${payload.concentration.share_from_top_10_pct}%`)
  console.log(`  top 25 boards= ${payload.concentration.share_from_top_25_pct}%`)
  console.log(`wrote ${OUT}`)
  console.log(`wrote ${CSV_OUT}`)
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
