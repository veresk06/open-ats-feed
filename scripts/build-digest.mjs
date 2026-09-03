// Build a dated public hiring digest from live ATS boards.
//
//   node scripts/build-digest.mjs [--greenhouse 400] [--ashby 300] [--lever 120] [--date YYYY-MM-DD]
//
// Writes digests/<date>.md (for humans) and digests/<date>.json (every number in
// the markdown, so a reader can recompute rather than trust). Both are committed.
//
// The sample is deterministic: the N largest boards per provider, in the order
// they appear in the committed company index, which is sorted by open postings.
// That is a stated bias, not a hidden one — it is repeated verbatim in the
// digest's own Limits section. Nothing here is projected to the full index.

import { mkdir, readFile, writeFile } from 'node:fs/promises'

import { PROVIDERS } from '../actor/src/normalize.js'
import {
  companySignal,
  techIn,
  RAMP_MIN_OPENED_30D,
  RAMP_MIN_RATIO,
  NEW_BOARD_DAYS,
  NEW_FUNCTION_DAYS,
} from '../actor/src/signals.js'

const DAY = 86_400_000
const UA = 'open-ats-feed digest (+https://github.com/veresk06/open-ats-feed)'
const WIDTH = { greenhouse: 8, ashby: 3 }

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const limits = {
  greenhouse: Number(arg('greenhouse', 300)),
  ashby: Number(arg('ashby', 250)),
  lever: Number(arg('lever', 100)),
}
const now = Date.now()
const date = arg('date', new Date(now).toISOString().slice(0, 10))
const fetched_at = new Date(now).toISOString()

const index = JSON.parse(await readFile(new URL('../actor/data/companies.json', import.meta.url), 'utf8'))

// The same four-attempt backoff the Actor uses (actor/src/main.js), and for the
// same reason. The first draft of this script fetched once and treated any
// failure as "no postings": at Ashby's configured width of 12 the host reset 19
// connections in 20, and the digest duly reported 101 live boards out of 650.
// A refused connection is instrument state, not a verdict about the company, and
// publishing it as one would have been the worst kind of wrong number — the kind
// that looks like a finding.
async function board(provider, token) {
  const spec = PROVIDERS[provider]
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(spec.url(token), {
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': UA, accept: 'application/json' },
      })
      if (res.status === 404 || res.status === 410) return { token, ok: false, why: 'gone' }
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        if (attempt === 3) return { token, ok: false, why: `http ${res.status}` }
        await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt))
        continue
      }
      if (!res.ok) return { token, ok: false, why: `http ${res.status}` }
      const list = spec.list(await res.json())
      if (!list) return { token, ok: false, why: 'unparseable' }
      return { token, ok: true, rows: list.map((j) => spec.map(j, token)).filter((r) => r.title && r.job_id) }
    } catch (err) {
      if (attempt === 3) return { token, ok: false, why: String(err?.cause?.code ?? err?.message ?? err) }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt))
    }
  }
  return { token, ok: false, why: 'refused after retries' }
}

// Per-posting tallies, kept as counters so no board's descriptions stay in memory.
// label -> { d30, prior60, companies }. The company set is the guard against a
// single employer's boilerplate becoming a market trend: one fintech board
// repeated the phrase "third-party rails" across 359 of its 3,080 postings, which
// was enough on its own to top the climbing table. Postings say how much; companies
// say how widely, and only the second is a market statement.
const tech = new Map()
const seniorityCount = new Map()
const workplaceCount = new Map()
const stats = { attempted: 0, responded: 0, withPostings: 0, postings: 0, dated: 0, opened7: 0, opened30: 0 }
const failures = new Map() // why -> count, reported in the digest rather than hidden
const signals = []

