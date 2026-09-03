import { Actor, log } from 'apify'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROVIDERS } from './normalize.js'
import { companySignal } from './signals.js'
import { isRecruitmentAd } from './recruitment-ads.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_FILE = resolve(HERE, '../data/companies.json')

await Actor.init()

const input = (await Actor.getInput()) ?? {}
const {
  // Same default as input_schema.json. Lever is opt-in because it is fetched at
  // 1 req/s, so silently including it turns a two-minute run into an hour-long one.
  providers = ['greenhouse', 'ashby'],
  outputMode = 'postings',
  signalTypes = [],
  minOpenPostings = 1,
  companies = [],
  keywords = [],
  location = '',
  workplace = [],
  seniority = [],
  department = '',
  postedSince = '',
  withSalaryOnly = false,
  // On by default: 0.48% of the corpus is commission-only/MLM recruitment copy and a
  // buyer paying per delivered row should not pay for it. See src/recruitment-ads.js.
  excludeRecruitmentAds = true,
  includeDescription = false,
  includeEmptyBoards = false,
  includeUnverifiedLever = false,
  maxCompaniesPerProvider = 250,
  maxItems = 5000,
} = input

const index = JSON.parse(await readFile(INDEX_FILE, 'utf8'))
const INDEX_AS_OF = index.as_of

// --------------------------------------------------------------- the work list

// An explicit `companies` list overrides the bundled index entirely: a user who
// names boards wants those boards, whether or not our last sweep saw them.
function parseExplicit(entries) {
  const byProvider = {}
  for (const raw of entries) {
    const s = String(raw).trim()
    if (!s) continue
    const [maybeProvider, ...rest] = s.split(':')
    if (rest.length && PROVIDERS[maybeProvider.toLowerCase()]) {
      const p = maybeProvider.toLowerCase()
      ;(byProvider[p] ??= []).push(rest.join(':').trim())
    } else {
      // No provider prefix — try it on every selected provider. A 404 is cheap
      // and guessing wrong is better than refusing the input.
      for (const p of providers) (byProvider[p] ??= []).push(s)
    }
  }
  return byProvider
}

function boardsFor(provider) {
  const entry = index.providers[provider]
  if (!entry) return []
  // `live` is sorted by posting count descending, so a capped run takes the
  // largest boards first rather than an alphabetical slice.
  const tokens = entry.live.map(([token]) => token)
  if (includeEmptyBoards) tokens.push(...entry.empty)
  if (provider === 'lever' && includeUnverifiedLever) tokens.push(...(entry.unverified ?? []))
  return tokens
}

const explicit = companies.length ? parseExplicit(companies) : null
const selected = providers.filter((p) => PROVIDERS[p])
if (!selected.length) {
  await Actor.fail('No valid provider selected. Choose at least one of: greenhouse, ashby, lever.')
}

// Two shapes of output from the same scan. "postings" is one row per open job.
// "signals" is one row per company: how fast it is hiring right now against its
// own recent baseline, which functions it has just opened, and which technologies
// it is hiring for. Both are derived from the same fetch, so a signals run costs
// the same to produce and delivers roughly 1/30th of the rows.
const SIGNALS = outputMode === 'signals'
if (!['postings', 'signals'].includes(outputMode)) {
  await Actor.fail(`outputMode must be "postings" or "signals", not "${outputMode}".`)
}
const wantedSignals = new Set(signalTypes)

const plan = selected.map((provider) => {
  const all = explicit ? (explicit[provider] ?? []) : boardsFor(provider)
  return { provider, tokens: all.slice(0, maxCompaniesPerProvider), available: all.length }
})

const planned = plan.reduce((a, p) => a + p.tokens.length, 0)
log.info('Run plan', {
  index_as_of: INDEX_AS_OF,
  boards: Object.fromEntries(plan.map((p) => [p.provider, `${p.tokens.length}/${p.available}`])),
  maxItems,
})
if (plan.some((p) => p.provider === 'lever' && p.tokens.length > 60)) {
  log.warning(
    `Lever is fetched at 1 request/second because api.lever.co asks for it in robots.txt. ` +
      `${plan.find((p) => p.provider === 'lever').tokens.length} Lever boards will take roughly ` +
      `${Math.ceil(plan.find((p) => p.provider === 'lever').tokens.length / 60)} minutes.`,
  )
}

