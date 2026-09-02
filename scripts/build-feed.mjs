#!/usr/bin/env node
// Build the normalized feed: fetch every live board and emit one NDJSON record
// per posting, with a schema that is identical across all three ATS vendors.
//
// The raw APIs disagree about almost everything. Greenhouse has `location.name`
// and `updated_at`; Ashby has `location`, `isRemote`, `employmentType` and
// `publishedAt`; Lever has `categories.location` and `createdAt`. Reconciling
// that is the actual product — the coverage index just says which boards exist.
//
// Usage:
//   node scripts/build-feed.mjs                    # everything in data/tokens.json
//   SINCE=2026-08-01 node scripts/build-feed.mjs   # delta mode
//   LIMIT=50 node scripts/build-feed.mjs           # smoke test

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS = resolve(ROOT, process.env.TOKENS_FILE ?? 'data/tokens.json')
const OUT = resolve(ROOT, process.env.OUT_FILE ?? 'data/feed.ndjson')

const CONCURRENCY = Number(process.env.CONCURRENCY ?? 16)
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity
// Delta mode. A posting is included only if its timestamp is at or after this.
// This is the feature the feed is actually sold on — a buyer polls daily and
// pays for what changed, not for a full re-download.
const SINCE = process.env.SINCE ? new Date(process.env.SINCE) : null

// ---------------------------------------------------------------- normalizing

const SENIORITY = [
  [/\b(intern|internship|apprentice)\b/i, 'intern'],
  [/\b(principal|staff|distinguished|fellow)\b/i, 'principal'],
  [/\b(head of|director|vp|vice president|chief|cto|ceo|cfo)\b/i, 'executive'],
  [/\b(senior|sr\.?|lead|manager)\b/i, 'senior'],
  [/\b(junior|jr\.?|entry[- ]level|associate|graduate|new grad)\b/i, 'junior'],
]

function seniority(title) {
  for (const [re, label] of SENIORITY) if (re.test(title)) return label
  return 'mid'
}

const REMOTE_RE = /\b(remote|work from home|wfh|distributed|anywhere)\b/i
const HYBRID_RE = /\bhybrid\b/i

// Vendors ship an explicit workplace enum, and where they do it beats any string
// match on a location label. Do NOT use Ashby's `isRemote` boolean for this: it
// is true for Hybrid roles too (measured on Ramp's board — 110 postings tagged
// `workplaceType: "Hybrid", isRemote: true`, all located "New York, NY (HQ)").
// Trusting it classified two thirds of the feed as remote, which is wrong by
// roughly a factor of three.
const WORKPLACE_ENUM = {
  remote: 'remote',
  onsite: 'onsite',
  hybrid: 'hybrid',
}

function workplace(text, enumValue) {
  const explicit = WORKPLACE_ENUM[String(enumValue ?? '').toLowerCase()]
  if (explicit) return explicit
  if (HYBRID_RE.test(text)) return 'hybrid'
  if (REMOTE_RE.test(text)) return 'remote'
  return 'onsite'
}

const CURRENCY = { $: 'USD', '£': 'GBP', '€': 'EUR', 'C$': 'CAD', 'A$': 'AUD' }

// Salary ranges in these feeds live in free text, in wildly inconsistent forms:
//   "$150,000 - $200,000"   "£70k–£90k"   "120000-160000 USD"   "€80.000 - €100.000"
// Anything not confidently a range is left null rather than guessed at — a wrong
// salary is worse than an absent one for every buyer of this data.
const SALARY_RE = new RegExp(
  String.raw`([$£€]|C\$|A\$)?\s?(\d{1,3}(?:[,.\s]\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK])` +
    String.raw`\s*(?:-|–|—|to)\s*` +
    String.raw`([$£€]|C\$|A\$)?\s?(\d{1,3}(?:[,.\s]\d{3})+|\d{2,3}(?:\.\d+)?\s?[kK])`,
  'g',
)

function parseAmount(raw) {
  const s = raw.trim()
  if (/[kK]$/.test(s)) return Math.round(parseFloat(s) * 1000)
  const digits = s.replace(/[,.\s]/g, '')
  const n = Number(digits)
  return Number.isFinite(n) ? n : null
}

function salary(text) {
  if (!text) return { min: null, max: null, currency: null }
  SALARY_RE.lastIndex = 0
  let best = null
  let m
  while ((m = SALARY_RE.exec(text)) !== null) {
    const min = parseAmount(m[2])
    const max = parseAmount(m[4])
    if (min === null || max === null) continue
    // Filter out ranges that are obviously not annual compensation: years,
    // headcounts, equity share counts, hourly rates below a plausible floor.
    if (min < 10_000 || max <= min || max > 10_000_000) continue
    if (!best || max - min > best.max - best.min) {
      best = { min, max, currency: CURRENCY[m[1] ?? m[3]] ?? null }
    }
  }
  return best ?? { min: null, max: null, currency: null }
}

function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

