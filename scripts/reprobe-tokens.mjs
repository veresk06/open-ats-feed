#!/usr/bin/env node
// Re-probe a handful of tokens one at a time, slowly.
//
// verify-coverage.mjs runs at concurrency 8 and marks a token `blocked` when the
// vendor refuses it after retries. A refusal under concurrency says something about
// our request rate, not about whether the board exists — so those tokens are unknown,
// not dead, and a coverage number that silently counts them as dead is wrong in the
// direction that flatters us. Same for `error`: a fetch failure or an HTML body where
// JSON was expected is a question, not an answer.
//
// This re-asks the question under conditions where the answer means something:
// one request at a time, seconds apart. Whatever it returns is the real status.
//
// Usage:
//   node scripts/reprobe-tokens.mjs --provider=recruitee --status=blocked,error
//
// Writes data/reprobe-<provider>.json and prints a status tally.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname

const ENDPOINTS = {
  recruitee: {
    url: (t) => `https://${encodeURIComponent(t)}.recruitee.com/api/offers/`,
    count: (j) => (Array.isArray(j?.offers) ? j.offers.length : null),
  },
  teamtailor: {
    url: (t) => `https://${encodeURIComponent(t)}.teamtailor.com/jobs.json`,
    count: (j) => (Array.isArray(j?.jobs) ? j.jobs.length : null),
  },
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

const provider = arg('provider')
const wanted = arg('status', 'blocked,error').split(',').map((s) => s.trim())
const delayMs = Number(arg('delay-ms', '3000'))
const coverageFile = arg('coverage', 'data/coverage-subdomain2.json')

const endpoint = ENDPOINTS[provider]
if (!endpoint) {
  console.error(`unknown provider: ${provider} (have ${Object.keys(ENDPOINTS).join(', ')})`)
  process.exit(2)
}

const coverage = JSON.parse(readFileSync(join(ROOT, coverageFile), 'utf8'))
const rows = coverage[provider]
if (!Array.isArray(rows)) {
  console.error(`${coverageFile} has no array for ${provider}`)
  process.exit(2)
}

const targets = rows.filter((r) => wanted.includes(r.status))
console.log(`${provider}: re-probing ${targets.length} tokens (${wanted.join('/')}) one at a time, ${delayMs}ms apart`)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
for (const row of targets) {
  const url = endpoint.url(row.token)
  let out = { token: row.token, was: row.status }
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'open-ats-feed/0.1 (+https://github.com/veresk06/open-ats-feed)' },
      signal: AbortSignal.timeout(20000),
    })
    out.http = res.status
    if (res.status === 404 || res.status === 410) {
      out.status = 'dead'
    } else if (res.status === 429 || res.status === 403) {
      // Still refused even at one request every few seconds. That is the vendor
      // saying no to us specifically, not a rate we can back off our way out of.
      out.status = 'blocked'
      out.reason = `http ${res.status} at 1 req/${delayMs}ms`
    } else if (!res.ok) {
      out.status = 'error'
      out.reason = `http ${res.status}`
    } else {
      const text = await res.text()
      try {
        const n = endpoint.count(JSON.parse(text))
        if (n === null) {
          out.status = 'dead'
          out.reason = 'json without a job list'
        } else {
          out.status = n > 0 ? 'live' : 'empty'
          out.jobs = n
        }
      } catch {
        // HTML where JSON was promised means this host is not serving a board API —
        // for these vendors that is a parked or redirected tenant, i.e. dead.
        out.status = 'dead'
        out.reason = 'non-json body'
      }
    }
  } catch (err) {
    out.status = 'error'
    out.reason = String(err?.message ?? err)
  }
  console.log(`  ${row.token}: ${row.status} -> ${out.status}${out.jobs != null ? ` (${out.jobs} jobs)` : ''}${out.reason ? ` [${out.reason}]` : ''}`)
  results.push(out)
  await sleep(delayMs)
}

const tally = {}
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1
const jobs = results.reduce((a, r) => a + (r.jobs ?? 0), 0)
console.log(`\n${provider} re-probe: ${JSON.stringify(tally)} | ${jobs} postings recovered`)

const outFile = join(ROOT, `data/reprobe-${provider}.json`)
writeFileSync(outFile, JSON.stringify({ provider, delayMs, results, tally, postings: jobs }, null, 2))
console.log(`wrote ${outFile}`)