// -------------------------------------------------------------------- charging

// Pay-per-event with three events, not one. The reason there are three: the two
// things that cost money here are different quantities. Compute is driven by
// boards *scanned*; dataset storage by rows *delivered*. A one-title filter over
// the full index scans 9,006 boards to deliver a handful of rows — priced per
// result that run earns cents and pays for none of the work it did. Charging the
// scan and the result separately makes the revenue driver and the cost driver
// the same two variables.
//
//   actor-start    $0.005      once per run
//   board-scanned  $0.0005     per board we got an answer from  ($0.50 / 1,000)
//   job-result     $0.0015     per row delivered                ($1.50 / 1,000)
//
// A board we could not read after four attempts is not charged. We spent the
// compute, but billing for a failed read is the kind of line item that costs
// more in reviews than it earns in cents.
const EVENT = { start: 'actor-start', board: 'board-scanned', result: 'job-result' }
const CHARGE_BOARDS_EVERY = 200
const CHARGE_TIMEOUT_MS = 30_000

const charging = Actor.getChargingManager()
const isPpe = charging.getPricingInfo().isPayPerEvent

let pushed = 0
let stop = false
let budgetSpent = false
let boardsPending = 0

// `maxTotalChargeUsd` is the user's hard ceiling. Past it the SDK deliberately
// overcharges by one event so the platform kills the run; we would rather stop
// on our own terms and hand back everything already delivered.
function haltOnBudget(eventName) {
  if (budgetSpent) return
  budgetSpent = true
  stop = true
  log.warning(
    `Run budget reached while charging "${eventName}" — stopping here and keeping what is ` +
      `already in the dataset. Raise the run's maximum total charge to go further.`,
  )
}

