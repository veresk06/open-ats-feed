#!/usr/bin/env node
// Turn two daily snapshots into hiring signals.
//
// This is the part of the product a competitor cannot clone in a weekend. Anyone can fetch
// Greenhouse today; nobody can fetch Greenhouse *last month* unless they were already running.
// The signals below are all differences between two days of data/history/*.jsonl.
//
//   node scripts/hiring-signals.mjs --from=2026-09-03 --to=2026-09-10
//   node scripts/hiring-signals.mjs --from=... --to=... --out=data/signals-2026-09-10.json
//
// Signal definitions, deliberately conservative — a false "ramping" is worse than a missed one,
// because the whole claim of this product is that the number can be trusted:
//
//   ramp_up     open roles grew >= 30% AND by >= 5 absolute. Percentage alone fires on 1 -> 2.
//   ramp_down   fell >= 30% and by >= 5. A hiring freeze is as tradeable as a ramp.
//   new_board   board is live in `to` and absent from `from`. A company that just adopted an
//               ATS, or just started hiring publicly. Highest-value row for a sales team.
//   went_dark   live in `from`, zero or gone in `to`. Freeze, acquisition, or they moved ATS.
//
// Boards missing from either side for a non-signal reason (probe budget exhausted, transient
// refusal) are reported as `coverage` and excluded from the signals — a gap must never be
// rendered as a change.

import { readFile, writeFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HISTORY_DIR = resolve(ROOT, 'data/history')

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.split('=').slice(1).join('=') : fallback
}

const RAMP_PCT = Number(arg('ramp-pct', 0.3))
const RAMP_ABS = Number(arg('ramp-abs', 5))

async function loadDay(date) {
  const file = resolve(HISTORY_DIR, `${date}.jsonl`)
  if (!existsSync(file)) throw new Error(`no snapshot for ${date} at ${file}`)
  const map = new Map()
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line)
      if (r.t) map.set(`${r.p}:${r.t}`, r)
    } catch {
      // Truncated final line from a killed snapshot run.
    }
  }
  return map
}

function boardUrl(provider, token) {
  if (provider === 'greenhouse') return `https://boards.greenhouse.io/${token}`
  if (provider === 'ashby') return `https://jobs.ashbyhq.com/${token}`
  if (provider === 'lever') return `https://jobs.lever.co/${token}`
  return null
}

async function main() {
  const from = arg('from')
  const to = arg('to')
  if (!from || !to) {
    console.error('usage: hiring-signals.mjs --from=YYYY-MM-DD --to=YYYY-MM-DD [--out=path]')
    process.exit(2)
  }
  const [a, b] = await Promise.all([loadDay(from), loadDay(to)])

  const signals = []
  const coverage = { only_in_from: 0, only_in_to_unprobed_before: 0 }

  for (const [key, now] of b) {
    const before = a.get(key)
    const [provider, token] = [now.p, now.t]
    const row = { provider, token, board_url: boardUrl(provider, token), from, to }

    if (!before) {
      // Absent from the earlier snapshot. This is only `new_board` if the earlier snapshot
      // actually covered this provider; otherwise it is a coverage gap wearing a signal's hat.
      signals.push({ ...row, signal: 'new_board', open_roles: now.j, delta: now.j })
      coverage.only_in_to_unprobed_before++
      continue
    }
    const d = now.j - before.j
    if (before.j > 0 && (now.j === 0 || now.gone)) {
      signals.push({ ...row, signal: 'went_dark', open_roles: 0, was: before.j, delta: -before.j })
    } else if (d >= RAMP_ABS && d >= before.j * RAMP_PCT) {
      signals.push({ ...row, signal: 'ramp_up', open_roles: now.j, was: before.j, delta: d })
    } else if (-d >= RAMP_ABS && -d >= before.j * RAMP_PCT && now.j > 0) {
      signals.push({ ...row, signal: 'ramp_down', open_roles: now.j, was: before.j, delta: d })
    }
  }
  for (const key of a.keys()) if (!b.has(key)) coverage.only_in_from++

  signals.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))

  const tally = {}
  for (const s of signals) tally[s.signal] = (tally[s.signal] ?? 0) + 1
  const result = {
    from,
    to,
    boards_from: a.size,
    boards_to: b.size,
    thresholds: { ramp_pct: RAMP_PCT, ramp_abs: RAMP_ABS },
    coverage,
    tally,
    signals,
  }

  const out = arg('out')
  if (out) {
    await writeFile(resolve(ROOT, out), JSON.stringify(result, null, 2) + '\n')
    console.log(`${signals.length} signals -> ${out}`)
  } else {
    console.log(JSON.stringify({ ...result, signals: signals.slice(0, 20) }, null, 2))
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
