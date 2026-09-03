import { Actor, log } from 'apify'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROVIDERS } from './normalize.js'
import { companySignal } from './signals.js'
import { isRecruitmentAd } from './recruitment-ads.js'
import { isVolunteerListing } from './volunteer.js'
import { dedupeBoardRows } from './dedupe.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_FILE = resolve(HERE, '../data/companies.json')

await Actor.init()

const input = (await Actor.getInput()) ?? {}
const {
  // Same default as input_schema.json. Lever is opt-in because it is fetched at
  // 1 req/s, so silently including it turns a two-minute run into an hour-long one.
  // Workable is opt-in for a related reason, measured in Cycle 33: apply.workable.com
  // sits behind Cloudflare bot management, which answers `429 cf-mitigated: challenge`
  // to every request after roughly 700 in quick succession, and serves 200 again once
  // the caller slows to about one request per 45 seconds. So it is rate-limited rather
  // than closed — Lever's problem with an undocumented and far stricter limit. A
  // provider that can be challenged mid-run must not be in the default set: a stranger
  // presses Try and is billed per board for boards that returned nothing.
  // Breezy is in the default set because it passes the same bar Greenhouse and Ashby
  // pass and Lever and Workable do not: all 4,562 harvested tokens were probed in one
  // pass at concurrency 8, and exactly one came back blocked. Speed is the criterion
  // here, not vendor size — Breezy's boards are small (median 4 open roles), which is
  // a different slice of the market rather than more of the same one.
  providers = ['greenhouse', 'ashby', 'breezy'],
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
  // Both on by default. Neither removes much of the corpus; both stop a single board from
  // swamping a run — 1,380 of the 1,411 ads we measured are on one Lever board. See
  // src/recruitment-ads.js and src/volunteer.js.
  excludeRecruitmentAds = true,
  excludeVolunteerListings = true,
  // Off by default, unlike the two above, and the asymmetry is deliberate. Those two remove rows
  // that are not paid openings at all. This one removes rows that may well be — three
  // requisitions for three headcount at one site look exactly like three copies of one job, and
  // the ATS does not publish headcount. See src/dedupe.js.
  dedupe = false,
  includeDescription = false,
  includeEmptyBoards = false,
  includeUnverifiedLever = false,
  maxCompaniesPerProvider = 250,
  // 1,000, not 5,000. At 5,000 a first press of Try on the store billed roughly $7.50 in
  // job-result fees, hit the run's charge budget before it got there, and returned a truncated
  // 28-of-500-board result marked `complete: false`. A default is a first impression, not a
  // harvest; anyone who wants the harvest raises it.
  maxItems = 1000,
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
  await Actor.fail(
    `No valid provider selected. Choose at least one of: ${Object.keys(PROVIDERS).join(', ')}.`,
  )
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
// A provider can be selectable and still have no boards in the bundled index — the
// roster is extended one measured vendor at a time, and the input schema lists a
// vendor as soon as the Actor can read it. Say so out loud: a run that silently
// returns nothing for a ticked provider looks like a broken Actor, not a roster that
// has not caught up yet.
for (const p of plan) {
  if (!explicit && p.available === 0) {
    log.warning(
      `No ${p.provider} boards are bundled in the index dated ${INDEX_AS_OF}, so this run will ` +
        `return nothing for it. Pass company tokens explicitly, e.g. "${p.provider}:acme", to read ` +
        `${p.provider} boards now.`,
    )
  }
}
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
  // Both rules are evaluated whether or not their flag is on, because the input schema promises
  // that RUN_STATS reports the count either way and build 0.1.17 and earlier did not deliver
  // that: the counter sat behind the flag, so a run with the filter off reported zero ads rather
  // than the ads it had just delivered. The rules are counted independently, so a row matching
  // both increments both — these are per-rule match counts, not a partition. On the measured
  // corpus the two populations are disjoint: 2 boards of 500 carry ads, 8 carry volunteer
  // listings, and no board carries both.
  let drop = false
  if (isRecruitmentAd(r)) { stats.recruitment_ads_excluded++; drop ||= excludeRecruitmentAds }
  if (isVolunteerListing(r)) { stats.volunteer_listings_excluded++; drop ||= excludeVolunteerListings }
  if (drop) return false
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
  // Reported whether or not the filters are on, so the numbers are visible rather than implied.
  // With a filter off these say what it would have taken; with it on, what it took.
  recruitment_ads_excluded: 0,
  volunteer_listings_excluded: 0,
  duplicates_merged: 0,
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

// `halted` defaults to the global budget flag. A caller that also has a local reason to stop —
// a provider that has spent its share of maxItems while the run as a whole still has budget —
// passes its own predicate rather than setting the global flag, which would end the run.
async function runPool(tokens, worker, { concurrency, delayMs, halted = () => stop }) {
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tokens.length) }, async () => {
      while (!halted()) {
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

// Every selected provider gets a row before any fetching, so a provider that returns nothing —
// or never gets reached — is visibly zero rather than silently absent. The Ashby bug below was
// invisible in RUN_STATS for exactly that reason: the key was missing, not zero.
for (const { provider } of plan) {
  stats.per_provider[provider] = { boards: 0, postings: 0, pushed: 0, failed: 0 }
}

// Providers are drained one after another. Without a per-provider ceiling the first one in the
// list eats the whole item budget and the rest never run at all — and on a DEFAULT run that is
// not a corner case. `boardsFor` returns boards largest-first, so the 14 biggest Greenhouse
// boards carry 30,449 postings, six times the default maxItems of 5,000. Ashby was therefore
// structurally unreachable: a store visitor pressing Try on a two-provider default got a
// single-provider result, 14 of 500 boards, and `complete: false`. Measured on run
// `usk8FoTK6YfqFLHbE`, build 0.1.21, before this fix.
//
// The share is recomputed at each provider against what is LEFT rather than divided up front,
// so a provider that yields less than its share hands the remainder to the ones after it and a
// two-provider run still delivers maxItems in total.
const active = plan.filter((p) => p.tokens.length)
for (const [planIndex, { provider, tokens }] of active.entries()) {
  if (stop) continue
  const spec = PROVIDERS[provider]
  const ps = stats.per_provider[provider]
  const share = Math.ceil((maxItems - pushed) / (active.length - planIndex))
  const cap = Math.min(maxItems, pushed + share)
  // Local to this provider: spending the share ends this provider's pool, not the run.
  let providerStop = false
  const batch = []

  // `pushed` is claimed before the await, not after. A dozen workers share this
  // batch, and incrementing after `await Actor.pushData` let two of them size
  // their slice against the same stale count — a 600-item cap delivered 676 on
  // the first platform run. maxItems is what a paying user is billed against, so
  // overshooting it is not a rounding error.
  async function flush(force) {
    if (!batch.length || (!force && batch.length < 500)) return
    const out = batch.splice(0, Math.min(batch.length, cap - pushed))
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
    if (pushed >= cap && !providerStop) {
      providerStop = true
      batch.length = 0
      if (pushed >= maxItems) {
        stop = true
        log.info(`maxItems (${maxItems}) reached — stopping early.`)
      } else {
        log.info(`${provider}: spent its ${share}-row share of maxItems — moving to the next provider.`)
      }
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
        // Deduped here too, not only in postings mode. No row is billed per duplicate in signals
        // mode, so this is not about cost — it is that a retail chain posting one role at
        // seventy-six stores under one location string reads as a hiring ramp it is not. With
        // the flag on, `open_postings` and the 7/30/90-day windows are counted over collapsed
        // rows and `minOpenPostings` gates on that same collapsed count. Not annotated: signals
        // rows are per-company aggregates and never carry a posting's own fields.
        const deduped = rows.filter((r) => keep(r, true))
        const { rows: kept, merged } = dedupeBoardRows(deduped, { apply: dedupe, annotate: false })
        stats.duplicates_merged += merged
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
        // Filter first, collapse second. The other order would decide which copy survives on a
        // population the buyer never asked for — with `location=Berlin` set, a Berlin row could
        // be dropped in favour of a Munich one that is then filtered away, and the buyer would
        // lose a posting they matched. Collapsing what they asked for cannot do that.
        const matched = rows.filter((r) => keep(r))
        const { rows: kept, merged } = dedupeBoardRows(matched, { apply: dedupe })
        stats.duplicates_merged += merged
        for (const r of kept) {
          if (!includeDescription) delete r.description
          batch.push({ ...r, index_as_of: INDEX_AS_OF, fetched_at })
          if (pushed + batch.length >= cap) break
        }
      }
      await flush(pushed + batch.length >= cap)
      await chargeBoards()
    },
    { concurrency: spec.concurrency, delayMs: spec.delayMs, halted: () => stop || providerStop },
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
// `pushed` is what this process CLAIMED to deliver. The platform's own charge ledger is what the
// buyer actually received, and the two can differ: on run `laSvdF3z2Wgij0hxD` they differed by 78
// rows. The per-batch give-back above is supposed to catch that, but when the run's budget ran out
// mid-batch the SDK's `chargedCount` did not report the shortfall, so the correction never fired
// and RUN_STATS over-reported delivery by 2.4%. Report the ledger and, when they disagree, say by
// how much rather than quietly picking the smaller number.
const delivered = isPpe ? charging.getChargedEventCount(EVENT.result) : pushed
stats.postings_pushed = SIGNALS ? 0 : delivered
if (SIGNALS) stats.companies_pushed = delivered
// Only ever non-zero on a budget-capped run. `per_provider[*].pushed` stays as claimed, so this
// is also the amount by which those per-provider figures sum above the run total.
if (pushed > delivered) stats.claimed_not_delivered = pushed - delivered
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
