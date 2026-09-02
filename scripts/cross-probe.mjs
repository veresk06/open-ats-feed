#!/usr/bin/env node
// Cross-probe: a company's board token is usually the same slug whichever ATS it
// runs on (`stripe`, `figma`, `ramp`). So a token harvested from Greenhouse is a
// free candidate for Ashby and Lever, and vice versa.
//
// This matters for two reasons:
//   1. Lever bans CCBot in robots.txt, so Common Crawl holds no Lever tokens at
//      all. Cross-probing is the only token source we have for Lever.
//   2. ~27% of harvested Greenhouse tokens are dead. Some of those companies did
//      not vanish, they switched ATS — and are live somewhere else.
//
// Usage: SAMPLE=500 node scripts/cross-probe.mjs

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = resolve(ROOT, process.env.TOKENS_FILE ?? 'data/tokens.json')
const OUT = resolve(ROOT, process.env.OUT_FILE ?? 'data/cross-probe.json')

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 20)
const SAMPLE = Number(process.env.SAMPLE ?? 400)
const SEED = Number(process.env.SEED ?? 7)

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
  if (n >= list.length) return [...list]
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy.slice(0, n)
}

async function probe(provider, token) {
  const spec = PROVIDERS[provider]
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(spec.url(token), {
        signal: AbortSignal.timeout(25_000),
        headers: { 'user-agent': 'open-ats-feed/coverage-test (+contact via github)' },
      })
      if (res.status === 404 || res.status === 410) return { status: 'dead' }
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      if (!res.ok) return { status: 'dead' }
      const jobs = spec.count(await res.json())
      if (jobs === null) return { status: 'dead' }
      return { status: jobs > 0 ? 'live' : 'empty', jobs }
    } catch {
      if (attempt === 3) return { status: 'error' }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return { status: 'error' }
}

async function runPool(items, worker) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        results[i] = await worker(items[i])
      }
    }),
  )
  return results
}

async function main() {
  const tokens = JSON.parse(await readFile(TOKENS, 'utf8'))
  const rand = mulberry32(SEED)
  const report = {}

  // Each source provider's tokens, probed against the two providers they did NOT
  // come from. Same-provider is already covered by verify-coverage.mjs.
  for (const source of Object.keys(PROVIDERS)) {
    const all = tokens[source] ?? []
    if (all.length < 20) {
      console.log(`${source}: only ${all.length} tokens, skipping as a source`)
      continue
    }
    const picked = sample(all, SAMPLE, rand)
    for (const target of Object.keys(PROVIDERS)) {
      if (target === source) continue
      const probed = await runPool(picked, (t) => probe(target, t))
      const live = probed.filter((r) => r.status === 'live')
      const key = `${source}->${target}`
      report[key] = {
        probed: picked.length,
        live: live.length,
        hitRate: +(live.length / picked.length).toFixed(4),
        postings: live.reduce((a, r) => a + r.jobs, 0),
      }
      console.log(
        `${key.padEnd(24)} ${live.length}/${picked.length} live` +
          ` (${(report[key].hitRate * 100).toFixed(1)}%), ${report[key].postings} postings`,
      )
    }
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(report, null, 2))
  console.log(`\nWrote ${OUT}`)
}

await main()