function tally(rows, company) {
  for (const r of rows) {
    stats.postings++
    const at = r.posted_at ? Date.parse(r.posted_at) : NaN
    if (!Number.isFinite(at)) continue
    stats.dated++
    const age = now - at
    const recent = age <= 30 * DAY
    const prior = age > 30 * DAY && age <= 90 * DAY
    if (age <= 7 * DAY) stats.opened7++
    if (recent) {
      stats.opened30++
      seniorityCount.set(r.seniority, (seniorityCount.get(r.seniority) ?? 0) + 1)
      workplaceCount.set(r.workplace, (workplaceCount.get(r.workplace) ?? 0) + 1)
    }
    if (!recent && !prior) continue
    const where = `${r.title ?? ''} ${r.team ?? ''} ${r.department ?? ''}`
    for (const t of techIn(`${where} ${r.description ?? ''}`, where)) {
      const cur = tech.get(t) ?? { d30: 0, prior60: 0, companies: new Set() }
      if (recent) {
        cur.d30++
        cur.companies.add(company)
      } else cur.prior60++
      tech.set(t, cur)
    }
  }
}

async function run(provider) {
  const spec = PROVIDERS[provider]
  const tokens = index.providers[provider].live.slice(0, limits[provider]).map(([t]) => t)
  // Measured today, 20 boards each: Greenhouse answered 20/20 at width 8, Ashby
  // answered 1/20 and reset the other 19. The Actor gets away with a wider pool
  // because it runs from a datacentre IP against a smaller board list; this
  // script runs from one machine and Ashby throttles it by dropping connections
  // rather than returning 429. Retries cover the rest.
  const width = spec.delayMs ? 1 : (WIDTH[provider] ?? Math.min(spec.concurrency ?? 8, 8))
  let cursor = 0
  async function worker() {
    while (cursor < tokens.length) {
      const token = tokens[cursor++]
      stats.attempted++
      let out
      try {
        out = await board(provider, token)
      } catch (err) {
        out = { ok: false, why: String(err?.message ?? err) }
      }
      if (!out.ok) failures.set(out.why, (failures.get(out.why) ?? 0) + 1)
      if (out.ok) {
        stats.responded++
        if (out.rows.length) {
          stats.withPostings++
          tally(out.rows, token)
          const s = companySignal(out.rows, {
            provider,
            token,
            company_url: out.rows[0].company_url,
            index_as_of: index.as_of,
            fetched_at,
            now,
          })
          if (s) signals.push(s)
        }
      }
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs))
      if (stats.attempted % 50 === 0) process.stderr.write(`  ${stats.attempted} boards…\n`)
    }
  }
  await Promise.all(Array.from({ length: width }, worker))
}

for (const provider of ['greenhouse', 'ashby', 'lever']) {
  process.stderr.write(`${provider}: ${limits[provider]} boards\n`)
  await run(provider)
}

// ---------- aggregate ----------

const byCount = (a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))

// The ratio's denominator is built from postings that are STILL OPEN today, and a
// posting that is 80 days old has had far longer to be filled than one that is 10
// days old. So every ramp ratio is an upper bound, and a ratio computed against a
// baseline of two or three surviving postings is mostly an artifact of that decay
// — the first run of this digest put a company at 237x on a baseline of 2.5. The
// digest therefore requires a baseline with enough left in it to divide by. The
// Actor's own classifier is unchanged; this is a publication threshold.
const RAMP_MIN_BASELINE = 5

const ramping = signals
  .filter((s) => s.signal === 'ramping' && s.opened_30d >= 10 && s.baseline_30d >= RAMP_MIN_BASELINE)
  .sort((a, b) => (b.ramp_ratio ?? 0) - (a.ramp_ratio ?? 0) || b.opened_30d - a.opened_30d)
  .slice(0, 20)

const newBoards = signals
  .filter((s) => s.signal === 'new_board')
  .sort((a, b) => b.open_postings - a.open_postings)
  .slice(0, 15)

const newFunctions = signals
  .filter((s) => s.new_functions.length)
  .sort((a, b) => b.new_functions[0].count - a.new_functions[0].count)
  .slice(0, 20)

const execs = signals
  .filter((s) => s.executive_openings_90d > 0)
  .sort((a, b) => b.executive_openings_90d - a.executive_openings_90d)
  .slice(0, 15)

const TECH_MIN_COMPANIES = 5

