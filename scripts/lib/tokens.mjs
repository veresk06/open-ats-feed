// Shared between the two harvesters: how a board URL becomes a company token, and
// how a partial harvest is checkpointed. Both harvesters write the same file, so a
// run of one can resume a run of the other.

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const OUT = resolve(ROOT, 'data/tokens.json')

// SmartRecruiters was harvested here in Cycle 33 and then removed on evidence, not on
// taste. `api.smartrecruiters.com/robots.txt` reads `User-agent: * / Disallow: /`, with
// a single `Allow: /v1/companies/` carve-out granted to `LinkedInBot`. We are not
// LinkedInBot. Our one claim no scraper can make is that every posting comes from an
// API its vendor publishes for the taking; fetching a host that refuses us would spend
// that claim to buy ~1,800 boards. Do not re-add it without a changed robots.txt.
//
// `caseSensitive` survives that removal because it is the correct general rule:
// Greenhouse, Lever, Ashby and Workable all resolve a lowercased token, and a vendor
// that puts a case-sensitive identifier in the API path does not. Lowercasing those
// silently yields a roster of 404s.
//
// `tokenFrom: 'subdomain'` exists because the first three vendors all put the company
// in the path and the fourth class of vendor does not. Breezy, Recruitee, Teamtailor
// and Personio all address a board as `{token}.vendor.tld`, so a path-only harvester
// finds none of them — which is one concrete reason our provider count sat at three.
export const SOURCES = [
  { provider: 'greenhouse', host: 'boards.greenhouse.io' },
  { provider: 'greenhouse', host: 'job-boards.greenhouse.io' },
  { provider: 'greenhouse', host: 'boards.eu.greenhouse.io' },
  { provider: 'greenhouse', host: 'job-boards.eu.greenhouse.io' },
  { provider: 'lever', host: 'jobs.lever.co' },
  { provider: 'lever', host: 'jobs.eu.lever.co' },
  { provider: 'ashby', host: 'jobs.ashbyhq.com' },
  { provider: 'workable', host: 'apply.workable.com' },
  // `{token}.breezy.hr/robots.txt` disallows only /css, /fonts, /stylesheets and
  // /javascripts — the `/json` board endpoint we read is allowed. Note that this is
  // the *tenant* host: the marketing host `breezy.hr` carries `Disallow: /api/`, and
  // we do not fetch that host at all.
  { provider: 'breezy', host: 'breezy.hr', tokenFrom: 'subdomain' },
]

export const PROVIDER_NAMES = [...new Set(SOURCES.map((s) => s.provider))]

// First path segments that are platform routes, not company tokens. `j` is Workable's
// direct-to-posting route (apply.workable.com/j/{JOBID}); `oauth` and `account` are
// SmartRecruiters console routes that appear under careers. hosts.
// `www`, `app`, `help` and the rest are here for the subdomain vendors: on a
// path vendor they could never appear in position 0, but on `{token}.breezy.hr`
// the vendor's own marketing and console subdomains sit in exactly the slot a
// company token occupies, and each one would otherwise be harvested as a company.
const NOT_A_TOKEN = new Set([
  'embed', 'api', 'v1', 'v0', 'jobs', 'job', 'static', 'assets', 'favicon.ico',
  'robots.txt', 'sitemap.xml', 'error', '404', 'index.html', 'apply', 'search',
  'postings', 'boards', 'company', 'companies', 'auth', 'login', 'signup',
  'j', 'oauth', 'account', 'settings', 'terms', 'privacy',
  'www', 'app', 'help', 'support', 'blog', 'status', 'mail', 'cdn', 'static1',
  'docs', 'developer', 'developers', 'admin', 'dashboard', 'go', 'get', 'my',
])

// The label immediately left of the vendor host, or null. A `host` is required and is
// never inferred: without it `a.b.breezy.hr.evil.com` would yield a token, and a nested
// label like `a.b.breezy.hr` is rejected rather than flattened, because a board token
// is a single label and anything else is a vendor route we have not seen before.
function subdomainOf(u, host) {
  if (!host) return null
  const suffix = `.${host.toLowerCase()}`
  const name = u.hostname.toLowerCase()
  if (!name.endsWith(suffix)) return null
  const label = name.slice(0, -suffix.length)
  if (!label || label.includes('.')) return null
  return label
}

export function tokenFromUrl(raw, { caseSensitive = false, tokenFrom = 'path', host } = {}) {
  let u
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const seg = tokenFrom === 'subdomain' ? subdomainOf(u, host) : u.pathname.split('/').filter(Boolean)[0]
  if (!seg) return null
  let token
  try {
    token = decodeURIComponent(seg).trim()
  } catch {
    return null
  }
  if (!caseSensitive) token = token.toLowerCase()
  if (!token || token.length > 100) return null
  if (NOT_A_TOKEN.has(token.toLowerCase())) return null
  // Board tokens are slugs. Pure digits are job ids that leaked into position 0.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(token)) return null
  if (/^\d+$/.test(token)) return null
  return token
}

export function snapshot(byProvider) {
  return Object.fromEntries(
    Object.entries(byProvider).map(([k, v]) => [k, [...v].sort()]),
  )
}

// The first run of this was killed mid-sweep and lost every token, because the
// output was only written at the end. Checkpoint after each host instead, and
// reload the checkpoint on start so a kill costs one host, not the whole sweep.
export async function save(byProvider) {
  await mkdir(dirname(OUT), { recursive: true })
  await writeFile(OUT, JSON.stringify(snapshot(byProvider), null, 2))
}

export async function load(byProvider) {
  try {
    const prev = JSON.parse(await readFile(OUT, 'utf8'))
    for (const [k, v] of Object.entries(prev)) {
      if (byProvider[k]) for (const t of v) byProvider[k].add(t)
    }
    const n = Object.values(byProvider).reduce((a, v) => a + v.size, 0)
    if (n) console.log(`Resuming from checkpoint: ${n} tokens already known\n`)
  } catch {
    // No checkpoint yet.
  }
}