// A charge call must never be able to hold a run open. Build 0.1.3 did all of its
// work in 3 seconds and then sat in RUNNING for 8 minutes with no further log
// output — the run was billing the user for compute it was not using, and would
// have kept doing so until the 1-hour timeout. Undercharging by a few cents when
// the platform does not answer is the cheaper failure by a wide margin.
let chargeStalls = 0
async function chargeSafely(eventName, count) {
  let timer
  const bail = new Promise((r) => {
    timer = setTimeout(() => r('stalled'), CHARGE_TIMEOUT_MS)
  })
  try {
    const res = await Promise.race([Actor.charge({ eventName, count }), bail])
    if (res === 'stalled') {
      chargeStalls++
      log.warning(`Charging "${eventName}" (x${count}) did not return in ${CHARGE_TIMEOUT_MS / 1000}s — not billed, continuing`)
      return null
    }
    return res
  } catch (err) {
    chargeStalls++
    log.warning(`Charging "${eventName}" (x${count}) failed: ${err?.message ?? err} — not billed, continuing`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Claim the count before the await, never after. A dozen workers share this
// counter, and making that mistake after the await is exactly what let a
// 600-item cap deliver 676 rows on the first platform run. There it cost us a
// wrong statistic. Here it would be a double charge, which is a refund and a
// one-star review.
async function chargeBoards(force = false) {
  if (boardsPending === 0 || (!force && boardsPending < CHARGE_BOARDS_EVERY)) return
  const claimed = boardsPending
  boardsPending = 0
  const res = await chargeSafely(EVENT.board, claimed)
  if (isPpe && res && res.chargedCount < claimed) haltOnBudget(EVENT.board)
}

// ------------------------------------------------------------------- filtering

const kw = keywords.map((k) => String(k).toLowerCase()).filter(Boolean)
const loc = location.trim().toLowerCase()
const dept = department.trim().toLowerCase()
const wp = new Set(workplace)
const sen = new Set(seniority)
const since = postedSince ? new Date(postedSince) : null
if (since && Number.isNaN(since.getTime())) {
  await Actor.fail(`postedSince is not a date I can parse: "${postedSince}". Use YYYY-MM-DD.`)
}

// `postedSince` is a delta filter on the posting stream. Applying it in signals
// mode would hide exactly the older postings the baseline is measured against, so
// every company would read as ramping. It is ignored there, out loud.
if (SIGNALS && since) {
  log.warning('postedSince is ignored in signals mode — the 7/30/90-day windows are computed from posted_at, and filtering the history away would make every company look like a ramp.')
}

function keep(r, ignoreSince = false) {
  if (excludeRecruitmentAds && isRecruitmentAd(r)) { stats.recruitment_ads_excluded++; return false }
  if (kw.length) {
    const hay = `${r.title} ${r.department ?? ''} ${r.team ?? ''} ${r.description ?? ''}`.toLowerCase()
    if (!kw.some((k) => hay.includes(k))) return false
  }
  if (loc && !String(r.location ?? '').toLowerCase().includes(loc)) return false
  if (dept && !String(r.department ?? '').toLowerCase().includes(dept)) return false
  if (wp.size && !wp.has(r.workplace)) return false
  if (sen.size && !sen.has(r.seniority)) return false
  if (withSalaryOnly && r.salary_min === null) return false
  if (since && !ignoreSince) {
    const t = r.updated_at ?? r.posted_at
    if (!t || new Date(t) < since) return false
  }
  return true
}

// ------------------------------------------------------------------ fetch loop

// Charged here rather than at the top of the file: every input validation has
// passed by this point, so a run that fails on a malformed `postedSince` never
// bills for starting.
await chargeSafely(EVENT.start, 1)

const stats = {
  output_mode: outputMode,
  index_as_of: INDEX_AS_OF,
  boards_planned: planned,
  boards_fetched: 0,
  boards_empty_or_gone: 0,
  boards_failed: 0,
  postings_seen: 0,
  postings_pushed: 0,
  // Reported whether or not the filter is on, so the number is visible rather than implied.
  recruitment_ads_excluded: 0,
  per_provider: {},
}
if (SIGNALS) {
  stats.companies_pushed = 0
  stats.signal_breakdown = { ramping: 0, new_board: 0, steady: 0, quiet: 0, undated: 0 }
}

async function fetchBoard(provider, token) {
  const spec = PROVIDERS[provider]
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(spec.url(token), {
        signal: AbortSignal.timeout(30_000),
        headers: {
          'user-agent': 'open-ats-feed (+https://github.com/veresk06/open-ats-feed)',
          accept: 'application/json',
        },
      })
      // 404/410 is a real answer: this board does not exist. Anything else in the
      // refusal family is instrument state, never a verdict about the company —
      // retry it, and if it never resolves, report it as failed rather than empty.
      if (res.status === 404 || res.status === 410) return { rows: [], gone: true }
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      if (!res.ok) return { rows: [], gone: true }
      const list = spec.list(await res.json())
      if (!list) return { rows: [], gone: true }
      return { rows: list.map((j) => spec.map(j, token)).filter((r) => r.title && r.job_id) }
    } catch (err) {
      if (attempt === 3) return { rows: [], failed: String(err?.message ?? err) }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return { rows: [], failed: 'refused after retries' }
}

async function runPool(tokens, worker, { concurrency, delayMs }) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tokens.length) }, async () => {
      while (!stop) {
        const i = next++
        if (i >= tokens.length) return
        const startedAt = Date.now()
        await worker(tokens[i])
        // Crawl-delay is measured between request starts, so subtract the time the
        // request itself took rather than sleeping a flat second on top of it.
        const wait = delayMs - (Date.now() - startedAt)
        if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      }
    }),
  )
}

const fetched_at = new Date().toISOString()
// Every 7/30/90-day window in signals mode is measured from this one instant, so
// a board read in the first minute of a run and one read an hour later are scored
// against the same clock.
const NOW_MS = Date.parse(fetched_at)