function iso(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// ------------------------------------------------------------------- adapters

const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=true`,
    list: (j) => (Array.isArray(j?.jobs) ? j.jobs : null),
    map: (job, token) => {
      const body = stripHtml(decodeURIComponent(job.content ?? ''))
      const loc = job.location?.name ?? ''
      return {
        source: 'greenhouse',
        company: token,
        job_id: String(job.id),
        title: (job.title ?? '').trim(),
        url: job.absolute_url ?? null,
        location: loc || null,
        workplace: workplace(`${loc} ${job.title ?? ''}`),
        department: job.departments?.[0]?.name ?? null,
        team: null,
        employment_type: null,
        posted_at: iso(job.first_published ?? job.updated_at),
        updated_at: iso(job.updated_at),
        ...salaryFields(`${job.title ?? ''} ${body}`),
        seniority: seniority(job.title ?? ''),
      }
    },
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}`,
    list: (j) => (Array.isArray(j?.jobs) ? j.jobs : null),
    map: (job, token) => {
      const body = stripHtml(job.descriptionPlain ?? job.descriptionHtml ?? '')
      const loc = job.location ?? ''
      return {
        source: 'ashby',
        company: token,
        job_id: String(job.id),
        title: (job.title ?? '').trim(),
        url: job.jobUrl ?? job.applyUrl ?? null,
        location: loc || null,
        workplace: workplace(`${loc} ${job.workplaceType ?? ''}`, job.workplaceType),
        department: job.department ?? null,
        team: job.team ?? null,
        employment_type: job.employmentType ?? null,
        posted_at: iso(job.publishedAt),
        updated_at: iso(job.publishedAt),
        ...salaryFields(`${job.title ?? ''} ${body}`),
        seniority: seniority(job.title ?? ''),
      }
    },
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    list: (j) => (Array.isArray(j) ? j : null),
    map: (job, token) => {
      const body = stripHtml(job.descriptionPlain ?? job.description ?? '')
      const loc = job.categories?.location ?? ''
      return {
        source: 'lever',
        company: token,
        job_id: String(job.id),
        title: (job.text ?? '').trim(),
        url: job.hostedUrl ?? job.applyUrl ?? null,
        location: loc || null,
        workplace: workplace(`${loc} ${job.workplaceType ?? ''}`),
        department: job.categories?.department ?? null,
        team: job.categories?.team ?? null,
        employment_type: job.categories?.commitment ?? null,
        posted_at: iso(job.createdAt),
        updated_at: iso(job.updatedAt ?? job.createdAt),
        ...salaryFields(`${job.text ?? ''} ${body}`),
        seniority: seniority(job.text ?? ''),
      }
    },
  },
}

function salaryFields(text) {
  const s = salary(text)
  return { salary_min: s.min, salary_max: s.max, salary_currency: s.currency }
}

// ----------------------------------------------------------------- fetch loop

async function fetchBoard(provider, token) {
  const spec = PROVIDERS[provider]
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(spec.url(token), {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': 'open-ats-feed (+https://github.com/veresk06/open-ats-feed)' },
      })
      if (res.status === 404 || res.status === 410) return []
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      if (!res.ok) return []
      const list = spec.list(await res.json())
      if (!list) return []
      return list.map((j) => spec.map(j, token)).filter((r) => r.title && r.job_id)
    } catch {
      if (attempt === 3) return []
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return []
}

async function runPool(items, worker) {
  let next = 0
  const out = []
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (true) {
        const i = next++
        if (i >= items.length) return
        out.push(...(await worker(items[i])))
      }
    }),
  )
  return out
}

async function main() {
  const tokens = JSON.parse(await readFile(TOKENS, 'utf8'))
  const jobs = []
  const stats = {}

  for (const provider of Object.keys(PROVIDERS)) {
    const list = (tokens[provider] ?? []).slice(0, LIMIT)
    if (!list.length) continue
    process.stderr.write(`${provider}: fetching ${list.length} boards\n`)
    const rows = await runPool(list, (t) => fetchBoard(provider, t))
    const kept = SINCE
      ? rows.filter((r) => r.updated_at && new Date(r.updated_at) >= SINCE)
      : rows
    stats[provider] = { boards: list.length, postings: rows.length, afterSince: kept.length }
    jobs.push(...kept)
  }

  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, jobs.map((j) => JSON.stringify(j)).join('\n') + '\n')

  const withSalary = jobs.filter((j) => j.salary_min !== null).length
  const remote = jobs.filter((j) => j.workplace === 'remote').length
  console.log(JSON.stringify(
    {
      ...stats,
      total: jobs.length,
      since: SINCE ? SINCE.toISOString() : null,
      enrichment: {
        withSalary,
        salaryCoverage: jobs.length ? +(withSalary / jobs.length).toFixed(3) : 0,
        remote,
        remoteShare: jobs.length ? +(remote / jobs.length).toFixed(3) : 0,
      },
      out: OUT,
    },
    null,
    2,
  ))
}

await main()