const techRows = [...tech.entries()]
  .map(([name, v]) => ({
    name,
    d30: v.d30,
    companies: v.companies.size,
    baseline30: v.prior60 / 2,
    ratio: v.prior60 ? Math.round((v.d30 / (v.prior60 / 2)) * 100) / 100 : null,
  }))
  .filter((t) => t.d30 >= 20 && t.companies >= TECH_MIN_COMPANIES)
  .sort((a, b) => b.companies - a.companies || b.d30 - a.d30)
  .slice(0, 25)

// Ranked by how many companies are hiring for it, not by how many postings say
// the word, for the reason recorded on the `tech` map above.
const climbing = techRows
  .filter((t) => t.ratio !== null && t.baseline30 >= 10)
  .sort((a, b) => b.ratio - a.ratio)
  .slice(0, 10)

const breakdown = {}
for (const s of signals) breakdown[s.signal] = (breakdown[s.signal] ?? 0) + 1

const payload = {
  date,
  generated_at: fetched_at,
  generator: 'scripts/build-digest.mjs',
  command: `node scripts/build-digest.mjs --greenhouse ${limits.greenhouse} --ashby ${limits.ashby} --lever ${limits.lever} --date ${date}`,
  index_as_of: index.as_of,
  sample: { rule: 'the N largest boards per provider, in company-index order (sorted by open postings)', limits },
  thresholds: {
    ramping: `>= ${RAMP_MIN_OPENED_30D} roles opened in 30 days AND >= ${RAMP_MIN_RATIO}x the company's own prior 60-day pace`,
    new_board: `no posting older than ${NEW_BOARD_DAYS} days`,
    new_function: `a department whose every posting is newer than ${NEW_FUNCTION_DAYS} days, on a board with <= 25 departments`,
    digest_ramping_floor: `this digest additionally requires >= 10 roles opened in 30 days and a surviving baseline of >= ${RAMP_MIN_BASELINE} before listing a ramp`,
  },
  stats,
  boards_not_read: Object.fromEntries([...failures.entries()].sort(byCount)),
  signal_breakdown: breakdown,
  ramping,
  new_boards: newBoards,
  new_functions: newFunctions,
  executive_openings: execs,
  technology: techRows,
  technology_climbing: climbing,
  seniority_30d: Object.fromEntries([...seniorityCount.entries()].sort(byCount)),
  workplace_30d: Object.fromEntries([...workplaceCount.entries()].sort(byCount)),
}

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) : '0.0')
const md = []
const w = (s = '') => md.push(s)

w(`# Hiring digest — ${date}`)
w()
w(
  `Every number below was counted from live ATS boards on ${date}, by ` +
    `[\`scripts/build-digest.mjs\`](../scripts/build-digest.mjs), against the public job APIs of ` +
    `Greenhouse, Ashby and Lever. Nothing is projected, estimated or back-filled. The raw rows are ` +
    `in [\`${date}.json\`](./${date}.json) — recompute anything you doubt.`,
)
w()
w(`\`\`\`\n${payload.command}\n\`\`\``)
w()
w('## The run')
w()
w('| | |')
w('|---|---:|')
w(`| Boards requested | ${stats.attempted} |`)
w(`| Boards that answered | ${stats.responded} |`)
w(`| Boards with at least one open posting | ${stats.withPostings} |`)
w(`| Open postings read | ${stats.postings.toLocaleString('en-US')} |`)
w(`| …carrying a publication date | ${stats.dated.toLocaleString('en-US')} (${pct(stats.dated, stats.postings)}%) |`)
w(`| Roles opened in the last 7 days | ${stats.opened7.toLocaleString('en-US')} |`)
w(`| Roles opened in the last 30 days | ${stats.opened30.toLocaleString('en-US')} |`)
w()
if (failures.size) {
  w(
    `${stats.attempted - stats.responded} boards were not read and are simply absent from ` +
      `everything below, after four attempts each with backoff: ` +
      [...failures.entries()]
        .sort(byCount)
        .map(([why, n]) => `${n} × \`${why}\``)
        .join(', ') +
      '. A board we could not read is an instrument failure, not a company that stopped hiring.',
  )
  w()
}
w(
  `Company classification across the ${signals.length} boards with postings: ` +
    Object.entries(breakdown)
      .sort(byCount)
      .map(([k, v]) => `**${k}** ${v}`)
      .join(', ') +
    '.',
)
w()

