#!/usr/bin/env node
// Resumable Workable coverage probe.
//
// Same shape and same reason as probe-lever-resume.mjs, for a different cause. Lever
// is slow because its robots.txt asks for 1 req/s. Workable states no crawl delay at
// all — "User-agent: * / Disallow:" — but it throttles in practice: a single-shot
// pass at concurrency 20 managed ~61 of 6,882 tokens before this script replaced it,
// because every 429 costs the exponential backoff that keeps `blocked` from being
// miscounted as `dead`.
//
// Either way the conclusion is the same one Lever forced: a pass that only writes its
// result at the end loses everything when the cycle is hard-killed. Append one JSON
// line per token as it is probed, skip on restart whatever is already recorded.
//
//   node scripts/probe-workable-resume.mjs [--budget-secs=1200] [--concurrency=8]
//
// Output: data/workable-probe.jsonl  (append-only, one record per token)

import { readFile, appendFile, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = resolve(ROOT, 'data/tokens.json')
const OUT = resolve(ROOT, 'data/workable-probe.jsonl')
const SUMMARY = resolve(ROOT, 'data/workable-probe-summary.json')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}
const BUDGET_MS = arg('budget-secs', 1200) * 1000
const CONCURRENCY = arg('concurrency', 8)

// `details=true` is not optional: without it the account resolves 200 with an empty
// `jobs` array, and every live board on the roster would be recorded `empty`.
const url = (t) =>
  `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(t)}?details=true`

async function probe(token) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url(token), {
        signal: AbortSignal.timeout(25_000),
        headers: { 'user-agent': 'open-ats-feed/coverage-test (+contact via github)' },
      })
      if (res.status === 404 || res.status === 410) return { token, status: 'dead', http: res.status }
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        // A refusal is a fact about us, never a verdict about the company.
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      if (!res.ok) return { token, status: 'dead', http: res.status }
      const body = await res.json()
      const jobs = Array.isArray(body?.jobs) ? body.jobs.length : null
      if (jobs === null) return { token, status: 'dead', http: res.status, reason: 'unexpected-shape' }
      return { token, status: jobs > 0 ? 'live' : 'empty', http: res.status, jobs }
    } catch (err) {
      if (attempt === 3) return { token, status: 'error', reason: err.message }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return { token, status: 'blocked', reason: 'refused-after-retries' }
}

// `live`, `empty` and `dead` are verdicts about a company and are final. `blocked` and
// `error` are facts about our own request, and a resume that treats them as settled
// writes off boards Cloudflare happened to challenge — permanently, and silently. They
// are kept in the file as a record of what happened and re-probed on the next pass.
const SETTLED = new Set(['live', 'empty', 'dead'])

async function readCheckpoint() {
  const done = new Map()
  if (!existsSync(OUT)) return done
  const rl = createInterface({ input: createReadStream(OUT), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      // A later line for the same token supersedes an earlier one, so a retried
      // `blocked` is replaced by its real verdict rather than counted twice.
      if (rec.token) done.set(rec.token, rec)
    } catch {
      // A truncated final line is expected when the process was killed mid-write.
    }
  }
  return done
}

async function main() {
  const tokens = JSON.parse(await readFile(TOKENS, 'utf8')).workable ?? []
  const checkpoint = await readCheckpoint()
  const todo = tokens.filter((t) => !SETTLED.has(checkpoint.get(t)?.status))
  const retrying = tokens.filter((t) => checkpoint.has(t) && !SETTLED.has(checkpoint.get(t).status))
  console.log(
    `workable: ${tokens.length} harvested · ${checkpoint.size} in checkpoint · ` +
      `${todo.length} to probe (${retrying.length} of them retries of blocked/error)`,
  )

  const startedAt = Date.now()
  let n = 0
  let stop = false
  // Appends are serialised by awaiting inside each worker, and the records are
  // independent lines, so concurrent workers cannot interleave a partial write.
  const queue = [...todo]
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (!stop) {
        const token = queue.shift()
        if (!token) return
        if (Date.now() - startedAt > BUDGET_MS) {
          stop = true
          return
        }
        const rec = await probe(token)
        await appendFile(OUT, JSON.stringify(rec) + '\n')
        checkpoint.set(token, rec)
        n++
        if (n % 25 === 0) process.stderr.write(`\r  ${n}/${todo.length} probed this pass`)
      }
    }),
  )
  if (stop) console.log(`\nbudget of ${BUDGET_MS / 1000}s reached — stopped cleanly, ${queue.length} left`)

  const all = [...checkpoint.values()]
  const tally = { live: 0, empty: 0, dead: 0, error: 0, blocked: 0 }
  let postings = 0
  for (const r of all) {
    tally[r.status] = (tally[r.status] ?? 0) + 1
    if (r.status === 'live') postings += r.jobs ?? 0
  }
  const summary = {
    as_of: new Date().toISOString().slice(0, 10),
    harvested: tokens.length,
    probed: all.length,
    remaining: tokens.length - all.length,
    ...tally,
    postings,
    // Denominator is what was probed, not what was harvested. A partial pass reports
    // the hit rate of the part it measured and says so via `remaining`.
    hitRate: all.length ? Number((tally.live / all.length).toFixed(4)) : 0,
  }
  await writeFile(SUMMARY, JSON.stringify(summary, null, 2) + '\n')
  console.log('\n' + JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
