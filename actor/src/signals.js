// Company-level hiring signals, derived from one board's open postings.
//
// The point of this file is a fact that was sitting in the data the whole time:
// all three vendors publish a per-posting creation date, and normalize.js already
// maps it to `posted_at`. So "this company is ramping", "this company just opened
// a sales function" and "this company is hiring for Snowflake" are computable from
// a SINGLE run — no accumulated history, nothing to back-date, nothing to wait for.
//
// What posting dates cannot show is a posting that went away or a board that went
// dark. That is what the daily snapshot series is for, and it is why the series
// keeps running rather than being replaced by this.
//
// Everything here is a pure function of one company's rows so it can be tested
// without the platform.

const DAY = 86_400_000

// Some acronyms belong to another industry entirely. Measured on BAYADA's live
// board, a home-care company: `dbt` matched Dialectical Behavior Therapy and
// `PHP` matched Partial Hospitalization Program, and the first draft of this file
// duly reported that a nursing agency was hiring for a data stack. Terms flagged
// `guarded` below only count when the posting also reads as a technical one.
const TECH_CONTEXT =
  /\b(engineer|engineering|developer|software|programmer|architect|devops|sre|technolog|technical|data|analytics|scientist|backend|frontend|full[- ]?stack|platform|infrastructure)\b/i

// Word-boundary matches only, and deliberately conservative: an ambiguous term
// produces a wrong signal, and a wrong signal is worse than a missing one for
// exactly the buyer who would pay for this. "Go" is not in the list because
// "go-to-market" is a job title; Golang is. "R" and "C" are out for the same
// reason. Each entry is [label, pattern, guarded].
const TECH = [
  ['Python', /\bpython\b/i],
  ['JavaScript', /\bjavascript\b/i],
  ['TypeScript', /\btypescript\b/i],
  ['React', /\breact(?:\.js)?\b/i, true],
  ['Vue', /\bvue(?:\.js)?\b/i],
  ['Angular', /\bangular\b/i],
  ['Svelte', /\bsvelte(?:kit)?\b/i],
  ['Node.js', /\bnode\.?js\b/i],
  ['Rust', /\brust\b/i, true],
  ['Golang', /\b(?:golang|go lang)\b/i],
  ['Java', /\bjava\b(?!script)/i],
  ['Kotlin', /\bkotlin\b/i],
  ['Swift', /\bswift(?:ui)?\b/i, true],
  ['Scala', /\bscala\b/i],
  ['Ruby', /\bruby\b/i, true],
  ['Rails', /\b(?:ruby on rails|rails)\b/i],
  ['PHP', /\bphp\b/i, true],
  ['Laravel', /\blaravel\b/i],
  ['Django', /\bdjango\b/i],
  ['Spring', /\bspring boot\b/i],
  ['.NET', /(?:\.net\b|\bdotnet\b)/i],
  ['C#', /\bc#|\bc sharp\b/i],
  ['C++', /\bc\+\+/i],
  ['Elixir', /\belixir\b/i, true],
  ['Terraform', /\bterraform\b/i],
  ['Kubernetes', /\b(?:kubernetes|k8s)\b/i],
  ['Docker', /\bdocker\b/i],
  ['AWS', /\b(?:aws|amazon web services)\b/i],
  ['GCP', /\b(?:gcp|google cloud)\b/i],
  ['Azure', /\bazure\b/i],
  ['Snowflake', /\bsnowflake\b/i],
  ['Databricks', /\bdatabricks\b/i],
  ['dbt', /\bdbt\b/, true],
  ['Airflow', /\bairflow\b/i],
  ['Kafka', /\bkafka\b/i],
  ['Spark', /\b(?:apache )?spark\b/i, true],
  ['PostgreSQL', /\b(?:postgres(?:ql)?)\b/i],
  ['MySQL', /\bmysql\b/i],
  ['MongoDB', /\bmongo(?:db)?\b/i],
  ['Redis', /\bredis\b/i],
  ['Elasticsearch', /\b(?:elasticsearch|opensearch)\b/i],
  ['GraphQL', /\bgraphql\b/i],
  ['Salesforce', /\bsalesforce\b/i],
  ['HubSpot', /\bhubspot\b/i],
  ['SAP', /\bsap\b/i, true],
  ['ServiceNow', /\bservicenow\b/i],
  ['Workday', /\bworkday\b/i],
  ['NetSuite', /\bnetsuite\b/i],
  ['Tableau', /\btableau\b/i],
  ['Looker', /\blooker\b/i],
  ['Power BI', /\bpower ?bi\b/i],
  ['PyTorch', /\bpytorch\b/i],
  ['TensorFlow', /\btensorflow\b/i],
  ['LLM', /\b(?:llm|large language model)s?\b/i],
  ['RAG', /\brag\b/i, true],
  ['LangChain', /\blangchain\b/i],
  ['CUDA', /\bcuda\b/i],
  ['Solidity', /\bsolidity\b/i],
  ['Unity', /\bunity\b/i, true],
  ['Unreal', /\bunreal engine\b/i],
  ['Figma', /\bfigma\b/i],
  ['Shopify', /\bshopify\b/i],
  ['Stripe', /\bstripe\b/i],
  ['Twilio', /\btwilio\b/i],
]

// Thresholds. Stated here rather than inlined because a buyer is entitled to know
// what "ramping" means, and the README quotes these numbers.
export const RAMP_MIN_OPENED_30D = 3 // below this, ratios are noise
export const RAMP_MIN_RATIO = 2 // last 30 days at 2x the prior 60-day pace
export const NEW_BOARD_DAYS = 60 // no posting older than this = the board is new
export const NEW_FUNCTION_DAYS = 45 // a department whose every posting is this recent
export const NEW_FUNCTION_MIN_HISTORY = 5 // …at a company with at least this many dated postings
export const NEW_FUNCTION_MIN_ROLES = 2 // …and at least this many roles in the department itself
// Above this many distinct departments, the field is not a function. Measured on
// live boards: BAYADA carries ~200 ("Baltimore Visits (BV) - 94"), SpaceX ~70
// ("Raptor Turbomachinery"), Anduril ~130 org paths. On a board like that we
// cannot tell a new function from a new site or a new sub-team, so we say
// nothing. The first draft of this file reported 190 "newly opened functions"
// for one home-care company, which is not a signal, it is a directory.
export const NEW_FUNCTION_MAX_DEPARTMENTS = 25

function within(rows, now, fromDays, toDays = 0) {
  const lo = now - fromDays * DAY
  const hi = now - toDays * DAY
  return rows.filter((r) => r.at > lo && r.at <= hi).length
}

function topCounts(pairs, limit) {
  const counts = new Map()
  for (const key of pairs) {
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }))
}

