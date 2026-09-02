#!/usr/bin/env node
// Collapse the coverage runs into the single company index the Actor ships with.
//
// The Actor must not re-discover companies at runtime — Common Crawl index reads
// cost hundreds of megabytes and take hours. Discovery happens here, out of band,
// and the result is a static file with an explicit `as_of` per provider so a user
// can see how stale the list they are querying is.
//
// Provenance, one line per provider, because these came from different runs:
//   greenhouse  coverage-c3-fast.json, with coverage-c3-gh403.json overriding the
//               2,107 tokens that were throttled to 403 in the first pass
//   ashby       coverage-c3-fast.json
//   lever       lever-probe.jsonl — the resumable full pass over all 4,961 tokens,
//               layered over coverage-c3-lever.json (the earlier seeded 1,000-token
//               sample) so the sample still counts for anything the full pass has
//               not reached yet. api.lever.co asks for 1 req/s, so the pass takes
//               ~83 minutes and runs out of band. Whatever remains unprobed ships
//               as an opt-in list rather than being counted dead.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = resolve(ROOT, 'actor/data/companies.json')
const AS_OF = process.env.AS_OF ?? new Date().toISOString().slice(0, 10)

const read = async (p) => JSON.parse(await readFile(resolve(ROOT, p), 'utf8'))

// The resumable probe appends one JSON object per token as it goes, so a partial
// file is a valid partial measurement rather than a corrupt one. A trailing
// half-written line is possible if the pass is killed mid-write; drop it rather
// than failing the build.
const readJsonl = async (p) => {
  const text = await readFile(resolve(ROOT, p), 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)]
      } catch {
        return []
      }
    })
}

const [fast, gh403, lever, leverFull, tokens] = await Promise.all([
  read('data/coverage-c3-fast.json'),
  read('data/coverage-c3-gh403.json'),
  read('data/coverage-c3-lever.json'),
  readJsonl('data/lever-probe.jsonl'),
  read('data/tokens.json'),
])

// A token appears in both the fast run and the 403 re-probe; the re-probe is the
// later and unthrottled measurement, so it wins.
function merge(...runs) {
  const byToken = new Map()
  for (const run of runs) for (const r of run ?? []) byToken.set(r.token, r)
  return [...byToken.values()]
}

// `live` means the board answered 200 with at least one posting. `empty` boards
// exist but had nothing open at probe time; they are kept separately because a
// buyer polling for new postings cares about them and a buyer downloading a
// snapshot does not.
function split(rows) {
  const live = rows.filter((r) => r.status === 'live')
  return {
    live: live.sort((a, b) => b.jobs - a.jobs).map((r) => [r.token, r.jobs]),
    empty: rows.filter((r) => r.status === 'empty').map((r) => r.token).sort(),
  }
}

const greenhouse = split(merge(fast.greenhouse, gh403.greenhouse))
const ashby = split(merge(fast.ashby))
// The full pass is the later and more complete measurement, so it wins over the
// sample wherever the two overlap.
const leverRows = merge(lever.lever, leverFull)
const leverSplit = split(leverRows)
const probed = new Set(leverRows.map((r) => r.token))
const leverUnverified = (tokens.lever ?? []).filter((t) => !probed.has(t)).sort()

const index = {
  as_of: AS_OF,
  source: 'Common Crawl indexes CC-MAIN-2024-51 … CC-MAIN-2025-51, verified against each vendor public API',
  repo: 'https://github.com/veresk06/open-ats-feed',
  providers: {
    greenhouse: { ...greenhouse, verified: true },
    ashby: { ...ashby, verified: true },
    lever: {
      ...leverSplit,
      verified: true,
      unverified: leverUnverified,
      note:
        `Lever was probed token by token: ${leverRows.length} of ${(tokens.lever ?? []).length} ` +
        'harvested tokens measured directly, no projection. ' +
        `${leverUnverified.length} tokens are unprobed, not dead — api.lever.co requests 1 req/s. ` +
        'Set includeUnverifiedLever to probe them inside a run.',
    },
  },
}

const counts = Object.fromEntries(
  Object.entries(index.providers).map(([k, v]) => [
    k,
    { live: v.live.length, postings: v.live.reduce((a, [, j]) => a + j, 0), empty: v.empty.length },
  ]),
)
index.totals = {
  live: Object.values(counts).reduce((a, c) => a + c.live, 0),
  postings: Object.values(counts).reduce((a, c) => a + c.postings, 0),
  perProvider: counts,
}

await mkdir(dirname(OUT), { recursive: true })
await writeFile(OUT, JSON.stringify(index))
console.log(JSON.stringify({ out: OUT, as_of: AS_OF, ...index.totals, leverUnverified: leverUnverified.length }, null, 2))
