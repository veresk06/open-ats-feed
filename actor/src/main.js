import { Actor, log } from 'apify'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PROVIDERS } from './normalize.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_FILE = resolve(HERE, '../data/companies.json')

await Actor.init()

const input = (await Actor.getInput()) ?? {}
const {
  providers = ['greenhouse', 'ashby', 'lever'],
  companies = [],
  keywords = [],
  location = '',
  workplace = [],
  seniority = [],
  department = '',
  postedSince = '',
  withSalaryOnly = false,
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

function keep(r) {
  if (kw.length) {
    const hay = `${r.title} ${r.department ?? ''} ${r.team ?? ''} ${r.description ?? ''}`.toLowerCase()
    if (!kw.some((k) => hay.includes(k))) return false
  }
  if (loc && !String(r.location ?? '').toLowerCase().includes(loc)) return false
  if (dept && !String(r.department ?? '').toLowerCase().includes(dept)) return false
  if (wp.size && !wp.has(r.workplace)) return false
  if (sen.size && !sen.has(r.seniority)) return false
  if (withSalaryOnly && r.salary_min === null) return false
  if (since) {
    const t = r.updated_at ?? r.posted_at
    if (!t || new Date(t) < since) return false
  }
  return true
}

// ------------------------------------------------------------------ fetch loop

const stats = {
  index_as_of: INDEX_AS_OF,
  boards_planned: planned,
  boards_fetched: 0,
  boards_empty_or_gone: 0,
  boards_failed: 0,
  postings_seen: 0,
  postings_pushed: 0,
  per_provider: {},
}

let pushed = 0
let stop = false

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
      await Actor.pushData(out)
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
      if (gone || !rows.length) stats.boards_empty_or_gone++
      stats.postings_seen += rows.length
      ps.postings += rows.length

      for (const r of rows) {
        if (!keep(r)) continue
        if (!includeDescription) delete r.description
        batch.push({ ...r, index_as_of: INDEX_AS_OF, fetched_at })
        if (pushed + batch.length >= maxItems) break
      }
      await flush(pushed + batch.length >= maxItems)
    },
    { concurrency: spec.concurrency, delayMs: spec.delayMs },
  )

  await flush(true)
  log.info(`${provider} done`, ps)
}

stats.postings_pushed = pushed
// Standing rule: every total ships with how much of the plan actually ran, so a
// truncated run is never mistaken for a complete one.
stats.units_completed = stats.boards_fetched
stats.units_planned = planned
stats.complete = stats.boards_fetched >= planned && !stop

await Actor.setValue('RUN_STATS', stats)
log.info('Finished', stats)

await Actor.exit()