w('## Companies ramping hardest')
w()
w(
  `A company is *ramping* when it opened at least ${RAMP_MIN_OPENED_30D} roles in the last 30 days ` +
    `at ${RAMP_MIN_RATIO}x or more of its own prior 60-day pace. The comparison is always against ` +
    `that company's own history, never against a peer group — a 40-person startup and a 40,000-person ` +
    `retailer are not on the same scale and pretending otherwise is where this kind of table usually ` +
    `goes wrong. This list additionally requires 10 roles in 30 days and a surviving baseline of at ` +
    `least ${RAMP_MIN_BASELINE}, so a board cannot top it on a ratio built from three postings.`,
)
w()
w(
  `**Read the ordering, not the multiple.** The baseline can only be counted from postings that are ` +
    `still open, and an 80-day-old posting has had far longer to be filled than a 10-day-old one. That ` +
    `decay is invisible from a single run and it inflates every ratio here, so each one is an upper ` +
    `bound rather than a measurement. It is stated here rather than in a footnote because it is the ` +
    `weakest number in this document.`,
)
w()
w('| Company | Open | 30d | Own baseline | Ramp | Named technology |')
w('|---|---:|---:|---:|---:|---|')
for (const s of ramping) {
  w(
    `| [${s.company}](${s.company_url}) | ${s.open_postings} | ${s.opened_30d} | ${s.baseline_30d} | ` +
      `**${s.ramp_ratio ?? '—'}x** | ${s.tech_signals.slice(0, 4).map((t) => t.name).join(', ') || '—'} |`,
  )
}
w()

if (newBoards.length) {
  w('## Boards that did not exist 60 days ago')
  w()
  w(
    `No posting on these boards is older than ${NEW_BOARD_DAYS} days. Either the company just started ` +
      `hiring publicly, or it just moved onto this ATS. Both are worth a sales team's attention and ` +
      `neither is visible from a job aggregator that only shows you titles.`,
  )
  w()
  w('| Company | Open postings | Oldest posting | Named technology |')
  w('|---|---:|---|---|')
  for (const s of newBoards) {
    w(
      `| [${s.company}](${s.company_url}) | ${s.open_postings} | ${(s.oldest_posting_at ?? '').slice(0, 10)} | ` +
        `${s.tech_signals.slice(0, 4).map((t) => t.name).join(', ') || '—'} |`,
    )
  }
  w()
}

if (newFunctions.length) {
  w('## Functions opened from scratch')
  w()
  w(
    `A department where *every* open role was posted in the last ${NEW_FUNCTION_DAYS} days, at a company ` +
      `whose board is older than that. This is the "they just stood up a sales team" signal. Boards that ` +
      `use the department field as a site code — enterprise ATS setups routinely carry 100+ of them — are ` +
      `excluded entirely, because there a new department is a new office, not a new function.`,
  )
  w()
  w('| Company | Function opened | Roles |')
  w('|---|---|---:|')
  for (const s of newFunctions) {
    for (const f of s.new_functions.slice(0, 2)) w(`| [${s.company}](${s.company_url}) | ${f.name} | ${f.count} |`)
  }
  w()
}

w('## What is being staffed')
w()
w(
  `Technology named in postings opened in the last 30 days, counted by keyword against the title, ` +
    `department, team and full description. The baseline column is the same count over the preceding ` +
    `60 days, normalised to a 30-day rate. Ambiguous acronyms only count inside a posting that reads as ` +
    `a technical one — on a home-care board \`dbt\` is Dialectical Behavior Therapy and \`PHP\` is Partial ` +
    `Hospitalization Program, which is exactly the class of error this column would otherwise be full of.`,
)
w()
w(
  `**The table is ordered by companies, not postings, and that is the whole point of the first column.** ` +
    `A single employer repeating one sentence across a thousand job descriptions can put a technology at ` +
    `the top of a posting count while telling you nothing about the market: one fintech board's boilerplate ` +
    `phrase "third-party rails" appeared in 359 of its 3,080 postings and was, by itself, enough to make ` +
    `Ruby on Rails the fastest-climbing technology in the first draft of this document. It is not in the ` +
    `list at all now — bare "rails" was removed as a keyword, because on a construction board it is a ` +
    `safety rail. Only terms named by at least ${TECH_MIN_COMPANIES} distinct companies appear here.`,
)
w()
w('| Technology | Companies | Postings, 30d | Baseline 30d | Ratio |')
w('|---|---:|---:|---:|---:|')
for (const t of techRows) {
  w(`| ${t.name} | ${t.companies} | ${t.d30} | ${t.baseline30} | ${t.ratio === null ? '—' : `${t.ratio}x`} |`)
}
w()
if (climbing.length) {
  w(
    'Climbing fastest against their own prior pace: ' +
      climbing.map((t) => `**${t.name}** ${t.ratio}x`).join(', ') +
      '.',
  )
  w()
}

