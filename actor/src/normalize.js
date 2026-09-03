// One record shape across three ATS vendors.
//
// The vendors agree on almost nothing. Greenhouse has `location.name` and
// `updated_at`; Ashby has `location`, `workplaceType` and `publishedAt`; Lever has
// `categories.location` and `createdAt`. Reconciling that is the product — the
// company index only says which boards exist.

const SENIORITY = [
  [/\b(intern|internship|apprentice)\b/i, 'intern'],
  [/\b(principal|staff|distinguished|fellow)\b/i, 'principal'],
  [/\b(head of|director|vp|vice president|chief|cto|ceo|cfo)\b/i, 'executive'],
  [/\b(senior|sr\.?|lead|manager)\b/i, 'senior'],
  [/\b(junior|jr\.?|entry[- ]level|associate|graduate|new grad)\b/i, 'junior'],
]

export function seniority(title) {
  for (const [re, label] of SENIORITY) if (re.test(title)) return label
  return 'mid'
}

const REMOTE_RE = /\b(remote|work from home|wfh|distributed|anywhere)\b/i
const HYBRID_RE = /\bhybrid\b/i

// Where a vendor ships an explicit workplace enum it beats any string match on a
// location label. Do NOT use Ashby's `isRemote` boolean: it is true for Hybrid
// roles too (measured on Ramp's board — 110 postings tagged
// `workplaceType: "Hybrid", isRemote: true`, all located "New York, NY (HQ)").
// Trusting it classified two thirds of the feed as remote, wrong by ~3x.
const WORKPLACE_ENUM = { remote: 'remote', onsite: 'onsite', hybrid: 'hybrid' }

export function workplace(text, enumValue) {
  const explicit = WORKPLACE_ENUM[String(enumValue ?? '').toLowerCase()]
  if (explicit) return explicit
  if (HYBRID_RE.test(text)) return 'hybrid'
  if (REMOTE_RE.test(text)) return 'remote'
  return 'onsite'
}

const CURRENCY = { $: 'USD', '£': 'GBP', '€': 'EUR', 'C$': 'CAD', 'A$': 'AUD' }

// Salary ranges live in free text, in wildly inconsistent forms:
//   "$150,000 - $200,000"   "£70k–£90k"   "120000-160000 USD"   "€80.000 - €100.000"
// Anything not confidently a range is left null rather than guessed at. A wrong
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
  const n = Number(s.replace(/[,.\s]/g, ''))
  return Number.isFinite(n) ? n : null
}

export function salary(text) {
  if (!text) return { min: null, max: null, currency: null }
  SALARY_RE.lastIndex = 0
  let best = null
  let m
  while ((m = SALARY_RE.exec(text)) !== null) {
    const min = parseAmount(m[2])
    const max = parseAmount(m[4])
    if (min === null || max === null) continue
    // Reject ranges that are obviously not annual compensation: years, headcounts,
    // equity share counts, hourly rates below a plausible floor.
    if (min < 10_000 || max <= min || max > 10_000_000) continue
    if (!best || max - min > best.max - best.min) {
      best = { min, max, currency: CURRENCY[m[1] ?? m[3]] ?? null }
    }
  }
  return best ?? { min: null, max: null, currency: null }
}

function salaryFields(text) {
  const s = salary(text)
  return { salary_min: s.min, salary_max: s.max, salary_currency: s.currency }
}

export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

