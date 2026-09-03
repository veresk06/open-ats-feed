#!/usr/bin/env node
// Verify harvested tokens against each ATS provider's public, unauthenticated
// job-board API, and count what is actually live right now.
//
// This is the Cycle 2 kill test. The gate:
//   >= 10,000 live companies AND >= 150,000 live postings.
//
// Output: data/coverage.json (per-token result) + data/coverage-summary.json

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = resolve(ROOT, process.env.TOKENS_FILE ?? 'data/tokens.json')
const OUT = resolve(ROOT, process.env.OUT_FILE ?? 'data/coverage.json')
const SUMMARY = resolve(ROOT, process.env.SUMMARY_FILE ?? 'data/coverage-summary.json')

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 24)
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity
// SAMPLE=n probes a random n per provider instead of the first n. LIMIT slices
// alphabetically, which is a biased sample — fine for a smoke test, wrong for
// estimating a hit rate we intend to extrapolate from.
const SAMPLE = process.env.SAMPLE ? Number(process.env.SAMPLE) : 0
const SEED = Number(process.env.SEED ?? 1)
// ONLY=lever probes one provider. Lever is rate-limited to 1 req/s by its robots.txt
// and takes ~80 minutes alone, so it runs as its own pass against a different host
// rather than blocking the two fast providers behind it.
const ONLY = (process.env.ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean)

// Deterministic PRNG so a sampled run is reproducible and reviewable.
function mulberry32(a) {
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sample(list, n, rand) {
  if (!n || n >= list.length) return list
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

// robots.txt on each host we actually fetch, checked 2026-09-03:
//   boards-api.greenhouse.io  "Disallow: /embed/"      — we fetch /v1/boards/, allowed
//   api.ashbyhq.com           robots.txt returns 401   — nothing stated, no restriction
//   api.lever.co              "Allow: /, Crawl-delay: 1" — allowed, and rate-limited below
//   apply.workable.com        "User-agent: * / Disallow:" — empty Disallow, all allowed
//   {token}.breezy.hr         "Disallow: /css /fonts /stylesheets /javascripts" — /json
//                             is allowed. This is the tenant host; the marketing host
//                             breezy.hr disallows /api/ and we never call it.
// The crawl delay is the reason `rate` exists. Lever states a limit in the file it
// serves us; honouring it costs an hour of wall clock and is not optional.
//
// Not here, and deliberately: api.smartrecruiters.com serves
// "User-agent: * / Disallow: /" and allows /v1/companies/ to LinkedInBot alone.
// Harvested in Cycle 33, dropped the same cycle. See scripts/lib/tokens.mjs.
const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    count: (j) => (Array.isArray(j) ? j.length : null),
    concurrency: 1,
    delayMs: 1000,
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
  workable: {
    // `details=true` matters here as much as in the Actor: without it the account
    // resolves 200 with an empty `jobs`, and every live board would be recorded
    // `empty`. That is the same class of error as the Greenhouse 403 below — a fact
    // about our request written down as a verdict about the company.
    url: (t) =>
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(t)}?details=true`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
  breezy: {
    url: (t) => `https://${encodeURIComponent(t)}.breezy.hr/json`,
    count: (j) => (Array.isArray(j) ? j.length : null),
    // Every tenant is its own host, so a fixed concurrency here is spread across
    // thousands of hostnames rather than pointed at one. Kept modest anyway until
    // there is a measured rate, because Workable's 429 was also a surprise.
    concurrency: 8,
  },
}

async function probe(provider, token) {
  const spec = PROVIDERS[provider]
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(spec.url(token), {
        signal: AbortSignal.timeout(25_000),
        headers: { 'user-agent': 'open-ats-feed/coverage-test (+contact via github)' },
      })
      if (res.status === 404 || res.status === 410) return { status: 'dead', http: res.status }
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        // Back off and retry: transient, not a verdict about the company.
        //
        // 403 belongs in this list and its absence corrupted a full run. Greenhouse
        // starts returning 403 once it decides you have asked too often. The old code
        // fell through to `dead`, so a throttled request was recorded as "this company
        // has no board" — and the run reported FEWER live companies from a strict
        // superset of tokens, which is arithmetically impossible and was the tell.
        // A blocked request is a fact about us, never a verdict about the company.
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      if (!res.ok) return { status: 'dead', http: res.status }
      const jobs = spec.count(await res.json())
      if (jobs === null) return { status: 'dead', http: res.status, reason: 'unexpected-shape' }
      return { status: jobs > 0 ? 'live' : 'empty', http: res.status, jobs }
    } catch (err) {
      if (attempt === 3) return { status: 'error', reason: err.message }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  // Exhausted the retries while still being refused. Distinct from `dead` on purpose:
  // `blocked` must never be counted as a company that does not exist.
  return { status: 'blocked', reason: 'refused-after-retries' }
}