export function techIn(text) {
  const found = []
  const technical = TECH_CONTEXT.test(text)
  for (const [label, re, guarded] of TECH) {
    if (guarded && !technical) continue
    if (re.test(text)) found.push(label)
  }
  return found
}

// Departments that exist only in the last NEW_FUNCTION_DAYS at a company that has
// been posting for longer than that. This is the "they just opened a sales
// function" signal, and it is only meaningful when there is enough history on the
// board to tell a new function from a new company.
function newFunctions(dated, now) {
  const byDept = new Map()
  for (const r of dated) {
    if (!r.department) continue
    const cur = byDept.get(r.department)
    if (!cur || r.at < cur.oldest) byDept.set(r.department, { oldest: r.at, count: (cur?.count ?? 0) + 1 })
    else byDept.set(r.department, { ...cur, count: cur.count + 1 })
  }
  const cutoff = now - NEW_FUNCTION_DAYS * DAY
  const companyOldest = Math.min(...dated.map((r) => r.at))
  if (dated.length < NEW_FUNCTION_MIN_HISTORY || companyOldest > cutoff) return []
  if (byDept.size > NEW_FUNCTION_MAX_DEPARTMENTS) return []
  return [...byDept.entries()]
    .filter(([, v]) => v.oldest > cutoff && v.count >= NEW_FUNCTION_MIN_ROLES)
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([name, v]) => ({ name, count: v.count }))
}

/**
 * One signal record for one company board.
 *
 * @param rows postings for a single company, already normalised and already
 *   filtered by the run's own keyword/location/etc. filters
 * @param meta { provider, token, company_url, index_as_of, fetched_at, now }
 * @returns the record, or null when the board has nothing open
 */
export function companySignal(rows, meta) {
  if (!rows.length) return null
  const now = meta.now ?? Date.now()

  const dated = rows
    .map((r) => ({ ...r, at: r.posted_at ? Date.parse(r.posted_at) : NaN }))
    .filter((r) => Number.isFinite(r.at))

  const opened7 = within(dated, now, 7)
  const opened30 = within(dated, now, 30)
  const opened90 = within(dated, now, 90)
  // The comparison window is the 60 days *before* the last 30, normalised to a
  // 30-day rate. Comparing the last 30 days against a baseline that contains the
  // last 30 days would flatten every ramp it is supposed to find.
  const prior = within(dated, now, 90, 30)
  const baseline30 = prior / 2
  const rampRatio = baseline30 > 0 ? Math.round((opened30 / baseline30) * 100) / 100 : null

  const oldest = dated.length ? Math.min(...dated.map((r) => r.at)) : null
  const newest = dated.length ? Math.max(...dated.map((r) => r.at)) : null
  const isNewBoard = oldest !== null && oldest > now - NEW_BOARD_DAYS * DAY

  let signal
  if (!dated.length) signal = 'undated'
  else if (isNewBoard) signal = 'new_board'
  else if (opened30 >= RAMP_MIN_OPENED_30D && (rampRatio === null || rampRatio >= RAMP_MIN_RATIO)) signal = 'ramping'
  else if (opened30 > 0) signal = 'steady'
  else signal = 'quiet'

  const recent = dated.filter((r) => r.at > now - 90 * DAY)
  const techCounts = new Map()
  for (const r of recent) {
    const hay = `${r.title ?? ''} ${r.team ?? ''} ${r.department ?? ''} ${r.description ?? ''}`
    for (const t of techIn(hay)) techCounts.set(t, (techCounts.get(t) ?? 0) + 1)
  }

  const withSalary = rows.filter((r) => r.salary_min !== null && r.salary_min !== undefined).length
  const remote = rows.filter((r) => r.workplace === 'remote').length

  return {
    record_type: 'company_signal',
    source: meta.provider,
    company: meta.token,
    company_url: meta.company_url,

    signal,
    open_postings: rows.length,
    postings_dated: dated.length,
    opened_7d: opened7,
    opened_30d: opened30,
    opened_90d: opened90,
    baseline_30d: Math.round(baseline30 * 100) / 100,
    ramp_ratio: rampRatio,

    new_functions: newFunctions(dated, now),
    top_departments: topCounts(
      rows.map((r) => r.department),
      5,
    ),
    top_titles: topCounts(
      rows.map((r) => r.title),
      5,
    ),
    tech_signals: [...techCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 12)
      .map(([name, count]) => ({ name, count })),
    executive_openings_90d: recent.filter((r) => r.seniority === 'executive').length,

    remote_postings: remote,
    postings_with_salary: withSalary,
    oldest_posting_at: oldest === null ? null : new Date(oldest).toISOString(),
    newest_posting_at: newest === null ? null : new Date(newest).toISOString(),

    index_as_of: meta.index_as_of,
    fetched_at: meta.fetched_at,
  }
}
