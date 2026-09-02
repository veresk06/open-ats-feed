#!/usr/bin/env node
// Resumable Lever coverage probe.
//
// api.lever.co/robots.txt states `Crawl-delay: 1`, so the full 4,961-token list is
// ~83 minutes of wall clock. The autonomous cycle is hard-killed at 30 minutes, which
// means a single-shot run loses everything it did. This script therefore appends one
// JSON line per token the moment it is probed, and on start it skips every token
// already recorded — in the Cycle 4 sample (data/coverage-c3-lever.json) or in its own
// checkpoint. Kill it at any point and re-running resumes where it stopped.
//
//   node scripts/probe-lever-resume.mjs [--budget-secs=1200]
//
// Output: data/lever-probe.jsonl  (append-only, one record per token)

import { readFile, appendFile, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = resolve(ROOT, 'data/tokens.json')
const SAMPLED = resolve(ROOT, 'data/coverage-c3-lever.json')
const OUT = resolve(ROOT, 'data/lever-probe.jsonl')
const SUMMARY = resolve(ROOT, 'data/lever-probe-summary.json')

const budgetArg = process.argv.find((a) => a.startsWith('--budget-secs='))
const BUDGET_MS = (budgetArg ? Number(budgetArg.split('=')[1]) : 1200) * 1000
const DELAY_MS = 1000

const url = (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`

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
      if (!Array.isArray(body)) return { token, status: 'dead', http: res.status, reason: 'unexpected-shape' }
      return { token, status: body.length > 0 ? 'live' : 'empty', http: res.status, jobs: body.length }
    } catch (err) {
      if (attempt === 3) return { token, status: 'error', reason: err.message }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return { token, status: 'blocked', reason: 'refused-after-retries' }
}

async function readCheckpoint() {
  const done = new Map()
  if (!existsSync(OUT)) return done
  const rl = createInterface({ input: createReadStream(OUT), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line)
      if (rec.token) done.set(rec.token, rec)
    } catch {
      // A truncated final line is expected when the process was killed mid-write.
      // Dropping it just re-probes one token.
    }
  }
  return done
}

async function main() {
  const tokens = JSON.parse(await readFile(TOKENS, 'utf8')).lever ?? []
  const prior = JSON.parse(await readFile(SAMPLED, 'utf8')).lever ?? []
  const priorByToken = new Map(prior.map((r) => [r.token, r]))
  const checkpoint = await readCheckpoint()

  const todo = tokens.filter((t) => !priorByToken.has(t) && !checkpoint.has(t))
  console.log(
    `lever: ${tokens.length} harvested · ${priorByToken.size} from cycle-4 sample · ` +
      `${checkpoint.size} in checkpoint · ${todo.length} remaining`,
  )
  if (todo.length === 0) {
    console.log('nothing to do')
  }

  const startedAt = Date.now()
  let n = 0
  for (const token of todo) {
    if (Date.now() - startedAt > BUDGET_MS) {
      console.log(`\nbudget of ${BUDGET_MS / 1000}s reached — stopping cleanly, ${todo.length - n} left`)
      break
    }
    const at = Date.now()
    const rec = await probe(token)
    await appendFile(OUT, JSON.stringify(rec) + '\n')
    checkpoint.set(token, rec)
    n++
    if (n % 25 === 0) process.stderr.write(`\r  ${n}/${todo.length} probed this pass`)
    const wait = DELAY_MS - (Date.now() - at)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  }

  // Summarise everything known about Lever: the cycle-4 sample plus the checkpoint.
  const all = [...priorByToken.values(), ...checkpoint.values()]
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
    hitRate: all.length ? Number((tally.live / all.length).toFixed(4)) : 0,
  }
  await writeFile(SUMMARY, JSON.stringify(summary, null, 2) + '\n')
  console.log('\n' + JSON.stringify(summary, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
