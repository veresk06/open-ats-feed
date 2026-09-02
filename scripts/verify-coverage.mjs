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

const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    count: (j) => (Array.isArray(j) ? j.length : null),
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
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
      if (res.status === 429 || res.status >= 500) {
        // Back off and retry: transient, not a verdict about the company.
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
  return { status: 'error', reason: 'rate-limited' }
}

async function runPool(items, worker) {
  const results = new Array(items.length)
  let next = 0
  let done = 0
  const tick = setInterval(() => {
    process.stderr.write(`\r  ${done}/${items.length} probed`)
  }, 2000)
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        results[i] = await worker(items[i])
        done++
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
    const all = tokens[provider] ?? []
    const list = sample(all, SAMPLE, rand).slice(0, LIMIT)
    if (!list.length) continue
    summary.perProvider[provider] = { harvested: all.length }
    console.log(`\n${provider}: probing ${list.length} tokens (concurrency ${CONCURRENCY})`)
    const probed = await runPool(list, (t) => probe(provider, t).then((r) => ({ token: t, ...r })))
    results[provider] = probed

    const live = probed.filter((r) => r.status === 'live')
    const s = {
      harvested: all.length,
      candidates: list.length,
      live: live.length,
      empty: probed.filter((r) => r.status === 'empty').length,
      dead: probed.filter((r) => r.status === 'dead').length,
      error: probed.filter((r) => r.status === 'error').length,
      postings: live.reduce((a, r) => a + r.jobs, 0),
    }
    s.hitRate = +(s.live / s.candidates).toFixed(4)
    s.medianJobs = live.length
      ? live.map((r) => r.jobs).sort((a, b) => a - b)[Math.floor(live.length / 2)]
      : 0
    summary.perProvider[provider] = s
    console.log(
      `  live ${s.live} / empty ${s.empty} / dead ${s.dead} / error ${s.error}` +
        ` | postings ${s.postings} | hit rate ${(s.hitRate * 100).toFixed(1)}% | median ${s.medianJobs} jobs`,
    )
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