if (execs.length) {
  w('## Executive openings')
  w()
  w(
    'Roles opened in the last 90 days whose title contains a head-of / director / VP / chief marker. ' +
      'A cluster of them at one company is a reorganisation, and it usually precedes a budget.',
  )
  w()
  w('| Company | Executive roles, 90d | Open postings |')
  w('|---|---:|---:|')
  for (const s of execs) w(`| [${s.company}](${s.company_url}) | ${s.executive_openings_90d} | ${s.open_postings} |`)
  w()
}

w('## Seniority and workplace, last 30 days')
w()
w(
  Object.entries(payload.seniority_30d)
    .map(([k, v]) => `**${k}** ${v} (${pct(v, stats.opened30)}%)`)
    .join(' · '),
)
w()
w(
  Object.entries(payload.workplace_30d)
    .map(([k, v]) => `**${k}** ${v} (${pct(v, stats.opened30)}%)`)
    .join(' · '),
)
w()

w('## Limits')
w()
w(
  `- **The sample is the largest boards, not a random one.** It is the top ${limits.greenhouse} Greenhouse, ` +
    `${limits.ashby} Ashby and ${limits.lever} Lever boards by open postings from a company index of ` +
    `${(index.providers.greenhouse.live.length + index.providers.ashby.live.length + index.providers.lever.live.length).toLocaleString('en-US')} ` +
    `live boards. Large employers are over-represented by construction. Nothing here is scaled up to the full index.`,
)
w(
  '- **A closed role is invisible, and that biases the ramp column upward.** Everything above is computed ' +
    'from publication dates on postings that are open today, so it can show hiring starting and cannot ' +
    'show hiring stopping. It also means the further back a comparison window reaches, the more of it has ' +
    'already been filled and deleted — so a company posting at a perfectly flat rate still reads as a mild ' +
    'ramp. Counts of roles opened are direct measurements; ratios against a baseline are not. A separate ' +
    'daily snapshot series, started 2026-09-03, is what will eventually correct this, and it is the one ' +
    'thing here that cannot be back-dated.',
)
w(
  '- **Seniority is inferred from the title,** not published by the company. Technology is a keyword match, ' +
    'not a stated requirement. Both are stated conservatively; neither is a fact the employer asserted.',
)
w(
  '- **Three ATS vendors, public endpoints only.** Companies hiring through Workday, Taleo, SuccessFactors ' +
    'or their own site are simply absent — not underweighted, absent.',
)
w()
w(
  `Generated from [open-ats-feed](https://github.com/veresk06/open-ats-feed). The same classifier runs as ` +
    `an Apify Actor over the whole index: [open-ats-jobs-feed](https://apify.com/sharp_malachite/open-ats-jobs-feed), ` +
    `\`outputMode: "signals"\`.`,
)
w()

const dir = new URL('../digests/', import.meta.url)
await mkdir(dir, { recursive: true })
await writeFile(new URL(`${date}.json`, dir), `${JSON.stringify(payload, null, 2)}\n`)
await writeFile(new URL(`${date}.md`, dir), `${md.join('\n')}`)
process.stderr.write(
  `\nwrote digests/${date}.md and digests/${date}.json — ${stats.withPostings} boards, ` +
    `${stats.postings} postings, ${ramping.length} ramps, ${newFunctions.length} new functions\n`,
)