async function runPool(items, worker, { concurrency = CONCURRENCY, delayMs = 0 } = {}) {
  const results = new Array(items.length)
  let next = 0
  let done = 0
  const tick = setInterval(() => {
    process.stderr.write(`\r  ${done}/${items.length} probed`)
  }, 2000)
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        const startedAt = Date.now()
        results[i] = await worker(items[i])
        done++
        // Crawl-delay is measured between request starts, so subtract the time the
        // request itself took rather than sleeping a flat second on top of it.
        const wait = delayMs - (Date.now() - startedAt)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      }
    }),
  )
  clearInterval(tick)
  process.stderr.write(`\r  ${done}/${items.length} probed\n`)
  return results
}

async function main() {
  const tokens = JSON.parse(await readFile(TOKENS, 'utf8'))
  const rand = mulberry32(SEED)
  const results = {}
  const summary = { perProvider: {}, gate: {}, sampled: SAMPLE || null }

  for (const provider of Object.keys(PROVIDERS)) {
    if (ONLY.length && !ONLY.includes(provider)) continue
    const all = tokens[provider] ?? []
    const list = sample(all, SAMPLE, rand).slice(0, LIMIT)
    if (!list.length) continue
    summary.perProvider[provider] = { harvested: all.length }
    const spec = PROVIDERS[provider]
    const pool = { concurrency: spec.concurrency ?? CONCURRENCY, delayMs: spec.delayMs ?? 0 }
    console.log(
      `\n${provider}: probing ${list.length} tokens (concurrency ${pool.concurrency}` +
        `${pool.delayMs ? `, ${pool.delayMs}ms crawl-delay` : ''})`,
    )
    const probed = await runPool(
      list,
      (t) => probe(provider, t).then((r) => ({ token: t, ...r })),
      pool,
    )
    results[provider] = probed

    const live = probed.filter((r) => r.status === 'live')
    const s = {
      harvested: all.length,
      candidates: list.length,
      live: live.length,
      empty: probed.filter((r) => r.status === 'empty').length,
      dead: probed.filter((r) => r.status === 'dead').length,
      error: probed.filter((r) => r.status === 'error').length,
      blocked: probed.filter((r) => r.status === 'blocked').length,
      postings: live.reduce((a, r) => a + r.jobs, 0),
    }
    // A blocked token has an unknown answer, so it is excluded from the denominator
    // rather than silently counted as a miss. If `blocked` is not ~0, the run is not
    // a measurement and the number below should not be quoted.
    s.resolved = s.candidates - s.blocked
    s.hitRate = +(s.live / (s.resolved || 1)).toFixed(4)
    s.medianJobs = live.length
      ? live.map((r) => r.jobs).sort((a, b) => a - b)[Math.floor(live.length / 2)]
      : 0
    summary.perProvider[provider] = s
    console.log(
      `  live ${s.live} / empty ${s.empty} / dead ${s.dead} / error ${s.error} / blocked ${s.blocked}` +
        ` | postings ${s.postings} | hit rate ${(s.hitRate * 100).toFixed(1)}% | median ${s.medianJobs} jobs`,
    )
    if (s.blocked) {
      console.log(`  ! ${s.blocked} tokens blocked — slow down and re-probe these before quoting a number`)
    }
  }

  const totals = Object.values(summary.perProvider).reduce(
    (a, s) => ({ live: a.live + s.live, postings: a.postings + s.postings }),
    { live: 0, postings: 0 },
  )
  summary.totals = totals

  // On a sampled run the raw totals understate the harvest. Scale each provider
  // by its own sampling ratio — hit rate and jobs-per-company differ per provider,
  // so a single blended factor would be wrong.
  const projected = Object.values(summary.perProvider).reduce(
    (a, s) => {
      const f = s.harvested / s.candidates
      return { live: a.live + s.live * f, postings: a.postings + s.postings * f }
    },
    { live: 0, postings: 0 },
  )
  summary.projected = { live: Math.round(projected.live), postings: Math.round(projected.postings) }

  const basis = SAMPLE ? summary.projected : totals
  summary.gate = {
    companiesRequired: 10_000,
    postingsRequired: 150_000,
    companiesActual: basis.live,
    postingsActual: basis.postings,
    basis: SAMPLE ? `projected from ${SAMPLE}/provider sample` : 'measured in full',
    pass: basis.live >= 10_000 && basis.postings >= 150_000,
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(results))
  await writeFile(SUMMARY, JSON.stringify(summary, null, 2))

  console.log(`\n${'='.repeat(64)}`)
  console.log(`BASIS          : ${summary.gate.basis}`)
  console.log(`LIVE COMPANIES : ${summary.gate.companiesActual.toLocaleString()} / 10,000 required`)
  console.log(`LIVE POSTINGS  : ${summary.gate.postingsActual.toLocaleString()} / 150,000 required`)
  console.log(`GATE           : ${summary.gate.pass ? 'PASS' : 'FAIL'}`)
  console.log('='.repeat(64))
}

await main()