// Greenhouse URI-encodes `content`, but not reliably: a description containing a
// literal "%" (a "100% remote" bullet, a discount, a CSS width) makes
// decodeURIComponent throw URIError and, before this guard existed, took the whole
// board down with it — 2 of the first 3 boards tested. Fall back to the raw string.
function decodeMaybe(s) {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function iso(v) {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export const PROVIDERS = {
  greenhouse: {
    url: (t) => `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(t)}/jobs?content=true`,
    list: (j) => (Array.isArray(j?.jobs) ? j.jobs : null),
    // boards-api.greenhouse.io/robots.txt: "Disallow: /embed/". We fetch /v1/boards/.
    concurrency: 12,
    delayMs: 0,
    map: (job, token) => {
      const body = stripHtml(decodeMaybe(job.content ?? ''))
      const loc = job.location?.name ?? ''
      return {
        source: 'greenhouse',
        company: token,
        company_url: `https://job-boards.greenhouse.io/${token}`,
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
        description: body || null,
      }
    },
  },
  ashby: {
    url: (t) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(t)}?includeCompensation=true`,
    list: (j) => (Array.isArray(j?.jobs) ? j.jobs : null),
    // api.ashbyhq.com/robots.txt returns 401 — nothing stated, no restriction.
    concurrency: 12,
    delayMs: 0,
    map: (job, token) => {
      const body = stripHtml(job.descriptionPlain ?? job.descriptionHtml ?? '')
      const loc = job.location ?? ''
      return {
        source: 'ashby',
        company: token,
        company_url: `https://jobs.ashbyhq.com/${token}`,
        job_id: String(job.id),
        title: (job.title ?? '').trim(),
        url: job.jobUrl ?? job.applyUrl ?? null,
        location: loc || null,
        workplace: workplace(`${loc} ${job.workplaceType ?? ''}`, job.workplaceType),
        department: job.department ?? null,
        team: job.team ?? null,
        employment_type: job.employmentType ?? null,
        posted_at: iso(job.publishedAt),
        updated_at: iso(job.updatedAt ?? job.publishedAt),
        ...salaryFields(`${job.title ?? ''} ${job.compensation?.compensationTierSummary ?? ''} ${body}`),
        seniority: seniority(job.title ?? ''),
        description: body || null,
      }
    },
  },
  lever: {
    url: (t) => `https://api.lever.co/v0/postings/${encodeURIComponent(t)}?mode=json`,
    list: (j) => (Array.isArray(j) ? j : null),
    // api.lever.co/robots.txt: "Allow: /" with "Crawl-delay: 1". Honoured below —
    // one request per second, single connection. This is why Lever runs are slow
    // and why maxCompanies matters more for Lever than for the other two.
    concurrency: 1,
    delayMs: 1000,
    map: (job, token) => {
      const body = stripHtml(job.descriptionPlain ?? job.description ?? '')
      const loc = job.categories?.location ?? ''
      return {
        source: 'lever',
        company: token,
        company_url: `https://jobs.lever.co/${token}`,
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
        description: body || null,
      }
    },
  },
  workable: {
    url: (t) =>
      `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(t)}?details=true`,
    // Without `details=true` the account resolves but `jobs` comes back empty, which
    // reads identically to a board with nothing open. The flag is not optional.
    list: (j) => (Array.isArray(j?.jobs) ? j.jobs : null),
    // apply.workable.com/robots.txt: "User-agent: * / Disallow:" — an empty Disallow,
    // i.e. everything allowed — plus "Content-Signal: search=yes, ai-input=yes,
    // ai-train=no". We index and redistribute postings and do not train on them.
    concurrency: 12,
    delayMs: 0,
    map: (job, token) => {
      const body = stripHtml(job.description ?? '')
      const loc = [job.city, job.state, job.country].map((s) => (s ?? '').trim())
        .filter(Boolean).join(', ')
      const label = `${loc} ${job.title ?? ''}`
      // `telecommuting` is trusted where Ashby's `isRemote` is not, and the difference
      // was measured rather than assumed: across 590 sampled postings it was true on
      // 8.0% and overlapped a "hybrid" location or title exactly 0 times. Ashby's flag
      // was true for Hybrid roles too, which is why it stays banned above. The text
      // fallback still runs first for anything labelled hybrid, so a future vendor
      // change degrades to the string match instead of mislabelling the feed.
      const remote = job.telecommuting === true && !HYBRID_RE.test(label)
      return {
        source: 'workable',
        company: token,
        company_url: `https://apply.workable.com/${token}/`,
        job_id: String(job.shortcode ?? job.id),
        title: (job.title ?? '').trim(),
        url: job.url ?? job.shortlink ?? job.application_url ?? null,
        location: loc || null,
        workplace: workplace(label, remote ? 'remote' : undefined),
        department: job.department || null,
        team: null,
        employment_type: job.employment_type ?? null,
        posted_at: iso(job.published_on ?? job.created_at),
        updated_at: iso(job.created_at ?? job.published_on),
        ...salaryFields(`${job.title ?? ''} ${body}`),
        // Deliberately still inferred from the title, though Workable ships an
        // `experience` field. Mixing a vendor enum into one provider and title
        // inference into the other three would make one column mean two different
        // things depending on the row it sits in. Uniform and documented beats
        // marginally richer and inconsistent.
        seniority: seniority(job.title ?? ''),
        description: body || null,
      }
    },
  },
  breezy: {
    url: (t) => `https://${encodeURIComponent(t)}.breezy.hr/json`,
    list: (j) => (Array.isArray(j) ? j : null),
    // {token}.breezy.hr/robots.txt: "User-Agent: * / Disallow: /css /fonts
    // /stylesheets /javascripts". /json is not disallowed. The marketing host
    // breezy.hr does carry "Disallow: /api/" — a different host, which we never call.
    concurrency: 8,
    delayMs: 0,
    map: (job, token) => {
      const loc = job.location?.name ?? [job.location?.city, job.location?.country?.name]
        .map((s) => (s ?? '').trim()).filter(Boolean).join(', ')
      // `location.is_remote` is deliberately NOT trusted. Ashby ships the same-looking
      // flag and it is true for Hybrid roles; believing it once mislabelled two thirds
      // of the feed. Workable's `telecommuting` earned its place by being measured
      // against 590 postings. Breezy's has not been measured, so this column comes from
      // the text until it has been. Promote it only with numbers behind it.
      return {
        source: 'breezy',
        company: token,
        company_url: `https://${token}.breezy.hr/`,
        job_id: String(job.id ?? job.friendly_id),
        title: (job.name ?? '').trim(),
        url: job.url ?? null,
        location: loc || null,
        workplace: workplace(`${loc} ${job.name ?? ''}`),
        department: job.department || null,
        team: null,
        employment_type: job.type?.name ?? null,
        posted_at: iso(job.published_date),
        updated_at: iso(job.published_date),
        // Breezy's board endpoint carries a `salary` string and no description at all —
        // the body lives behind a per-posting fetch we do not make. `description` is
        // therefore null for every Breezy row, which is honest; inventing one from the
        // title would put a different kind of value in a column that means "the posting".
        ...salaryFields(`${job.name ?? ''} ${job.salary ?? ''}`),
        seniority: seniority(job.name ?? ''),
        description: null,
      }
    },
  },
  recruitee: {
    url: (t) => `https://${encodeURIComponent(t)}.recruitee.com/api/offers/`,
    list: (j) => (Array.isArray(j?.offers) ? j.offers : null),
    // {token}.recruitee.com/robots.txt: "User-Agent: * / Disallow: /v/". `/api/offers/`
    // is not disallowed. Checked on a live tenant, not on the apex: the marketing host
    // recruitee.com serves a different file, and a non-existent tenant 301s away to
    // recruitee.com/careers_not_hosted, so reading robots.txt through a dead token
    // answers a question about the wrong host.
    concurrency: 8,
    delayMs: 0,
    map: (job, token) => {
      const loc = (job.location ?? [job.city, job.country_code]
        .map((s) => (s ?? '').trim()).filter(Boolean).join(', ')) || null
      // `remote` is a boolean and is deliberately NOT passed to workplace(). The rule
      // this codebase already paid for: a three-valued enum that can say "hybrid" is
      // trustworthy (Ashby's workplaceType), a boolean that collapses hybrid into
      // remote is not (Ashby's isRemote, which mislabelled two thirds of the feed).
      // Recruitee's is the second kind and is unmeasured besides.
      return {
        source: 'recruitee',
        company: token,
        company_url: `https://${token}.recruitee.com/`,
        job_id: String(job.id ?? job.slug),
        title: (job.title ?? '').trim(),
        url: job.careers_url ?? null,
        location: loc,
        workplace: workplace(`${loc ?? ''} ${job.title ?? ''}`),
        department: job.department || null,
        team: null,
        employment_type: job.employment_type_code || null,
        posted_at: iso(job.published_at),
        updated_at: iso(job.published_at),
        // Recruitee is the first provider that ships a *structured, published* salary
        // rather than one buried in prose, so this column stops being a parse for it.
        // Only `period: "year"` is taken at face value. A monthly figure times twelve
        // is not the annual salary in the countries where Recruitee is thickest —
        // 13th- and 14th-month payments are ordinary in NL, DE, AT and PT — and hourly
        // needs an assumed working week. Those are estimates, and the schema says this
        // column is never estimated. So they stay null rather than become a guess.
        ...recruiteeSalary(job.salary),
        seniority: seniority(job.title ?? ''),
        description: stripHtml(job.description) || null,
      }
    },
  },
  teamtailor: {
    url: (t) => `https://${encodeURIComponent(t)}.teamtailor.com/jobs.json`,
    list: (j) => (Array.isArray(j?.items) ? j.items : null),
    // {token}.teamtailor.com/robots.txt disallows /app/, /messages/, /messenger/,
    // /facebook/tab/ and /jobs/internal/. `/jobs.json` is not among them. The file also
    // names `aihitdata` with a blanket "Disallow: /" — we are not aihitdata, so the `*`
    // group governs us — and carries
    // "Content-Signal: search=yes, ai-train=no, ai-input=yes". We build a search and
    // feed index and do not train on this text, which is the `search=yes` case.
    //
    // A tenant's *career site* may 301 to a customer domain (hemnet.teamtailor.com →
    // career.hemnet.se). `/jobs.json` does not: it serves 200 on the teamtailor.com
    // host directly, measured. So the subdomain stays the addressable unit and there is
    // no second host whose robots.txt we would have to read.
    concurrency: 8,
    delayMs: 0,
    map: (job, token) => {
      const jp = job._jobposting ?? {}
      const addr = jp.jobLocation?.[0]?.address ?? {}
      const loc = [addr.addressLocality, addr.addressRegion, addr.addressCountry]
        .map((s) => (s ?? '').trim()).filter(Boolean).join(', ') || null
      const body = stripHtml(job.content_html)
      // `jobLocationType` is schema.org's own vocabulary, but in practice it is either
      // "TELECOMMUTE" or absent — it cannot express hybrid, which makes it the same
      // shape of flag as Ashby's isRemote rather than the same shape as Ashby's
      // workplaceType. Not trusted; the column comes from the text until measured.
      return {
        source: 'teamtailor',
        company: token,
        company_url: `https://${token}.teamtailor.com/`,
        job_id: String(job.id),
        title: (job.title ?? '').trim(),
        url: job.url ?? null,
        location: loc,
        workplace: workplace(`${loc ?? ''} ${job.title ?? ''}`),
        department: jp.department || null,
        team: null,
        employment_type: jp.employmentType || null,
        posted_at: iso(job.date_published ?? jp.datePosted),
        updated_at: iso(job.date_published ?? jp.datePosted),
        // Teamtailor exposes schema.org `baseSalary`, but it was null on every posting
        // of both boards read so far, so there is nothing measured to trust yet. Parse
        // the body like the other text-salary providers; revisit if a harvested roster
        // shows baseSalary populated at any real rate.
        ...salaryFields(`${job.title ?? ''} ${body}`),
        seniority: seniority(job.title ?? ''),
        description: body || null,
      }
    },
  },
}

// Recruitee's salary object is {min,max,period,currency} with the amounts as strings.
function recruiteeSalary(s) {
  const none = { salary_min: null, salary_max: null, salary_currency: null }
  if (!s || s.period !== 'year') return none
  const num = (v) => {
    const n = Number(String(v ?? '').replace(/[,\s]/g, ''))
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null
  }
  const min = num(s.min)
  const max = num(s.max)
  if (min === null && max === null) return none
  return { salary_min: min, salary_max: max, salary_currency: s.currency || null }
}
