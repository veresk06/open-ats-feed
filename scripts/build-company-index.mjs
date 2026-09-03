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
//   breezy      coverage-breezy-full.json — all 4,562 harvested tokens probed at
//               concurrency 8 in one pass, 1 blocked and 1 errored. Nothing was
//               projected: the Cycle-34 250-token sample predicted the live-board
//               count to within 3.9% but under-predicted postings by 16.6%, because
//               postings-per-board is long-tailed and a small sample misses the big
//               boards. Sample company counts if you must; never sample posting counts.
//   recruitee   coverage-subdomain2.json — all 3,554 harvested tokens in one pass,
//               with reprobe-recruitee.json overriding the 7 that came back blocked
//               or errored. That override is not a formality: 4 of those 7 were live
//               boards, worth 61 postings. A `blocked` verdict at concurrency 8 is a
//               statement about our request rate, not about the board, so counting it
//               as dead understates coverage in the direction that flatters nobody.
//               2 tokens still answer 403 at one request every 3 seconds; those are
//               genuine refusals and are neither live nor empty.
//   teamtailor  coverage-subdomain2.json — all 3,175 tokens in one pass, 0 blocked,
//               with reprobe-teamtailor.json layered on for symmetry. It changed
//               nothing: 4 of the 6 errors were parked tenants serving HTML, 2 still
//               fail to connect. Re-probing that recovers nothing is still worth
//               doing — it is what makes the Recruitee correction trustworthy rather
//               than a number we went looking for.
//   all six     coverage-theirs-only.json — layered last, on every provider. These are
//               the 2,035 board tokens that kalil0321/ats-scrapers publishes and our
//               Common Crawl harvest never found (Cycle 41's diff, the half that points
//               at us). Their snapshot supplied the candidate list and nothing else: each
//               token was probed against the same vendor API on the same terms as every
//               other row here, and only a live 200 with >= 1 open posting enters the
//               index. No count, status or posting figure of theirs is carried over.
//               Layering last is the same later-measurement-wins rule as the re-probes.

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

const [fast, gh403, lever, leverFull, breezyFull, sub2, reRecruitee, reTeamtailor, tokens, theirs] =
  await Promise.all([
    read('data/coverage-c3-fast.json'),
    read('data/coverage-c3-gh403.json'),
    read('data/coverage-c3-lever.json'),
    readJsonl('data/lever-probe.jsonl'),
    read('data/coverage-breezy-full.json'),
    read('data/coverage-subdomain2.json'),
    read('data/reprobe-recruitee.json'),
    read('data/reprobe-teamtailor.json'),
    read('data/tokens.json'),
    read('data/coverage-theirs-only.json'),
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

const greenhouse = split(merge(fast.greenhouse, gh403.greenhouse, theirs.greenhouse))
const ashby = split(merge(fast.ashby, theirs.ashby))
// The full pass is the later and more complete measurement, so it wins over the
// sample wherever the two overlap.
const leverRows = merge(lever.lever, leverFull, theirs.lever)
const leverSplit = split(leverRows)
const probed = new Set(leverRows.map((r) => r.token))
const leverUnverified = (tokens.lever ?? []).filter((t) => !probed.has(t)).sort()

// Breezy needed no resume file and no re-probe: one pass covered every harvested
// token. `blocked` and `error` rows are neither live nor empty, so `split` drops
// them — 2 of 4,562, which is why the pass counts as a measurement rather than a
// partial one.
const breezy = split(merge(breezyFull.breezy, theirs.breezy))

// The slow re-probe is the later and more meaningful measurement of the same token,
// so it wins over the concurrent pass — the same rule that lets the Greenhouse 403
// re-probe override the fast run.
const recruitee = split(merge(sub2.recruitee, reRecruitee.results, theirs.recruitee))
const teamtailor = split(merge(sub2.teamtailor, reTeamtailor.results, theirs.teamtailor))

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
    breezy: { ...breezy, verified: true },
    recruitee: { ...recruitee, verified: true },
    teamtailor: { ...teamtailor, verified: true },
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