for (const { provider, tokens } of plan) {
  if (stop || !tokens.length) continue
  const spec = PROVIDERS[provider]
  const ps = { boards: 0, postings: 0, pushed: 0, failed: 0 }
  stats.per_provider[provider] = ps
  const batch = []

  // `pushed` is claimed before the await, not after. A dozen workers share this
  // batch, and incrementing after `await Actor.pushData` let two of them size
  // their slice against the same stale count — a 600-item cap delivered 676 on
  // the first platform run. maxItems is what a paying user is billed against, so
  // overshooting it is not a rounding error.
  async function flush(force) {
    if (!batch.length || (!force && batch.length < 500)) return
    const out = batch.splice(0, Math.min(batch.length, maxItems - pushed))
    if (out.length) {
      pushed += out.length
      ps.pushed += out.length
      const res = await Actor.pushData(out, EVENT.result)
      // Under pay-per-event the SDK trims the batch to whatever the run's
      // remaining budget covers, so what we claimed and what actually landed can
      // differ. Give the difference back rather than reporting rows we did not
      // deliver. Off pay-per-event `chargedCount` is always 0 and nothing is
      // trimmed, which is why this is gated on `isPpe`.
      if (isPpe && res.chargedCount < out.length) {
        const short = out.length - res.chargedCount
        pushed -= short
        ps.pushed -= short
        haltOnBudget(EVENT.result)
      }
    }
    if (pushed >= maxItems && !stop) {
      stop = true
      batch.length = 0
      log.info(`maxItems (${maxItems}) reached — stopping early.`)
    }
  }

  await runPool(
    tokens,
    async (token) => {
      const { rows, gone, failed } = await fetchBoard(provider, token)
      stats.boards_fetched++
      ps.boards++
      if (failed) {
        stats.boards_failed++
        ps.failed++
        log.warning(`${provider}:${token} could not be read (${failed}) — reported as failed, not empty`)
        return
      }
      boardsPending++
      if (gone || !rows.length) stats.boards_empty_or_gone++
      stats.postings_seen += rows.length
      ps.postings += rows.length

      if (SIGNALS) {
        // One row per company, computed the moment its board is read. Nothing is
        // held in memory across boards: a signal only ever needs that company's
        // own postings, which is what makes this streamable rather than a
        // second pass over the whole run.
        const kept = rows.filter((r) => keep(r, true))
        // Descriptions are fetched either way. Off by default they are used for
        // nothing; on, they widen technology detection past the title at the cost
        // of matching a stack mentioned only in a benefits paragraph.
        if (!includeDescription) for (const r of kept) delete r.description
        const sig =
          kept.length >= minOpenPostings
            ? companySignal(kept, {
                provider,
                token,
                company_url: kept[0].company_url,
                index_as_of: INDEX_AS_OF,
                fetched_at,
                now: NOW_MS,
              })
            : null
        if (sig && (!wantedSignals.size || wantedSignals.has(sig.signal))) {
          stats.signal_breakdown[sig.signal]++
          batch.push(sig)
        }
      } else {
        for (const r of rows) {
          if (!keep(r)) continue
          if (!includeDescription) delete r.description
          batch.push({ ...r, index_as_of: INDEX_AS_OF, fetched_at })
          if (pushed + batch.length >= maxItems) break
        }
      }
      await flush(pushed + batch.length >= maxItems)
      await chargeBoards()
    },
    { concurrency: spec.concurrency, delayMs: spec.delayMs },
  )

  log.info(`${provider}: fetch pool drained, flushing`)
  await flush(true)
  log.info(`${provider}: flushed, settling board charges`)
  await chargeBoards(true)
  log.info(`${provider} done`, ps)
}

await chargeBoards(true)
log.info('all charges settled, writing RUN_STATS')

// In signals mode no posting is delivered at all — the run reads them and ships
// one aggregate row per company — so reporting them as delivered rows would
// overstate what the buyer received.
stats.postings_pushed = SIGNALS ? 0 : pushed
if (SIGNALS) stats.companies_pushed = pushed
stats.charged = isPpe
  ? {
      [EVENT.start]: charging.getChargedEventCount(EVENT.start),
      [EVENT.board]: charging.getChargedEventCount(EVENT.board),
      [EVENT.result]: charging.getChargedEventCount(EVENT.result),
      budget_reached: budgetSpent,
      charge_calls_stalled: chargeStalls,
    }
  : { pricing: 'this run was not billed per event' }
// Standing rule: every total ships with how much of the plan actually ran, so a
// truncated run is never mistaken for a complete one.
stats.units_completed = stats.boards_fetched
stats.units_planned = planned
stats.complete = stats.boards_fetched >= planned && !stop

await Actor.setValue('RUN_STATS', stats)
log.info('Finished', stats)

await Actor.exit()
