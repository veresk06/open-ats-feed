#!/usr/bin/env node
// Daily open-postings snapshot — the only asset in this product that cannot be back-dated.
//
// Raw ATS data is commoditising: the price fell from $4 to $1–2.25 per 1,000 jobs while we
// were measuring coverage. Derived hiring signals — "this company is ramping", "this company
// just opened a sales function" — are not commoditising, because they require *history*, and
// history only accrues forward. A competitor can clone our fetcher in a weekend; they cannot
// clone a series that started before they did. So the snapshot starts today whether or not the
// signals product is ever built.
//
// One line per live board per day:  {"p":"greenhouse","t":"spacex","j":2272}
// Deliberately terse — 9,006 rows/day is ~350 KB, ~128 MB/year, which is fine in git.
//
//   node scripts/snapshot-history.mjs --seed          seed day 0 from actor/data/companies.json
//   node scripts/snapshot-history.mjs                 probe live, today's date
//   node scripts/snapshot-history.mjs --providers=greenhouse,ashby --budget-secs=900
//
// Resumable by construction: the day's file is append-only and already-recorded tokens are
// skipped on restart, because the cycle that runs this is hard-killed at 30 minutes.

import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMPANIES = resolve(ROOT, 'actor/data/companies.json')
const HISTORY_DIR = resolve(ROOT, 'data/history')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}
const SEED = process.argv.includes('--seed')
const BUDGET_MS = Number(arg('budget-secs', 1200)) * 1000
const DATE = arg('date', new Date().toISOString().slice(0, 10))

// Lever is excluded by default: api.lever.co/robots.txt asks for Crawl-delay: 1, so its 347
// live boards cost six minutes a day on their own. It is opt-in rather than silently dropped —
// see the `providers` argument — and its absence is recorded in the manifest.
const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
    concurrency: 16,
    delayMs: 0,
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
    concurrency: 16,
    delayMs: 0,
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    count: (j) => (Array.isArray(j) ? j.length : null),
    concurrency: 1,
    delayMs: 1000,
  },
}

const SELECTED = arg('providers', 'greenhouse,ashby')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s in PROVIDERS)

async function probe(provider, token) {
  const spec = PROVIDERS[provider]
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(spec.url(token), {
        signal: AbortSignal.timeout(25_000),
        headers: { 'user-agent': 'open-ats-feed/history-snapshot (+contact via github)' },
      })
      // 403/429/5xx are facts about us, not about the company. Retry rather than record a
      // zero — a false zero in a history series reads as "this company stopped hiring", which
      // is exactly the signal the series exists to produce. A wrong one is worse than a gap.
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      if (res.status === 404 || res.status === 410) return { j: null, gone: true }
      if (!res.ok) return { j: null, gone: true }
      const n = spec.count(await res.json())
      return n === null ? { j: null, gone: true } : { j: n }
    } catch {
      if (attempt === 3) return null // unknown — omitted from the series, not recorded as 0
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return null
}

async function alreadyDone(file) {
  const seen = new Set()
  if (!existsSync(file)) return seen
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.t) seen.add(`${r.p}:${r.t}`)
    } catch {
      // Truncated last line from a killed process; re-probing one token is the whole cost.
    }
  }
  return seen
}

async function main() {
  await mkdir(HISTORY_DIR, { recursive: true })
  const companies = JSON.parse(await readFile(COMPANIES, 'utf8'))
  const file = resolve(HISTORY_DIR, `${DATE}.jsonl`)

  if (SEED) {
    // Day 0 costs no requests: the counts were already measured when the shipped index was
    // built, and companies.json carries the `as_of` date they were measured on.
    const date = companies.as_of ?? DATE
    const out = resolve(HISTORY_DIR, `${date}.jsonl`)
    let lines = ''
    let n = 0
    for (const [provider, block] of Object.entries(companies.providers ?? {})) {
      for (const [token, jobs] of block.live ?? []) {
        lines += JSON.stringify({ p: provider, t: token, j: jobs }) + '\n'
        n++
      }
    }
    await writeFile(out, lines)
    await writeFile(
      resolve(HISTORY_DIR, `${date}.manifest.json`),
      JSON.stringify(
        { date, rows: n, providers: Object.keys(companies.providers ?? {}), source: 'seed:companies.json' },
        null,
        2,
      ) + '\n',
    )
    console.log(`seeded ${n} rows into data/history/${date}.jsonl`)
    return
  }

  const seen = await alreadyDone(file)
  const work = []
  for (const provider of SELECTED) {
    for (const [token] of companies.providers?.[provider]?.live ?? []) {
      if (!seen.has(`${provider}:${token}`)) work.push([provider, token])
    }
  }
  console.log(`${DATE}: ${seen.size} already recorded · ${work.length} to probe · providers ${SELECTED.join(',')}`)

  const startedAt = Date.now()
  let done = 0
  let stopped = false
  const byProvider = new Map(SELECTED.map((p) => [p, work.filter(([q]) => q === p)]))

  for (const provider of SELECTED) {
    const items = byProvider.get(provider)
    const spec = PROVIDERS[provider]
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(spec.concurrency, items.length) }, async () => {
        while (!stopped) {
          const i = next++
          if (i >= items.length) return
          if (Date.now() - startedAt > BUDGET_MS) {
            stopped = true
            return
          }
          const at = Date.now()
          const [, token] = items[i]
          const r = await probe(provider, token)
          if (r && r.j !== null) await appendFile(file, JSON.stringify({ p: provider, t: token, j: r.j }) + '\n')
          else if (r?.gone) await appendFile(file, JSON.stringify({ p: provider, t: token, j: 0, gone: 1 }) + '\n')
          done++
          if (done % 200 === 0) process.stderr.write(`\r  ${done}/${work.length}`)
          const wait = spec.delayMs - (Date.now() - at)
          if (wait > 0) await new Promise((rr) => setTimeout(rr, wait))
        }
      }),
    )
  }

  const total = (await alreadyDone(file)).size
  await writeFile(
    resolve(HISTORY_DIR, `${DATE}.manifest.json`),
    JSON.stringify(
      { date: DATE, rows: total, providers: SELECTED, complete: !stopped, source: 'live-probe' },
      null,
      2,
    ) + '\n',
  )
  console.log(`\n${DATE}: ${total} rows · ${stopped ? 'budget exhausted, resume to finish' : 'complete'}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
